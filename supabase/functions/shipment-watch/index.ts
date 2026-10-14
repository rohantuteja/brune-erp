// shipment-watch v6
// Follows every parcel the business is waiting on and stores it in `shipments` (migration 020):
//   forward parcels not delivered, parcels coming back to origin (RTO), and customer returns on their way.
// Sources: Shopify (Velocity writes its tracking on the fulfilment and its promise and RTO state in the order
// note) and Return Prime (the reverse pickup) say which parcels MAY be pending; Velocity's own order-tracking and
// shipping-charges APIs then decide, because the other two lag the courier (29 of the first 133 "pending" parcels were
// already resolved). Rules and their tests: _shared/shipments.ts.
// Read-only towards Shopify, Return Prime and Velocity; writes only the `shipments` table.
//
// Actions (POST { action } with an admin user's JWT, or the x-cron-key header):
//   scan   — { dry?: true } read everything, save it (dry: only report what it would save and what looks wrong)
//   tick   — what the schedule calls every 30 minutes; does nothing unless app_settings.shipment_watch_mode is "live"
//   status — counts of what is stored

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, type Ctx, cronKeyValid, gql, json, loadCtx, requireAdmin, secrets, setting, sleep } from '../_shared/shopify-admin.ts';
import { DEFAULTS, NO_AWB, type Settings, type Shipment, type VelocityMoney, type VelocityTrack, applyVelocity, parseCharges, parseNote, parseTracking, shipmentsOfOrder, shipmentsOfReturn, staysClosed } from '../_shared/shipments.ts';

