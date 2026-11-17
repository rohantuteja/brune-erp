// Myntra returns: which of an order's returns are back with us, so the ERP can receive them in Unicommerce.
// Pure rules, no network (tested: node --test supabase/functions/_shared/myntra-returns.test.ts).
//
// Myntra orders live in Unicommerce (channel MYNTRAPPMP). When one comes back Unicommerce holds a return on it that stays
// open until someone receives it, and nobody was: the piece never went back into stock and no return invoice (credit note)
// was issued. Two kinds, as Unicommerce names them:
//   "Courier Returned"  the parcel came back undelivered (RTO), status RETURN_EXPECTED, tracking RTO_*
//   "Customer Returned" the customer sent it back, status COURIER_ALLOCATED, tracking CIR_*  (reverse pickup, code RPxxxx)
// Myntra's tracking tells where the parcel is. These two mean it has been handed back to us:
//   RTO_DELIVERED_TO_SELLER, CIR_DELIVERED_TO_SELLER
// Everything else (pickup arranged, RTO initiated, status not defined, anything new) waits.
//
// The owner's rule (17 Nov 2026): the team is small and cannot check every parcel, so whatever the courier has brought back
// is received at once as good stock; a wrong or damaged piece is the odd case and is fixed by hand afterwards.

export const BACK_STATUSES = new Set(['CIR_DELIVERED_TO_SELLER', 'RTO_DELIVERED_TO_SELLER']);
/** What a return that is still open is called in Unicommerce. Anything else is not touched. */
export const OPEN_RETURN_STATUSES = new Set(['RETURN_EXPECTED', 'COURIER_ALLOCATED']);
/** An item that left the warehouse and has not come back. */
export const OUT_ITEM_STATUSES = new Set(['DISPATCHED', 'DELIVERED']);

export const MAX_ATTEMPTS = 5;
/** A claim older than this is a run that died halfway: Unicommerce is asked what happened before anything is tried again. */
export const CLAIM_STALE_MS = 10 * 60_000;

export type ReturnKind = 'rto' | 'customer';
export type ReturnItem = { code: string; sku: string; status: string };
export type OpenReturn = {
  code: string;
  kind: ReturnKind;
  ucStatus: string;
  tracking: string;
  awb: string | null;
  courier: string | null;
  items: ReturnItem[];
};

export type Reading = {
  /** Back with us and open in Unicommerce: to be received. */
  receive: OpenReturn[];
  /** Still on its way (or in a state we do not know): left alone. */
  waiting: OpenReturn[];
  /** Back, but something does not look right, so a person decides. */
  attention: Array<{ code: string; reason: string; ret?: OpenReturn }>;
  /** Returns already received in Unicommerce (by anyone): their codes, so a log row that says otherwise can be closed. */
  receivedCodes: string[];
  received: number;
};

export const kindOf = (type: unknown): ReturnKind => (/courier/i.test(String(type ?? '')) ? 'rto' : 'customer');

/** Has Unicommerce received this return record? (the same test the ledger and the velocity job use) */
export function isReceivedReturn(r: any): boolean {
  return r?.statusCode === 'RETURNED' || !!r?.inventoryReceivedDate || !!r?.returnCompletedDate;
}

/** Sort an order's returns (`saleOrderDTO` from oms/saleorder/get) into received, to receive now, waiting and needs a person. */
export function readReturns(so: any): Reading {
  const out: Reading = { receive: [], waiting: [], attention: [], receivedCodes: [], received: 0 };
  const items: any[] = so?.saleOrderItems ?? [];
  const itemByCode = new Map(items.map(i => [String(i.code), i]));
  const claimed = new Set<string>();

  for (const r of so?.returns ?? []) {
    if (r?.statusCode === 'CANCELLED') continue;
    if (isReceivedReturn(r)) { out.received++; out.receivedCodes.push(String(r.code ?? '')); continue; }

    const code = String(r?.code ?? '');
    const kind = kindOf(r?.type);
    const ret: OpenReturn = {
      code, kind,
      ucStatus: String(r?.statusCode ?? ''),
      tracking: String(r?.trackingStatus ?? ''),
      awb: r?.trackingNumber ? String(r.trackingNumber) : null,
      courier: r?.shippingProvider ? String(r.shippingProvider) : null,
      items: (r?.returnItems ?? []).map((ri: any) => {
        const it = itemByCode.get(String(ri.saleOrderItemCode));
        return { code: String(ri.saleOrderItemCode), sku: String(ri.itemSku ?? it?.itemSku ?? ''), status: String(it?.statusCode ?? 'UNKNOWN') };
      }),
    };

    if (!BACK_STATUSES.has(ret.tracking)) { out.waiting.push(ret); continue; }

    // It is back. Receive it only when everything about it is as expected; otherwise a person looks.
    const why = problem(ret, itemByCode, claimed);
    if (why) { out.attention.push({ code, reason: why, ret }); continue; }
    ret.items.forEach(i => claimed.add(i.code));
    out.receive.push(ret);
  }
  return out;
}

