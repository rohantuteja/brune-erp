// accounting-ledger v8
// Gathers the facts about Shopify orders from every system, builds each order's
// double-entry ledger, and reports which orders balance and which need a person
// or a balancing document. `order` and `report` write nothing. `sync` and `tick`
// save the result to the ledger_* tables (migration 017) and nothing else: no
// Shopify, Unicommerce or Return Prime call here changes anything.
//
// Per order it reads:
//   Shopify       the order, how it was paid, refunds, the customer's store credit
//   Unicommerce   the order (saleorder/get) and, per shipping package, the sale and
//                 return invoices with their real amounts (invoice/details/get)
//   Return Prime  its refunds: amount, date, return fee, whether the parcel arrived
//   cod_deliveries / Velocity   the delivery date of COD parcels and the remittance (UTR) that paid them
//   GoKwik        its settlement report (gokwik_payments, uploaded by hand): what it paid out per order, its fee and the GST on it
// and, for Myntra orders (channel MYNTRAPPMP, which live only in Unicommerce): the order, its sale invoice and its
// return invoices. Myntra is a marketplace: the invoice is to the end customer (B2C), but Myntra collects the payment and
// pays us later, so those orders sit on a "Myntra receivable" clearing account and stay open until its settlement is
// matched (later). A Myntra order enters the ledger once Unicommerce has invoiced it.
// then _shared/order-facts.ts turns that into facts and _shared/ledger.ts into entries.
// The rules and their tests: docs/accounting-ledger.md.
//
// Entries before app_settings.accounting_start_date (2026-10-01) are computed, so an
// order can be shown to balance, but are never part of `exportable`.
//
// Actions (POST { action } with an admin user's JWT, or the x-cron-key header):
//   order  — { order: "37613" } full facts, notes and entries for one order; a Myntra order by its Unicommerce
//            order code, or by its invoice number once it is in the ledger
//   report — { from?: "2026-10-01", limit?: 15, after?: cursor, only_issues?: true, budget_s?: 80 }
//            orders updated since `from`. One page of `limit` orders, or with `budget_s` as many
//            pages as fit in that many seconds (Return Prime is read once per call). Pass `next`
//            back as `after` for more; `next` is null at the end.
//   credit — { order: "37586" } read-only look at what Shopify says about the customer's money for
//            an order: refunds, every store credit transaction on the customer's account, the
//            order's timeline entries about credit / refunds / returns, and its note. No names.
//   velocity_gap — { from?: "2026-09-10" } read-only: COD orders from before the start date that are NOT in the
//            ledger (Shopify has not updated them since), checked against Velocity. Lists those Velocity paid on or
//            after the start date (October receipts the ledger would otherwise miss) and those delivered but never paid.
//   sync   — { kind?: "full" | "incremental", budget_s?: 100 } start a run (or continue the one
//            that is running) and save orders for up to budget_s seconds. A run holds the queue
//            of Shopify order ids: a full run is every order updated since the start date, an
//            incremental one those updated since the last run plus every open order.
//   tick   — what the schedule calls every 10 minutes. Does nothing unless
//            app_settings.ledger_sync_mode is "live"; then it continues a part-done run, or
//            starts a full run (each night) or an incremental one (each hour).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildFacts, buildMyntraFacts, istDate, type RawInputs } from '../_shared/order-facts.ts';
import { buildOrderLedger } from '../_shared/ledger.ts';
import { decideTick, ledgerRow } from '../_shared/ledger-store.ts';
import { ucErrorText, ucPost } from '../_shared/unicommerce.ts';
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
      case 'credit': return json(await creditHistory(ctx, String(body.order ?? '').replace(/^#/, '')));
      case 'velocity_gap': return json(await velocityGap(ctx, body));
      case 'sync':   return json(await sync(ctx, body));
      case 'tick':   return json(await tick(ctx, body));
      default:       return json({ error: 'action must be order, report, credit, velocity_gap, sync or tick' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Actions ───────────────────────────────────────────────────────────────────

async function oneOrder(ctx: Ctx, name: string) {
  if (!name) return { error: 'order is required' };
  // A Myntra order: its Unicommerce order code (a UUID), or its invoice number once the ledger knows it.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
  if (uuid || /^I\d{4}RE\d+$/i.test(name)) {
    let code = name;
    if (!uuid) {
      const { data } = await ctx.admin.from('ledger_orders').select('channel_ref').eq('order_name', name).eq('channel', 'myntra').maybeSingle();
      if (!data?.channel_ref) return { error: `Myntra invoice ${name} is not in the ledger yet: pass the Unicommerce order code` };
      code = String(data.channel_ref);
    }
    const shared = await sharedInputs(ctx);
    const [res] = await processMyntra(ctx, [code], shared, true);
    return res ? { ...res, entries: res.ledger.entries } : { error: `Myntra order ${code} not found, or not invoiced yet` };
  }
  const nodes = await shopifyOrders(ctx, `name:${name}`, 5);
  // Shopify's name search is loose ("37720" also finds "3-7720"): keep the exact order.
  const exact = nodes.nodes.filter(n => String(n.name).replace(/^#/, '') === name);
  if (!exact.length) return { error: `order ${name} not found on Shopify` };
  const [res] = await process(ctx, exact);
  return { ...res, entries: res.ledger.entries };
}

// What Shopify says about the customer's money on one order: used to find out whether a customer
// was given store credit (or a refund) by hand. Returns no names or contact details.
async function creditHistory(ctx: Ctx, name: string) {
  if (!name) return { error: 'order is required' };
  const res = await gql(ctx, `query CreditHistory($q: String!) {
    orders(first: 5, query: $q) { nodes {
      name displayFinancialStatus cancelledAt tags note createdAt
      totalPriceSet { shopMoney { amount } }
      refunds { createdAt totalRefundedSet { shopMoney { amount } } }
      events(first: 50, reverse: true) { nodes { message createdAt } }
      customer { id storeCreditAccounts(first: 5) { nodes { id balance { amount }
        transactions(first: 50, reverse: true) { nodes { __typename amount { amount } balanceAfterTransaction { amount } createdAt event } } } } }
    } }
  }`, { q: `name:${name}` });
  const o = (res.data.orders.nodes as any[]).find(n => String(n.name).replace(/^#/, '') === name);
  if (!o) return { error: `order ${name} not found on Shopify` };
  const relevant = /credit|refund|return|rto|cancel|payment|captured/i;   // timeline lines about money; notification lines name the customer, so they are left out
  return {
    order: name, financialStatus: o.displayFinancialStatus, cancelledAt: o.cancelledAt, createdAt: o.createdAt, tags: o.tags,
    note: o.note ? String(o.note).slice(0, 300) : null, total: o.totalPriceSet?.shopMoney?.amount,
    refunds: o.refunds.map((r: any) => ({ at: r.createdAt, amount: r.totalRefundedSet?.shopMoney?.amount })),
    customerFound: !!o.customer,
    accounts: (o.customer?.storeCreditAccounts?.nodes ?? []).map((a: any) => ({
      balance: a.balance?.amount,
      transactions: (a.transactions?.nodes ?? []).map((t: any) => ({ type: String(t.__typename).replace('StoreCreditAccount', ''), amount: t.amount?.amount, balanceAfter: t.balanceAfterTransaction?.amount, at: t.createdAt, event: t.event })),
    })),
    events: (o.events?.nodes ?? []).filter((e: any) => relevant.test(e.message) && !/email|@/i.test(e.message)).map((e: any) => ({ at: e.createdAt, message: String(e.message).replace(/<[^>]+>/g, '').slice(0, 200) })),
  };
}

// COD parcels from before the accounting start date that are not in the ledger (Shopify has not touched the
// order since), checked against Velocity: which were paid out on or after the start date (receipts that belong
// to October) and which were delivered and never paid out.
async function velocityGap(ctx: Ctx, body: any) {
  const cutoff = await setting(ctx.admin, 'accounting_start_date', '2026-10-01');
  const from = String(body.from ?? '2026-09-10');
  const today = istDate(Date.now());
  const found: Array<{ name: string; awb: string; cancelled: boolean; rto: boolean; id: number }> = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const res = await gql(ctx, `query Gap($q: String!, $after: String) {
      orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId name cancelledAt tags paymentGatewayNames fulfillments(first: 3) { trackingInfo { number } } }
      }
    }`, { q: `created_at:>=${from} updated_at:<${cutoff}`, after });
    for (const n of res.data.orders.nodes) {
      if (!/cash_on_delivery|ppcod/i.test((n.paymentGatewayNames ?? []).join(' '))) continue;
      const awb = (n.fulfillments ?? []).flatMap((f: any) => (f.trackingInfo ?? []).map((t: any) => String(t.number ?? ''))).find(Boolean);
      if (!awb) continue;
      found.push({ name: String(n.name).replace(/^#/, ''), awb, id: Number(n.legacyResourceId), cancelled: !!n.cancelledAt, rto: (n.tags ?? []).some((t: string) => /^rto_delivered$/i.test(t)) });
    }
    const conn = res.data.orders;
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const { data: known } = await ctx.admin.from('ledger_orders').select('order_name').in('order_name', found.map(f => f.name));
  const inLedger = new Set((known ?? []).map(r => String(r.order_name)));
  const todo = found.filter(f => !inLedger.has(f.name) && !f.rto && !f.cancelled);
  const v = (await velocityLookup(ctx, todo.map(f => f.awb))).recs;
  const rows = todo.map(f => ({ ...f, v: v.get(f.awb) }));
  const paidAfter = rows.filter(r => r.v?.utr_no && String(r.v.remittance_date) >= cutoff);
  const paidBefore = rows.filter(r => r.v?.utr_no && String(r.v.remittance_date) < cutoff);
  const unpaid = rows.filter(r => r.v?.delivery_date && !r.v?.utr_no);
  const undelivered = rows.filter(r => !r.v?.delivery_date);
  const sum = (xs: typeof rows) => Math.round(xs.reduce((a, r) => a + Number(r.v?.cod_amount ?? 0), 0) * 100) / 100;
  const age = (d: string) => Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000);
  return {
    cutoff, from, cod_orders_checked: todo.length, already_in_ledger: found.filter(f => inLedger.has(f.name)).length,
    paid_on_or_after_start: { orders: paidAfter.length, amount: sum(paidAfter), by_date: Object.fromEntries([...new Set(paidAfter.map(r => String(r.v!.remittance_date)))].sort().map(d => [d, { orders: paidAfter.filter(r => r.v!.remittance_date === d).length, amount: sum(paidAfter.filter(r => r.v!.remittance_date === d)) }])), list: paidAfter.map(r => ({ order: r.name, delivered: r.v!.delivery_date, remitted: r.v!.remittance_date, amount: r.v!.cod_amount, utr: r.v!.utr_no })) },
    paid_before_start: { orders: paidBefore.length, amount: sum(paidBefore) },
    delivered_never_paid: { orders: unpaid.length, amount: sum(unpaid), list: unpaid.map(r => ({ order: r.name, delivered: r.v!.delivery_date, days_ago: age(String(r.v!.delivery_date)), amount: r.v!.cod_amount, scheduled: r.v!.remittance_date })) },
    not_delivered: { orders: undelivered.length, amount: sum(undelivered) },
  };
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

// ── Storing the ledger ────────────────────────────────────────────────────────

const CHUNK = 40;                 // orders per Shopify query
const DEFAULT_BUDGET_S = 100;     // one call stays well inside the 150 s the platform allows

const budgetMs = (body: any) => Math.min(Math.max(Number(body?.budget_s ?? DEFAULT_BUDGET_S), 5), 110) * 1000;

async function latestRunning(ctx: Ctx) {
  const { data } = await ctx.admin.from('ledger_runs').select('*').eq('status', 'running').order('started_at', { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function sync(ctx: Ctx, body: any) {
  const running = await latestRunning(ctx);
  const run = running ?? await startRun(ctx, body.kind === 'incremental' ? 'incremental' : 'full');
  return advance(ctx, run, budgetMs(body));
}

async function tick(ctx: Ctx, body: any) {
  const mode = await setting(ctx.admin, 'ledger_sync_mode', 'off');
  if (mode !== 'live') return { mode, did: 'off' };
  const running = await latestRunning(ctx);
  const { data: done } = await ctx.admin.from('ledger_runs').select('kind, started_at').eq('status', 'done').order('started_at', { ascending: false }).limit(50);
  const at = (r?: { started_at: string }) => r ? Date.parse(r.started_at) : null;
  const did = decideTick(
    Date.now(),
    running ? { kind: running.kind, status: running.status, startedAt: Date.parse(running.started_at), updatedAt: Date.parse(running.updated_at) } : null,
    at(done?.[0]), at(done?.find(r => r.kind === 'full')),
  );
  if (did === 'busy' || did === 'wait') return { mode, did };
  const run = did === 'continue' ? running! : await startRun(ctx, did);
  return { mode, did, ...(await advance(ctx, run, budgetMs(body))) };
}

// The queue: every order updated since the start date (full) or since the last run (incremental),
// plus every order that is still open or needs attention, because those change without Shopify
// noticing (a parcel arrives, a courier delivers, Unicommerce issues an invoice).
async function startRun(ctx: Ctx, kind: 'full' | 'incremental') {
  const cutoff = await setting(ctx.admin, 'accounting_start_date', '2026-10-01');
  let since = cutoff;
  if (kind === 'incremental') {
    const { data } = await ctx.admin.from('ledger_runs').select('started_at').eq('status', 'done').order('started_at', { ascending: false }).limit(1);
    if (data?.[0]) { const d = istDate(Date.parse(data[0].started_at) - 2 * 86_400_000); since = d > cutoff ? d : cutoff; }
  }
  const ids = new Set<number>(await shopifyOrderIds(ctx, `updated_at:>=${since}`));
  const { data: open } = await ctx.admin.from('ledger_orders').select('order_id, channel, channel_ref').in('status', ['open', 'attention']);
  const myntra = new Set<string>();
  for (const r of open ?? []) {
    if (r.channel === 'myntra' && r.channel_ref) myntra.add(String(r.channel_ref));
    else if (r.order_id != null) ids.add(Number(r.order_id));
  }
  // Myntra orders: a full run reads every one since Myntra went live in Unicommerce; an incremental run those changed since the last run.
  const myntraFrom = await setting(ctx.admin, 'myntra_ledger_from', '2026-09-20');
  // A Unicommerce problem finding Myntra orders must not stop the Shopify orders: it is recorded on the run instead.
  let myntraError: string | null = null;
  try {
    for (const c of await myntraCodes(ctx, kind === 'full' || since < myntraFrom ? myntraFrom : since, kind === 'full' ? 'CREATED' : 'UPDATED')) myntra.add(c);
  } catch (err) { myntraError = err instanceof Error ? err.message : String(err); }
  const queue: Array<number | string> = [...ids, ...[...myntra].map(c => `M:${c}`)];
  const { data, error } = await ctx.admin.from('ledger_runs').insert({ kind, status: 'running', queue, total: queue.length, summary: { since, missing: [], held: [], ...(myntraError ? { myntra_error: myntraError.slice(0, 300) } : {}) } }).select('*').single();
  if (error) throw new Error(`could not start a run: ${error.message}`);
  return data;
}

async function advance(ctx: Ctx, run: any, budget: number) {
  const started = Date.now();
  const queue: Array<number | string> = run.queue ?? [];       // Shopify order ids, and "M:<code>" for Myntra orders
  const missing: number[] = run.summary?.missing ?? [];
  // Orders left as they were because Velocity could not be reached; the next run tries them again.
  const held: string[] = run.summary?.held ?? [];
  let pos: number = run.pos;
  try {
    const shared = await sharedInputs(ctx);
    while (pos < run.total && Date.now() - started < budget) {
      const chunk = queue.slice(pos, pos + CHUNK);
      const ids = chunk.filter((i): i is number => typeof i === 'number');
      const myntraChunk = chunk.filter((i): i is string => typeof i === 'string' && i.startsWith('M:')).map(i => i.slice(2));
      const rows: any[] = [];
      if (ids.length) {
        const page = await shopifyOrders(ctx, ids.map(i => `id:${i}`).join(' OR '), ids.length);
        const found = new Set(page.nodes.map(n => Number(n.legacyResourceId)));
        for (const i of ids) if (!found.has(i)) missing.push(i);
        const results = await process(ctx, page.nodes, shared);
        for (const r of results) if (r.held) held.push(r.order);
        rows.push(...results.filter(r => !r.held).map(r => ledgerRow(r, shared.cutoff)));
      }
      if (myntraChunk.length) rows.push(...(await processMyntra(ctx, myntraChunk, shared)).map(r => ledgerRow(r, shared.cutoff)));
      const { error } = rows.length ? await ctx.admin.rpc('ledger_save_orders', { p_orders: rows }) : { error: null };
      if (error) throw new Error(`saving the ledger: ${error.message}`);
      pos += chunk.length;
      await ctx.admin.from('ledger_runs').update({ pos, updated_at: new Date().toISOString(), summary: { ...run.summary, missing, held } }).eq('id', run.id);
    }
    const finished = pos >= run.total;
    if (finished) {
      const counts: Record<string, number> = {};
      for (const st of ['complete', 'open', 'attention', 'not_a_sale']) {
        const { count } = await ctx.admin.from('ledger_orders').select('order_name', { count: 'exact', head: true }).eq('status', st);
        counts[st] = count ?? 0;
      }
      await ctx.admin.from('ledger_runs').update({ status: 'done', finished_at: new Date().toISOString(), updated_at: new Date().toISOString(), summary: { ...run.summary, missing, held, orders: counts } }).eq('id', run.id);
    }
    return { run: run.id, kind: run.kind, finished, processed: pos, total: run.total, missing: missing.length, held: held.length, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.admin.from('ledger_runs').update({ status: 'failed', error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', run.id);
    throw err;
  }
}

async function shopifyOrderIds(ctx: Ctx, q: string): Promise<number[]> {
  const ids: number[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const res = await gql(ctx, `query LedgerIds($q: String!, $after: String) {
      orders(first: 250, after: $after, query: $q, sortKey: UPDATED_AT) { pageInfo { hasNextPage endCursor } nodes { legacyResourceId } }
    }`, { q, after });
    const conn = res.data.orders;
    for (const n of conn.nodes) ids.push(Number(n.legacyResourceId));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return ids;
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
  // Decisions a person made about an order (migration 018).
  const { data: adj } = await ctx.admin.from('ledger_adjustments').select('order_name, kind, amount, reason, approved_by');
  const adjustments = new Map<string, any[]>();
  for (const a of adj ?? []) adjustments.set(String(a.order_name), [...(adjustments.get(String(a.order_name)) ?? []), a]);
  // The transaction dates GoKwik's uploaded reports cover (an order paid inside that range but missing from it is a problem).
  const edge = async (asc: boolean) => (await ctx.admin.from('gokwik_payments').select('txn_date').order('txn_date', { ascending: asc }).limit(1)).data?.[0]?.txn_date as string | undefined;
  const [from, to] = [await edge(true), await edge(false)];
  const gatewayCoverage = from && to ? { from, to } : undefined;
  return { cutoff, sellerState, today, rp, reversalIds, adjustments, gatewayCoverage };
}

async function process(ctx: Ctx, orders: any[], shared?: Shared) {
  const { cutoff, sellerState, today, rp, reversalIds, adjustments, gatewayCoverage } = shared ?? await sharedInputs(ctx);
  const ids = orders.map(o => Number(o.legacyResourceId));
  // GoKwik's settlement report rows (amount, fee, GST, what reached the bank), by Shopify order number.
  const { data: gk } = await ctx.admin.from('gokwik_payments').select('order_name, payment_id, settlement_date, utr, amount, fee, tax, credit')
    .in('order_name', orders.map(o => String(o.name).replace(/^#/, '')));
  const payoutsBy = new Map<string, NonNullable<RawInputs['gatewayPayouts']>>();
  for (const r of gk ?? []) {
    const list = payoutsBy.get(String(r.order_name)) ?? [];
    list.push({ date: String(r.settlement_date), utr: String(r.utr), gross: Number(r.amount), fee: Number(r.fee), tax: Number(r.tax), net: Number(r.credit), ref: String(r.payment_id) });
    payoutsBy.set(String(r.order_name), list);
  }
  const { data: cod } = await ctx.admin.from('cod_deliveries').select('order_id, delivered_on, utr, remittance_date, cod_amount').in('order_id', ids);
  const codBy = new Map((cod ?? []).map(r => [Number(r.order_id), r]));

  // Unicommerce: the order, then its sale invoice and return invoices.
  const ucBy = new Map<number, RawInputs['uc']>();
  for (const o of orders) ucBy.set(Number(o.legacyResourceId), await unicommerce(ctx, Number(o.legacyResourceId)));

  // Velocity's view of every COD parcel that has not been paid out yet: when it was delivered and whether the
  // money has been remitted (UTR). Parcels already paid out are known from cod_deliveries.
  const awbOf = (o: any) => (o.fulfillments ?? []).flatMap((f: any) => (f.trackingInfo ?? []).map((t: any) => String(t.number ?? ''))).find(Boolean) as string | undefined;
  const needVelocity = orders.filter(o => !codBy.get(Number(o.legacyResourceId))?.utr
    && !(o.tags ?? []).some((t: string) => /^rto_delivered$/i.test(t))
    && /cash_on_delivery|ppcod/i.test((o.paymentGatewayNames ?? []).join(' ')));
  const velocity = await velocityLookup(ctx, needVelocity.map(awbOf).filter(Boolean) as string[]);

  const out: Array<{ order: string; orderId: number; facts: any; notes: string[]; skip?: string; held?: boolean; ledger: ReturnType<typeof buildOrderLedger> }> = [];
  for (const o of orders) {
    const id = Number(o.legacyResourceId);
    const awb = awbOf(o);
    const row = codBy.get(id);
    const v = awb ? velocity.recs.get(awb) : undefined;
    const held = !!awb && velocity.unreachable.has(awb);
    // The money the courier paid out: from the delivery row when it has recorded the UTR, else Velocity's answer.
    const remittance = row?.utr
      ? { utr: String(row.utr), date: String(row.remittance_date ?? row.delivered_on ?? ''), amount: row.cod_amount != null ? Number(row.cod_amount) : null }
      : v?.utr_no ? { utr: String(v.utr_no), date: String(v.remittance_date ?? ''), amount: v.cod_amount != null ? Number(v.cod_amount) : null } : null;
    const built = buildFacts({
      sellerState, today, shopify: o, uc: ucBy.get(id) ?? null,
      rpRequests: rp.get(String(o.name).replace(/^#/, '')) ?? [], reversalIds,
      adjustments: adjustments.get(String(o.name).replace(/^#/, '')) ?? [],
      codDeliveredOn: (row?.delivered_on as string | null) ?? null,
      velocityDeliveredOn: v?.delivery_date ?? null,
      remittance: remittance && remittance.date ? remittance : null,
      gatewayPayouts: payoutsBy.get(String(o.name).replace(/^#/, '')) ?? [],
    });
    if (held) built.notes.push("Velocity could not be reached: this parcel's delivery and payout are unknown, so the order is not saved");
    out.push({ order: built.facts.order, orderId: id, facts: built.facts, notes: built.notes, skip: built.skip, held, ledger: buildOrderLedger(built.facts, { cutoff, today, gatewayCoverage }) });
  }
  return out;
}

// ── Myntra (Unicommerce channel MYNTRAPPMP) ───────────────────────────────────────────────────

// The Unicommerce codes of Myntra orders created (or, for an incremental run, changed) since a date. Unicommerce's order
// search takes at most 31 days at a time, and pages of 500.
async function myntraCodes(ctx: Ctx, fromDate: string, dateType: 'CREATED' | 'UPDATED'): Promise<string[]> {
  const out = new Set<string>();
  const end = Date.now();
  const WINDOW = 30 * 86_400_000;
  for (let start = Date.parse(`${fromDate}T00:00:00+05:30`); start < end; start += WINDOW) {
    const to = Math.min(start + WINDOW, end);
    for (let displayStart = 0; ; displayStart += 500) {
      const r = await ucPost(ctx.admin, '/services/rest/v1/oms/saleOrder/search', {
        channel: 'MYNTRAPPMP', dateType, fromDate: new Date(start).toISOString(), toDate: new Date(to).toISOString(),
        searchOptions: { displayLength: 500, displayStart },
      });
      if (!r?.successful) throw new Error(`Unicommerce Myntra order search failed: ${ucErrorText(r)}`);
      for (const e of r.elements ?? []) out.add(String(e.code));
      if ((r.elements ?? []).length < 500) break;
    }
  }
  return [...out];
}

// Myntra orders → ledger results. An order Unicommerce has not invoiced yet is left out (it is not a sale yet).
// With `keepAll` (the single-order action) a result is returned even for a skipped order.
async function processMyntra(ctx: Ctx, codes: string[], shared: Shared, keepAll = false) {
  const out: Array<{ order: string; orderId: number | null; facts: any; notes: string[]; skip?: string; ledger: ReturnType<typeof buildOrderLedger> }> = [];
  for (const code of codes) {
    const uc = await unicommerce(ctx, code);
    if (!uc?.order) continue;
    const built = buildMyntraFacts({ today: shared.today, bookFrom: shared.cutoff, uc });
    if (built.ignore && !keepAll) continue;
    out.push({ order: built.facts.order || code, orderId: null, facts: built.facts, notes: built.notes, skip: built.skip ?? built.ignore, ledger: buildOrderLedger(built.facts, { cutoff: shared.cutoff, today: shared.today }) });
  }
  return out;
}

async function shopifyOrders(ctx: Ctx, q: string, first: number, after: string | null = null) {
  const res = await gql(ctx, `query LedgerOrders($q: String!, $first: Int!, $after: String) {
    orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { id legacyResourceId name createdAt cancelledAt tags note paymentGatewayNames
        subtotalPriceSet { shopMoney { amount } } totalShippingPriceSet { shopMoney { amount } } shippingAddress { provinceCode }
        transactions(first: 20) { id kind status gateway amountSet { shopMoney { amount } } processedAt }
        lineItems(first: 10) { nodes { quantity } }
        refunds { createdAt refundLineItems(first: 10) { nodes { quantity subtotalSet { shopMoney { amount } } } }
          transactions(first: 5) { nodes { kind gateway amountSet { shopMoney { amount } } } } }
        fulfillments(first: 3) { trackingInfo { number } }
        customer { id storeCreditAccounts(first: 1) { nodes { id transactions(first: 50, reverse: true) { nodes { __typename ... on Node { id } amount { amount } createdAt } } } } } }
    }
  }`, { q, first, after });
  const conn = res.data.orders;
  return { nodes: conn.nodes as any[], hasNext: !!conn.pageInfo.hasNextPage, cursor: conn.pageInfo.endCursor as string | null };
}

async function unicommerce(ctx: Ctx, orderId: number | string): Promise<RawInputs['uc']> {
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

// Velocity's COD remittance API: delivery date, COD amount, and the remittance (UTR set once paid), by AWB.
// 100 parcels a call, 5 calls a minute, so calls are spaced 13 s apart even across separate lookups.
// `unreachable` holds the parcels whose answer could not be had (Velocity down, rate-limited, no token): an order on
// one of them must not be rewritten with "no delivery, no payout", which a silent skip used to do.
type VelocityRec = { delivery_date: string | null; cod_amount: number | null; remittance_date: string | null; utr_no: string | null };
let lastVelocityCall = 0;
async function velocityLookup(ctx: Ctx, awbs: string[]): Promise<{ recs: Map<string, VelocityRec>; unreachable: Set<string> }> {
  const recs = new Map<string, VelocityRec>();
  const unreachable = new Set<string>();
  const list = [...new Set(awbs)];
  if (!list.length) return { recs, unreachable };
  const token = (await secrets(ctx.admin, ['velocity_api_token'])).velocity_api_token;
  if (!token) return { recs, unreachable: new Set(list) };
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    const ask = () => fetch(VELOCITY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ awbs: batch }) });
    const wait = 13_000 - (Date.now() - lastVelocityCall);
    if (wait > 0) await sleep(wait);
    lastVelocityCall = Date.now();
    let res = await ask();
    if (res.status === 429) {
      await sleep(30_000); lastVelocityCall = Date.now();
      res = await ask();
    }
    const body = res.ok ? await res.json().catch(() => null) : null;
    if (!body) { for (const a of batch) unreachable.add(a); continue; }
    for (const r of body.data ?? []) recs.set(String(r.tracking_number), { delivery_date: r.delivery_date ?? null, cod_amount: r.cod_amount ?? null, remittance_date: r.remittance_date ?? null, utr_no: r.utr_no ?? null });
  }
  return { recs, unreachable };
}
