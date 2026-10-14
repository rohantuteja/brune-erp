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
  base_note: string | null;            // the note before those flags are added (not stored); lets Velocity's answer be applied afterwards
  // What Velocity itself says (applyVelocity). Shopify's and Return Prime's statuses lag the courier.
  velocity_status: string | null;      // Velocity's own status: in_transit, ndr_raised, return_cancelled, lost ...
  velocity_checked_at: string | null;
  velocity_last_activity: string | null;
  velocity_last_at: string | null;     // ISO
  verified: boolean;                   // Velocity confirmed the state on the last scan
  outcome: 'delivered' | 'returned_to_us' | 'cancelled' | null;     // how a closed parcel ended
  attention: 'ndr' | 'pickup_failed' | 'lost' | 'unverified' | null; // why a person must look
  attention_reason: string | null;
  freight_debit: number | null;        // Velocity wallet: freight charged for this parcel, with GST
  credit_received: number | null;      // Velocity wallet: credits other than the COD reversal, with GST
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

// Parcels a Unicommerce dispatch hands to Velocity. Unicommerce books the AWB with Velocity (the same 14-digit series) but names the
// carrier SHIPFAST on the Shopify fulfilment: a name Shopify cannot follow, so the fulfilment stays plain FULFILLED with no courier
// events and never turns DELIVERED. They are not hand-typed old AWBs: Velocity carries them, so they stay pending and Velocity's own
// tracking decides, like any other parcel (order 37929, 13 Oct 2026, was dropped as "untracked" before this).
const VELOCITY_CARRIED = /^(shipfast|velocity)/i;
export const isVelocityCarried = (company?: string | null) => VELOCITY_CARRIED.test(String(company ?? '').trim());

/**
 * Shopify never says DELIVERED for those parcels, so every scan lists them as undelivered again and builds a pending row: once
 * Velocity has closed one, it stays closed (and is not asked of Velocity again). `prev` is the stored row, if any.
 */
export const staysClosed = (prev: { state?: string } | undefined, row: Pick<Shipment, 'state' | 'courier' | 'raw_status'>) =>
  prev?.state === 'closed' && row.state === 'pending' && isVelocityCarried(row.courier) && UNTRACKED.has(String(row.raw_status ?? ''));
const VOIDED = new Set(['CANCELED', 'CANCELLED', 'LABEL_VOIDED']);

type Inputs = { today: string; settings: Settings };

// Flags that depend on today's date and the thresholds; the rest of a row is facts.
type Flagged = 'late_days' | 'pending_days' | 'escalation' | 'claim_eligible' | 'stuck' | 'note' | 'base_note' | VelocityFields;
type VelocityFields = 'velocity_status' | 'velocity_checked_at' | 'velocity_last_activity' | 'velocity_last_at' | 'verified' | 'outcome' | 'attention' | 'attention_reason' | 'freight_debit' | 'credit_received';
const NOT_CHECKED = { velocity_status: null, velocity_checked_at: null, velocity_last_activity: null, velocity_last_at: null, verified: false, outcome: null, attention: null, attention_reason: null, freight_debit: null, credit_received: null } as const;

