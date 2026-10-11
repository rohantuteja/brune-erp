// Shipments the ERP is waiting on: forward parcels not yet delivered, parcels coming back to
// origin (RTO), and customer returns on their way to the warehouse. Pure rules, no network:
// the shipment-watch function reads Shopify and Return Prime and hands the raw data in.
//
// What each source says:
//   Shopify fulfilment  Velocity's tracking: displayStatus (IN_TRANSIT, OUT_FOR_DELIVERY,
//                       ATTEMPTED_DELIVERY, DELIVERED ...), deliveredAt, and the latest events.
//   Shopify order note  Velocity writes the courier's promise and any RTO state there, and does
//                       not always add a tag:
//                         "EDD: 2026-10-12 09:00:00 +0530"          expected delivery date
//                         "RTO Initiated on 2026-10-11 14:57:50"    (IST)
//                         "RTO In Transit on 2026-10-11 09:19:31"
//                         "RTO Delivered on 2026-10-03 16:04:38"    parcel is back
//   Return Prime        the reverse pickup of a customer return: AWB, shipment_status
//                       ("Requested", "On the way to warehouse", ...), tracking_updated_at.
//
// What the owner needs from them:
//   escalate    a forward parcel past its expected delivery date. Prepaid first (the customer has
//               paid and complains); COD and part-paid parcels still get a view.
//   claim       any parcel (forward, RTO or return) still not delivered 45 days after dispatch:
//               only then can a credit note be requested from the courier.

export type ShipmentKind = 'forward' | 'rto' | 'return';
export type PaymentType = 'prepaid' | 'cod' | 'partial';

export type Settings = {
  claimDays: number;            // not delivered after this many days → credit note can be requested
  prepaidLateDays: number;      // prepaid: escalate when this many days past the expected delivery date
  codLateDays: number;          // COD / part-paid: consider escalating at this many days late
  defaultSlaDays: number;       // expected delivery when the note has no EDD: dispatch + this many days
  stuckDays: number;            // no tracking update for this long
};

export const DEFAULTS: Settings = { claimDays: 45, prepaidLateDays: 1, codLateDays: 2, defaultSlaDays: 7, stuckDays: 4 };

export type Shipment = {
  awb: string;
  kind: ShipmentKind;
  order_name: string;
  order_id: number | null;
  request_number: string | null;
  courier: string | null;
  tracking_url: string | null;
  payment_type: PaymentType | null;
  order_total: number | null;
  cod_due: number | null;
  city: string | null;
  pincode: string | null;
  dispatched_on: string;               // IST date the parcel left (return: the day the request was made)
  edd: string | null;                  // IST date promised
  rto_state: 'initiated' | 'in_transit' | 'delivered' | null;
  rto_since: string | null;            // IST date the RTO started
  status: string;                      // normalised: in_transit, out_for_delivery, attempted, delivered, rto_initiated, rto_in_transit, rto_delivered, return_requested, return_on_the_way, return_received ...
  raw_status: string | null;
  last_event_at: string | null;        // ISO
  attempts: number;
  state: 'pending' | 'closed';
  closed_on: string | null;
  late_days: number;                   // days past the expected delivery date (forward parcels), 0 otherwise
  pending_days: number;                // days since dispatch
  escalation: 'now' | 'consider' | null;
  claim_eligible: boolean;
  stuck: boolean;
  note: string | null;                 // what a person needs to see: "3 delivery attempts", "no update for 6 days"
};

