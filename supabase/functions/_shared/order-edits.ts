// What the ERP's stock correction should be for each line of an edited Shopify
// order (see shopify-order-webhook: "Order edits"). Unicommerce imports an
// order once and never sees later edits, then dispatches its own copy when
// Velocity ships, so its stock is off by the difference between what the
// customer gets and what its copy holds.

import type { UcOrder } from './unicommerce.ts';
import { SHIPPED } from './uc-returns.ts';

export type EditTarget = { line_item_id: number; sku: string; required: number; why: string };

// Shopify snapshot behind the opening Unicommerce stock load (29 Sep 2026, 22:37:59 IST).
const STOCK_LOAD_CUTOFF = Date.parse('2026-09-29T17:07:59Z');

// What the ERP's correction should be per line. Unicommerce's copy accounts for
// its items that aren't cancelled (held, or taken out when dispatched); Shopify
// says what the customer actually gets: the current quantity plus anything
// returned since (refunds other than cancelling an unshipped item). The
// difference is the ERP's correction: positive = take out, negative = put back.
//
// Shopify also marks an order edited when a refund removes an item, so every
// Return Prime return shows up here; for those the two sides agree.
export function editTargets(order: any, uc: UcOrder | null, ledger: Map<number, number>):
  { lines: EditTarget[]; pending?: string; note?: string } {
  if (!uc) return { lines: [], note: 'order not in Unicommerce, which never counted it' };
  // The opening stock load came from Shopify's own stock, which already
  // reflected these orders as they were then.
  if (Date.parse(order.created_at) < STOCK_LOAD_CUTOFF && !ledger.size) {
    return { lines: [], note: 'placed before the opening stock load, so not corrected' };
  }
  // Unicommerce cancelled its copy, so it holds and has taken out nothing for
  // this order (cancelled before shipping, or refunded before it ever shipped
  // it): undo any corrections. Seen on Return Prime refunds of orders shipped
  // before Unicommerce took over (#37654).
  if (uc.status === 'CANCELLED') {
    return { lines: [...ledger.keys()].map(id => ({ line_item_id: id, sku: '', required: 0, why: 'Unicommerce cancelled its copy of the order' })) };
  }
  if (order.cancelled_at) {
    // Shipped (an RTO): the corrections stay; the returns flow puts pieces back.
    if (uc.items.some(i => SHIPPED.has(i.status))) return { lines: [] };
    return { lines: [], pending: 'cancelled on Shopify; waiting for Unicommerce to cancel its copy' };
  }
  const returned = new Map<number, number>();
  for (const rf of order.refunds ?? []) {
    for (const rli of rf.refund_line_items ?? []) {
      if (rli.restock_type === 'cancel') continue;
      returned.set(Number(rli.line_item_id), (returned.get(Number(rli.line_item_id)) ?? 0) + Number(rli.quantity ?? 0));
    }
  }
  const lines: EditTarget[] = [];
  let matched = 0;
  for (const l of order.line_items ?? []) {
    if (!l.sku || l.gift_card) continue;
    const id = String(l.id);
    const ucActive = uc.items.filter(i => (i.code === id || i.code.startsWith(`${id}-`)) && i.status !== 'CANCELLED').length;
    matched += ucActive;
    const required = Number(l.current_quantity ?? l.quantity) + (returned.get(Number(l.id)) ?? 0) - ucActive;
    lines.push({
      line_item_id: Number(l.id), sku: l.sku, required,
      why: required > 0 ? `${required} added after Unicommerce imported the order`
        : required < 0 ? `${-required} removed after Unicommerce imported the order` : 'matches Unicommerce',
    });
  }
  // Guard: if none of Unicommerce's items match a Shopify line, the codes don't
  // line up the way we expect; correcting would take out the whole order twice.
  if (!matched && uc.items.some(i => i.status !== 'CANCELLED')) {
    return { lines: [], note: "none of Unicommerce's items match this order's Shopify lines — check it by hand" };
  }
  return { lines };
}
