// shopify-order-webhook v7
// Puts stock back into Unicommerce when pieces come back from Shopify orders,
// and handles RTO orders end to end.
//
// Stock model: every Shopify order is imported into Unicommerce, which holds a
// piece per unit and takes it out of stock when it marks the order dispatched
// (once Velocity fulfils it). After an RTO cancel Unicommerce opens a "Courier
// Returned" return on the order; the ERP receives that return as good stock
// (no one has to receive it by hand), or adds the piece directly when
// Unicommerce never shipped it. See ../_shared/uc-returns.ts. Lines wait (status
// 'waiting') until Unicommerce has opened the return, 6–30 min after the cancel;
// a 15-min job (pg_cron, migration 011) settles them and retries failed lines.
//
//   Shopify cancellations before shipping are NOT handled here: Unicommerce
//     cancels its copy of the order itself and releases the held piece (seen on
//     #37715, within a second), so adding a piece too would count it twice.
//   tag rto_delivered (orders/updated) → the parcel is back at the warehouse and
//     every unit goes back, if the order is open in Unicommerce or shipped before
//     the opening stock load (whose Shopify snapshot had already deducted it).
//     Then, when app_settings.rto_shopify_actions is true, cancel the order on
//     Shopify (no restock, customer emailed). If the customer paid anything
//     (prepaid, a part-payment, store credit), the cancel refunds all of it to
//     store credit with no expiry; Shopify works out the amount, shipping
//     included. Shopify won't cancel such an order while its shipment is active,
//     and Velocity never closes the shipment on RTO, so the ERP cancels the
//     fulfillment first. Neither step changes Shopify stock.
//
// Order edits (orders/edited): Unicommerce imports an order once and never
//   sees later edits, so when Velocity ships an edited order it dispatches its
//   own stale copy (#37827: the XS swapped out by email was dispatched instead
//   of the M that shipped). The ERP corrects Unicommerce's stock per line —
//   takes out pieces added by the edit, puts back pieces removed — and records
//   it (shopify_order_edit_lines, migration 012). If the order is then
//   cancelled before shipping the corrections are reversed; on an RTO or a
//   return the pieces it took out are added back. Unicommerce's own order and
//   invoice still show the original items.
//
// Test mode: until app_settings.order_webhook_mode is "live", only orders
// tagged erp-test are processed; every other order is ignored.
//
// Exactly-once: shopify_order_restocks (per order line) and shopify_rto_orders
// (per RTO order) are claimed before anything is changed — see migration 004.
// Orders already tagged rto_delivered at go-live are 'baseline' rows and are
// never processed. Webhooks are answered at once and processed in the
// background, inside Shopify's 5-second limit.
//
// Safety net: a daily sweep (pg_cron, migration 010, header x-cron-key matching
// private_secrets.erp_stock_cron_key) processes any order tagged rto_delivered
// in the last 3 days that the ERP never heard about, e.g. because Shopify gave
// up on the webhook or deleted the subscription, and re-checks orders edited
// in that time. RTOs claimed but never finished (stuck 'processing' for over
// an hour) are moved to Needs attention.
//
// Admin actions (POST { action } with an admin user's JWT):
//   status   — webhook subscriptions, granted Shopify scopes, ledger counts
//   register — baseline the currently tagged RTO orders, then subscribe the webhooks
//   dry_run  — { order: "37506" } shows what would happen, changing nothing
//   retry    — re-attempt order lines whose Unicommerce update failed, and the
//              stock step of RTO orders that failed before any line was recorded
//              (e.g. the Unicommerce order lookup failed). { dry: true } only plans.
//   cancel   — { order: "36840", dry?: true } cancel one RTO order on Shopify the
//              same way (refund to store credit if paid), for orders whose
//              automatic cancel failed. Stock is not touched; dry only shows the plan.
//   sweep    — { days?: 3, dry?: true } run the safety-net sweep now (or preview it)
//   settle   — run the 15-min job now: settle waiting lines, retry failed ones,
//              re-check edit corrections that are pending or need attention
//   edits    — { order: "37827", dry?: true } correct (or preview) one edited order
//   subscribe — create any missing webhook subscriptions (no baselining)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, getSaleOrder, getSaleOrderDetail } from '../_shared/unicommerce.ts';
import { type BackLine, type Settled, settleReturnedLines } from '../_shared/uc-returns.ts';
import { type EditTarget, editTargets } from '../_shared/order-edits.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const API_VERSION = '2026-04';
const WEBHOOK_URL = 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-order-webhook';
const TOPICS = ['orders/updated', 'orders/cancelled', 'orders/edited'];
const RTO_TAG = 'rto_delivered';
const TEST_TAG = 'erp-test';
// Shopify snapshot behind the opening Unicommerce stock load (29 Sep 2026, 22:37:59 IST).
const STOCK_LOAD_CUTOFF = Date.parse('2026-09-29T17:07:59Z');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Ctx = { admin: SupabaseClient; shop: string; token: string };
type Reason = 'cancelled' | 'rto';  // 'cancelled' only for rows from before 1 Oct 2026
type LinePlan = { line_item_id: number; sku: string; qty: number; add: boolean; why: string };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const raw = await req.text();
  const topic = req.headers.get('X-Shopify-Topic');

  try {
    const { data: secrets } = await admin
      .from('private_secrets')
      .select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain', 'shopify_client_secret']);
    const secret = (k: string) => secrets?.find(s => s.key === k)?.value as string | undefined;
    const ctx: Ctx = {
      admin,
      shop: secret('shopify_shop_domain') || 'supply-rethought.myshopify.com',
      token: secret('shopify_access_token') ?? '',
    };

    // ── Shopify webhook ───────────────────────────────────────────────────────
    if (topic) {
      const clientSecret = secret('shopify_client_secret');
      const hmac = req.headers.get('X-Shopify-Hmac-Sha256') ?? '';
      if (!clientSecret || !(await verifyHmac(clientSecret, raw, hmac))) {
        return json({ error: 'Invalid HMAC' }, 401);
      }
      const order = JSON.parse(raw);
      const work = handleOrderEvent(ctx, topic, order)
        .catch(err => console.error(`[${topic}] ${order?.name}:`, err instanceof Error ? err.message : err));
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else await work;
      return json({ ok: true });
    }

    // ── Scheduled jobs: daily RTO sweep, 15-min settle ────────────────────────
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
      const job = (raw ? JSON.parse(raw) : {}).job;
      return json(job === 'settle'
        ? { ...(await settleWaiting(ctx)), edits: await recheckEdits(ctx) }
        : await sweep(ctx, 3, false));
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
      case 'register': return json(await register(ctx));
      case 'dry_run':  return json(await dryRun(ctx, String(body.order ?? '')));
      case 'retry':    return json(await retryFailed(ctx, body.dry === true));
      case 'cancel':   return json(await cancelRto(ctx, String(body.order ?? ''), body.dry === true));
      case 'sweep':    return json(await sweep(ctx, Number(body.days ?? 3), body.dry !== false));
      case 'settle':   return json({ ...(await settleWaiting(ctx)), edits: await recheckEdits(ctx) });
      case 'edits':    return json(await editsOne(ctx, String(body.order ?? ''), body.dry === true));
      case 'subscribe': return json({ registered: await subscribeTopics(ctx) });
      default:         return json({ error: 'action must be status, register, dry_run, retry, cancel, sweep, settle, edits or subscribe' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── Event routing ─────────────────────────────────────────────────────────────

const hasTag = (order: any, tag: string) =>
  String(order.tags ?? '').split(',').some(t => t.trim().toLowerCase() === tag);
const isRto = (order: any) => hasTag(order, RTO_TAG);

async function isLive(ctx: Ctx): Promise<boolean> {
  const { data } = await ctx.admin.from('app_settings').select('value').eq('key', 'order_webhook_mode').maybeSingle();
  return data?.value === 'live';
}

// orders/cancelled is still subscribed: for RTO orders it is a second route to
// handleRto (the claim makes it a no-op), and it re-checks edited orders so
// their corrections are reversed if Unicommerce cancels its copy. Other
// cancellations are Unicommerce's. orders/edited carries an order_edit, not
// the order.
async function handleOrderEvent(ctx: Ctx, topic: string, payload: any) {
  if (topic === 'orders/edited') {
    if (await isLive(ctx)) await reconcileEdits(ctx, Number(payload.order_edit?.order_id));
    return;
  }
  const order = payload;
  if (!hasTag(order, TEST_TAG) && !(await isLive(ctx))) return;
  if (topic === 'orders/cancelled' && await hasEditCorrections(ctx, order.id)) await reconcileEdits(ctx, order.id);
  if (isRto(order)) return handleRto(ctx, order);
}

// ── Planning (read-only) ──────────────────────────────────────────────────────

async function unicommerceState(ctx: Ctx, order: any) {
  const uc = await getSaleOrder(ctx.admin, String(order.id));
  return { inUc: !!uc, ucOpen: !!uc && uc.status !== 'CANCELLED' };
}

const notTakenWhy = (inUc: boolean) => inUc
  ? 'order is cancelled in Unicommerce, so its piece was already released'
  : 'order never reached Unicommerce, so Unicommerce never took this piece';

// RTO: the whole parcel came back. Couriers sometimes cancel the fulfillment on
// RTO, so every unit on the order counts, not just successfully fulfilled ones.
async function planRtoLines(ctx: Ctx, order: any): Promise<LinePlan[]> {
  const { inUc, ucOpen } = await unicommerceState(ctx, order);
  const edits = await editCorrections(ctx, order.id);
  const firstShipped = Math.min(
    ...(order.fulfillments ?? []).map((f: any) => Date.parse(f.created_at)).filter(Number.isFinite),
  );
  const shippedBeforeLoad = firstShipped < STOCK_LOAD_CUTOFF;
  const add = ucOpen || shippedBeforeLoad;
  const why = ucOpen ? 'RTO received; order open in Unicommerce'
    : shippedBeforeLoad ? 'RTO received; shipped before the opening stock load'
    : notTakenWhy(inUc);
  return (order.line_items ?? [])
    .filter((l: any) => l.sku && !l.gift_card)
    .map((l: any) => {
      const edited = edits.get(Number(l.id)) ?? 0;  // pieces the ERP took out (+) or put back (−) for an edit
      return {
        line_item_id: l.id,
        sku: l.sku,
        // Before cancellation current_quantity reflects order edits; cancelling
        // zeroes it, so then take the original quantity less what edits removed.
        qty: order.cancelled_at ? l.quantity - Math.max(0, -edited) : (l.current_quantity ?? l.quantity),
        add: add || edited > 0,
        why: !add && edited > 0 ? 'RTO received; added to the order after Unicommerce imported it' : why,
      };
    })
    .filter((l: LinePlan) => l.qty > 0);
}

// ── Applying ──────────────────────────────────────────────────────────────────

// Claim each line exactly once, then settle the claimed ones: lines that should
// come back go to Unicommerce (../_shared/uc-returns.ts), the rest are skipped.
async function applyLines(ctx: Ctx, order: any, reason: Reason, lines: LinePlan[]) {
  const results: Array<LinePlan & { result: string }> = [];
  const back: BackLine[] = [];
  const now = new Date().toISOString();
  for (const l of lines) {
    // Exactly-once claim for this order line (ON CONFLICT DO NOTHING).
    const { data: claimed, error: claimErr } = await ctx.admin
      .from('shopify_order_restocks')
      .upsert({
        order_id: order.id, line_item_id: l.line_item_id, order_name: order.name,
        sku: l.sku, qty: l.qty, reason, status: 'claimed', detail: l.why,
      }, { onConflict: 'order_id,line_item_id', ignoreDuplicates: true })
      .select('order_id');
    if (claimErr) throw claimErr;
    if (!claimed?.length) { results.push({ ...l, result: 'already handled' }); continue; }
    if (l.add) {
      back.push({ line_item_id: l.line_item_id, sku: l.sku, qty: l.qty, since: now });
    } else {
      await recordLine(ctx, order.id, l.line_item_id, 'skipped', l.why);
      results.push({ ...l, result: 'skipped' });
    }
  }
  if (back.length) {
    const settled = await settleRows(ctx, order.id, back, remarksFor(order.name, reason));
    for (const l of lines.filter(x => back.some(b => b.line_item_id === x.line_item_id))) {
      results.push({ ...l, result: settled.get(l.line_item_id) ?? 'failed' });
    }
  }
  return results;
}

const remarksFor = (orderName: string, reason: Reason) =>
  `Shopify ${orderName} ${reason === 'rto' ? 'RTO received' : 'cancelled before shipping'}`;

async function recordLine(ctx: Ctx, orderId: number, lineItemId: number, status: string, detail: string) {
  await ctx.admin
    .from('shopify_order_restocks')
    .update({ status, detail, updated_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .eq('line_item_id', lineItemId);
}

// Put one order's claimed lines into Unicommerce stock and record each outcome
// (restocked / waiting / skipped / failed). If Unicommerce can't be reached the
// lines are marked failed; the 15-min job retries them.
async function settleRows(ctx: Ctx, orderId: number, lines: BackLine[], remarks: string): Promise<Map<number, string>> {
  let settled: Settled[];
  try {
    settled = await settleReturnedLines(ctx.admin, orderId, lines, remarks);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    settled = lines.map(l => ({ line_item_id: l.line_item_id, status: 'failed' as const, detail: msg }));
  }
  for (const s of settled) await recordLine(ctx, orderId, s.line_item_id, s.status, s.detail);
  return new Map(settled.map(s => [s.line_item_id, s.status]));
}

// Settle ledger rows (already claimed by the caller), one order at a time.
async function settleClaimedRows(ctx: Ctx, rows: any[]) {
  const results = [];
  const byOrder = new Map<number, any[]>();
  for (const r of rows) byOrder.set(r.order_id, [...(byOrder.get(r.order_id) ?? []), r]);
  for (const [orderId, group] of byOrder) {
    const settled = await settleRows(ctx, orderId,
      group.map(r => ({ line_item_id: r.line_item_id, sku: r.sku, qty: r.qty, since: r.created_at })),
      remarksFor(group[0].order_name, group[0].reason));
    for (const r of group) results.push({ order: r.order_name, sku: r.sku, qty: r.qty, result: settled.get(r.line_item_id) });
  }
  return results;
}

// The 15-min job (pg_cron, migration 011): settle lines waiting for Unicommerce
// to open its return, and retry failed lines at most hourly. Rows are claimed
// first so a webhook and the job never settle the same line at once; claims
// older than an hour (a crashed run) are released.
async function settleWaiting(ctx: Ctx) {
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  await ctx.admin.from('shopify_order_restocks').update({ status: 'waiting', updated_at: now })
    .in('status', ['failed', 'claimed']).lt('updated_at', hourAgo);
  const { data: rows } = await ctx.admin.from('shopify_order_restocks')
    .update({ status: 'claimed', updated_at: now }).eq('status', 'waiting').select('*');
  const settled = await settleClaimedRows(ctx, rows ?? []);
  return { settled: settled.length, results: settled };
}

async function handleRto(ctx: Ctx, order: any) {
  // Exactly-once claim for the order; baseline and already-processed orders stop here.
  const { data: claimed, error: claimErr } = await ctx.admin
    .from('shopify_rto_orders')
    .upsert({ order_id: order.id, order_name: order.name, status: 'processing', financial_status: order.financial_status },
      { onConflict: 'order_id', ignoreDuplicates: true })
    .select('order_id');
  if (claimErr) throw claimErr;
  if (!claimed?.length) return;

  const notes: string[] = [];
  let linesFailed = false;
  try {
    const results = await applyLines(ctx, order, 'rto', await planRtoLines(ctx, order));
    linesFailed = results.some(r => r.result === 'failed');
  } catch (e) {
    linesFailed = true;
    notes.push(`stock: ${e instanceof Error ? e.message : String(e)}`);
  }

  let outcome: CancelOutcome;
  try {
    outcome = await cancelOnShopify(ctx, order.id, await shopifyActionsEnabled(ctx));
  } catch (e) {
    outcome = { cancel_status: 'failed', credit_status: 'needs_review', credit_amount: null,
      notes: [`cancel: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const { cancel_status, credit_status, credit_amount } = outcome;
  notes.push(...outcome.notes);

  const attention = linesFailed || cancel_status === 'failed' ||
    ['failed', 'unknown', 'needs_review', 'disabled'].includes(credit_status);
  await ctx.admin.from('shopify_rto_orders').update({
    status: attention ? 'needs_attention' : 'done',
    cancel_status, credit_status, credit_amount,
    detail: notes.join('; ') || null,
    updated_at: new Date().toISOString(),
  }).eq('order_id', order.id);
}

async function shopifyActionsEnabled(ctx: Ctx): Promise<boolean> {
  const { data } = await ctx.admin.from('app_settings').select('value').eq('key', 'rto_shopify_actions').maybeSingle();
  return data?.value === true;
}

// What's paid and shipped on an order, from Shopify. paid = still held on the
// order (received minus refunded).
type PaymentInfo = { cancelled: boolean; customerId: string | null; received: number; paid: number; activeFulfillments: string[] };

async function paymentInfo(ctx: Ctx, orderId: number): Promise<PaymentInfo> {
  const r = await gql(ctx, `query($id: ID!) {
    order(id: $id) {
      cancelledAt
      customer { id }
      totalReceivedSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      fulfillments(first: 20) { id status }
    }
  }`, { id: `gid://shopify/Order/${orderId}` });
  const o = r.data?.order;
  if (!o) throw new Error(`Shopify order ${orderId} not found${r.errors ? `: ${JSON.stringify(r.errors)}` : ''}`);
  const received = Number(o.totalReceivedSet?.shopMoney?.amount ?? 0);
  const refunded = Number(o.totalRefundedSet?.shopMoney?.amount ?? 0);
  return {
    cancelled: !!o.cancelledAt,
    customerId: o.customer?.id ?? null,
    received,
    paid: Math.round((received - refunded) * 100) / 100,
    activeFulfillments: (o.fulfillments ?? []).filter((f: any) => f.status === 'SUCCESS').map((f: any) => f.id),
  };
}

type CancelOutcome = { cancel_status: string; credit_status: string; credit_amount: number | null; notes: string[] };

// Cancel an RTO order on Shopify: no restock, customer emailed, and anything
// paid refunded to store credit by the cancel itself. Orders with money on
// them get their active shipments cancelled first, or Shopify refuses
// ("Cannot cancel an order that has outstanding fulfillments").
async function cancelOnShopify(ctx: Ctx, orderId: number, enabled: boolean): Promise<CancelOutcome> {
  const o = await paymentInfo(ctx, orderId);
  const credit_amount = o.paid > 0 ? o.paid : null;
  const nothingToRefund = o.received > 0 ? 'already_refunded' : 'not_prepaid';

  if (o.cancelled) {
    return o.paid > 0
      ? { cancel_status: 'already_cancelled', credit_status: 'needs_review', credit_amount,
          notes: [`credit: order was already cancelled with ₹${o.paid} paid and not refunded`] }
      : { cancel_status: 'already_cancelled', credit_status: nothingToRefund, credit_amount, notes: [] };
  }
  if (!enabled) {
    return { cancel_status: 'disabled', credit_status: o.paid > 0 ? 'disabled' : nothingToRefund, credit_amount,
      notes: o.paid > 0 ? [`RTO Shopify actions are off: not cancelled, ₹${o.paid} not refunded`] : [] };
  }
  if (o.paid <= 0) {
    const err = await cancelOrder(ctx, orderId, false);
    return { cancel_status: err ? 'failed' : 'cancelled', credit_status: nothingToRefund, credit_amount,
      notes: err ? [`cancel: ${err}`] : [] };
  }

  if (!o.customerId) {
    return { cancel_status: 'failed', credit_status: 'needs_review', credit_amount,
      notes: [`cancel: not attempted — ₹${o.paid} was paid but the order has no customer to give store credit to`] };
  }
  for (const id of o.activeFulfillments) {
    const err = await cancelFulfillment(ctx, id);
    if (err) {
      return { cancel_status: 'failed', credit_status: 'needs_review', credit_amount,
        notes: [`cancel: the shipment could not be cancelled: ${err}`] };
    }
  }
  const err = await cancelOrder(ctx, orderId, true);
  if (err) return { cancel_status: 'failed', credit_status: 'needs_review', credit_amount, notes: [`cancel: ${err}`] };

  // Shopify cancels (and refunds) in a background job: confirm both happened.
  for (let i = 0; i < 6; i++) {
    await new Promise(ok => setTimeout(ok, 2000));
    const after = await paymentInfo(ctx, orderId);
    if (after.cancelled && after.paid <= 0) {
      return { cancel_status: 'cancelled', credit_status: 'issued', credit_amount, notes: [] };
    }
  }
  return { cancel_status: 'cancelled', credit_status: 'unknown', credit_amount,
    notes: [`credit: cancel accepted, but the ₹${o.paid} store credit refund wasn't confirmed within 12 s — check the order`] };
}

// Cancel without restock; Shopify emails the customer. With refundToStoreCredit
// everything still paid is refunded to store credit (no expiry); otherwise
// nothing is refunded. Returns an error or null.
async function cancelOrder(ctx: Ctx, orderId: number, refundToStoreCredit: boolean): Promise<string | null> {
  try {
    const r = await gql(ctx, `mutation($id: ID!, $note: String, $refundMethod: OrderCancelRefundMethodInput!) {
      orderCancel(orderId: $id, reason: OTHER, restock: false, notifyCustomer: true,
        refundMethod: $refundMethod, staffNote: $note) {
        orderCancelUserErrors { message }
      }
    }`, {
      id: `gid://shopify/Order/${orderId}`,
      note: refundToStoreCredit
        ? 'RTO delivered — paid amount refunded to store credit, cancelled by Brune ERP'
        : 'RTO delivered — cancelled by Brune ERP',
      refundMethod: refundToStoreCredit ? { storeCreditRefund: {} } : { originalPaymentMethodsRefund: false },
    });
    const errs = [...(r.data?.orderCancel?.orderCancelUserErrors ?? []), ...(r.errors ?? [])];
    return errs.length ? errs.map((e: any) => e.message).join('; ') : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Cancel one shipment (fulfillment). Doesn't change Shopify stock. Returns an error or null.
async function cancelFulfillment(ctx: Ctx, fulfillmentId: string): Promise<string | null> {
  try {
    const r = await gql(ctx, `mutation($id: ID!) {
      fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { message } }
    }`, { id: fulfillmentId });
    const errs = [...(r.data?.fulfillmentCancel?.userErrors ?? []), ...(r.errors ?? [])];
    return errs.length ? errs.map((e: any) => e.message).join('; ') : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// What cancelOnShopify would do, for the dry runs.
async function describeCancel(ctx: Ctx, orderId: number) {
  const o = await paymentInfo(ctx, orderId);
  if (o.cancelled) {
    return { cancel: 'already cancelled', refund: o.paid > 0 ? `₹${o.paid} paid and not refunded — needs a person` : 'nothing to refund' };
  }
  if (o.paid <= 0) {
    return { cancel: 'cancel the order (no restock, customer emailed)', refund: o.received > 0 ? 'already refunded' : 'nothing paid' };
  }
  if (!o.customerId) return { cancel: 'not possible', refund: `₹${o.paid} paid but no customer to give store credit to` };
  return {
    cancel: `cancel ${o.activeFulfillments.length} active shipment(s), then cancel the order (no restock, customer emailed)`,
    refund: `₹${o.paid} to store credit, no expiry`,
  };
}

// ── Admin actions ─────────────────────────────────────────────────────────────

async function status(ctx: Ctx) {
  const [hooks, scopes, restocks, rto] = await Promise.all([
    rest(ctx, 'webhooks.json?limit=250'),
    gql(ctx, '{ currentAppInstallation { accessScopes { handle } } }'),
    ctx.admin.from('shopify_order_restocks').select('reason, status'),
    ctx.admin.from('shopify_rto_orders').select('status'),
  ]);
  const count = (rows: any[] | null, key: (r: any) => string) =>
    (rows ?? []).reduce((m: Record<string, number>, r) => { m[key(r)] = (m[key(r)] ?? 0) + 1; return m; }, {});
  return {
    webhooks: (hooks.webhooks ?? []).filter((w: any) => w.address === WEBHOOK_URL).map((w: any) => w.topic),
    scopes: (scopes.data?.currentAppInstallation?.accessScopes ?? []).map((s: any) => s.handle),
    rto_shopify_actions: await shopifyActionsEnabled(ctx),
    mode: (await isLive(ctx)) ? 'live' : `test (only orders tagged ${TEST_TAG})`,
    restocks: count(restocks.data, r => `${r.reason}:${r.status}`),
    rto_orders: count(rto.data, r => r.status),
  };
}

// Baseline every order already tagged rto_delivered (so it is never processed),
// then subscribe the webhooks. Re-running is safe.
async function register(ctx: Ctx) {
  let after: string | null = null;
  let baselined = 0;
  do {
    const r: any = await gql(ctx, `query($after: String) {
      orders(first: 250, after: $after, query: "tag:${RTO_TAG}") {
        pageInfo { hasNextPage endCursor } nodes { legacyResourceId name }
      }
    }`, { after });
    const nodes = r.data?.orders?.nodes ?? [];
    if (nodes.length) {
      const { error } = await ctx.admin.from('shopify_rto_orders').upsert(
        nodes.map((n: any) => ({ order_id: Number(n.legacyResourceId), order_name: n.name, status: 'baseline' })),
        { onConflict: 'order_id', ignoreDuplicates: true },
      );
      if (error) throw error;
      baselined += nodes.length;
    }
    after = r.data?.orders?.pageInfo?.hasNextPage ? r.data.orders.pageInfo.endCursor : null;
  } while (after);

  return { baselined, registered: await subscribeTopics(ctx) };
}

// Create any missing webhook subscriptions for TOPICS.
async function subscribeTopics(ctx: Ctx) {
  const existing = (await rest(ctx, 'webhooks.json?limit=250')).webhooks ?? [];
  const registered = [];
  for (const topic of TOPICS) {
    if (existing.some((w: any) => w.topic === topic && w.address === WEBHOOK_URL)) {
      registered.push({ topic, result: 'already registered' });
      continue;
    }
    const r = await rest(ctx, 'webhooks.json', { webhook: { topic, address: WEBHOOK_URL, format: 'json' } });
    registered.push({ topic, result: r.webhook?.id ? 'registered' : JSON.stringify(r.errors ?? r) });
  }
  return registered;
}

async function dryRun(ctx: Ctx, orderRef: string) {
  const name = orderRef.replace(/^#/, '');
  const found = (await rest(ctx, `orders.json?status=any&name=${encodeURIComponent(name)}`)).orders ?? [];
  const order = found.find((o: any) => String(o.name).replace(/^#/, '') === name);
  if (!order) return { error: `order ${orderRef} not found` };

  const { data: rtoRow } = await ctx.admin.from('shopify_rto_orders').select('status').eq('order_id', order.id).maybeSingle();
  const { data: done } = await ctx.admin.from('shopify_order_restocks').select('line_item_id, status').eq('order_id', order.id);
  const rto = isRto(order);
  const lines = rto ? await planRtoLines(ctx, order) : [];
  return {
    dry_run: true,
    order: order.name,
    event: rto ? 'rto' : 'none (not tagged rto_delivered; cancellations are handled by Unicommerce)',
    rto_record: rtoRow?.status ?? null,
    would_process: rto ? !rtoRow : false,
    lines: lines.map(l => ({ ...l, already: done?.find(d => d.line_item_id === l.line_item_id)?.status ?? null })),
    ...(rto ? {
      shopify: await describeCancel(ctx, order.id),
      rto_shopify_actions: await shopifyActionsEnabled(ctx),
    } : {}),
  };
}

async function retryFailed(ctx: Ctx, dry = false) {
  let results;
  if (dry) {
    const { data: failed } = await ctx.admin.from('shopify_order_restocks').select('*').eq('status', 'failed');
    results = (failed ?? []).map(row => ({ order: row.order_name, sku: row.sku, qty: row.qty, result: 'would retry' }));
  } else {
    // Re-claim atomically: only one retry may move a failed row back to claimed.
    const { data: reclaimed } = await ctx.admin.from('shopify_order_restocks')
      .update({ status: 'claimed', updated_at: new Date().toISOString() })
      .eq('status', 'failed').select('*');
    results = await settleClaimedRows(ctx, reclaimed ?? []);
  }
  const rto = await retryRtoStock(ctx, dry);
  return { dry, retried: results.length, results, rto_orders: rto.length, rto };
}

// RTO orders whose stock step failed before any line was recorded: plan the
// lines again from the order as it is now and apply them (each line exactly
// once). The Shopify cancel and store credit aren't repeated; they keep their
// recorded outcome, so a failed cancel still needs a person.
async function retryRtoStock(ctx: Ctx, dry: boolean) {
  const { data: rows } = await ctx.admin.from('shopify_rto_orders')
    .select('order_id, order_name, cancel_status, credit_status, detail')
    .eq('status', 'needs_attention').like('detail', 'stock: %');
  const out = [];
  for (const row of rows ?? []) {
    const { count } = await ctx.admin.from('shopify_order_restocks')
      .select('line_item_id', { count: 'exact', head: true }).eq('order_id', row.order_id);
    if (count) continue;  // its lines exist; failed ones are retried above

    let order: any;
    let lines: LinePlan[];
    try {
      order = (await rest(ctx, `orders/${row.order_id}.json`)).order;
      lines = await planRtoLines(ctx, order);
    } catch (e) {
      out.push({ order: row.order_name, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (dry) {
      out.push({ order: row.order_name, cancel: row.cancel_status, credit: row.credit_status, lines });
      continue;
    }

    const results = await applyLines(ctx, order, 'rto', lines);
    const linesFailed = results.some(r => r.result === 'failed');
    // The stock note always comes first; keep the cancel / credit notes after it.
    const otherNotes = String(row.detail ?? '').replace(/^stock: .*?(?=; (?:cancel|credit|store credit)|$)(?:; )?/, '');
    const detail = [linesFailed ? 'stock: some lines failed — retry again' : '', otherNotes].filter(Boolean).join('; ');
    const attention = linesFailed || row.cancel_status === 'failed' ||
      ['failed', 'unknown', 'needs_review', 'disabled'].includes(row.credit_status);
    await ctx.admin.from('shopify_rto_orders').update({
      status: attention ? 'needs_attention' : 'done',
      detail: detail || null,
      updated_at: new Date().toISOString(),
    }).eq('order_id', row.order_id);
    out.push({ order: row.order_name, status: attention ? 'needs_attention' : 'done', lines: results });
  }
  return out;
}

// Cancel one RTO order on Shopify, the same way as an incoming RTO (refund to
// store credit if anything was paid). For orders whose automatic cancel failed.
async function cancelRto(ctx: Ctx, orderRef: string, dry: boolean) {
  const name = orderRef.replace(/^#/, '');
  const { data: row } = await ctx.admin.from('shopify_rto_orders')
    .select('order_id, order_name, status, detail')
    .eq('order_name', name).maybeSingle();
  if (!row || row.status === 'baseline') return { error: `${orderRef} is not an RTO order the ERP has processed` };
  if (dry) return { dry_run: true, order: row.order_name, ...(await describeCancel(ctx, row.order_id)) };

  const outcome = await cancelOnShopify(ctx, row.order_id, true);
  // Keep the stock note; the cancel and credit notes are replaced.
  const stockNote = /^stock: .*?(?=; (?:cancel|credit|store credit|RTO Shopify)|$)/.exec(String(row.detail ?? ''))?.[0];
  const detail = [stockNote ?? '', ...outcome.notes].filter(Boolean).join('; ');
  const attention = !!stockNote || outcome.cancel_status === 'failed' ||
    ['failed', 'unknown', 'needs_review', 'disabled'].includes(outcome.credit_status);
  await ctx.admin.from('shopify_rto_orders').update({
    status: attention ? 'needs_attention' : 'done',
    cancel_status: outcome.cancel_status,
    credit_status: outcome.credit_status,
    credit_amount: outcome.credit_amount,
    detail: detail || null,
    updated_at: new Date().toISOString(),
  }).eq('order_id', row.order_id);
  return { order: row.order_name, ...outcome, status: attention ? 'needs_attention' : 'done' };
}

// Safety net for missed webhooks: process every order tagged rto_delivered in
// the last `days` days that has no ERP record, exactly as the webhook would
// have (the claim keeps it exactly-once if the webhook arrives too). Then move
// RTOs stuck in 'processing' for over an hour to Needs attention: their stock
// lines and Shopify cancel may be half done, so a person checks them.
async function sweep(ctx: Ctx, days: number, dry: boolean) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const ids: number[] = [];
  let after: string | null = null;
  do {
    const r: any = await gql(ctx, `query($after: String, $q: String) {
      orders(first: 100, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor } nodes { legacyResourceId }
      }
    }`, { after, q: `tag:${RTO_TAG} updated_at:>=${since}` });
    if (r.errors) throw new Error(`Shopify order search failed: ${JSON.stringify(r.errors)}`);
    ids.push(...(r.data?.orders?.nodes ?? []).map((n: any) => Number(n.legacyResourceId)));
    after = r.data?.orders?.pageInfo?.hasNextPage ? r.data.orders.pageInfo.endCursor : null;
  } while (after);

  const { data: known } = ids.length
    ? await ctx.admin.from('shopify_rto_orders').select('order_id').in('order_id', ids)
    : { data: [] as Array<{ order_id: number }> };
  const knownIds = new Set((known ?? []).map(k => Number(k.order_id)));
  const missed = [];
  for (const id of ids.filter(i => !knownIds.has(i))) {
    const order = (await rest(ctx, `orders/${id}.json`)).order;
    if (!order || !isRto(order)) continue;
    if (dry) { missed.push({ order: order.name, result: 'would process as an RTO' }); continue; }
    await handleOrderEvent(ctx, 'sweep', order);
    const { data: row } = await ctx.admin.from('shopify_rto_orders').select('status').eq('order_id', id).maybeSingle();
    missed.push({ order: order.name, result: row?.status ?? 'not processed (test mode)' });
  }

  const { data: stuck } = await ctx.admin.from('shopify_rto_orders')
    .select('order_id, order_name').eq('status', 'processing')
    .lt('updated_at', new Date(Date.now() - 3_600_000).toISOString());
  if (!dry) {
    for (const row of stuck ?? []) {
      await ctx.admin.from('shopify_rto_orders').update({
        status: 'needs_attention',
        detail: 'processing never finished — check its stock and its cancel on Shopify',
        updated_at: new Date().toISOString(),
      }).eq('order_id', row.order_id).eq('status', 'processing');
    }
  }

  // Orders edited in the same window, in case an orders/edited webhook was missed.
  const edited: number[] = [];
  after = null;
  do {
    const r: any = await gql(ctx, `query($after: String, $q: String) {
      orders(first: 100, after: $after, query: $q) {
        pageInfo { hasNextPage endCursor } nodes { legacyResourceId edited }
      }
    }`, { after, q: `updated_at:>=${since}` });
    if (r.errors) throw new Error(`Shopify order search failed: ${JSON.stringify(r.errors)}`);
    edited.push(...(r.data?.orders?.nodes ?? []).filter((n: any) => n.edited).map((n: any) => Number(n.legacyResourceId)));
    after = r.data?.orders?.pageInfo?.hasNextPage ? r.data.orders.pageInfo.endCursor : null;
  } while (after);
  const edits = [];
  for (const id of edited) {
    const r = await reconcileEdits(ctx, id, dry);
    const res = r as { status?: string; plan?: Array<{ change: number }> };
    if ((res.status && res.status !== 'ok') || res.plan?.some(p => p.change)) edits.push(r);
  }

  if (missed.length || stuck?.length || edits.length) console.warn('[rto sweep]', JSON.stringify({ missed, stuck, edits }));
  return { dry, since, rto_orders_checked: ids.length, missed, stuck: (stuck ?? []).map(r => r.order_name), edited_orders_checked: edited.length, edits };
}

async function cronKeyValid(admin: SupabaseClient, key: string): Promise<boolean> {
  const { data } = await admin.from('private_secrets').select('value').eq('key', 'erp_stock_cron_key').maybeSingle();
  return !!data?.value && data.value === key;
}

// ── Order edits ───────────────────────────────────────────────────────────────

// Net pieces the ERP has taken out of Unicommerce per Shopify line for edits
// (negative: put back).
async function editCorrections(ctx: Ctx, orderId: number): Promise<Map<number, number>> {
  const { data } = await ctx.admin.from('shopify_order_edit_lines').select('line_item_id, net_removed').eq('order_id', orderId);
  return new Map((data ?? []).map(r => [Number(r.line_item_id), Number(r.net_removed)]));
}

async function hasEditCorrections(ctx: Ctx, orderId: number): Promise<boolean> {
  const { count } = await ctx.admin.from('shopify_order_edit_lines')
    .select('line_item_id', { count: 'exact', head: true }).eq('order_id', orderId).neq('net_removed', 0);
  return !!count;
}

// Bring Unicommerce's stock in line with an edited order, applying only the
// difference from what the ERP has already corrected. One run per order at a
// time (shopify_order_edits.locked_until).
async function reconcileEdits(ctx: Ctx, orderId: number, dry = false) {
  if (!orderId) return { error: 'no order id' };
  const now = new Date();
  if (!dry) {
    await ctx.admin.from('shopify_order_edits').upsert({ order_id: orderId }, { onConflict: 'order_id', ignoreDuplicates: true });
    const { data: locked } = await ctx.admin.from('shopify_order_edits')
      .update({ locked_until: new Date(now.getTime() + 120_000).toISOString() })
      .eq('order_id', orderId).or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`).select('order_id');
    if (!locked?.length) return { order_id: orderId, result: 'busy' };
  }

  let name: string | undefined;
  let status = 'ok';
  let detail: string | undefined;
  const changes: string[] = [];
  const failures: string[] = [];
  const plan: Array<EditTarget & { applied: number; change: number }> = [];
  try {
    const order = (await rest(ctx, `orders/${orderId}.json`)).order;
    name = order.name;
    const ledger = await editCorrections(ctx, orderId);
    const skus = new Map<number, string>();
    const { data: rows } = await ctx.admin.from('shopify_order_edit_lines').select('line_item_id, sku').eq('order_id', orderId);
    for (const r of rows ?? []) skus.set(Number(r.line_item_id), r.sku);
    const targets = editTargets(order, await getSaleOrderDetail(ctx.admin, String(orderId)), ledger);
    if (targets.pending) { status = 'pending'; detail = targets.pending; }
    if (targets.note) { detail = targets.note; if (targets.note.startsWith('none of')) status = 'needs_attention'; }
    for (const t of targets.lines) {
      const sku = t.sku || skus.get(t.line_item_id) || '';
      const applied = ledger.get(t.line_item_id) ?? 0;
      const change = t.required - applied;
      plan.push({ ...t, sku, applied, change });
      if (dry || change === 0) continue;
      const err = await adjustStock(ctx.admin, sku, Math.abs(change), change > 0 ? 'REMOVE' : 'ADD',
        `Shopify ${order.name} edited: ${t.why}`);
      if (err) { failures.push(`${sku}: ${err}`); continue; }
      await ctx.admin.from('shopify_order_edit_lines').upsert({
        order_id: orderId, line_item_id: t.line_item_id, sku, net_removed: t.required, detail: t.why, updated_at: now.toISOString(),
      }, { onConflict: 'order_id,line_item_id' });
      changes.push(`${sku} ${change > 0 ? `−${change}` : `+${-change}`}`);
    }
    if (failures.length) { status = 'needs_attention'; detail = `couldn't correct Unicommerce stock: ${failures.join('; ')}`; }
    else if (changes.length) detail = `Unicommerce stock corrected: ${changes.join(', ')}`;
  } catch (e) {
    status = 'needs_attention';
    detail = e instanceof Error ? e.message : String(e);
  }
  if (!dry) {
    await ctx.admin.from('shopify_order_edits').update({
      ...(name ? { order_name: name } : {}), status, ...(detail ? { detail } : {}),
      checked_at: now.toISOString(), locked_until: null, updated_at: now.toISOString(),
    }).eq('order_id', orderId);
  }
  return { order: name, status, detail, dry, plan: plan.map(p => ({ sku: p.sku, required: p.required, applied: p.applied, change: p.change, why: p.why })) };
}

// The 15-min job: orders waiting for Unicommerce to cancel its copy, and (at
// most hourly) corrections that failed.
async function recheckEdits(ctx: Ctx) {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const { data } = await ctx.admin.from('shopify_order_edits').select('order_id')
    .or(`status.eq.pending,and(status.eq.needs_attention,updated_at.lt.${hourAgo})`);
  const results = [];
  for (const r of data ?? []) results.push(await reconcileEdits(ctx, Number(r.order_id)));
  return results;
}

async function editsOne(ctx: Ctx, orderRef: string, dry: boolean) {
  const name = orderRef.replace(/^#/, '');
  const found = (await rest(ctx, `orders.json?status=any&name=${encodeURIComponent(name)}&fields=id,name`)).orders ?? [];
  const order = found.find((o: any) => String(o.name).replace(/^#/, '') === name);
  if (!order) return { error: `order ${orderRef} not found` };
  return reconcileEdits(ctx, Number(order.id), dry);
}

// ── Shopify + helpers ─────────────────────────────────────────────────────────

async function gql(ctx: Ctx, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`https://${ctx.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  return res.json();
}

async function rest(ctx: Ctx, path: string, body?: unknown) {
  const res = await fetch(`https://${ctx.shop}/admin/api/${API_VERSION}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !body) throw new Error(`Shopify REST ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function verifyHmac(secret: string, body: string, hmacHeader: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return btoa(String.fromCharCode(...new Uint8Array(sig))) === hmacHeader;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
