// Order items Unicommerce took without stock ("sold at zero").
//
// Products set to keep selling at 0 on Shopify (inventory policy CONTINUE) take
// orders Unicommerce has no stock for. Unicommerce can't go negative: it keeps
// such an item waiting (UNFULFILLABLE, counted in its openSale) and pushes 0
// back to Shopify. When stock comes in it gives it to the waiting items first.
// But Velocity fulfils the order on Shopify as soon as the piece ships, and
// Unicommerce then marks the waiting item DISPATCHED without taking anything
// out: the piece that left is never deducted, and the next batch is added in
// full (Kira Blue L, Oct 2026: 6 too many).
//
// The ERP follows those items (unicommerce_backorders, migration 015):
//   waiting — Unicommerce has no stock for it yet
//   covered — Unicommerce gave it stock; nothing more to do
//   owed    — dispatched while still waiting: the piece left uncounted
//   settled — taken out of Unicommerce stock once there was stock to take
//   closed  — cancelled while waiting
// Owed pieces are taken out as soon as the SKU has stock again: right after a
// batch is added (batch-sync.ts), or by the 15-min job (after a return, or a
// change made in Unicommerce). Until then they're the SKU's negative stock.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, stockSnapshot, ucErrorText, ucPost } from './unicommerce.ts';
import { SHIPPED } from './uc-returns.ts';

const WAITING = 'UNFULFILLABLE';
// How far back the job looks for newly imported orders. A waiting item only
// has to be seen once; Velocity ships the next day at the earliest.
const RECENT_DAYS = 2;

type UcItem = { code: string; sku: string; status: string };
type UcOrderItems = { code: string; displayCode: string; channel: string; status: string; items: UcItem[] };

async function orderItems(admin: SupabaseClient, code: string): Promise<UcOrderItems | null> {
  const data = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code });
  const so = data?.successful ? data.saleOrderDTO : null;
  if (!so) {
    if ((data?.errors ?? []).some((e: any) => e.message === 'INVALID_SALE_ORDER_CODE')) return null;
    throw new Error(`Unicommerce order lookup failed: ${ucErrorText(data)}`);
  }
  return {
    code: so.code, displayCode: so.displayOrderCode, channel: so.channel, status: so.status,
    items: (so.saleOrderItems ?? []).map((i: any) => ({ code: String(i.code), sku: i.itemSku, status: i.statusCode })),
  };
}

// Codes of orders created in the last `days` days that aren't finished.
async function openRecentOrders(admin: SupabaseClient, days: number): Promise<string[]> {
  const now = new Date();
  const codes: string[] = [];
  for (const status of ['CREATED', 'PROCESSING']) {
    const data = await ucPost(admin, '/services/rest/v1/oms/saleOrder/search', {
      status, dateType: 'CREATED',
      fromDate: new Date(now.getTime() - days * 86_400_000).toISOString(), toDate: now.toISOString(),
      searchOptions: { displayLength: 500, displayStart: 0 },
    });
    if (!data?.successful) throw new Error(`Unicommerce order search failed: ${ucErrorText(data)}`);
    codes.push(...(data.elements ?? []).map((e: any) => String(e.code)));
  }
  return [...new Set(codes)];
}

const nextStatus = (ucStatus: string): 'waiting' | 'covered' | 'owed' | 'closed' =>
  ucStatus === WAITING ? 'waiting'
    : ucStatus === 'CANCELLED' ? 'closed'
    : SHIPPED.has(ucStatus) ? 'owed'
    : 'covered';

// Record items waiting for stock in recently imported orders, then move every
// waiting item on (covered / owed / closed). With `sku`, only that SKU's
// waiting items are re-checked (right after stock was added for it).
export async function trackBackorders(admin: SupabaseClient, opts: { sku?: string; days?: number } = {}) {
  const now = new Date().toISOString();
  const found: string[] = [];
  if (!opts.sku) {
    for (const code of await openRecentOrders(admin, opts.days ?? RECENT_DAYS)) {
      const o = await orderItems(admin, code);
      const rows = (o?.items ?? []).filter(i => i.status === WAITING).map(i => ({
        sale_order_code: o!.code, item_code: i.code, order_name: o!.displayCode, channel: o!.channel,
        sku: i.sku, status: 'waiting', uc_status: i.status, detail: 'no stock in Unicommerce when the order came in',
      }));
      if (!rows.length) continue;
      const { data } = await admin.from('unicommerce_backorders')
        .upsert(rows, { onConflict: 'sale_order_code,item_code', ignoreDuplicates: true }).select('order_name, sku');
      found.push(...(data ?? []).map(r => `${r.order_name} ${r.sku}`));
    }
  }

  let q = admin.from('unicommerce_backorders').select('*').eq('status', 'waiting');
  if (opts.sku) q = q.eq('sku', opts.sku);
  const { data: waiting } = await q;
  const moved: string[] = [];
  for (const code of [...new Set((waiting ?? []).map(w => w.sale_order_code))]) {
    const o = await orderItems(admin, code);
    for (const w of (waiting ?? []).filter(x => x.sale_order_code === code)) {
      const item = o?.items.find(i => i.code === w.item_code);
      const status = item ? nextStatus(item.status) : 'closed';
      if (status === 'waiting') continue;
      const detail = status === 'owed' ? 'dispatched while Unicommerce had no stock for it, so the piece was never taken out'
        : status === 'covered' ? 'Unicommerce gave it stock'
        : item ? 'cancelled while waiting for stock' : 'no longer in Unicommerce';
      await admin.from('unicommerce_backorders').update({ status, uc_status: item?.status ?? null, detail, updated_at: now })
        .eq('sale_order_code', w.sale_order_code).eq('item_code', w.item_code).eq('status', 'waiting');
      moved.push(`${w.order_name} ${w.sku} → ${status}`);
    }
  }
  return { found, moved };
}

