// stock-audit v1
// Finds pieces Unicommerce dispatched while it had no stock for them ("sold at
// zero", see ../_shared/backorders.ts) by replaying each SKU from a known
// starting stock, and (on request) takes them out of Unicommerce.
//
// Admin only: POST { since, baseline, manual?, skus?, apply? } with an admin
// user's JWT.
//   since    — when Unicommerce's stock was known to be right (ISO time)
//   baseline — Unicommerce available stock per SKU at `since`
//   manual   — other stock changes since then: [{ sku, at, qty (+ in, − out), why }]
//   skus     — only these SKUs (default: every SKU in baseline)
//   apply    — SKUs whose owed pieces to record (unicommerce_backorders) and
//              take out of Unicommerce; only SKUs whose replay matches it
// Without `apply` it changes nothing.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { ucPost } from '../_shared/unicommerce.ts';
import { SHIPPED } from '../_shared/uc-returns.ts';
import { type AuditEvent, replay, settleOwed } from '../_shared/backorders.ts';

const API_VERSION = '2026-04';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Ctx = { admin: SupabaseClient; shop: string; token: string };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    const { data: profile } = await admin.from('user_profiles').select('role').eq('id', user.id).single();
    if (profile?.role !== 'admin') return json({ error: 'Forbidden: admin only' }, 403);

    const { data: secrets } = await admin.from('private_secrets').select('key, value')
      .in('key', ['shopify_access_token', 'shopify_shop_domain']);
    const secret = (k: string) => secrets?.find(s => s.key === k)?.value as string | undefined;
    const ctx: Ctx = {
      admin,
      shop: secret('shopify_shop_domain') || 'supply-rethought.myshopify.com',
      token: secret('shopify_access_token') ?? '',
    };
    return json(await auditStock(ctx, await req.json()));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

type AuditBody = {
  since: string;                                   // when Unicommerce's stock was known to be right
  baseline: Record<string, number>;                // Unicommerce available stock per SKU at `since`
  manual?: Array<{ sku: string; at: string; qty: number; why: string }>;  // other changes (+ in, − out)
  skus?: string[];                                 // only these SKUs
  apply?: string[];                                // record and take out the owed pieces of these SKUs
};