const istDay = (t: string | number) => new Date((typeof t === 'number' ? t : Date.parse(t)) + 19_800_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

// ── Velocity's order note ─────────────────────────────────────────────────────────────────────
export function parseNote(note?: string | null): { edd: string | null; rto: { state: 'initiated' | 'in_transit' | 'delivered'; on: string } | null } {
  const text = String(note ?? '');
  const edd = /EDD:\s*(\d{4}-\d{2}-\d{2})/i.exec(text)?.[1] ?? null;
  // Several states can be written over time: the latest one wins ("Delivered" beats "In Transit" beats "Initiated").
  let rto: { state: 'initiated' | 'in_transit' | 'delivered'; on: string } | null = null;
  const rank = { initiated: 1, in_transit: 2, delivered: 3 } as const;
  for (const m of text.matchAll(/RTO\s+(Initiated|In\s*Transit|Delivered)\s+on\s+(\d{4}-\d{2}-\d{2})/gi)) {
    const state = m[1].toLowerCase().replace(/\s+/g, '') === 'intransit' ? 'in_transit' : (m[1].toLowerCase() as 'initiated' | 'delivered');
    if (!rto || rank[state] >= rank[rto.state]) rto = { state, on: m[2] };
  }
  return { edd, rto };
}

const isCodGateway = (g: string) => /cash_on_delivery|ppcod|cash on delivery/i.test(g ?? '');
const isCodOnly = (g: string) => /^cash_on_delivery$|^manual$/i.test(g ?? '');
const succeeded = (t: any) => t.status === 'SUCCESS' && (t.kind === 'SALE' || t.kind === 'CAPTURE');

// How the order was paid: prepaid, cash on delivery, or part-paid (an advance, or store credit, plus cash on delivery).
export function paymentOf(gateways: string[], transactions: any[], total: number): { type: PaymentType; codDue: number } {
  const cod = (gateways ?? []).some(isCodGateway);
  const prepaid = Math.round((transactions ?? []).filter(t => succeeded(t) && !isCodOnly(t.gateway))
    .reduce((s, t) => s + Number(t.amountSet?.shopMoney?.amount ?? 0), 0) * 100) / 100;
  if (!cod) return { type: 'prepaid', codDue: 0 };
  return { type: prepaid > 0.005 ? 'partial' : 'cod', codDue: Math.max(0, Math.round((total - prepaid) * 100) / 100) };
}

// Shopify's fulfilment display status. Parcels Velocity tracks carry a courier status; old orders whose AWB was
// only typed in (a courier Shopify cannot follow) show FULFILLED / MARKED_AS_FULFILLED and have no tracking at all,
// so nothing can be said about them. A cancelled or voided fulfilment is not a parcel.
const FORWARD_STATUS: Record<string, string> = {
  IN_TRANSIT: 'in_transit', OUT_FOR_DELIVERY: 'out_for_delivery', ATTEMPTED_DELIVERY: 'attempted', DELIVERED: 'delivered',
  CONFIRMED: 'picked_up', PICKED_UP: 'picked_up', LABEL_PRINTED: 'label_created', LABEL_PURCHASED: 'label_created', SUBMITTED: 'label_created',
  READY_FOR_PICKUP: 'ready_for_pickup', DELAYED: 'delayed', FAILURE: 'failed', NOT_DELIVERED: 'failed',
};
const UNTRACKED = new Set(['FULFILLED', 'MARKED_AS_FULFILLED']);
const VOIDED = new Set(['CANCELED', 'CANCELLED', 'LABEL_VOIDED']);

type Inputs = { today: string; settings: Settings };

// Flags that depend on today's date and the thresholds; the rest of a row is facts.
function withFlags(r: Omit<Shipment, 'late_days' | 'pending_days' | 'escalation' | 'claim_eligible' | 'stuck' | 'note'> & { note?: string | null }, inp: Inputs): Shipment {
  const { today, settings } = inp;
  const pending = r.state === 'pending';
  const pendingDays = Math.max(0, daysBetween(r.dispatched_on, today));
  const expected = r.edd ?? (r.kind === 'forward' ? istDay(Date.parse(r.dispatched_on) + settings.defaultSlaDays * 86_400_000) : null);
  const lateDays = pending && r.kind === 'forward' && expected ? Math.max(0, daysBetween(expected, today)) : 0;
  const quiet = r.last_event_at ? daysBetween(istDay(r.last_event_at), today) : pendingDays;
  const stuck = pending && quiet >= settings.stuckDays;
  let escalation: Shipment['escalation'] = null;
  if (pending && r.kind === 'forward') {
    if (r.payment_type === 'prepaid' && lateDays >= settings.prepaidLateDays) escalation = 'now';
    else if (r.payment_type !== 'prepaid' && lateDays >= settings.codLateDays) escalation = 'consider';
    // A prepaid parcel with no tracking movement for days is escalated even before its date passes.
    if (!escalation && r.payment_type === 'prepaid' && stuck) escalation = 'now';
  }
  const bits: string[] = [];
  if (r.attempts > 0 && pending) bits.push(`${r.attempts} delivery attempt${r.attempts === 1 ? '' : 's'}`);
  if (stuck) bits.push(`no tracking update for ${quiet} days`);
  return {
    ...r, late_days: lateDays, pending_days: pendingDays, escalation,
    claim_eligible: pending && pendingDays >= settings.claimDays, stuck,
    note: [r.note, ...bits].filter(Boolean).join('; ') || null,
  };
}

// ── A Shopify order → its forward / RTO shipments ────────────────────────────────────────────
// Orders come from shipment-watch's query: id, name, createdAt, cancelledAt, note, tags, paymentGatewayNames,
// totalPriceSet, transactions, shippingAddress {city, zip}, fulfillments {createdAt, displayStatus, deliveredAt,
// inTransitAt, trackingInfo {company, number}, events (newest first) {status, happenedAt}}.
export function shipmentsOfOrder(o: any, inp: Inputs): Shipment[] {
  const tags: string[] = (o.tags ?? []).map((t: string) => String(t).toLowerCase());
  const { edd, rto: noted } = parseNote(o.note);
  // Velocity does not always tag; the tag still counts when it is the only sign.
  const rtoState = noted?.state ?? (tags.includes('rto_delivered') ? 'delivered' : tags.includes('rto_initiated') ? 'initiated' : null);
  const rtoSince = noted?.on ?? null;
  const total = Number(o.totalPriceSet?.shopMoney?.amount ?? 0);
  const pay = paymentOf(o.paymentGatewayNames ?? [], o.transactions ?? [], total);
  const out: Shipment[] = [];

  for (const f of o.fulfillments ?? []) {
    const t = (f.trackingInfo ?? []).find((x: any) => x?.number);
    if (!t) continue;
    const awb = String(t.number);
    const events: Array<{ status: string; happenedAt: string }> = f.events?.nodes ?? [];
    const last = events[0]?.happenedAt ?? f.inTransitAt ?? f.createdAt ?? null;
    const attempts = events.filter(e => e.status === 'ATTEMPTED_DELIVERY').length;
    const delivered = f.displayStatus === 'DELIVERED' || !!f.deliveredAt;
    const cancelled = !!o.cancelledAt;
    const kind: ShipmentKind = rtoState ? 'rto' : 'forward';
    const dispatchedOn = istDay(f.createdAt ?? o.createdAt);
    // An order that was fulfilled again (the first AWB cancelled, a new courier booked) keeps the note written for the
    // first booking, so a promise dated before this parcel left is not this parcel's promise.
    const promised = edd && edd >= dispatchedOn ? edd : null;

    const ds = String(f.displayStatus ?? '');
    let status: string, state: Shipment['state'] = 'pending', closedOn: string | null = null;
    if (VOIDED.has(ds)) { status = 'cancelled'; state = 'closed'; }
    else if (rtoState === 'delivered') { status = 'rto_delivered'; state = 'closed'; closedOn = noted?.on ?? (o.cancelledAt ? istDay(o.cancelledAt) : null); }
    else if (rtoState) status = rtoState === 'initiated' ? 'rto_initiated' : 'rto_in_transit';
    else if (delivered) { status = 'delivered'; state = 'closed'; closedOn = f.deliveredAt ? istDay(f.deliveredAt) : null; }
    else if (cancelled) { status = 'cancelled'; state = 'closed'; closedOn = istDay(o.cancelledAt); }
    else if (UNTRACKED.has(ds)) { status = 'untracked'; state = 'closed'; }
    else status = FORWARD_STATUS[ds] ?? (ds.toLowerCase() || 'unknown');

    out.push(withFlags({
      awb, kind, order_name: String(o.name).replace(/^#/, ''), order_id: Number(o.legacyResourceId) || null, request_number: null,
      courier: t.company ?? null, tracking_url: `https://www.velocityshipping.in/track/${awb}`,
      payment_type: pay.type, order_total: total, cod_due: pay.codDue || null,
      city: o.shippingAddress?.city ?? null, pincode: o.shippingAddress?.zip ?? null,
      dispatched_on: dispatchedOn, edd: promised, rto_state: rtoState, rto_since: rtoSince,
      status, raw_status: f.displayStatus ?? null, last_event_at: last, attempts, state, closed_on: closedOn,
      note: rtoState && state === 'pending' && rtoSince ? `RTO ${rtoState === 'initiated' ? 'initiated' : 'in transit'} since ${rtoSince}` : null,
    }, inp));
  }
  return out;
}

// ── A Return Prime request → its reverse-pickup shipments ─────────────────────────────────────
const RETURN_DONE = /returned to warehouse|received|delivered|cancel|rejected|failed/i;

export function shipmentsOfReturn(rq: any, inp: Inputs): Shipment[] {
  const out: Shipment[] = [];
  const seen = new Set<string>();
  const received = !!rq.received?.status;
  // Return Prime archives a request once it has dealt with it (refund paid) while the parcel may still be travelling,
  // so only a rejected or received request is finished. Its flags are objects: { status: boolean, ... }.
  const requestLive = rq.status === 'approved' && !rq.rejected?.status;
  for (const li of rq.line_items ?? []) {
    for (const s of li.shipping ?? []) {
      const awb = String(s.awb ?? '');
      if (!awb || seen.has(awb)) continue;
      seen.add(awb);
      const raw = String(s.shipment_status ?? '');
      const done = received || !requestLive || RETURN_DONE.test(raw);
      const status = done ? 'return_received' : /requested|created|booked|pending/i.test(raw) ? 'return_requested' : 'return_on_the_way';
      out.push(withFlags({
        awb, kind: 'return', order_name: String(rq.order?.name ?? '').replace(/^#/, ''), order_id: null, request_number: rq.request_number ?? null,
        courier: String(s.shipping_company ?? '').replace(/v\d+$/i, '') || null, tracking_url: s.tracking_url || (awb ? `https://www.velocityshipping.in/track/${awb}` : null),
        payment_type: null, order_total: null, cod_due: null, city: null, pincode: null,
        dispatched_on: istDay(rq.created_at), edd: null, rto_state: null, rto_since: null,
        status, raw_status: raw || null, last_event_at: s.tracking_updated_at ?? null, attempts: 0,
        state: done ? 'closed' : 'pending', closed_on: done ? (rq.received?.created_at ? istDay(rq.received.created_at) : null) : null,
        note: raw && !done ? `Return Prime: ${raw}` : null,
      }, inp));
    }
  }
  return out;
}
