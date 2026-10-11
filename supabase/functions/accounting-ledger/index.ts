// accounting-ledger v4 — READ ONLY
// Gathers the facts about Shopify orders from every system, builds each order's
// double-entry ledger, and reports which orders balance and which need a person
// or a balancing document. Nothing is written anywhere: no tables, no Shopify,
// Unicommerce or Return Prime calls that change anything.
//
// Per order it reads:
//   Shopify       the order, how it was paid, refunds, the customer's store credit
//   Unicommerce   the order (saleorder/get) and, per shipping package, the sale and
//                 return invoices with their real amounts (invoice/details/get)
//   Return Prime  its refunds: amount, date, return fee, whether the parcel arrived
//   cod_deliveries / Velocity   the delivery date of COD parcels
// then _shared/order-facts.ts turns that into facts and _shared/ledger.ts into entries.
// The rules and their tests: docs/accounting-ledger.md.
//
// Entries before app_settings.accounting_start_date (2026-10-01) are computed, so an
// order can be shown to balance, but are never part of `exportable`.
//
// Actions (POST { action } with an admin user's JWT, or the x-cron-key header):
//   order  — { order: "37613" } full facts, notes and entries for one order
//   report — { from?: "2026-10-01", limit?: 15, after?: cursor, only_issues?: true, budget_s?: 80 }
//            orders updated since `from`. One page of `limit` orders, or with `budget_s` as many
//            pages as fit in that many seconds (Return Prime is read once per call). Pass `next`
//            back as `after` for more; `next` is null at the end.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildFacts, istDate, type RawInputs } from '../_shared/order-facts.ts';
import { buildOrderLedger } from '../_shared/ledger.ts';
import { ucPost } from '../_shared/unicommerce.ts';
import { CORS, type Ctx, cronKeyValid, gql, json, loadCtx, requireAdmin, secrets, setting, sleep } from '../_shared/shopify-admin.ts';

