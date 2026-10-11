// cod-paid-on-delivery v1
// Marks COD / PPCOD orders paid on Shopify when Velocity reports the parcel
// delivered, and follows each one to its COD remittance.
//
// Why on delivery, not on remittance: the customer pays the courier at the door.
// Until the order shows paid, Return Prime can't record a refund on it — it
// credits store credit by hand and Shopify never shows the return (9 of 15 COD
// returns in Sep–Oct 2026). Velocity's own mark-paid only runs at remittance,
// days later, and skips COD orders that also used store credit. The money still
// reaches the bank later: the remittance (UTR) is recorded on the same row.
//
// Rules (supabase/functions/_shared/cod-paid.ts, tested):
//   - delivered on or after app_settings.accounting_start_date (2026-10-01) only;
//     earlier deliveries are 'baseline' rows, left to Velocity at remittance
//   - the delivery date must come from Velocity (cod-remittance API), not a guess;
//     its remittance_date is only a schedule, a UTR means the money was paid
//   - never RTO orders, cancelled, already paid or prepaid orders
//   - Velocity's COD amount must equal what Shopify shows outstanding, else the
//     row is 'attention' and nothing is marked
//   - Shopify's orderMarkAsPaid refuses an order that is already paid, so this
//     and Velocity's own automation cannot both record the payment
//
// Dry mode: until app_settings.cod_paid_mode is "live" the job only writes
// 'would_mark' rows saying what it would do. A dry admin sweep writes nothing.
// app_settings.cod_paid_limit caps how many orders one run marks (default 100);
// set it to 1 for the first live run, check that order, then raise it. Orders
// over the cap simply wait for the next run.
//
// Schedule: every 15 minutes (pg_cron, migration 016, header x-cron-key matching
// private_secrets.erp_stock_cron_key). Velocity allows 5 calls a minute, 100
// parcels each, so lookups are spaced.
//
// Admin actions (POST { action } with an admin user's JWT):
//   status  — mode, start date, limit, counts per status, recent attention/failed rows
//   sweep   — { dry?: true } run the job now; dry (default) only reports
//   order   — { order: "37858", dry?: true } the same for one order

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { decideMark, type OrderForPaid, type PaidDecision, type VelocityRow } from '../_shared/cod-paid.ts';
import { CORS, type Ctx, cronKeyValid, gql, json, loadCtx, requireAdmin, secrets, setting, sleep } from '../_shared/shopify-admin.ts';

const VELOCITY_URL = 'https://shazam.velocity.in/custom/api/v1/cod-remittance';
const LOOKBACK_DAYS = 60;     // a September order can be delivered in October
const OVERDUE_DAYS = 10;      // delivered this long ago, no UTR yet: a courier or cash problem
const MAX_PAGES = 5;
const STALE_CLAIM_MS = 15 * 60_000;
const RETRY_FAILED_MS = 60 * 60_000;

