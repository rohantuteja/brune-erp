// Puts pieces that came back from Shopify orders (RTOs and Return Prime
// returns) into Unicommerce stock. Shared by shopify-order-webhook and
// returnprime-webhook; the callers decide WHETHER a line should go back (their
// rules about the opening stock load, refunds before the switch, rejections),
// this decides HOW.
//
// Unicommerce marks a Shopify order dispatched once Velocity fulfils it, and
// when the order is later cancelled (RTO) or refunded (return) it opens a
// "Courier Returned" return on it, status RETURN_EXPECTED, that waits to be
// received. So for a line Unicommerce shipped:
//   • its return is open      → complete it as good stock (Unicommerce puts the
//                               piece back, closes the return, issues its return
//                               invoice) — tested on #37707, 8 Oct 2026
//   • already received there  → nothing to do; someone received it in Unicommerce
//   • no return yet           → wait; Unicommerce opens it 6–30 min after the
//                               Shopify cancel or refund, and the callers' 15-min
//                               job tries again. After WAIT_LIMIT the piece is
//                               added directly instead.
// Lines Unicommerce never had (an item added to the order after it was
// imported) are skipped, since Unicommerce never took that piece, unless the
// ERP took it out when it corrected the edit (shopify_order_edit_lines,
// migration 012): then it is added back directly. Orders Unicommerce
// doesn't have, or cancelled, and lines it never shipped, get a direct stock
// add as before.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adjustStock, completeReturn, getSaleOrderDetail } from './unicommerce.ts';

export type BackLine = { line_item_id: number; sku: string; qty: number; since: string };
export type Settled = { line_item_id: number; status: 'restocked' | 'waiting' | 'skipped' | 'failed'; detail: string };

const WAIT_LIMIT_MS = 6 * 3_600_000;
export const SHIPPED = new Set(['DISPATCHED', 'DELIVERED', 'REPLACED', 'RESHIPPED']);

export const WAITING_DETAIL = 'back at the warehouse; waiting for Unicommerce to open its return';

export async function settleReturnedLines(
  admin: SupabaseClient, shopifyOrderId: number, lines: BackLine[], remarks: string,
): Promise<Settled[]> {
  const uc = await getSaleOrderDetail(admin, String(shopifyOrderId));
  const add = async (l: BackLine, why: string): Promise<Settled> => {
    let err: string | null;
    try {
      err = await adjustStock(admin, l.sku, l.qty, 'ADD', remarks);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    return { line_item_id: l.line_item_id, status: err ? 'failed' : 'restocked', detail: err ?? why };
  };

  const out: Settled[] = [];
  if (!uc || uc.status === 'CANCELLED') {
    for (const l of lines) out.push(await add(l, 'added to Unicommerce stock'));
    return out;
  }

  // Match each line to Unicommerce's items for it.
  const shipped: Array<{ line: BackLine; codes: string[] }> = [];
  for (const l of lines) {
    const id = String(l.line_item_id);
    const items = uc.items.filter(i => i.code === id || i.code.startsWith(`${id}-`));
    const codes = items.map(i => i.code);
    if (!items.length) {
      const { data: edit } = await admin.from('shopify_order_edit_lines').select('net_removed')
        .eq('order_id', shopifyOrderId).eq('line_item_id', l.line_item_id).maybeSingle();
      out.push(Number(edit?.net_removed ?? 0) > 0
        ? await add(l, 'added to the order after Unicommerce imported it; the ERP had taken it out of stock, so added back')
        : { line_item_id: l.line_item_id, status: 'skipped',
            detail: "not in Unicommerce's copy of the order (added after it was imported), so Unicommerce never took this piece" });
    } else if (items.some(i => SHIPPED.has(i.status)) || uc.returns.some(r => r.items.some(i => codes.includes(i.code)))) {
      shipped.push({ line: l, codes });
    } else {
      out.push(await add(l, 'added to Unicommerce stock (Unicommerce never shipped it)'));
    }
  }
  if (!shipped.length) return out;

  // Settle Unicommerce's returns that cover these lines, whole returns at a time.
  const backCodes = new Set(shipped.flatMap(s => s.codes));
  const outcome = new Map<string, { ok: boolean; already?: boolean; detail: string }>();
  for (const r of uc.returns) {
    const mine = r.items.filter(i => backCodes.has(i.code));
    if (!mine.length) continue;
    if (r.received) {
      for (const i of mine) outcome.set(i.code, { ok: true, already: true, detail: `already received in Unicommerce (return ${r.code})` });
      continue;
    }
    if (r.status !== 'RETURN_EXPECTED') continue;
    if (r.items.some(i => !backCodes.has(i.code))) {
      for (const i of mine) outcome.set(i.code, { ok: false, detail: `Unicommerce return ${r.code} also lists items that aren't back yet — receive it in Unicommerce by hand` });
      continue;
    }
    let err: string | null;
    try {
      err = await completeReturn(admin, String(shopifyOrderId), r.items.map(i => i.code), remarks);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    for (const i of mine) {
      outcome.set(i.code, err
        ? { ok: false, detail: `Unicommerce return ${r.code}: ${err}` }
        : { ok: true, detail: `received Unicommerce return ${r.code} as good stock` });
    }
  }

  for (const { line, codes } of shipped) {
    const done = codes.map(c => outcome.get(c)).filter(Boolean) as Array<{ ok: boolean; already?: boolean; detail: string }>;
    const failed = done.find(d => !d.ok);
    if (failed) {
      out.push({ line_item_id: line.line_item_id, status: 'failed', detail: failed.detail });
    } else if (done.length) {
      out.push({ line_item_id: line.line_item_id, status: done.every(d => d.already) ? 'skipped' : 'restocked', detail: done[0].detail });
    } else if (Date.now() - Date.parse(line.since) > WAIT_LIMIT_MS) {
      out.push(await add(line, 'Unicommerce opened no return within 6 h, so added to stock directly'));
    } else {
      out.push({ line_item_id: line.line_item_id, status: 'waiting', detail: WAITING_DETAIL });
    }
  }
  return out;
}
