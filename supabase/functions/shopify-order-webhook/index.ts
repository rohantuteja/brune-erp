// shopify-order-webhook v1
// Puts stock back into Unicommerce when pieces come back from Shopify orders,
// and handles RTO orders end to end.
//
// Stock model: every Shopify order is imported into Unicommerce and left open
// there, where it holds (or will take) one piece per unit. So when a piece comes
// back the ERP ADDs it to Unicommerce stock and never touches the Unicommerce order.
//
//   Shopify cancellations before shipping are NOT handled here: Unicommerce
//     cancels its copy of the order itself and releases the held piece (seen on
//     #37715, within a second), so adding a piece too would count it twice.
//   tag rto_delivered (orders/updated) → the parcel is back at the warehouse and
//     every unit goes back, if the order is open in Unicommerce or shipped before
//     the opening stock load (whose Shopify snapshot had already deducted it).
//     Then, when app_settings.rto_shopify_actions is true: cancel the order on
//     Shopify (no refund, customer emailed) and, for prepaid orders, credit the
//     product amount (after discounts, excluding shipping, no expiry) to the
//     customer's store credit with Shopify's store credit email.
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
//   retry    — re-attempt order lines whose Unicommerce update failed

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
      case 'retry':    return json(await retryFailed(ctx));
      default:         return json({ error: 'action must be status, register, dry_run or retry' }, 400);
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

// Store credit for prepaid RTO orders: the product amount after discounts,
// excluding shipping. Anything unusual goes to a person instead.
function planCredit(order: any): { action: 'none' | 'issue' | 'review'; amount?: number; why: string } {
  if (order.financial_status !== 'paid') return { action: 'none', why: `payment status ${order.financial_status}` };
  if (!order.customer?.id) return { action: 'review', why: 'order has no customer to credit' };
  const refunded = (order.refunds ?? [])
    .flatMap((r: any) => r.transactions ?? [])
    .filter((t: any) => t.kind === 'refund' && t.status === 'success')
    .reduce((s: number, t: any) => s + Number(t.amount || 0), 0);
  if (refunded > 0) return { action: 'review', why: `₹${refunded} already refunded on this order` };
  const amount = Number(order.cancelled_at ? order.subtotal_price : (order.current_subtotal_price ?? order.subtotal_price));
  if (!(amount > 0)) return { action: 'review', why: 'could not work out the product amount' };
  return { action: 'issue', amount, why: 'prepaid: products after discounts, excluding shipping' };
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

  const credit = planCredit(order);
  let cancel_status: string;
  let credit_status: string;
  // Recorded even when not issued, so a person can credit it by hand.
  const credit_amount = credit.action === 'issue' ? credit.amount! : null;

  if (!(await shopifyActionsEnabled(ctx))) {
    cancel_status = order.cancelled_at ? 'already_cancelled' : 'disabled';
    credit_status = credit.action === 'none' ? 'not_prepaid' : 'disabled';
    if (credit.action !== 'none') notes.push('store credit not issued automatically (RTO Shopify actions are off)');
  } else {
    if (order.cancelled_at) {
      cancel_status = 'already_cancelled';
    } else {
      const err = await cancelOrder(ctx, order);
      cancel_status = err ? 'failed' : 'cancelled';
      if (err) notes.push(`cancel: ${err}`);
    }
    if (credit.action === 'none') {
      credit_status = 'not_prepaid';
    } else if (credit.action === 'review') {
      credit_status = 'needs_review';
      notes.push(`credit: ${credit.why}`);
    } else if (cancel_status === 'failed') {
      credit_status = 'needs_review';
      notes.push('credit: not issued because the cancel failed');
    } else {
      const r = await issueStoreCredit(ctx, order, credit.amount!);
      credit_status = r.status;
      if (r.error) notes.push(`credit: ${r.error}`);
    }
  }

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

// Cancel without refund or restock; Shopify emails the customer. Returns an error or null.
async function cancelOrder(ctx: Ctx, order: any): Promise<string | null> {
  try {
    const r = await gql(ctx, `mutation($id: ID!, $note: String) {
      orderCancel(orderId: $id, reason: OTHER, restock: false, notifyCustomer: true,
        refundMethod: { originalPaymentMethodsRefund: false }, staffNote: $note) {
        orderCancelUserErrors { message } userErrors { message }
      }
    }`, { id: `gid://shopify/Order/${order.id}`, note: 'RTO delivered — cancelled by Brune ERP' });
    const errs = [...(r.data?.orderCancel?.orderCancelUserErrors ?? []), ...(r.data?.orderCancel?.userErrors ?? []), ...(r.errors ?? [])];
    return errs.length ? errs.map((e: any) => e.message).join('; ') : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// No expiry; notify sends Shopify's store credit email.
async function issueStoreCredit(ctx: Ctx, order: any, amount: number): Promise<{ status: string; error?: string }> {
  try {
    const r = await gql(ctx, `mutation($id: ID!, $input: StoreCreditAccountCreditInput!) {
      storeCreditAccountCredit(id: $id, creditInput: $input) {
        storeCreditAccountTransaction { amount { amount } } userErrors { message }
      }
    }`, {
      id: `gid://shopify/Customer/${order.customer.id}`,
      input: { creditAmount: { amount: amount.toFixed(2), currencyCode: order.currency || 'INR' }, notify: true },
    });
    const errs = [...(r.data?.storeCreditAccountCredit?.userErrors ?? []), ...(r.errors ?? [])];
    if (errs.length) return { status: 'failed', error: errs.map((e: any) => e.message).join('; ') };
    return { status: 'issued' };
  } catch (e) {
    // No response: the credit may or may not exist — a person must check before retrying.
    return { status: 'unknown', error: e instanceof Error ? e.message : String(e) };
  }
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
      cancel: order.cancelled_at ? 'already cancelled' : 'cancel on Shopify, no refund, customer emailed',
      credit: planCredit(order),
      rto_shopify_actions: await shopifyActionsEnabled(ctx),
    } : {}),
  };
}

async function retryFailed(ctx: Ctx) {
  const { data: failed } = await ctx.admin.from('shopify_order_restocks').select('*').eq('status', 'failed');
  const results = [];
  for (const row of failed ?? []) {
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
  return { retried: results.length, results };
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