const RP_API = 'https://api.returnprime.co';
const RP_PAGES = 40;
const PAGE = 25;                    // orders per Shopify query (keeps the query cost well under the limit)
const VELOCITY = 'https://shazam.velocity.in/custom/api/v1';
const VEL_BATCH = 50;               // parcels per Velocity call

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const body = await req.json().catch(() => ({}));
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
    } else {
      const denied = await requireAdmin(admin, req);
      if (denied) return denied;
    }
    const ctx = await loadCtx(admin);
    switch (body.action) {
      case 'scan':   return json(await scan(ctx, body.dry === true));
      case 'tick':   return json(await tick(ctx));
      case 'status': return json(await status(ctx));
      default:       return json({ error: 'action must be scan, tick or status' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function tick(ctx: Ctx) {
  const mode = await setting(ctx.admin, 'shipment_watch_mode', 'off');
  if (mode !== 'live') return { mode, did: 'off' };
  return { mode, did: 'scan', ...(await scan(ctx, false)) };
}

async function loadSettings(ctx: Ctx): Promise<Settings & { lookbackDays: number }> {
  const n = async (key: string, d: number) => Number(await setting(ctx.admin, key, String(d)));
  return {
    claimDays: await n('shipment_claim_days', DEFAULTS.claimDays),
    prepaidLateDays: await n('shipment_escalate_prepaid_days', DEFAULTS.prepaidLateDays),
    codLateDays: await n('shipment_escalate_cod_days', DEFAULTS.codLateDays),
    defaultSlaDays: await n('shipment_default_sla_days', DEFAULTS.defaultSlaDays),
    stuckDays: await n('shipment_stuck_days', DEFAULTS.stuckDays),
    lookbackDays: await n('shipment_lookback_days', 150),
  };
}

const ORDER_FIELDS = `id legacyResourceId name createdAt cancelledAt note tags paymentGatewayNames
  totalPriceSet { shopMoney { amount } }
  transactions(first: 5) { kind status gateway amountSet { shopMoney { amount } } }
  shippingAddress { city zip }
  fulfillments(first: 2) { createdAt displayStatus deliveredAt inTransitAt trackingInfo { company number }
    events(first: 6, reverse: true) { nodes { status happenedAt } } }`;

async function ordersPage(ctx: Ctx, q: string, after: string | null) {
  const res = await gql(ctx, `query Ships($q: String!, $after: String) {
    orders(first: ${PAGE}, after: $after, query: $q, sortKey: CREATED_AT) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } }
  }`, { q, after });
  const c = res.data.orders;
  return { nodes: c.nodes as any[], next: c.pageInfo.hasNextPage ? c.pageInfo.endCursor as string : null };
}

async function scan(ctx: Ctx, dry: boolean) {
  const started = Date.now();
  const settings = await loadSettings(ctx);
  const today = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - settings.lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const inp = { today, settings };

  const { data: stored } = await ctx.admin.from('shipments').select('awb, order_id, state, kind');
  const known = new Map((stored ?? []).map(r => [String(r.awb), r]));
  const rows = new Map<string, Shipment>();
  const anomalies = { rto_delivered_note_without_tag: [] as string[], rto_pending_note_without_tag: [] as string[], rto_tag_without_note: [] as string[] };

  // 1. Forward parcels and RTOs: every order Shopify has shipped and not marked delivered.
  const seenOrders = new Set<number>();
  let after: string | null = null;
  for (let i = 0; i < 60; i++) {
    const page = await ordersPage(ctx, `created_at:>=${since} (fulfillment_status:fulfilled OR fulfillment_status:partial) -delivery_status:delivered`, after);
    for (const o of page.nodes) {
      seenOrders.add(Number(o.legacyResourceId));
      note(o, anomalies);
      for (const r of shipmentsOfOrder(o, inp)) if (!staysClosed(known.get(r.awb), r)) rows.set(r.awb, r);
    }
    if (!page.next) break;
    after = page.next;
  }

  // 2. Parcels pending last time that Shopify no longer lists as undelivered: look again, they are probably closed now.
  const gone = [...new Set((stored ?? []).filter(r => r.state === 'pending' && r.kind !== 'return' && r.order_id && !seenOrders.has(Number(r.order_id))).map(r => Number(r.order_id)))];
  for (let i = 0; i < gone.length; i += PAGE) {
    const page = await ordersPage(ctx, gone.slice(i, i + PAGE).map(id => `id:${id}`).join(' OR '), null);
    for (const o of page.nodes) for (const r of shipmentsOfOrder(o, inp)) rows.set(r.awb, r);
  }

  // 3. Customer returns on their way to the warehouse.
  const rpToken = Deno.env.get('RETURN_PRIME_TOKEN') || (await secrets(ctx.admin, ['returnprime_token'])).returnprime_token;
  let returnRequests = 0;
  if (rpToken) {
    for (let page = 1; page <= RP_PAGES; page++) {
      const res = await fetch(`${RP_API}/return-exchange/v2?page=${page}`, { headers: { 'x-rp-token': rpToken, 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.status === false) throw new Error(`Return Prime ${res.status}: ${body?.message ?? 'request failed'}`);
      for (const rq of body.data?.list ?? []) {
        returnRequests++;
        for (const r of shipmentsOfReturn(rq, inp)) rows.set(r.awb, r);
      }
      if (!body.data?.hasNextPage) break;
    }
  }

  // 4. Velocity decides. Every parcel still thought pending is asked of Velocity's own tracking, and its wallet ledger says
  //    what it charged and whether it has credited anything back.
  const asked = [...rows.values()].filter(r => r.state === 'pending' && !r.awb.startsWith(NO_AWB)).map(r => r.awb);
  const vel = await askVelocity(ctx, asked);
  const checkedAt = new Date().toISOString();
  for (const r of [...rows.values()]) {
    if (r.state !== 'pending') continue;
    rows.set(r.awb, applyVelocity(r, vel.tracking.get(r.awb), vel.money.get(r.awb), inp, checkedAt));
  }

  // Keep what is pending, and anything we already knew about (so it can close). Closed history is not invented.
  const keep = [...rows.values()].filter(r => r.state === 'pending' || known.has(r.awb));
  // Old orders whose AWB was only typed in carry no courier tracking: nothing can be said about them.
  const untracked = [...rows.values()].filter(r => r.status === 'untracked');
  const pending = keep.filter(r => r.state === 'pending');
  const summary = {
    scanned_at: new Date().toISOString(), seconds: 0, today,
    shopify_orders_read: seenOrders.size + gone.length, return_requests_read: returnRequests,
    saved: keep.length, pending: pending.length, closed_now: keep.length - pending.length, untracked_not_followed: untracked.length,
    velocity: { asked: asked.length, tracking_answered: vel.tracking.size, charges_answered: vel.money.size, failed_calls: vel.failed, no_record: pending.filter(r => r.attention === 'unverified' && r.velocity_status == null).length },
    closed_by_velocity: keep.filter(r => r.state === 'closed' && known.get(r.awb)?.state === 'pending').length,
    flagged: count(pending.filter(r => r.attention), r => r.attention!),
    credit_received_parcels: pending.filter(r => (r.credit_received ?? 0) > 0).length,
    by_kind: count(pending, r => r.kind),
    escalate_now: pending.filter(r => r.escalation === 'now').length,
    consider_escalating: pending.filter(r => r.escalation === 'consider').length,
    claim_eligible: pending.filter(r => r.claim_eligible).length,
    anomalies: { rto_delivered_note_without_tag: anomalies.rto_delivered_note_without_tag.slice(0, 30), rto_pending_note_without_tag: anomalies.rto_pending_note_without_tag.length, rto_tag_without_note: anomalies.rto_tag_without_note.slice(0, 30) },
  };
  if (dry) return { dry_run: true, ...summary, seconds: Math.round((Date.now() - started) / 1000), sample_claims: pending.filter(r => r.claim_eligible).slice(0, 15).map(slim) };

  const now = new Date().toISOString();
  for (let i = 0; i < keep.length; i += 200) {
    const { error } = await ctx.admin.from('shipments').upsert(keep.slice(i, i + 200).map(({ base_note, ...r }) => ({ ...r, updated_at: now })), { onConflict: 'awb' });
    if (error) throw new Error(`saving shipments: ${error.message}`);
  }
  summary.seconds = Math.round((Date.now() - started) / 1000);
  await ctx.admin.from('app_settings').upsert({ key: 'shipment_watch_last_run', value: summary }, { onConflict: 'key' });
  return summary;
}

// Velocity's order-tracking (status, delivery scans) and shipping-charges (wallet ledger) for a list of tracking numbers.
// A parcel missing from a successful answer has no record at Velocity (null); a failed call leaves its parcels out of
// the maps altogether, which applyVelocity reports as "did not answer".
async function askVelocity(ctx: Ctx, awbs: string[]) {
  const tracking = new Map<string, VelocityTrack | null>();
  const money = new Map<string, VelocityMoney>();
  let failed = 0;
  const token = (await secrets(ctx.admin, ['velocity_api_token'])).velocity_api_token;
  if (!token || !awbs.length) return { tracking, money, failed: token ? 0 : 1 };
  const call = async (path: string, batch: string[]) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${VELOCITY}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ awbs: batch }) });
        if (res.status === 429 && attempt === 0) { await sleep(20_000); continue; }
        if (!res.ok) return null;
        return await res.json();
      } catch { return null; }
    }
    return null;
  };
  for (let i = 0; i < awbs.length; i += VEL_BATCH) {
    const batch = awbs.slice(i, i + VEL_BATCH);
    const t = await call('order-tracking', batch);
    if (t?.result && typeof t.result === 'object') for (const awb of batch) tracking.set(awb, parseTracking(t.result[awb])); else failed++;
    await sleep(1000);
    const c = await call('shipping-charges', batch);
    if (Array.isArray(c?.data)) for (const d of c.data) { if (d?.tracking_number && !d.error) money.set(String(d.tracking_number), parseCharges(d)); } else failed++;
    await sleep(1000);
  }
  return { tracking, money, failed };
}