function problem(ret: OpenReturn, itemByCode: Map<string, any>, claimed: Set<string>): string | null {
  if (!ret.code) return 'the return has no code';
  if (!OPEN_RETURN_STATUSES.has(ret.ucStatus)) return `Unicommerce shows the return as ${ret.ucStatus || 'unknown'}, which is not one this job receives`;
  // RTO_* belongs to a Courier Returned return and CIR_* to a Customer Returned one: a mix-up means Myntra's data is odd.
  const wanted = ret.kind === 'rto' ? 'RTO_DELIVERED_TO_SELLER' : 'CIR_DELIVERED_TO_SELLER';
  if (ret.tracking !== wanted) return `a ${ret.kind === 'rto' ? 'Courier Returned' : 'Customer Returned'} return with tracking ${ret.tracking}`;
  if (!ret.items.length) return 'the return lists no items';
  for (const i of ret.items) {
    if (!itemByCode.has(i.code)) return `item ${i.code} of the return is not on the order`;
    if (!OUT_ITEM_STATUSES.has(i.status)) return `item ${i.code} is ${i.status} in Unicommerce, not dispatched or delivered`;
    if (claimed.has(i.code)) return `item ${i.code} is on two open returns`;
  }
  return null;
}

/** What Unicommerce shows in the stock-movement note, 100 characters at most (the receive call cuts it there). */
export function remarksFor(ret: OpenReturn): string {
  return `Auto: Myntra ${ret.kind === 'rto' ? 'RTO' : 'return'} ${ret.code} delivered to seller${ret.awb ? ` ${ret.awb}` : ''}`.slice(0, 100);
}

/** After the receive call: did Unicommerce really take this return? Read from a fresh copy of the order. */
export function receivedIn(so: any, ret: Pick<OpenReturn, 'code' | 'items'>): boolean {
  const rec = (so?.returns ?? []).find((r: any) => String(r.code) === ret.code);
  if (rec && isReceivedReturn(rec)) return true;
  const byCode = new Map<string, any>((so?.saleOrderItems ?? []).map((i: any) => [String(i.code), i]));
  return ret.items.length > 0 && ret.items.every(i => byCode.get(i.code)?.statusCode === 'RETURNED');
}

/** The return invoice (credit note) number Unicommerce shows for a return, once it exists. */
export function returnInvoiceOf(so: any, code: string): string | null {
  const rec = (so?.returns ?? []).find((r: any) => String(r.code) === code);
  return rec?.returnInvoiceDisplayCode ? String(rec.returnInvoiceDisplayCode) : null;
}

// ── The list of returns still on their way ────────────────────────────────────────────────────
// Analytics → Myntra → Myntra returns → "Pieces with a return open". Every sweep keeps one row per open return in
// myntra_open_returns (tracking, parcel, pieces); when Myntra opened it and why the customer sent it back come from
// Unicommerce's oms/return/get, asked once per return (the answer does not change) so a run stays short.

/** What to ask oms/return/get for one return: a customer return by its reverse pickup code, an RTO by its shipment code (its own code). */
export function detailRequest(ret: Pick<OpenReturn, 'code' | 'kind'>): Record<string, string> {
  return ret.kind === 'customer' ? { reversePickupCode: ret.code } : { shipmentCode: ret.code };
}

/** Unicommerce writes these dates as 'YYYY-MM-DD HH:MM:SS' in Indian time (checked against the delivery challan's epoch, 17 Nov 2026). */
export function istToIso(s: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s ?? '').trim());
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export type ReturnDetail = { openedAt: string | null; reason: string | null };

