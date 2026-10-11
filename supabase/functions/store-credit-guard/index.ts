// store-credit-guard v1
// Takes back store credit that a Return Prime return put on a customer's account
// twice.
//
// The cause (Oct 2026, orders 36791 and 37613): on a COD order Return Prime
// credits the customer by hand with the full refund (goods minus the ₹99 return
// fee) — its own record shows ONE refund — and also records a Shopify refund per
// way the order was paid. COD becomes "refunded to Cash On Delivery", paperwork
// that moves no money. The part paid with store credit becomes a refund to the
// "Shopify Store Credits" payment method, which GoKwik (Gokwik_Brune) turns into
// a real credit a few seconds later. The customer keeps the refund plus the store
// credit they spent at checkout; it was unspent on both accounts (₹2,599.20).
// Prepaid returns and plain COD returns are fine: one credit each.
//
// The guard watches Return Prime's recent refunds on COD (manual-payment) orders
// and, if the credits that landed around the refund exceed what Return Prime
// refunded by exactly the store-credit refund, debits that amount from the
// account with storeCreditAccountDebit. Rules: ../_shared/credit-guard.ts
// (tested on the real cases). It never debits more than the balance: if the
// customer already spent it, the return is 'flagged' for a person.
//
// Exactly-once: store_credit_reversals has one row per (order, Return Prime
// request), claimed before the debit.
//
// Dry mode: until app_settings.credit_guard_mode is "live" the job only writes
// 'would_reverse' rows. The `reverse` admin action is an explicit instruction and
// always acts.
//
// Schedule: every 2 minutes (pg_cron, migration 016, header x-cron-key matching
// private_secrets.erp_stock_cron_key) over the last 48 hours of refunds.
//
// Admin actions (POST { action } with an admin user's JWT):
//   status  — mode and the reversal rows
//   sweep   — { hours?: 48, dry?: true } check recent returns; dry (default) writes nothing
//   check   — { order: "37613" } what the guard would do about one order's return
//   reverse — { order: "37613" } take the extra credit back now (live, ignores mode)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { type Credit, evaluateReturn, type GuardDecision } from '../_shared/credit-guard.ts';
import { CORS, type Ctx, cronKeyValid, gql, json, loadCtx, requireAdmin, secrets, setting } from '../_shared/shopify-admin.ts';

const RP_API = 'https://api.returnprime.co';
const SWEEP_PAGES = 3;          // 10 requests a page, newest first
const LOOKUP_PAGES = 15;        // looking for one older return
const STALE_CLAIM_MS = 10 * 60_000;
// Shopify's refund transaction lands within seconds of Return Prime's own credit.
const REFUND_BEFORE_MS = 2 * 60_000;
const REFUND_AFTER_MS = 10 * 60_000;

