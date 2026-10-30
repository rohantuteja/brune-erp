// Myntra sales per SKU, for the Pipeline Health velocity. Tested in channel-velocity.test.ts.
//
// Stock is one pool that Unicommerce pushes to Shopify and Myntra, so the days of stock left have to be divided by the
// sales of BOTH channels. Shopify's sales come from ShopifyQL (shopify-sync); Myntra's come from Unicommerce, one row per
// piece in public.myntra_order_lines, read by the myntra-velocity function. pipeline_health() adds the two.
//
// What counts is what Shopify's own "net items sold" counts:
//   • a piece is sold on the day its order was placed (UC `created`), unless the piece was cancelled;
//   • a returned piece is taken off again on the day it is received back at the warehouse. A return that is only expected
//     (the courier is allocated, the parcel is on its way) is not taken off yet: that piece is not back on the shelf, so the
//     stock it would be divided into has not got it back either.

import { CHANNEL } from './myntra-fulfil.ts';

export { CHANNEL };

export const DAY_MS = 86_400_000;
export const SEARCH_WINDOW_MS = 30 * DAY_MS;      // Unicommerce's order search takes at most 31 days
export const LOOKBACK_DAYS = 75;                  // the 30-day velocity window + 45 days in which an old order can still come back
export const RETURN_WATCH_DAYS = 45;              // an order this young can still be returned, so it is read again now and then
export const REFRESH_MS = 6 * 3_600_000;          // ...at most this often
export const MAX_FETCH = 60;                      // orders read from Unicommerce in one run

export type ReturnState = 'expected' | 'received';

export type Line = {
  item_code: string;
  order_code: string;
  sku: string;
  style_code: string;
  size: string;
  ordered_at: string;                             // ISO
  cancelled: boolean;
  return_state: ReturnState | null;               // null: no return
  returned_at: string | null;                     // ISO, only when received
  uc_updated_at: string;                          // ISO: the order's `updated` when it was read
};

const iso = (ms: number) => new Date(ms).toISOString();

/** "TARA-WHITE-DRESS-51-M" → { style_code: "TARA-WHITE-DRESS-51", size: "M" }: split on the last dash, as shopify-sync does. */
export function splitSku(sku: unknown): { style_code: string; size: string } | null {
  const parts = String(sku ?? '').trim().split('-');
  if (parts.length < 2) return null;
  const size = parts[parts.length - 1].trim();
  const style_code = parts.slice(0, -1).join('-').trim();
  return size && style_code ? { style_code, size } : null;
}

/**
 * One row per piece of a Unicommerce Myntra order (`saleOrderDTO` from oms/saleorder/get).
 * `skipped` names the items whose SKU is not "style-size", so they are not silently lost.
 */
export function linesFromOrder(so: any): { lines: Line[]; skipped: string[] } {
  const orderedMs = Number(so?.created);
  if (!so?.code || !Number.isFinite(orderedMs) || orderedMs <= 0) return { lines: [], skipped: [] };
  const updatedMs = Number(so.updated) > 0 ? Number(so.updated) : orderedMs;

  const received = new Map<string, number>();     // item code → when its return arrived back
  const expected = new Set<string>();
  for (const r of so.returns ?? []) {
    if (r.statusCode === 'CANCELLED') continue;
    const doneMs = Number(r.inventoryReceivedDate) || Number(r.returnCompletedDate) || 0;
    const isReceived = doneMs > 0 || r.statusCode === 'RETURNED';
    for (const ri of r.returnItems ?? []) {
      const code = String(ri.saleOrderItemCode);
      if (isReceived) received.set(code, doneMs || updatedMs);
      else expected.add(code);
    }
  }

  const lines: Line[] = [];
  const skipped: string[] = [];
  for (const it of so.saleOrderItems ?? []) {
    const sku = String(it.itemSku ?? it.sellerSkuCode ?? '').trim();
    const parts = splitSku(sku);
    if (!parts) { skipped.push(String(it.code)); continue; }
    const code = String(it.code);
    const cancelled = it.statusCode === 'CANCELLED';
    // An item Unicommerce itself marks RETURNED counts as received even if the return record carries no date.
    const receivedMs = cancelled ? undefined : (received.get(code) ?? (it.statusCode === 'RETURNED' ? updatedMs : undefined));
    lines.push({
      item_code: code,
      order_code: String(so.code),
      sku,
      ...parts,
      ordered_at: iso(orderedMs),
      cancelled,
      return_state: cancelled ? null : receivedMs ? 'received' : expected.has(code) ? 'expected' : null,
      returned_at: receivedMs ? iso(receivedMs) : null,
      uc_updated_at: iso(updatedMs),
    });
  }
  return { lines, skipped };
}

/** What the database already holds about one order, to decide whether it must be read again. */
export type KnownOrder = { updated_ms: number; synced_ms: number; ordered_ms: number; open: boolean };

/** An order is "open" while one of its pieces could still be returned or have its return received. */
export function isOpen(rows: Array<Pick<Line, 'cancelled' | 'return_state'>>): boolean {
  return rows.some(r => !r.cancelled && r.return_state !== 'received');
}

/**
 * Which orders to read from Unicommerce, most important first:
 *   1. orders the database has never seen;
 *   2. orders Unicommerce says changed since they were read;
 *   3. orders that could still be returned (younger than RETURN_WATCH_DAYS) and were last read over REFRESH_MS ago,
 *      the longest-unread first. Unicommerce does not necessarily touch an order's `updated` when a return arrives.
 * `elements` are the search results ({ code, created, updated } in epoch ms).
 */
export function ordersToFetch(
  elements: Array<{ code: string; created: number; updated: number }>,
  known: Map<string, KnownOrder>,
  nowMs: number,
): string[] {
  const fresh: Array<{ code: string; at: number }> = [];
  const changed: Array<{ code: string; at: number }> = [];
  const stale: Array<{ code: string; at: number }> = [];
  for (const e of elements) {
    const k = known.get(e.code);
    if (!k) fresh.push({ code: e.code, at: e.created });
    else if (e.updated > k.updated_ms) changed.push({ code: e.code, at: e.created });
    else if (k.open && nowMs - k.ordered_ms <= RETURN_WATCH_DAYS * DAY_MS && nowMs - k.synced_ms > REFRESH_MS) stale.push({ code: e.code, at: k.synced_ms });
  }
  fresh.sort((a, b) => b.at - a.at);              // newest orders first: they are the ones inside the velocity window
  changed.sort((a, b) => b.at - a.at);
  stale.sort((a, b) => a.at - b.at);              // longest unread first
  return [...fresh, ...changed, ...stale].map(x => x.code);
}

/** Search windows of at most SEARCH_WINDOW_MS covering [fromMs, toMs]. */
export function searchWindows(fromMs: number, toMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = fromMs; start < toMs; start += SEARCH_WINDOW_MS) out.push([start, Math.min(start + SEARCH_WINDOW_MS, toMs)]);
  return out;
}