// Take owed pieces out of Unicommerce wherever the SKU has stock again, oldest
// first. Each settled row records what it was settled by.
export async function settleOwed(admin: SupabaseClient, opts: { sku?: string; by?: string; dry?: boolean } = {}) {
  let q = admin.from('unicommerce_backorders').select('*').eq('status', 'owed').order('updated_at');
  if (opts.sku) q = q.eq('sku', opts.sku);
  const { data: owed } = await q;
  if (!owed?.length) return [];
  const bySku = new Map<string, any[]>();
  for (const r of owed) bySku.set(r.sku, [...(bySku.get(r.sku) ?? []), r]);
  const stock = await stockSnapshot(admin, [...bySku.keys()]);
  const results = [];
  for (const [sku, rows] of bySku) {
    const n = Math.min(rows.length, stock[sku]?.available ?? 0);
    if (!n) { results.push({ sku, owed: rows.length, settled: 0, note: 'no stock to take it from yet' }); continue; }
    const take = rows.slice(0, n);
    if (opts.dry) { results.push({ sku, owed: rows.length, settled: n, dry: true }); continue; }
    const orders = take.map(r => r.order_name).join(', ');
    const err = await adjustStock(admin, sku, n, 'REMOVE', `Sold at zero, shipped before its stock was added: ${orders}`);
    if (err) { results.push({ sku, owed: rows.length, settled: 0, error: err }); continue; }
    const now = new Date().toISOString();
    for (const r of take) {
      await admin.from('unicommerce_backorders').update({
        status: 'settled', settled_by: opts.by ?? 'stock was back in Unicommerce', updated_at: now,
      }).eq('sale_order_code', r.sale_order_code).eq('item_code', r.item_code).eq('status', 'owed');
    }
    results.push({ sku, owed: rows.length, settled: n });
  }
  return results;
}

// ── Audit: replay what Unicommerce did ───────────────────────────────────────
//
// Replays a SKU's events in time order the way Unicommerce handles them, from
// a known starting stock: orders take stock (or wait for it), stock coming in
// goes to waiting items first, and a waiting item that is dispatched is
// "owed". The replay's end state must match Unicommerce's actual stock before
// its owed list is trusted.

export type AuditEvent =
  | { at: number; kind: 'order'; unit: string; order: string }        // order item imported
  | { at: number; kind: 'dispatch'; unit: string }                    // shipped
  | { at: number; kind: 'release'; unit: string }                     // cancelled before shipping
  | { at: number; kind: 'add'; qty: number; why: string }             // stock in
  | { at: number; kind: 'remove'; qty: number; why: string };         // stock out (not an order)

export type AuditResult = {
  available: number; blocked: number; waiting: number;
  owed: Array<{ unit: string; order: string }>;
  negative: boolean;   // the replay took out more than there was
};

const ORDER_OF = { order: 0, add: 1, remove: 2, release: 3, dispatch: 4 } as const;

export function replay(start: number, events: AuditEvent[]): AuditResult {
  let available = start, blocked = 0, negative = false;
  const queue: string[] = [];                 // waiting units, oldest first
  const allocated = new Set<string>();
  const orderOf = new Map<string, string>();
  const owed: Array<{ unit: string; order: string }> = [];
  const fill = () => {
    while (available > 0 && queue.length) {
      allocated.add(queue.shift()!);
      available--; blocked++;
    }
  };
  const sorted = [...events].sort((a, b) => a.at - b.at || ORDER_OF[a.kind] - ORDER_OF[b.kind]);
  for (const e of sorted) {
    if (e.kind === 'order') {
      orderOf.set(e.unit, e.order);
      if (available > 0) { allocated.add(e.unit); available--; blocked++; } else queue.push(e.unit);
    } else if (e.kind === 'add') {
      available += e.qty; fill();
    } else if (e.kind === 'remove') {
      available -= e.qty; if (available < 0) negative = true;
    } else if (e.kind === 'dispatch' || e.kind === 'release') {
      if (allocated.delete(e.unit)) {
        blocked--;
        if (e.kind === 'release') { available++; fill(); }
      } else {
        const i = queue.indexOf(e.unit);
        if (i < 0) continue;            // not an order the replay knows (before the start)
        queue.splice(i, 1);
        if (e.kind === 'dispatch') owed.push({ unit: e.unit, order: orderOf.get(e.unit) ?? '' });
      }
    }
  }
  return { available, blocked, waiting: queue.length, owed, negative };
}