type RpReturn = { request: string; orderId: number; orderName: string; refunded: number; refundedAt: string };
type Check = {
  order: string; request: string; decision: GuardDecision;
  rpRefunded: number; storeCreditRefund: number; balance: number; customerId: string | null; accountId: string | null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const raw = await req.text();
  try {
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
      return json(await sweep(await loadCtx(admin), { hours: 48, record: true }));
    }
    const denied = await requireAdmin(admin, req);
    if (denied) return denied;
    const body = raw ? JSON.parse(raw) : {};
    const ctx = await loadCtx(admin);
    const order = String(body.order ?? '').replace(/^#/, '');
    switch (body.action) {
      case 'status':  return json(await status(ctx));
      case 'sweep':   return json(await sweep(ctx, { hours: Number(body.hours ?? 48), record: body.dry === false }));
      case 'check':   return json(await one(ctx, order, 'check'));
      case 'reverse': return json(await one(ctx, order, 'reverse'));
      default:        return json({ error: 'action must be status, sweep, check or reverse' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── The job ───────────────────────────────────────────────────────────────────

async function sweep(ctx: Ctx, opts: { hours: number; record: boolean }) {
  const mode = await setting(ctx.admin, 'credit_guard_mode', 'dry');
  const live = opts.record && mode === 'live';
  const startDate = await setting(ctx.admin, 'accounting_start_date', '2026-10-01');
  const since = Date.now() - opts.hours * 3_600_000;
  const returns = (await recentReturns(ctx, SWEEP_PAGES)).filter(r => Date.parse(r.refundedAt) >= since);

  const out = { mode, live, record: opts.record, start_date: startDate, returns_checked: returns.length, reversed: [] as unknown[], would_reverse: [] as unknown[], flagged: [] as unknown[] };
  for (const r of returns) {
    const known = await ctx.admin.from('store_credit_reversals').select('status, updated_at').eq('order_id', r.orderId).eq('request_number', r.request).maybeSingle();
    if (known.data && ['reversed', 'flagged'].includes(known.data.status as string)) continue;   // done; a person decides flagged ones
    const c = await check(ctx, r);
    if (c.decision.action === 'ok') continue;
    const summary = { order: c.order, request: c.request, excess: c.decision.excess, reason: c.decision.reason };
    if (c.decision.action === 'flag') {
      out.flagged.push(summary);
      if (opts.record) await record(ctx, r, c, 'flagged');
      continue;
    }
    if (!live) {
      out.would_reverse.push(summary);
      if (opts.record) await record(ctx, r, c, 'would_reverse');
      continue;
    }
    const done = await reverse(ctx, r, c);
    (done.ok ? out.reversed : out.flagged).push({ ...summary, ...(done.ok ? {} : { reason: done.reason }) });
  }
  if (out.flagged.length) console.warn('[credit-guard] needs a person', JSON.stringify(out.flagged));
  return out;
}

// One order, by hand. 'check' only reports; 'reverse' takes the credit back.
async function one(ctx: Ctx, orderName: string, what: 'check' | 'reverse') {
  if (!orderName) return { error: 'order is required' };
  const found = (await recentReturns(ctx, LOOKUP_PAGES, orderName))[0];
  if (!found) return { error: `no refunded Return Prime return found for order ${orderName}` };
  const c = await check(ctx, found);
  const report = { order: c.order, request: c.request, action: c.decision.action, excess: c.decision.excess, reason: c.decision.reason, rp_refunded: c.rpRefunded, store_credit_refund: c.storeCreditRefund, credited: c.decision.credited, balance: c.balance };
  if (what === 'check' || c.decision.action !== 'reverse') return report;
  const done = await reverse(ctx, found, c);
  return { ...report, reversed: done.ok, ...(done.ok ? {} : { problem: done.reason }) };
}

// Claim the return, debit the account, record the outcome.
async function reverse(ctx: Ctx, r: RpReturn, c: Check): Promise<{ ok: boolean; reason: string }> {
  if (c.decision.action !== 'reverse' || !c.accountId) return { ok: false, reason: 'nothing to reverse' };
  const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  await record(ctx, r, c, 'would_reverse', true);
  const { data: claimed } = await ctx.admin.from('store_credit_reversals')
    .update({ status: 'reversing', updated_at: new Date().toISOString() })
    .eq('order_id', r.orderId).eq('request_number', r.request)
    .or(`status.eq.would_reverse,and(status.eq.reversing,updated_at.lt.${stale})`)
    .select('id');
  if (!claimed?.length) return { ok: false, reason: 'already handled' };

  try {
    const res = await gql(ctx, `mutation DebitCredit($id: ID!, $amount: MoneyInput!) {
      storeCreditAccountDebit(id: $id, debitInput: { debitAmount: $amount }) {
        storeCreditAccountTransaction { id amount { amount } account { id balance { amount } } }
        userErrors { field message }
      }
    }`, { id: c.accountId, amount: { amount: c.decision.excess.toFixed(2), currencyCode: 'INR' } });
    const payload = res.data?.storeCreditAccountDebit;
    const errs = payload?.userErrors ?? [];
    if (errs.length || !payload?.storeCreditAccountTransaction) {
      const why = errs.map((e: { message: string }) => e.message).join('; ') || 'Shopify returned no transaction';
      await ctx.admin.from('store_credit_reversals').update({ status: 'flagged', detail: `debit failed: ${why}`, updated_at: new Date().toISOString() }).eq('order_id', r.orderId).eq('request_number', r.request);
      return { ok: false, reason: why };
    }
    await ctx.admin.from('store_credit_reversals').update({
      status: 'reversed', detail: c.decision.reason, debit_transaction_id: payload.storeCreditAccountTransaction.id, updated_at: new Date().toISOString(),
    }).eq('order_id', r.orderId).eq('request_number', r.request);
    return { ok: true, reason: 'reversed' };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    await ctx.admin.from('store_credit_reversals').update({ status: 'flagged', detail: `debit failed: ${why}`, updated_at: new Date().toISOString() }).eq('order_id', r.orderId).eq('request_number', r.request);
    return { ok: false, reason: why };
  }
}

async function record(ctx: Ctx, r: RpReturn, c: Check, status: 'would_reverse' | 'flagged', keepExisting = false) {
  await ctx.admin.from('store_credit_reversals').upsert({
    order_id: r.orderId, order_name: r.orderName, request_number: r.request, customer_id: c.customerId,
    rp_refunded: c.rpRefunded, store_credit_refund: c.storeCreditRefund, credited_total: c.decision.credited, excess: c.decision.excess,
    status, detail: c.decision.reason, updated_at: new Date().toISOString(),
  }, { onConflict: 'order_id,request_number', ignoreDuplicates: keepExisting });
}

// ── Reading ───────────────────────────────────────────────────────────────────

// Return Prime's recent refunds on COD (manual-payment) orders, newest first.
// Only those can double: prepaid orders are refunded natively, once.
async function recentReturns(ctx: Ctx, pages: number, onlyOrder?: string): Promise<RpReturn[]> {
  const token = Deno.env.get('RETURN_PRIME_TOKEN') || (await secrets(ctx.admin, ['returnprime_token'])).returnprime_token;
  if (!token) throw new Error('Return Prime token missing (RETURN_PRIME_TOKEN)');
  const out: RpReturn[] = [];
  for (let page = 1; page <= pages; page++) {
    const res = await fetch(`${RP_API}/return-exchange/v2?page=${page}`, { headers: { 'x-rp-token': token, 'Content-Type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.status === false) throw new Error(`Return Prime ${res.status}: ${body?.message ?? 'request failed'}`);
    for (const req of body.data?.list ?? []) {
      if (req.order?.order_manual_payment !== true) continue;
      if (onlyOrder && String(req.order?.name) !== onlyOrder) continue;
      const lines = (req.line_items ?? []).map((l: any) => l.refund).filter((rf: any) => rf?.status === 'refunded' && rf?.refunded_at);
      if (!lines.length) continue;
      out.push({
        request: String(req.request_number), orderId: Number(req.order.id), orderName: String(req.order.name),
        refunded: Math.round(lines.reduce((s: number, rf: any) => s + Number(rf.refunded_amount?.shop_money?.amount ?? 0), 0) * 100) / 100,
        refundedAt: lines.map((rf: any) => rf.refunded_at as string).sort()[0],
      });
    }
    if (!body.data?.hasNextPage) break;
  }
  return out;
}

async function check(ctx: Ctx, r: RpReturn): Promise<Check> {
  const res = await gql(ctx, `query GuardOrder($id: ID!) {
    order(id: $id) {
      id name
      refunds { createdAt transactions(first: 5) { nodes { kind gateway amountSet { shopMoney { amount } } } } }
      customer { id storeCreditAccounts(first: 1) { nodes { id balance { amount } transactions(first: 50, reverse: true) { nodes { __typename amount { amount } createdAt } } } } }
    }
  }`, { id: `gid://shopify/Order/${r.orderId}` });
  const order = res.data?.order;
  const at = Date.parse(r.refundedAt);
  // Shopify refunds recorded against the store-credit payment method at the time of the return.
  let storeCreditRefund = 0;
  for (const rf of order?.refunds ?? []) {
    const t = Date.parse(rf.createdAt);
    if (t < at - REFUND_BEFORE_MS || t > at + REFUND_AFTER_MS) continue;
    for (const tx of rf.transactions?.nodes ?? []) {
      if (tx.kind === 'REFUND' && /store.?credit/i.test(tx.gateway ?? '')) storeCreditRefund += Number(tx.amountSet?.shopMoney?.amount ?? 0);
    }
  }
  storeCreditRefund = Math.round(storeCreditRefund * 100) / 100;

  const account = order?.customer?.storeCreditAccounts?.nodes?.[0];
  const credits: Credit[] = (account?.transactions?.nodes ?? [])
    .filter((t: any) => t.__typename === 'StoreCreditAccountCreditTransaction')
    .map((t: any) => ({ amount: Number(t.amount.amount), at: t.createdAt as string }));
  const balance = Number(account?.balance?.amount ?? 0);
  const decision = evaluateReturn({ rpRefunded: r.refunded, rpRefundedAt: r.refundedAt, storeCreditRefund, credits, balance });
  return {
    order: r.orderName, request: r.request, decision, rpRefunded: r.refunded, storeCreditRefund, balance,
    customerId: order?.customer?.id ?? null, accountId: account?.id ?? null,
  };
}

async function status(ctx: Ctx) {
  const { data } = await ctx.admin.from('store_credit_reversals')
    .select('order_name, request_number, excess, status, detail, updated_at').order('updated_at', { ascending: false }).limit(50);
  return { mode: await setting(ctx.admin, 'credit_guard_mode', 'dry'), reversals: data ?? [] };
}