// Replay every SKU from a known starting stock the way Unicommerce handles it
// (../_shared/backorders.ts, replay): orders from Shopify and Myntra take stock
// or wait for it, batches, RTOs and returns bring stock in and go to waiting
// items first, and a Shopify order shipped while still waiting is owed. A
// SKU's result is only trusted when the replay ends on Unicommerce's actual
// available, reserved and waiting counts. With `apply`, the owed pieces of the
// listed SKUs are recorded (unicommerce_backorders) and taken out.
async function auditStock(ctx: Ctx, body: AuditBody) {
  const since = Date.parse(body.since);
  if (!Number.isFinite(since) || !body.baseline) return { error: 'since and baseline are required' };
  const scope = new Set(body.skus ?? Object.keys(body.baseline));
  const events = new Map<string, AuditEvent[]>();
  const push = (sku: string, e: AuditEvent) => { if (scope.has(sku)) events.set(sku, [...(events.get(sku) ?? []), e]); };
  const units = new Map<string, { code: string; order: string; channel: string }>();
  const warnings: string[] = [];
  const lookback = new Date(since - 10 * 86_400_000).toISOString();

  // Shopify orders. Unicommerce counts a line as imported; an order edit is
  // counted as corrected by the ERP (shopify_order_edit_lines).
  const { data: editRows } = await ctx.admin.from('shopify_order_edit_lines').select('order_id, line_item_id, net_removed');
  const edits = new Map((editRows ?? []).map(r => [`${r.order_id}:${r.line_item_id}`, Number(r.net_removed)]));
  let after: string | null = null;
  do {
    const r: any = await gql(ctx, `query($after: String, $q: String) {
      orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
        pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId name createdAt cancelledAt
          fulfillments(first: 10) { createdAt }
          lineItems(first: 50) { nodes { id sku quantity } } }
      }
    }`, { after, q: `created_at:>=${lookback}` });
    if (r.errors) throw new Error(`Shopify order search failed: ${JSON.stringify(r.errors)}`);
    for (const o of r.data?.orders?.nodes ?? []) {
      const created = Date.parse(o.createdAt);
      const shipped = Math.min(...(o.fulfillments ?? []).map((f: any) => Date.parse(f.createdAt)));
      const cancelled = o.cancelledAt ? Date.parse(o.cancelledAt) : NaN;
      for (const l of o.lineItems?.nodes ?? []) {
        if (!l.sku || !scope.has(l.sku)) continue;
        const lineId = String(l.id).split('/').pop()!;
        const edited = edits.get(`${o.legacyResourceId}:${lineId}`) ?? 0;
        const qty = edited < 0 ? l.quantity + edited : edited > 0 ? edited : l.quantity;
        for (let k = 1; k <= qty; k++) {
          const unit = `${lineId}:${k}`;
          if (created >= since) {
            units.set(unit, { code: String(o.legacyResourceId), order: o.name, channel: 'SHOPIFY' });
            push(l.sku, { at: created, kind: 'order', unit, order: o.name });
            if (Number.isFinite(shipped)) push(l.sku, { at: shipped, kind: 'dispatch', unit });
            else if (Number.isFinite(cancelled)) push(l.sku, { at: cancelled, kind: 'release', unit });
          } else if (!Number.isFinite(shipped) && cancelled >= since) {
            // Held at the start and cancelled later: Unicommerce let the piece go.
            push(l.sku, { at: cancelled, kind: 'add', qty: 1, why: `${o.name} cancelled` });
          }
        }
      }
    }
    after = r.data?.orders?.pageInfo?.hasNextPage ? r.data.orders.pageInfo.endCursor : null;
  } while (after);

  // Myntra orders, from Unicommerce (its own channel; timestamps are the order's).
  const search = await ucPost(ctx.admin, '/services/rest/v1/oms/saleOrder/search', {
    channel: 'MYNTRAPPMP', dateType: 'CREATED', fromDate: lookback, toDate: new Date().toISOString(),
    searchOptions: { displayLength: 500, displayStart: 0 },
  });
  for (const e of search?.elements ?? []) {
    const so = (await ucPost(ctx.admin, '/services/rest/v1/oms/saleorder/get', { code: e.code }))?.saleOrderDTO;
    if (!so) { warnings.push(`Myntra order ${e.code} could not be read`); continue; }
    const created = Number(so.created), updated = Number(so.updated);
    for (const i of so.saleOrderItems ?? []) {
      if (!scope.has(i.itemSku)) continue;
      const unit = `uc:${so.code}:${i.code}`;
      if (created >= since) {
        units.set(unit, { code: String(so.code), order: `Myntra ${so.displayOrderCode}`, channel: 'MYNTRAPPMP' });
        push(i.itemSku, { at: created, kind: 'order', unit, order: `Myntra ${so.displayOrderCode}` });
        if (i.statusCode === 'CANCELLED') push(i.itemSku, { at: updated, kind: 'release', unit });
        else if (SHIPPED.has(i.statusCode) || /RETURN/.test(i.statusCode)) push(i.itemSku, { at: updated, kind: 'dispatch', unit });
      } else if (i.statusCode === 'CANCELLED' && updated >= since) {
        push(i.itemSku, { at: updated, kind: 'add', qty: 1, why: `Myntra ${so.displayOrderCode} cancelled` });
      }
    }
    for (const ret of so.returns ?? []) {
      const at = Number(ret.inventoryReceivedDate ?? ret.returnCompletedDate ?? 0);
      if (!at || at < since) continue;
      for (const ri of ret.returnItems ?? []) {
        const sku = (so.saleOrderItems ?? []).find((x: any) => String(x.code) === String(ri.saleOrderItemCode))?.itemSku;
        if (sku) push(sku, { at, kind: 'add', qty: 1, why: `Myntra ${so.displayOrderCode} return received` });
      }
    }
  }

  // Stock the ERP added or took out since the start.
  const iso = new Date(since).toISOString();
  const { data: synced } = await ctx.admin.from('shopify_batch_inventory_sync').select('batch_id, size, qty, applied, updated_at').gte('updated_at', iso);
  const ids = [...new Set((synced ?? []).map(r => r.batch_id))];
  const { data: batches } = ids.length ? await ctx.admin.from('production_batches').select('id, style_code').in('id', ids) : { data: [] as any[] };
  const style = new Map((batches ?? []).map(b => [b.id, b.style_code]));
  for (const r of synced ?? []) {
    const sku = `${style.get(r.batch_id)}-${r.size}`;
    if (r.applied) push(sku, { at: Date.parse(r.updated_at), kind: 'add', qty: r.qty, why: `batch #${r.batch_id}` });
    else if (scope.has(sku)) warnings.push(`batch #${r.batch_id} ${r.size} was moved back after the start; check it by hand`);
  }
  for (const [table, label] of [['shopify_order_restocks', 'RTO'], ['returnprime_restocks', 'return']] as const) {
    const { data } = await ctx.admin.from(table).select('*').gte('updated_at', iso).in('status', ['restocked', 'skipped']);
    for (const r of data ?? []) {
      const received = r.status === 'restocked' || String(r.detail ?? '').startsWith('already received in Unicommerce');
      if (received) push(r.sku, { at: Date.parse(r.updated_at), kind: 'add', qty: r.qty, why: `${label} ${r.order_name}` });
    }
  }
  const { data: settledRows } = await ctx.admin.from('unicommerce_backorders').select('sku, order_name, updated_at').eq('status', 'settled').gte('updated_at', iso);
  for (const r of settledRows ?? []) push(r.sku, { at: Date.parse(r.updated_at), kind: 'remove', qty: 1, why: `sold at zero ${r.order_name}` });
  for (const m of body.manual ?? []) {
    push(m.sku, m.qty >= 0
      ? { at: Date.parse(m.at), kind: 'add', qty: m.qty, why: m.why }
      : { at: Date.parse(m.at), kind: 'remove', qty: -m.qty, why: m.why });
  }

  // Replay and compare with Unicommerce now.
  const skus = [...scope];
  const actual: Record<string, { available: number; blocked: number; waiting: number }> = {};
  for (let i = 0; i < skus.length; i += 100) {
    const snap = await ucPost(ctx.admin, '/services/rest/v1/inventory/inventorySnapshot/get', { itemTypeSKUs: skus.slice(i, i + 100) });
    for (const s of snap?.inventorySnapshots ?? []) {
      actual[s.itemTypeSKU] = { available: s.inventory ?? 0, blocked: s.inventoryBlocked ?? 0, waiting: s.openSale ?? 0 };
    }
  }
  const results = [];
  let matched = 0;
  for (const sku of skus) {
    const r = replay(body.baseline[sku] ?? 0, events.get(sku) ?? []);
    const a = actual[sku] ?? { available: 0, blocked: 0, waiting: 0 };
    const match = r.available === a.available && r.blocked === a.blocked && r.waiting === a.waiting;
    if (match) matched++;
    if (!match || r.owed.length || r.negative) {
      results.push({
        sku, match, start: body.baseline[sku] ?? 0,
        replay: { available: r.available, blocked: r.blocked, waiting: r.waiting },
        unicommerce: a,
        owed: r.owed.map(o => o.order),
        ...(r.negative ? { note: 'the replay went below zero: an event is missing' } : {}),
        ...(match ? {} : { events: (events.get(sku) ?? []).map(e => `${new Date(e.at).toISOString().slice(0, 16)} ${e.kind}${'qty' in e ? ` ${e.qty}` : ''} ${'why' in e ? e.why : 'order' in e ? e.order : e.unit}`) }),
      });
    }
  }

  // Apply: record the owed pieces of the listed SKUs and take them out.
  const applied = [];
  for (const sku of body.apply ?? []) {
    const row = results.find(r => r.sku === sku);
    if (!row?.match || !row.owed.length) { applied.push({ sku, result: 'not applied: no owed pieces, or the replay doesn\'t match Unicommerce' }); continue; }
    const r = replay(body.baseline[sku] ?? 0, events.get(sku) ?? []);
    const rows = r.owed.map(o => {
      const u = units.get(o.unit)!;
      return {
        sale_order_code: u.code, item_code: `audit:${o.unit}`, order_name: u.order, channel: u.channel, sku,
        status: 'owed', detail: 'found by the stock audit: shipped while Unicommerce had no stock for it',
      };
    });
    const { error } = await ctx.admin.from('unicommerce_backorders').upsert(rows, { onConflict: 'sale_order_code,item_code', ignoreDuplicates: true });
    if (error) { applied.push({ sku, result: `not recorded: ${error.message}` }); continue; }
    applied.push({ sku, result: await settleOwed(ctx.admin, { sku, by: `stock audit ${new Date().toISOString().slice(0, 10)}` }) });
  }

  return { since: new Date(since).toISOString(), skus: skus.length, matched, warnings, results, ...(body.apply ? { applied } : {}) };
}

async function gql(ctx: Ctx, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(`https://${ctx.shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  return res.json();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