const RP_API = 'https://api.returnprime.co';
const RP_PAGES = 30;
const VELOCITY_URL = 'https://shazam.velocity.in/custom/api/v1/cod-remittance';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const raw = await req.text();
  try {
    const body = raw ? JSON.parse(raw) : {};
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
    } else {
      const denied = await requireAdmin(admin, req);
      if (denied) return denied;
    }
    const ctx = await loadCtx(admin);
    switch (body.action) {
      case 'order':  return json(await oneOrder(ctx, String(body.order ?? '').replace(/^#/, '')));
      case 'report': return json(await report(ctx, body));
      default:       return json({ error: 'action must be order or report' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Actions ───────────────────────────────────────────────────────────────────

async function oneOrder(ctx: Ctx, name: string) {
  if (!name) return { error: 'order is required' };
  const nodes = await shopifyOrders(ctx, `name:${name}`, 5);
  // Shopify's name search is loose ("37720" also finds "3-7720"): keep the exact order.
  const exact = nodes.nodes.filter(n => String(n.name).replace(/^#/, '') === name);
  if (!exact.length) return { error: `order ${name} not found on Shopify` };
  const [res] = await process(ctx, exact);
  return { ...res, entries: res.ledger.entries };
}

async function report(ctx: Ctx, body: any) {
  const cutoff = await setting(ctx.admin, 'accounting_start_date', '2026-10-01');
  const from = String(body.from ?? cutoff);
  const limit = Math.min(Math.max(Number(body.limit ?? 15), 1), 40);
  const budgetMs = Math.min(Math.max(Number(body.budget_s ?? 0), 0), 100) * 1000;
  const started = Date.now();
  const shared = await sharedInputs(ctx);
  const results: Awaited<ReturnType<typeof process>> = [];
  let after: string | null = body.after ?? null;
  let next: string | null = null;
  do {
    const page = await shopifyOrders(ctx, `updated_at:>=${from}`, limit, after);
    results.push(...await process(ctx, page.nodes, shared));
    next = page.hasNext ? page.cursor : null;
    after = next;
  } while (next && Date.now() - started < budgetMs);

  const summary = { orders: results.length, balanced: 0, not_a_sale: 0, open: 0, attention: 0, awaiting_return: 0, in_transit: 0, refund_due: 0, store_credit_differs: 0, unexplained_residual: 0, bad_facts: 0, needing_balancing_documents: 0 };
  const balancing: Record<string, { orders: number; amount: number }> = {};
  for (const r of results) {
    if (r.skip) { summary.not_a_sale++; continue; }
    if (r.ledger.balanced) summary.balanced++;
    if (r.ledger.status === 'open') summary.open++;
    if (r.ledger.status === 'attention') summary.attention++;
    for (const t of new Set(r.ledger.exceptions.map((e: any) => e.type))) (summary as any)[t as string]++;
    if (r.ledger.balancing.some((b: any) => b.type !== 'return_fee_invoice')) summary.needing_balancing_documents++;
    for (const b of r.ledger.balancing) {
      const t = (balancing[b.type] ??= { orders: 0, amount: 0 });
      t.orders++; t.amount = Math.round((t.amount + b.amount) * 100) / 100;
    }
  }
  const rows = results
    .filter(r => !r.skip)
    .filter(r => !body.only_issues || !r.ledger.balanced || r.ledger.balancing.some((b: any) => b.type !== 'return_fee_invoice'))
    .map(r => ({
      order: r.order, status: r.ledger.status, balanced: r.ledger.balanced, net: r.ledger.net, opening: r.ledger.opening,
      exceptions: r.ledger.exceptions, balancing: r.ledger.balancing, notes: r.notes,
    }));
  return { cutoff, from, summary, balancing, next, seconds: Math.round((Date.now() - started) / 1000), orders: rows };
}

// ── Gathering ─────────────────────────────────────────────────────────────────

type Shared = Awaited<ReturnType<typeof sharedInputs>>;

// What every order in a run needs, read once per run.
async function sharedInputs(ctx: Ctx) {
  const cutoff = await setting(ctx.admin, 'accounting_start_date', '2026-10-01');
  const sellerState = await setting(ctx.admin, 'seller_state', 'UP');
  const today = istDate(Date.now());
  const rp = await returnPrimeByOrder(ctx);
  // The debits the ERP made to take back double store credit (store-credit-guard).
  const { data: rev } = await ctx.admin.from('store_credit_reversals').select('debit_transaction_id').eq('status', 'reversed');
  const reversalIds = (rev ?? []).map(r => String(r.debit_transaction_id)).filter(Boolean);
  return { cutoff, sellerState, today, rp, reversalIds };
}

async function process(ctx: Ctx, orders: any[], shared?: Shared) {
  const { cutoff, sellerState, today, rp, reversalIds } = shared ?? await sharedInputs(ctx);
  const ids = orders.map(o => Number(o.legacyResourceId));
  const { data: cod } = await ctx.admin.from('cod_deliveries').select('order_id, delivered_on').in('order_id', ids);
  const codBy = new Map((cod ?? []).map(r => [Number(r.order_id), r.delivered_on as string | null]));

  // Unicommerce: the order, then its sale invoice and return invoices.
  const ucBy = new Map<number, RawInputs['uc']>();
  for (const o of orders) ucBy.set(Number(o.legacyResourceId), await unicommerce(ctx, Number(o.legacyResourceId)));

  // Velocity delivery dates for COD parcels we have no delivery row for.
  const needVelocity = orders.filter(o => !codBy.get(Number(o.legacyResourceId)) && /cash_on_delivery|ppcod/i.test((o.paymentGatewayNames ?? []).join(' ')));
  const awbOf = (o: any) => (o.fulfillments ?? []).flatMap((f: any) => (f.trackingInfo ?? []).map((t: any) => String(t.number ?? ''))).find(Boolean) as string | undefined;
  const velocity = await velocityDelivery(ctx, needVelocity.map(awbOf).filter(Boolean) as string[]);

  const out: Array<{ order: string; facts: any; notes: string[]; skip?: string; ledger: ReturnType<typeof buildOrderLedger> }> = [];
  for (const o of orders) {
    const id = Number(o.legacyResourceId);
    const awb = awbOf(o);
    const built = buildFacts({
      sellerState, today, shopify: o, uc: ucBy.get(id) ?? null,
      rpRequests: rp.get(String(o.name).replace(/^#/, '')) ?? [], reversalIds,
      codDeliveredOn: codBy.get(id) ?? null,
      velocityDeliveredOn: awb ? velocity.get(awb) ?? null : null,
    });
    out.push({ order: built.facts.order, facts: built.facts, notes: built.notes, skip: built.skip, ledger: buildOrderLedger(built.facts, { cutoff, today }) });
  }
  return out;
}

async function shopifyOrders(ctx: Ctx, q: string, first: number, after: string | null = null) {
  const res = await gql(ctx, `query LedgerOrders($q: String!, $first: Int!, $after: String) {
    orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { id legacyResourceId name createdAt cancelledAt tags paymentGatewayNames
        subtotalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } } shippingAddress { provinceCode }
        transactions(first: 20) { id kind status gateway amountSet { shopMoney { amount } } processedAt }
        refunds { createdAt refundLineItems(first: 10) { nodes { subtotalSet { shopMoney { amount } } } }
          transactions(first: 5) { nodes { kind gateway amountSet { shopMoney { amount } } } } }
        fulfillments(first: 3) { trackingInfo { number } }
        customer { id storeCreditAccounts(first: 1) { nodes { id transactions(first: 50, reverse: true) { nodes { __typename ... on Node { id } amount { amount } createdAt } } } } } }
    }
  }`, { q, first, after });
  const conn = res.data.orders;
  return { nodes: conn.nodes as any[], hasNext: !!conn.pageInfo.hasNextPage, cursor: conn.pageInfo.endCursor as string | null };
}

async function unicommerce(ctx: Ctx, orderId: number): Promise<RawInputs['uc']> {
  const so = await ucPost(ctx.admin, '/services/rest/v1/oms/saleorder/get', { code: String(orderId) });
  if (!so?.successful || !so.saleOrderDTO) return null;
  const order = so.saleOrderDTO;
  if (order.status === 'CANCELLED') return { order, returnInvoices: {} };
  const pkg: string | undefined = (order.shippingPackages ?? [])[0]?.code;
  const out: NonNullable<RawInputs['uc']> = { order, returnInvoices: {} };
  if (!pkg) return out;
  out.saleInvoice = (await ucPost(ctx.admin, '/services/rest/v1/invoice/details/get', { shippingPackageCode: pkg, return: false }))?.invoice;
  for (const r of order.returns ?? []) {
    if (!r.returnInvoiceDisplayCode) continue;
    const inv = (await ucPost(ctx.admin, '/services/rest/v1/invoice/details/get', { shippingPackageCode: pkg, return: true }))?.invoice;
    if (inv) out.returnInvoices[r.code] = inv;
  }
  return out;
}

// Return Prime requests, newest first, grouped by Shopify order number.
async function returnPrimeByOrder(ctx: Ctx): Promise<Map<string, any[]>> {
  const token = Deno.env.get('RETURN_PRIME_TOKEN') || (await secrets(ctx.admin, ['returnprime_token'])).returnprime_token;
  if (!token) throw new Error('Return Prime token missing (RETURN_PRIME_TOKEN)');
  const by = new Map<string, any[]>();
  for (let page = 1; page <= RP_PAGES; page++) {
    const res = await fetch(`${RP_API}/return-exchange/v2?page=${page}`, { headers: { 'x-rp-token': token, 'Content-Type': 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.status === false) throw new Error(`Return Prime ${res.status}: ${body?.message ?? 'request failed'}`);
    for (const rq of body.data?.list ?? []) {
      const key = String(rq.order?.name ?? '');
      if (key) (by.get(key) ?? by.set(key, []).get(key)!).push(rq);
    }
    if (!body.data?.hasNextPage) break;
  }
  return by;
}

// Delivery dates by AWB, from Velocity's COD remittance API (100 a call, 5 calls a minute).
async function velocityDelivery(ctx: Ctx, awbs: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const list = [...new Set(awbs)];
  if (!list.length) return out;
  const token = (await secrets(ctx.admin, ['velocity_api_token'])).velocity_api_token;
  if (!token) return out;
  for (let i = 0; i < list.length; i += 100) {
    if (i) await sleep(13_000);
    const res = await fetch(VELOCITY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ awbs: list.slice(i, i + 100) }) });
    if (!res.ok) continue;
    const body = await res.json().catch(() => ({}));
    for (const r of body.data ?? []) out.set(String(r.tracking_number), r.delivery_date ?? null);
  }
  return out;
}