function withFlags(r: Omit<Shipment, Flagged> & Partial<Pick<Shipment, VelocityFields>> & { note?: string | null }, inp: Inputs): Shipment {
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
    ...NOT_CHECKED, ...r, late_days: lateDays, pending_days: pendingDays, escalation,
    claim_eligible: pending && pendingDays >= settings.claimDays, stuck,
    base_note: r.note ?? null,
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
    else if (UNTRACKED.has(ds)) {
      if (isVelocityCarried(t.company)) status = 'label_created';      // dispatched from Unicommerce: no courier scan known yet; Velocity says more
      else { status = 'untracked'; state = 'closed'; }
    }
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
// Return Prime writes "_" where a pickup has no tracking number yet. Such a request is still a parcel somebody is waiting on,
// so it gets a key of its own (two of them must not overwrite each other) and a flag, and Velocity is not asked about it.
export const NO_AWB = 'NOAWB-';
const realAwb = (awb: string) => /^[A-Za-z0-9]{6,}$/.test(awb);

export function shipmentsOfReturn(rq: any, inp: Inputs): Shipment[] {
  const out: Shipment[] = [];
  const seen = new Set<string>();
  const received = !!rq.received?.status;
  // Return Prime archives a request once it has dealt with it (refund paid) while the parcel may still be travelling,
  // so only a rejected or received request is finished. Its flags are objects: { status: boolean, ... }.
  const requestLive = rq.status === 'approved' && !rq.rejected?.status;
  for (const li of rq.line_items ?? []) {
    for (const s of li.shipping ?? []) {
      const given = String(s.awb ?? '').trim();
      const placeholder = !realAwb(given);
      const awb = placeholder ? `${NO_AWB}${rq.request_number ?? rq.order?.name ?? 'unknown'}-${out.length + 1}` : given;
      if (seen.has(awb)) continue;
      seen.add(awb);
      const raw = String(s.shipment_status ?? '');
      const done = received || !requestLive || RETURN_DONE.test(raw);
      const status = done ? 'return_received' : /requested|created|booked|pending/i.test(raw) ? 'return_requested' : 'return_on_the_way';
      out.push(withFlags({
        awb, kind: 'return', order_name: String(rq.order?.name ?? '').replace(/^#/, ''), order_id: null, request_number: rq.request_number ?? null,
        courier: String(s.shipping_company ?? '').replace(/v\d+$/i, '') || null, tracking_url: s.tracking_url || (placeholder ? null : `https://www.velocityshipping.in/track/${awb}`),
        payment_type: null, order_total: null, cod_due: null, city: null, pincode: null,
        dispatched_on: istDay(rq.created_at), edd: null, rto_state: null, rto_since: null,
        status, raw_status: raw || null, last_event_at: s.tracking_updated_at ?? null, attempts: 0,
        state: done ? 'closed' : 'pending', closed_on: done ? (rq.received?.created_at ? istDay(rq.received.created_at) : null) : null,
        note: raw && !done ? `Return Prime: ${raw}` : null,
        ...(placeholder && !done ? { attention: 'unverified' as const, attention_reason: 'Return Prime has no pickup tracking number for this request, so the parcel cannot be followed' } : {}),
      }, inp));
    }
  }
  return out;
}

// ── Velocity's own answer ─────────────────────────────────────────────────────────────────────
// Shopify's fulfilment status and Return Prime's shipment status lag the courier: a first check of 133 "pending"
// parcels against Velocity found 29 already resolved (20 returns cancelled, 4 returns and 1 RTO delivered back,
// 2 forward parcels delivered, and 3 RTOs Velocity had marked lost). So every parcel still thought pending is
// asked of Velocity's order-tracking API, and its answer decides:
//   closed    a terminal status WITH evidence (a delivery date or a tracking log): delivered, delivered back to us, cancelled
//   flagged   anything Velocity cannot confirm, a terminal status with no evidence, a failed delivery or pickup (NDR),
//             a lost parcel: the row stays pending and says why a person must look
//   pending   everything else, with Velocity's status in place of Shopify's
// Velocity's wallet ledger (shipping-charges API) adds what it charged and any credit it has given back.

export type VelocityTrack = {
  status: string | null;             // tracking_data.shipment_status
  deliveredAt: string | null;        // shipment_track[0].delivered_date, IST text
  edd: string | null;                // estimated_delivery_date, IST date
  originalEdd: string | null;        // original_edd, IST date
  lastActivity: string | null;       // newest line of shipment_track_activities
  lastActivityAt: string | null;     // its date, IST text
  activities: number;                // how many tracking lines there are
};
export type VelocityMoney = { freightDebit: number | null; creditReceived: number };

const r2 = (n: number) => Math.round(n * 100) / 100;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Velocity writes IST wall-clock text ("2026-10-10 14:30:38"); this makes it a real instant. */
export function istText(t: string | null): string | null {
  if (!t) return null;
  const x = t.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(x)) return x;
  const iso = `${x.replace(' ', 'T')}${x.length === 10 ? 'T00:00:00' : ''}+05:30`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** One AWB's entry of the order-tracking answer ({ tracking_data: ... }), or null when it holds no tracking. */
export function parseTracking(rec: any): VelocityTrack | null {
  const td = rec?.tracking_data;
  if (!td || typeof td !== 'object') return null;
  const track = Array.isArray(td.shipment_track) ? td.shipment_track[0] : null;
  const acts: any[] = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [];
  const day = (v: unknown) => str(v)?.slice(0, 10) ?? null;     // already IST ("2026-10-10T23:59:59+05:30")
  return {
    status: str(td.shipment_status) ?? str(track?.current_status),
    deliveredAt: str(track?.delivered_date),
    edd: day(td.estimated_delivery_date), originalEdd: day(td.original_edd),
    lastActivity: str(acts[0]?.activity), lastActivityAt: str(acts[0]?.date),
    activities: acts.length,
  };
}

/** One AWB's entry of the shipping-charges answer: freight charged, and credits other than the COD reversal. */
export function parseCharges(rec: any): VelocityMoney {
  const lines: any[] = Array.isArray(rec?.charges) ? rec.charges : [];
  const amt = (l: any) => Number(l?.amount_with_gst ?? 0) || 0;
  const freight = lines.filter(l => l?.event_type === 'shipment_debit');
  const credits = lines.filter(l => l?.transaction_type === 'credit' && l?.event_type !== 'shipment_cod_credit');
  return { freightDebit: freight.length ? r2(freight.reduce((a, l) => a + amt(l), 0)) : null, creditReceived: r2(credits.reduce((a, l) => a + amt(l), 0)) };
}

const LOST = /^(lost|damaged|destroyed|misrouted|shipment_lost)$/;
const delivered = /^(delivered|return_delivered|rto_delivered)$/;

type Patch = Partial<Pick<Shipment, 'kind' | 'rto_state' | 'status' | 'state' | 'outcome' | 'attention' | 'attention_reason'>> & { closed_on?: string | null };

function classify(row: Shipment, t: VelocityTrack): Patch {
  const s = (t.status ?? '').toLowerCase();
  const evidence = !!t.deliveredAt || t.activities > 0;
  const when = istText(t.deliveredAt) ?? istText(t.lastActivityAt);
  const day = when ? istDay(when) : null;
  if (!s) return { attention: 'unverified', attention_reason: 'Velocity has no status for this parcel' };
  if (LOST.test(s)) return { status: 'lost', attention: 'lost', attention_reason: `Velocity marked this parcel ${s}${day ? ` on ${day}` : ''}` };
  if (/cancel/.test(s)) return { status: s, state: 'closed', outcome: 'cancelled', closed_on: day };
  if (delivered.test(s)) {
    if (!evidence) return { status: s, attention: 'unverified', attention_reason: `Velocity says ${s.replace(/_/g, ' ')} but shows no delivery scan: check its tracking page` };
    if (row.kind === 'rto' && s === 'delivered') return { status: s, attention: 'unverified', attention_reason: 'The order note says RTO but Velocity says delivered: check its tracking page' };
    const back = s !== 'delivered';
    return { status: s, state: 'closed', outcome: back ? 'returned_to_us' : 'delivered', closed_on: day, ...(row.kind === 'forward' && s === 'rto_delivered' ? { kind: 'rto' as const, rto_state: 'delivered' as const } : {}) };
  }
  const patch: Patch = { status: s };
  if (row.kind === 'forward' && s.startsWith('rto_')) { patch.kind = 'rto'; patch.rto_state = s === 'rto_initiated' ? 'initiated' : 'in_transit'; }
  if (/not_picked|pickup_failed/.test(s)) { patch.attention = 'pickup_failed'; patch.attention_reason = 'Velocity could not collect the return: the customer was not available'; }
  else if (/ndr|undelivered/.test(s)) {
    const back = row.kind === 'return' || s.startsWith('return_');
    patch.attention = back ? 'pickup_failed' : 'ndr';
    patch.attention_reason = back ? 'Velocity could not collect the return (a non-delivery report is open)' : 'Delivery failed: Velocity is waiting for instructions (a non-delivery report is open)';
  }
  return patch;
}

/**
 * Put Velocity's answer on a parcel. `track` is undefined when Velocity was not asked or did not answer, and null when it
 * answered with no record of the AWB: either way the parcel is flagged "unverified", never silently trusted.
 */
export function applyVelocity(row: Shipment, track: VelocityTrack | null | undefined, money: VelocityMoney | undefined, inp: Inputs, checkedAt: string): Shipment {
  if (row.awb.startsWith(NO_AWB)) return row;          // nothing to ask Velocity about; it already says why
  let patch: Patch = {};
  let verified = false;
  if (row.state === 'pending') {
    if (track) { patch = classify(row, track); verified = !patch.attention || patch.attention === 'ndr' || patch.attention === 'pickup_failed' || patch.attention === 'lost'; }
    else patch = { attention: 'unverified', attention_reason: track === null ? 'Velocity has no record of this tracking number: check which courier carries it' : 'Velocity did not answer on the last check' };
  }
  const t = track ?? null;
  const next = { ...row, ...patch } as Shipment;
  // The promise the customer was given: the courier's original one, else the one on the order note, else its current estimate.
  const edd = (row.kind === 'forward' ? (t?.originalEdd ?? row.edd ?? t?.edd) : row.edd) ?? null;
  return withFlags({
    ...next,
    note: row.base_note,
    edd,
    velocity_status: t?.status ?? row.velocity_status, velocity_checked_at: checkedAt,
    velocity_last_activity: t?.lastActivity ?? row.velocity_last_activity,
    velocity_last_at: istText(t?.lastActivityAt ?? null) ?? row.velocity_last_at,
    last_event_at: istText(t?.lastActivityAt ?? null) ?? row.last_event_at,
    verified,
    outcome: patch.outcome ?? null,
    attention: (patch.attention ?? null) as Shipment['attention'], attention_reason: patch.attention_reason ?? null,
    freight_debit: money?.freightDebit ?? row.freight_debit, credit_received: money ? money.creditReceived : row.credit_received,
    closed_on: patch.state === 'closed' ? (patch.closed_on ?? row.closed_on) : row.closed_on,
  }, inp);
}
