// myntra-velocity v1
// Keeps public.myntra_order_lines current: one row per piece of every Myntra order in Unicommerce (channel MYNTRAPPMP),
// so pipeline_health() can add Myntra's sales to Shopify's when it works out the days of stock left (migration 038).
// Rules (which orders to read, how an order becomes rows): _shared/channel-velocity.ts (tested).
//
// Each run:
//   1. searches the Myntra orders created in the last 75 days (30 days of velocity + 45 days in which an old order can still be returned)
//   2. reads from Unicommerce only the orders that need it: new ones, ones Unicommerce says changed, and young ones that could still
//      be returned and were last read over 6 hours ago (a return does not necessarily change the order's own `updated` time)
//   3. saves one row per piece: SKU, order date, cancelled or not, and whether a return is expected or has been received
//   Orders not read in a run (more than 60, or out of time) wait for the next one.
//
// Every Unicommerce call goes through public.uc_post (ucPost), never straight from here. This function only READS Unicommerce.
//
// Schedule: 7 and 37 minutes past every hour (pg_cron, migration 038, header x-cron-key matching private_secrets.erp_stock_cron_key).
//
// Actions (POST { action } with the cron key, or with an admin user's JWT):
//   sync     — the scheduled run; { days? } widens the search (up to 120) for a backfill
//   status   — what is stored and how the last run went
// With the cron key and no action a run is made; with a JWT and no action the status is returned.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CORS, cronKeyValid, json, requireAdmin } from '../_shared/shopify-admin.ts';
import { ucErrorText, ucPost } from '../_shared/unicommerce.ts';
import {
  CHANNEL, DAY_MS, LOOKBACK_DAYS, MAX_FETCH, isOpen, linesFromOrder, ordersToFetch, searchWindows,
  type KnownOrder, type Line,
} from '../_shared/channel-velocity.ts';

// An edge function run is cut off at 150 s: stop reading orders at 100 s so the summary is always saved.
const RUN_BUDGET_MS = 100_000;
const MAX_DAYS = 120;
const LAST_RUN_KEY = 'myntra_velocity_last_run';

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
      return json(await dispatch(admin, { action: 'sync', ...body }));
    }
    const denied = await requireAdmin(admin, req);
    if (denied) return denied;
    return json(await dispatch(admin, { action: 'status', ...body }));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function dispatch(admin: SupabaseClient, body: any) {
  switch (body.action) {
    case 'sync':   return await sync(admin, Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(body.days) || LOOKBACK_DAYS))));
    case 'status': return await status(admin);
    default: throw new Error('action must be sync or status');
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────────────────────

async function sync(admin: SupabaseClient, days: number) {
  const startedAt = Date.now();
  try {
    const fromMs = startedAt - days * DAY_MS;
    const elements = await searchOrders(admin, fromMs, startedAt);
    const known = await knownOrders(admin, fromMs);
    const todo = ordersToFetch(elements, known, startedAt);

    let read = 0, lines = 0;
    const failed: string[] = [];
    const skipped: string[] = [];
    for (const code of todo.slice(0, MAX_FETCH)) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) break;
      let so: any;
      try { so = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code }); }
      catch (err) { so = { successful: false, errors: [{ description: err instanceof Error ? err.message : String(err) }] }; }
      if (!so?.successful || !so.saleOrderDTO) { failed.push(`${code}: ${ucErrorText(so)}`); continue; }

      const parsed = linesFromOrder(so.saleOrderDTO);
      skipped.push(...parsed.skipped);
      if (parsed.lines.length) {
        const now = new Date().toISOString();
        const { error } = await admin.from('myntra_order_lines').upsert(parsed.lines.map(l => ({ ...l, synced_at: now })), { onConflict: 'item_code' });
        if (error) throw new Error(`could not save the pieces of ${code}: ${error.message}`);
      }
      read++;
      lines += parsed.lines.length;
    }

    const summary = {
      at: new Date().toISOString(), ok: true, days, found: elements.length, read, pieces: lines,
      waiting: Math.max(0, todo.length - read - failed.length), failed: failed.slice(0, 5), skipped_items: skipped.slice(0, 10),
      ms: Date.now() - startedAt,
    };
    await record(admin, summary);
    return summary;
  } catch (err) {
    await record(admin, { at: new Date().toISOString(), ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt });
    throw err;
  }
}

