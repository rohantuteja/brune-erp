// shopify-order-webhook v4
// Puts stock back into Unicommerce when pieces come back from Shopify orders,
// and handles RTO orders end to end.
//
// Stock model: every Shopify order is imported into Unicommerce, which holds a
// piece per unit and takes it out of stock when it marks the order dispatched
// (a daily batch). So when a piece comes back the ERP ADDs it to Unicommerce
// stock and never touches the Unicommerce order. After an RTO cancel Unicommerce
// opens a "Courier Returned" return that waits to be received; receiving it in
// Unicommerce as well would count the piece twice (seen on #37707, 5 Oct 2026).
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
// Test mode: until app_settings.order_webhook_mode is "live", only orders
// tagged erp-test are processed; every other order is ignored.
//
// Exactly-once: shopify_order_restocks (per order line) and shopify_rto_orders
// (per RTO order) are claimed before anything is changed — see migration 004.
// Orders already tagged rto_delivered at go-live are 'baseline' rows and are
// never processed. Webhooks are answered at once and processed in the
// background, inside Shopify's 5-second limit.
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

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, getSaleOrder } from '../_shared/unicommerce.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const API_VERSION = '2026-04';
const WEBHOOK_URL = 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-order-webhook';
const TOPICS = ['orders/updated', 'orders/cancelled'];
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
      default:         return json({ error: 'action must be status, register, dry_run, retry or cancel' }, 400);
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
// handleRto (the claim makes it a no-op). Other cancellations are Unicommerce's.
async function handleOrderEvent(ctx: Ctx, _topic: string, order: any) {
  if (!hasTag(order, TEST_TAG) && !(await isLive(ctx))) return;
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
    .map((l: any) => ({
      line_item_id: l.id,
      sku: l.sku,
      // Before cancellation current_quantity reflects order edits; cancelling zeroes it.
      qty: order.cancelled_at ? l.quantity : (l.current_quantity ?? l.quantity),
      add,
      why,
    }))
    .filter((l: LinePlan) => l.qty > 0);
}

// ── Applying ──────────────────────────────────────────────────────────────────

async function applyLines(ctx: Ctx, order: any, reason: Reason, lines: LinePlan[]) {
  const results = [];
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
    results.push({ ...l, result: await restockClaimedLine(ctx, order.id, order.name, reason, l) });
  }
  return results;
}

async function restockClaimedLine(ctx: Ctx, orderId: number, orderName: string, reason: Reason, l: LinePlan) {
  let status: 'restocked' | 'skipped' | 'failed' = 'skipped';
  let detail = l.why;
  if (l.add) {
    let err: string | null;
    try {
      err = await adjustStock(ctx.admin, l.sku, l.qty, 'ADD',
        `Shopify ${orderName} ${reason === 'rto' ? 'RTO received' : 'cancelled before shipping'}`);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    status = err ? 'failed' : 'restocked';
    if (err) detail = err;
  }
  await ctx.admin
    .from('shopify_order_restocks')
    .update({ status, detail, updated_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .eq('line_item_id', l.line_item_id);
  return status;
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
  return { baselined, registered };
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
  const { data: failed } = await ctx.admin.from('shopify_order_restocks').select('*').eq('status', 'failed');
  const results = [];
  for (const row of failed ?? []) {
    if (dry) { results.push({ order: row.order_name, sku: row.sku, qty: row.qty, result: 'would retry' }); continue; }
    // Re-claim atomically: only one retry may move a failed row back to claimed.
    const { data: reclaimed } = await ctx.admin.from('shopify_order_restocks')
      .update({ status: 'claimed', updated_at: new Date().toISOString() })
      .eq('order_id', row.order_id).eq('line_item_id', row.line_item_id).eq('status', 'failed')
      .select('order_id');
    if (!reclaimed?.length) continue;
    const result = await restockClaimedLine(ctx, row.order_id, row.order_name, row.reason, {
      line_item_id: row.line_item_id, sku: row.sku, qty: row.qty, add: true, why: row.detail,
    });
    results.push({ order: row.order_name, sku: row.sku, qty: row.qty, result });
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
