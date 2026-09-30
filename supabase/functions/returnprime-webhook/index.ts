// returnprime-webhook v1
// Puts Return Prime returns back into Unicommerce stock once the return parcel
// is back at the warehouse: courier status "Returned to warehouse", which is
// also when Return Prime marks the request "received".
//
// Triggers: Return Prime's request/received webhook (fast path), and a
// scheduled sweep every 15 minutes (pg_cron, header x-cron-key matching
// private_secrets.erp_stock_cron_key) as backup for missed webhooks. Return
// Prime doesn't sign webhooks, so the URL carries a key derived from
// RETURN_PRIME_TOKEN and every event is re-read from Return Prime's API before
// anything changes — a forged call can at most make the ERP look at a real
// request's real state.
//
// Per returned item, exactly once (returnprime_restocks, migration 005):
//   • request rejected                       → skipped, needs a person
//   • refunded before the switch → skipped: the old flow already put it back
//     into stock at refund time (also checked against its return_restocks log)
//   • order open in Unicommerce, or shipped before the opening stock load → ADD
//   • otherwise → skipped: Unicommerce never took this piece
//
// Admin actions (POST { action } with an admin user's JWT):
//   status   — Return Prime webhook subscriptions and ledger counts
//   dry_run  — { request: "RET710" } shows what would happen, changing nothing
//   process  — { request: "RET511" } handles that one return now (same rules, exactly once)
//   sweep    — { dry?: true, pages?: 10, include_waiting? } process (or preview) recent returns
//   register — baseline every return already back at the warehouse, then
//              subscribe request/received to this function

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, getSaleOrder } from '../_shared/unicommerce.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const RP_API = 'https://api.returnprime.co';
const FN_URL = 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/returnprime-webhook';
const SHOPIFY_API_VERSION = '2026-04';
const BACK_AT_WAREHOUSE = 'returned to warehouse';
// Shopify snapshot behind the opening Unicommerce stock load (29 Sep 2026, 22:37:59 IST).
const STOCK_LOAD_CUTOFF = Date.parse('2026-09-29T17:07:59Z');
// Until shopify-return-webhook v18 (deployed 29 Sep 2026 23:41 UTC) the ERP put
// Return Prime returns back into stock at refund time.
const REFUND_RESTOCK_CUTOFF = '2026-09-29T23:41:24Z';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Ctx = { admin: SupabaseClient; rpToken: string; shop: string; shopToken: string };
type LinePlan = {
  line_item_id: number; sku: string; qty: number;
  action: 'add' | 'skip' | 'wait'; why: string;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const rpToken = Deno.env.get('RETURN_PRIME_TOKEN') ?? '';
  const url = new URL(req.url);
  const raw = await req.text();

  try {
    const { data: secrets } = await admin
      .from('private_secrets').select('key, value').in('key', ['shopify_access_token', 'shopify_shop_domain']);
    const secret = (k: string) => secrets?.find(s => s.key === k)?.value as string | undefined;
    const ctx: Ctx = {
      admin, rpToken,
      shop: secret('shopify_shop_domain') || 'supply-rethought.myshopify.com',
      shopToken: secret('shopify_access_token') ?? '',
    };
    if (!rpToken) return json({ error: 'RETURN_PRIME_TOKEN not set' }, 500);

    // ── Scheduled backup sweep ──────────────────────────────────────────────
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
      const result = await sweep(ctx, { dry: false, pages: 5 });
      return json({ swept: result.requests });
    }

    // ── Return Prime webhook ──────────────────────────────────────────────────
    if (url.searchParams.has('key')) {
      if (url.searchParams.get('key') !== await webhookKey(rpToken)) return json({ error: 'bad key' }, 401);
      const body = raw ? JSON.parse(raw) : {};
      const id = body?.id ?? body?.data?.id ?? body?.request?.id ?? body?.data?.request?.id;
      const work = (id ? processRequestId(ctx, String(id)) : sweep(ctx, { dry: false, pages: 3 }))
        .catch(err => console.error('[returnprime]', id ?? 'sweep', err instanceof Error ? err.message : err));
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else await work;
      return json({ ok: true });
    }

    // ── Admin actions ─────────────────────────────────────────────────────────
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Forbidden: admin only' }, 403);

    const body = raw ? JSON.parse(raw) : {};
    switch (body.action) {
      case 'status':   return json(await status(ctx));
      case 'dry_run':  return json(await dryRun(ctx, String(body.request ?? '')));
      case 'process':  return json(await processOne(ctx, String(body.request ?? '')));
      case 'sweep':    return json(await sweep(ctx, { dry: body.dry !== false, pages: Number(body.pages ?? 10), includeWaiting: !!body.include_waiting }));
      case 'register': return json(await register(ctx));
      default:         return json({ error: 'action must be status, dry_run, process, sweep or register' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Return Prime API ──────────────────────────────────────────────────────────

async function rp(ctx: Ctx, path: string, init?: RequestInit) {
  const res = await fetch(`${RP_API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-rp-token': ctx.rpToken, ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.status === false) throw new Error(`Return Prime ${res.status}: ${body?.message ?? 'request failed'}`);
  return body.data;
}

const getRequest = async (ctx: Ctx, id: string) => (await rp(ctx, `/return-exchange/v2/${id}`))?.request;
const listPage = async (ctx: Ctx, page: number) => rp(ctx, `/return-exchange/v2?page=${page}`);

async function webhookKey(token: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('returnprime-webhook')));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ── Planning (read-only) ──────────────────────────────────────────────────────

// When the item was known to be back: the "received" time, else the courier's last update.
const arrivedAt = (r: any, li: any) =>
  Date.parse(r.received?.created_at ?? (li.shipping ?? [])[0]?.tracking_updated_at ?? '') || 0;

// Until the switch the ERP put a return back into stock the moment it was refunded.
const refundedBeforeSwitch = (li: any) =>
  li.refund?.status === 'refunded' && Date.parse(li.refund?.refunded_at ?? '') < Date.parse(REFUND_RESTOCK_CUTOFF);

const backAtWarehouse = (r: any, li: any) =>
  r.received?.status === true ||
  (li.shipping ?? []).some((s: any) => String(s.shipment_status ?? '').toLowerCase() === BACK_AT_WAREHOUSE);

async function planRequest(ctx: Ctx, r: any): Promise<LinePlan[]> {
  const lines = (r.line_items ?? []).filter((li: any) => li.original_product?.sku && li.id);
  const qtyOf = (li: any) => Number(li.shop_price?.return_quantity ?? li.quantity ?? 0);
  if (!lines.some((li: any) => backAtWarehouse(r, li))) {
    return lines.map((li: any) => ({
      line_item_id: li.id, sku: li.original_product.sku, qty: qtyOf(li), action: 'wait',
      why: `not back yet (${(li.shipping ?? [])[0]?.shipment_status ?? 'no shipment'})` +
        (refundedBeforeSwitch(li) ? ' — already counted when refunded before the switch; will be skipped on arrival' : ''),
    }));
  }

  const orderId = r.order?.id;
  const [uc, oldRestocks] = await Promise.all([
    getSaleOrder(ctx.admin, String(orderId)),
    ctx.admin.from('return_restocks').select('line_items')
      .eq('shopify_order_id', String(orderId)).lt('processed_at', REFUND_RESTOCK_CUTOFF),
  ]);
  const ucOpen = !!uc && uc.status !== 'CANCELLED';
  const restockedAtRefund = new Set(
    (oldRestocks.data ?? []).flatMap((row: any) => (row.line_items ?? []).map((i: any) => i.sku)),
  );
  // Shipping date only matters when neither of the above decides it.
  let shippedBeforeLoad = false;
  const alreadyCounted = (li: any) => refundedBeforeSwitch(li) || restockedAtRefund.has(li.original_product.sku);
  const undecided = lines.some((li: any) => backAtWarehouse(r, li) && !r.rejected?.status && !alreadyCounted(li));
  if (undecided && !ucOpen) {
    const shopOrder = await shopify(ctx, `orders/${orderId}.json?fields=id,fulfillments`);
    const firstShipped = Math.min(
      ...(shopOrder.order?.fulfillments ?? []).map((f: any) => Date.parse(f.created_at)).filter(Number.isFinite),
    );
    shippedBeforeLoad = firstShipped < STOCK_LOAD_CUTOFF;
  }

  return lines.map((li: any) => {
    const sku = li.original_product.sku;
    const base = { line_item_id: li.id, sku, qty: qtyOf(li) };
    if (!backAtWarehouse(r, li)) return { ...base, action: 'wait', why: 'not back yet' };
    if (r.rejected?.status) return { ...base, action: 'skip', why: 'request rejected in Return Prime — check the piece by hand' };
    if (alreadyCounted(li)) return { ...base, action: 'skip', why: 'already put back at refund time, before the switch' };
    if (ucOpen) return { ...base, action: 'add', why: 'back at warehouse; order open in Unicommerce' };
    if (shippedBeforeLoad) return { ...base, action: 'add', why: 'back at warehouse; shipped before the opening stock load' };
    return { ...base, action: 'skip', why: uc
      ? 'order is cancelled in Unicommerce, so its piece was already released'
      : 'order never reached Unicommerce, so Unicommerce never took this piece' };
  });
}

// ── Applying ──────────────────────────────────────────────────────────────────

async function processRequestId(ctx: Ctx, id: string) {
  const r = await getRequest(ctx, id);
  if (r) await processRequest(ctx, r);
}

async function processRequest(ctx: Ctx, r: any) {
  const plans = await planRequest(ctx, r);
  const results = [];
  for (const l of plans) {
    if (l.action === 'wait') { results.push({ ...l, result: 'waiting' }); continue; }
    // Exactly-once claim for this returned item (ON CONFLICT DO NOTHING).
    const { data: claimed, error } = await ctx.admin.from('returnprime_restocks').upsert({
      request_id: r.id, line_item_id: l.line_item_id, request_number: r.request_number,
      order_id: r.order?.id, order_name: r.order?.name, sku: l.sku, qty: l.qty,
      status: 'claimed', detail: l.why,
    }, { onConflict: 'request_id,line_item_id', ignoreDuplicates: true }).select('request_id');
    if (error) throw error;
    if (!claimed?.length) { results.push({ ...l, result: 'already handled' }); continue; }

    let status: 'restocked' | 'skipped' | 'failed' = 'skipped';
    let detail = l.why;
    if (l.action === 'add') {
      let err: string | null;
      try {
        err = await adjustStock(ctx.admin, l.sku, l.qty, 'ADD', `Return Prime ${r.request_number} back at warehouse`);
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      status = err ? 'failed' : 'restocked';
      if (err) detail = err;
    }
    await ctx.admin.from('returnprime_restocks')
      .update({ status, detail, updated_at: new Date().toISOString() })
      .eq('request_id', r.id).eq('line_item_id', l.line_item_id);
    results.push({ ...l, result: status });
  }
  return results;
}

// ── Admin actions ─────────────────────────────────────────────────────────────

async function sweep(ctx: Ctx, { dry, pages, includeWaiting = false }: { dry: boolean; pages: number; includeWaiting?: boolean }) {
  const { data: done } = await ctx.admin.from('returnprime_restocks').select('request_id, line_item_id, status');
  const handled = new Map((done ?? []).map(d => [`${d.request_id}:${d.line_item_id}`, d.status]));
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const data = await listPage(ctx, page);
    for (const r of data?.list ?? []) {
      const open = (r.line_items ?? []).filter((li: any) => li.id && !handled.has(`${r.id}:${li.id}`));
      if (!open.length || (!open.some((li: any) => backAtWarehouse(r, li)) && !(dry && includeWaiting))) continue;
      const lines = dry ? await planRequest(ctx, r) : await processRequest(ctx, r);
      out.push({ request: r.request_number, lines });
    }
    if (!data?.hasNextPage) break;
  }
  return { dry, requests: out.length, results: out };
}

async function findRequest(ctx: Ctx, ref: string) {
  const want = ref.toUpperCase();
  for (let page = 1; page <= 100; page++) {
    const data = await listPage(ctx, page);
    const r = (data?.list ?? []).find((x: any) => x.request_number === want || x.id === ref);
    if (r) return r;
    if (!data?.hasNextPage) break;
  }
  return null;
}

async function dryRun(ctx: Ctx, ref: string) {
  const r = await findRequest(ctx, ref);
  if (!r) return { error: `request ${ref} not found` };
  const { data: done } = await ctx.admin.from('returnprime_restocks')
    .select('line_item_id, status').eq('request_id', r.id);
  const lines = await planRequest(ctx, r);
  return { dry_run: true, request: r.request_number, stage: r.status,
    lines: lines.map(l => ({ ...l, already: done?.find(d => d.line_item_id === l.line_item_id)?.status ?? null })) };
}

async function processOne(ctx: Ctx, ref: string) {
  const r = await findRequest(ctx, ref);
  if (!r) return { error: `request ${ref} not found` };
  return { request: r.request_number, lines: await processRequest(ctx, r) };
}

async function status(ctx: Ctx) {
  const [hooks, rows] = await Promise.all([
    rp(ctx, '/v2/webhook/').catch(e => ({ error: e.message })),
    ctx.admin.from('returnprime_restocks').select('status'),
  ]);
  const counts = (rows.data ?? []).reduce((m: Record<string, number>, r: any) => { m[r.status] = (m[r.status] ?? 0) + 1; return m; }, {});
  const list = Array.isArray(hooks) ? hooks : [];
  return {
    webhooks: list.filter((w: any) => String(w.url).startsWith(FN_URL)).map((w: any) => ({ topics: w.topics, active: w.active })),
    ledger: counts,
  };
}

// Baseline every returned item that was back at the warehouse before the
// switch (so it is never processed), then subscribe request/received. Items
// that arrived after the switch are left for processing: nothing counted them.
// Re-running is safe.
async function register(ctx: Ctx) {
  let baselined = 0;
  for (let page = 1; page <= 200; page++) {
    const data = await listPage(ctx, page);
    const rows = (data?.list ?? []).flatMap((r: any) => (r.line_items ?? [])
      .filter((li: any) => li.id && li.original_product?.sku && backAtWarehouse(r, li) &&
        arrivedAt(r, li) < Date.parse(REFUND_RESTOCK_CUTOFF))
      .map((li: any) => ({
        request_id: r.id, line_item_id: li.id, request_number: r.request_number,
        order_id: r.order?.id, order_name: r.order?.name, sku: li.original_product.sku,
        qty: Number(li.shop_price?.return_quantity ?? li.quantity ?? 0),
        status: 'baseline', detail: 'back at warehouse before the switch to Unicommerce',
      })));
    if (rows.length) {
      const { error } = await ctx.admin.from('returnprime_restocks')
        .upsert(rows, { onConflict: 'request_id,line_item_id', ignoreDuplicates: true });
      if (error) throw error;
      baselined += rows.length;
    }
    if (!data?.hasNextPage) break;
  }

  const hookUrl = `${FN_URL}?key=${await webhookKey(ctx.rpToken)}`;
  const existing = await rp(ctx, '/v2/webhook/').catch(() => []);
  if ((Array.isArray(existing) ? existing : []).some((w: any) => w.url === hookUrl)) {
    return { baselined, webhook: 'already registered' };
  }
  const created = await rp(ctx, '/v2/webhook/', {
    method: 'POST', body: JSON.stringify({ url: hookUrl, topics: ['request/received'] }),
  });
  return { baselined, webhook: created?.active ? 'registered' : created };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function cronKeyValid(admin: SupabaseClient, key: string): Promise<boolean> {
  const { data } = await admin.from('private_secrets').select('value').eq('key', 'erp_stock_cron_key').maybeSingle();
  return !!data?.value && data.value === key;
}

// Shopify REST allows 2 calls/second; wait and retry when it says to slow down.
async function shopify(ctx: Ctx, path: string) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${ctx.shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`, {
      headers: { 'X-Shopify-Access-Token': ctx.shopToken },
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise(ok => setTimeout(ok, 1000 * Number(res.headers.get('Retry-After') ?? 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