async function record(admin: SupabaseClient, value: Record<string, unknown>) {
  await admin.from('app_settings').upsert({ key: LAST_RUN_KEY, value }, { onConflict: 'key' });
}

// Every Myntra order created between the two instants, with the times Unicommerce gives it.
async function searchOrders(admin: SupabaseClient, fromMs: number, toMs: number): Promise<Array<{ code: string; created: number; updated: number }>> {
  const found = new Map<string, { code: string; created: number; updated: number }>();
  for (const [from, to] of searchWindows(fromMs, toMs)) {
    for (let displayStart = 0; ; displayStart += 500) {
      const r = await ucPost(admin, '/services/rest/v1/oms/saleOrder/search', {
        channel: CHANNEL, dateType: 'CREATED', fromDate: new Date(from).toISOString(), toDate: new Date(to).toISOString(),
        searchOptions: { displayLength: 500, displayStart },
      });
      if (!r?.successful) throw new Error(`Unicommerce Myntra order search failed: ${ucErrorText(r)}`);
      for (const e of r.elements ?? []) {
        const created = Number(e.created) || 0;
        found.set(String(e.code), { code: String(e.code), created, updated: Number(e.updated) || created });
      }
      if ((r.elements ?? []).length < 500) break;
    }
  }
  return [...found.values()];
}

// What is already stored for the orders in the range, one entry per order.
async function knownOrders(admin: SupabaseClient, fromMs: number): Promise<Map<string, KnownOrder>> {
  const byOrder = new Map<string, Array<{ ordered_ms: number; updated_ms: number; synced_ms: number } & Pick<Line, 'cancelled' | 'return_state'>>>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('myntra_order_lines')
      .select('order_code, ordered_at, uc_updated_at, synced_at, cancelled, return_state')
      .gte('ordered_at', new Date(fromMs).toISOString()).order('item_code').range(from, from + 999);
    if (error) throw new Error(`could not read the stored pieces: ${error.message}`);
    for (const r of data ?? []) {
      const rows = byOrder.get(r.order_code as string) ?? [];
      rows.push({
        ordered_ms: Date.parse(r.ordered_at as string), updated_ms: Date.parse(r.uc_updated_at as string), synced_ms: Date.parse(r.synced_at as string),
        cancelled: !!r.cancelled, return_state: (r.return_state as Line['return_state']) ?? null,
      });
      byOrder.set(r.order_code as string, rows);
    }
    if ((data ?? []).length < 1000) break;
  }
  const out = new Map<string, KnownOrder>();
  for (const [code, rows] of byOrder) {
    out.set(code, {
      updated_ms: Math.max(...rows.map(r => r.updated_ms)),
      synced_ms: Math.min(...rows.map(r => r.synced_ms)),
      ordered_ms: rows[0].ordered_ms,
      open: isOpen(rows),
    });
  }
  return out;
}

// ── Status ────────────────────────────────────────────────────────────────────────────────────

async function status(admin: SupabaseClient) {
  const count = async (apply: (q: any) => any) => {
    const { count: n, error } = await apply(admin.from('myntra_order_lines').select('item_code', { count: 'exact', head: true }));
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const edge = async (ascending: boolean) => {
    const { data } = await admin.from('myntra_order_lines').select('ordered_at').order('ordered_at', { ascending }).limit(1);
    return data?.[0]?.ordered_at ?? null;
  };
  const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const { data: last } = await admin.from('app_settings').select('value').eq('key', LAST_RUN_KEY).maybeSingle();
  return {
    pieces: await count(q => q),
    cancelled: await count(q => q.eq('cancelled', true)),
    return_expected: await count(q => q.eq('return_state', 'expected')),
    return_received: await count(q => q.eq('return_state', 'received')),
    sold_last_30_days: await count(q => q.eq('cancelled', false).gte('ordered_at', since30)),
    first_order: await edge(true),
    last_order: await edge(false),
    last_run: last?.value ?? null,
  };
}