type CodOrder = OrderForPaid & { id: number; gid: string };
type Known = { status: string; updated_at: string };

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
      return json(await sweep(await loadCtx(admin), { record: true }));
    }
    const denied = await requireAdmin(admin, req);
    if (denied) return denied;
    const body = raw ? JSON.parse(raw) : {};
    const ctx = await loadCtx(admin);
    switch (body.action) {
      case 'status': return json(await status(ctx));
      case 'sweep':  return json(await sweep(ctx, { record: body.dry === false }));
      case 'order':  return json(await sweep(ctx, { record: body.dry === false, only: String(body.order ?? '').replace(/^#/, '') }));
      default:       return json({ error: 'action must be status, sweep or order' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── The job ───────────────────────────────────────────────────────────────────

async function sweep(ctx: Ctx, opts: { record: boolean; only?: string }) {
  const startDate = await setting(ctx.admin, 'accounting_start_date', '2026-10-01');
  const mode = await setting(ctx.admin, 'cod_paid_mode', 'dry');
  const live = opts.record && mode === 'live';
  let budget = Math.max(0, Number(await setting(ctx.admin, 'cod_paid_limit', '100')) || 0);
  const velocityToken = (await secrets(ctx.admin, ['velocity_api_token'])).velocity_api_token;
  if (!velocityToken) throw new Error('velocity_api_token is missing from private_secrets');

  const orders = await unpaidCodOrders(ctx, startDate, opts.only);
  const known = await knownRows(ctx, orders.map(o => o.id));
  const todo = orders.filter(o => opts.only || retryable(known.get(o.id)));

  // One Velocity lookup covers new orders and the marked ones still waiting for a UTR.
  const { data: awaiting } = await ctx.admin.from('cod_deliveries')
    .select('order_id, order_name, awb, delivered_on').eq('status', 'marked').is('utr', null).not('awb', 'is', null);
  const rows = await velocity(velocityToken, [
    ...todo.flatMap(o => o.awbs), ...(awaiting ?? []).map(r => r.awb as string),
  ]);

  const out = {
    mode, live, record: opts.record, start_date: startDate, checked: todo.length,
    marked: [] as string[],
    would_mark: [] as Array<{ order: string; awb: string; delivered_on: string; amount: number }>,
    attention: [] as Array<{ order: string; reason: string }>,
    failed: [] as Array<{ order: string; reason: string }>,
    baseline: 0, waiting: 0, deferred: 0, limit: budget, skipped: {} as Record<string, number>,
    remittances_recorded: 0, overdue_remittance: [] as Array<{ order: string; delivered_on: string }>,
  };

  for (const o of todo) {
    const d = decideMark(o, rows.get(o.awbs[0] ?? ''), startDate);
    if (d.action === 'mark' && live) {
      if (budget <= 0) { out.deferred++; continue; }   // over cod_paid_limit: next run
      budget--;
    }
    await act(ctx, o, d, { live, record: opts.record }, out);
  }

  // Follow marked orders to their remittance.
  const today = Date.now();
  for (const r of awaiting ?? []) {
    const v = rows.get(r.awb as string);
    if (v?.utr_no) {
      out.remittances_recorded++;
      if (opts.record) {
        await ctx.admin.from('cod_deliveries').update({
          utr: v.utr_no, remittance_date: v.remittance_date, updated_at: new Date().toISOString(),
        }).eq('order_id', r.order_id);
      }
    } else if (r.delivered_on && today - Date.parse(r.delivered_on as string) > OVERDUE_DAYS * 86_400_000) {
      out.overdue_remittance.push({ order: r.order_name as string, delivered_on: r.delivered_on as string });
    }
  }
  if (out.attention.length || out.failed.length || out.overdue_remittance.length) console.warn('[cod-paid]', JSON.stringify(out));
  return out;
}

type Out = {
  marked: string[]; would_mark: Array<{ order: string; awb: string; delivered_on: string; amount: number }>;
  attention: Array<{ order: string; reason: string }>; failed: Array<{ order: string; reason: string }>;
  baseline: number; waiting: number; skipped: Record<string, number>;
};

async function act(ctx: Ctx, o: CodOrder, d: PaidDecision, mode: { live: boolean; record: boolean }, out: Out) {
  const now = new Date().toISOString();
  const base = { order_id: o.id, order_name: o.name, updated_at: now };
  switch (d.action) {
    case 'wait': out.waiting++; return;
    case 'skip': out.skipped[d.reason] = (out.skipped[d.reason] ?? 0) + 1; return;
    case 'baseline':
      out.baseline++;
      if (mode.record) await ctx.admin.from('cod_deliveries').upsert({ ...base, awb: d.awb, status: 'baseline', delivered_on: d.deliveredOn, detail: d.reason }, { onConflict: 'order_id' });
      return;
    case 'attention':
      out.attention.push({ order: o.name, reason: d.reason });
      if (mode.record) await ctx.admin.from('cod_deliveries').upsert({
        ...base, awb: d.awb ?? o.awbs[0] ?? null, status: 'attention', delivered_on: d.deliveredOn ?? null,
        cod_amount: d.codAmount ?? null, outstanding: o.outstanding, detail: d.reason,
      }, { onConflict: 'order_id' });
      return;
    case 'mark': {
      const row = { ...base, awb: d.awb, delivered_on: d.deliveredOn, cod_amount: d.codAmount, outstanding: o.outstanding };
      if (!mode.live) {
        out.would_mark.push({ order: o.name, awb: d.awb, delivered_on: d.deliveredOn, amount: d.codAmount });
        if (mode.record) await ctx.admin.from('cod_deliveries').upsert({ ...row, status: 'would_mark', detail: 'dry mode' }, { onConflict: 'order_id' });
        return;
      }
      const result = await markPaid(ctx, o, d, row);
      if (result.ok) out.marked.push(o.name); else out.failed.push({ order: o.name, reason: result.reason });
      return;
    }
  }
}

// Claim the order (exactly once), re-check it on Shopify, then record the payment.
async function markPaid(ctx: Ctx, o: CodOrder, d: Extract<PaidDecision, { action: 'mark' }>, row: Record<string, unknown>) {
  const stale = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const retryFailed = new Date(Date.now() - RETRY_FAILED_MS).toISOString();
  await ctx.admin.from('cod_deliveries').upsert({ ...row, status: 'would_mark' }, { onConflict: 'order_id', ignoreDuplicates: true });
  const { data: claimed } = await ctx.admin.from('cod_deliveries')
    .update({ status: 'marking', updated_at: new Date().toISOString() })
    .eq('order_id', o.id)
    .or(`status.in.(would_mark,attention),and(status.eq.failed,updated_at.lt.${retryFailed}),and(status.eq.marking,updated_at.lt.${stale})`)
    .select('order_id');
  if (!claimed?.length) return { ok: false, reason: 'already being handled' };

  const fail = async (reason: string) => {
    await ctx.admin.from('cod_deliveries').update({ status: 'failed', detail: reason, updated_at: new Date().toISOString() }).eq('order_id', o.id);
    return { ok: false, reason };
  };
  try {
    // Look at the order again right before paying it: Velocity's own automation,
    // a return or a person may have changed it since the sweep read it.
    const fresh = (await unpaidCodOrders(ctx, '1900-01-01', o.name))[0];
    if (!fresh) return fail('order not found on Shopify');
    const again = decideMark(fresh, { tracking_number: d.awb, delivery_date: d.deliveredOn, cod_amount: d.codAmount, remittance_date: null, utr_no: null }, '0000-00-00');
    if (again.action === 'skip' && again.reason.startsWith('already ')) {
      await ctx.admin.from('cod_deliveries').update({ status: 'marked', detail: `Shopify already showed it ${again.reason.slice(8)} before the ERP marked it`, updated_at: new Date().toISOString() }).eq('order_id', o.id);
      return { ok: true, reason: again.reason };
    }
    if (again.action !== 'mark') return fail(`changed on Shopify before marking: ${'reason' in again ? again.reason : again.action}`);

    const res = await gql(ctx, `mutation MarkPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { field message } }
    }`, { input: { id: o.gid } });
    const errs = res.data?.orderMarkAsPaid?.userErrors ?? [];
    if (errs.length) return fail(errs.map((e: { message: string }) => e.message).join('; '));
    await ctx.admin.from('cod_deliveries').update({
      status: 'marked', marked_at: new Date().toISOString(), detail: `delivered ${d.deliveredOn}, ${d.codAmount.toFixed(2)} marked paid`,
      updated_at: new Date().toISOString(),
    }).eq('order_id', o.id);
    return { ok: true, reason: 'marked' };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────

async function unpaidCodOrders(ctx: Ctx, startDate: string, only?: string): Promise<CodOrder[]> {
  const from = new Date(Date.parse(startDate) - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const q = only
    ? `name:${only}`
    : `created_at:>=${from} AND (gateway:cash_on_delivery OR gateway:'Gokwik PPCOD') AND fulfillment_status:fulfilled AND (financial_status:pending OR financial_status:partially_paid)`;
  const nodes: CodOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await gql(ctx, `query Unpaid($q: String!, $after: String) {
      orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes { id legacyResourceId name tags cancelledAt displayFinancialStatus paymentGatewayNames
          totalOutstandingSet { shopMoney { amount } } fulfillments(first: 3) { trackingInfo { number } } }
      }
    }`, { q, after });
    for (const n of res.data.orders.nodes) {
      nodes.push({
        id: Number(n.legacyResourceId), gid: n.id, name: String(n.name).replace(/^#/, ''), tags: n.tags ?? [],
        cancelled: !!n.cancelledAt, financialStatus: n.displayFinancialStatus, gateways: n.paymentGatewayNames ?? [],
        outstanding: Number(n.totalOutstandingSet?.shopMoney?.amount ?? 0),
        awbs: [...new Set<string>((n.fulfillments ?? []).flatMap((f: any) => (f.trackingInfo ?? []).map((t: any) => String(t.number ?? '')).filter(Boolean)))],
      });
    }
    if (!res.data.orders.pageInfo.hasNextPage) break;
    after = res.data.orders.pageInfo.endCursor;
  }
  return nodes;
}

async function knownRows(ctx: Ctx, ids: number[]): Promise<Map<number, Known>> {
  const map = new Map<number, Known>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await ctx.admin.from('cod_deliveries').select('order_id, status, updated_at').in('order_id', ids.slice(i, i + 200));
    for (const r of data ?? []) map.set(Number(r.order_id), { status: r.status as string, updated_at: r.updated_at as string });
  }
  return map;
}

// Rows the job is finished with are not looked at again; claims that never
// finished and old failures are retried.
function retryable(k: Known | undefined): boolean {
  if (!k) return true;
  const age = Date.now() - Date.parse(k.updated_at);
  switch (k.status) {
    case 'marked': case 'baseline': return false;
    case 'marking': return age > STALE_CLAIM_MS;
    case 'failed': return age > RETRY_FAILED_MS;
    default: return true;   // would_mark, attention: look again
  }
}

// Velocity COD remittance lookup: 100 parcels a call, 5 calls a minute.
async function velocity(token: string, awbs: string[]): Promise<Map<string, VelocityRow>> {
  const out = new Map<string, VelocityRow>();
  const list = [...new Set(awbs.filter(Boolean))];
  for (let i = 0; i < list.length; i += 100) {
    if (i) await sleep(13_000);
    let res = await call(token, list.slice(i, i + 100));
    if (res.status === 429) { await sleep(30_000); res = await call(token, list.slice(i, i + 100)); }
    if (!res.ok) throw new Error(`Velocity ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const r of body.data ?? []) out.set(String(r.tracking_number), r as VelocityRow);
  }
  return out;
}

const call = (token: string, awbs: string[]) => fetch(VELOCITY_URL, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ awbs }),
});

async function status(ctx: Ctx) {
  const { data } = await ctx.admin.from('cod_deliveries').select('status');
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.status as string] = (counts[r.status as string] ?? 0) + 1;
  const { data: needs } = await ctx.admin.from('cod_deliveries').select('order_name, status, detail, updated_at')
    .in('status', ['attention', 'failed']).order('updated_at', { ascending: false }).limit(20);
  return {
    mode: await setting(ctx.admin, 'cod_paid_mode', 'dry'),
    limit_per_run: await setting(ctx.admin, 'cod_paid_limit', '100'),
    accounting_start_date: await setting(ctx.admin, 'accounting_start_date', '2026-10-01'),
    counts, needs_attention: needs ?? [],
  };
}