/** The date Myntra opened the return (else Unicommerce's own) and the customer's reason, from an oms/return/get answer. */
export function parseDetail(resp: any): ReturnDetail | null {
  if (!resp?.successful) return null;
  const v = resp.returnSaleOrderValue ?? {};
  const reasons = [...new Set<string>((resp.returnSaleOrderItems ?? [])
    .map((i: any) => String(i?.marketplaceReturnReason ?? '').trim()).filter(Boolean))];
  const rto = String(v.rtoReason ?? '').trim();
  return {
    openedAt: istToIso(v.channelReturnCreatedDate) ?? istToIso(v.returnCreatedDate),
    reason: reasons.length ? reasons.join('; ').slice(0, 300) : rto || null,
  };
}

export type OpenRow = {
  return_code: string; order_code: string; kind: ReturnKind; skus: string[];
  tracking_status: string | null; awb: string | null; courier: string | null; uc_status: string | null;
  opened_at: string | null; reason: string | null; detail_fetched_at: string | null; seen_at: string;
};
export type SeenOpen = { opened_at: string | null; reason: string | null; detail_fetched_at: string | null };

/** Has the detail of this return been asked for yet? Once is enough. */
export const needsDetail = (before: SeenOpen | undefined): boolean => !before?.detail_fetched_at;

/** The row kept for an open return. What is already known stays when this run did not ask again, so every row carries every column. */
export function openRow(orderCode: string, ret: OpenReturn, before: SeenOpen | undefined, detail: ReturnDetail | null, nowIso: string): OpenRow {
  return {
    return_code: ret.code, order_code: orderCode, kind: ret.kind,
    skus: ret.items.map(i => i.sku).filter(Boolean),
    tracking_status: ret.tracking || null, awb: ret.awb, courier: ret.courier, uc_status: ret.ucStatus || null,
    opened_at: detail?.openedAt ?? before?.opened_at ?? null,
    reason: detail ? detail.reason : before?.reason ?? null,
    detail_fetched_at: detail ? nowIso : before?.detail_fetched_at ?? null,
    seen_at: nowIso,
  };
}

/** Every return of an order that is still open in Unicommerce, wherever its parcel is. */
export function openReturnsOf(r: Reading): OpenReturn[] {
  return [...r.waiting, ...r.receive, ...r.attention.flatMap(a => (a.ret ? [a.ret] : []))];
}

/**
 * Rows to drop from the list: the order has no open piece any more (received by hand, cancelled), or the order was read this run
 * and the return is no longer open on it. An order that was not read this run keeps its rows until it is.
 */
export function staleCodes(
  existing: Array<{ return_code: string; order_code: string }>, openOrders: Set<string>, readOrders: Set<string>, seen: Set<string>,
): string[] {
  return existing
    .filter(e => !openOrders.has(e.order_code) || (readOrders.has(e.order_code) && !seen.has(e.return_code)))
    .map(e => e.return_code);
}

// ── Whether to try a return again ─────────────────────────────────────────────────────────────

export type Known = { status: string; attempts: number; next_try_at: string | null; claimed_at: string | null };
export type Decision = 'try' | 'skip' | 'reconcile';

/**
 * Exactly-once: a return Unicommerce has not received is tried when it is new, or failed and its back-off has passed.
 * A claim that is still fresh belongs to another run; a stale one means a run died after (maybe) calling Unicommerce, and
 * the order has just been read and still shows the return open, so the call did not happen and it may be tried again.
 * A return a person has to look at ('attention', 'unverified') is never retried on its own: a second receive could
 * add the piece to stock twice.
 */
export function decide(known: Known | undefined, nowMs: number): Decision {
  if (!known) return 'try';
  switch (known.status) {
    case 'failed': return known.attempts >= MAX_ATTEMPTS ? 'skip' : (!known.next_try_at || Date.parse(known.next_try_at) <= nowMs ? 'try' : 'skip');
    case 'working': return known.claimed_at && nowMs - Date.parse(known.claimed_at) > CLAIM_STALE_MS ? 'reconcile' : 'skip';
    default: return 'skip';       // received, unverified, attention, resolved
  }
}

/** Back-off after a failed receive: 30 min, 2 h, 6 h, 24 h, then a person (MAX_ATTEMPTS). */
export function retryAt(attempts: number, nowMs: number): string {
  const waits = [30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
  return new Date(nowMs + waits[Math.min(Math.max(attempts, 1), waits.length) - 1]).toISOString();
}