// Where Velocity's note and tags disagree: the note is what the ERP trusts, this shows when a tag is missing.
function note(o: any, a: { rto_delivered_note_without_tag: string[]; rto_pending_note_without_tag: string[]; rto_tag_without_note: string[] }) {
  const tags = (o.tags ?? []).map((t: string) => String(t).toLowerCase());
  const rto = parseNote(o.note).rto;
  const name = String(o.name).replace(/^#/, '');
  if (rto?.state === 'delivered' && !tags.includes('rto_delivered')) a.rto_delivered_note_without_tag.push(name);
  if (rto && rto.state !== 'delivered' && !tags.includes('rto_initiated')) a.rto_pending_note_without_tag.push(name);
  if (!rto && (tags.includes('rto_delivered') || tags.includes('rto_initiated'))) a.rto_tag_without_note.push(name);
}

const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m: Record<string, number>, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
const slim = (r: Shipment) => ({ awb: r.awb, order: r.order_name, kind: r.kind, status: r.status, days: r.pending_days, payment: r.payment_type });

async function status(ctx: Ctx) {
  const { data } = await ctx.admin.from('shipments').select('kind, state, escalation, claim_eligible');
  const rows = data ?? [];
  const { data: last } = await ctx.admin.from('app_settings').select('value').eq('key', 'shipment_watch_last_run').maybeSingle();
  return {
    mode: await setting(ctx.admin, 'shipment_watch_mode', 'off'),
    stored: rows.length,
    pending_by_kind: count(rows.filter(r => r.state === 'pending'), r => r.kind),
    escalate_now: rows.filter(r => r.state === 'pending' && r.escalation === 'now').length,
    consider: rows.filter(r => r.state === 'pending' && r.escalation === 'consider').length,
    claim_eligible: rows.filter(r => r.state === 'pending' && r.claim_eligible).length,
    last_run: last?.value ?? null,
  };
}
