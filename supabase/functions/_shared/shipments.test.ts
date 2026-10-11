// Run: node --test supabase/functions/_shared/shipments.test.ts
// Shapes are the real Shopify and Return Prime responses for orders 37874, 37875, 37852, 36354 (Oct 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, applyVelocity, istText, parseCharges, parseNote, parseTracking, paymentOf, shipmentsOfOrder, shipmentsOfReturn } from './shipments.ts';

const m = (amount: number) => ({ shopMoney: { amount: String(amount) } });
const ev = (...xs: Array<[string, string]>) => ({ nodes: xs.map(([status, happenedAt]) => ({ status, happenedAt })) });   // newest first
const inp = (today: string) => ({ today, settings: DEFAULTS });

const order = (over: any = {}) => ({
  name: '37874', legacyResourceId: '1', createdAt: '2026-10-08T18:25:56Z', cancelledAt: null, tags: ['COD'], note: 'EDD: 2026-10-12 09:00:00 +0530',
  paymentGatewayNames: ['cash_on_delivery'], totalPriceSet: m(1499), transactions: [{ kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1499) }],
  shippingAddress: { city: 'MUMBAI', zip: '400074' },
  fulfillments: [{ createdAt: '2026-10-09T05:40:30Z', displayStatus: 'ATTEMPTED_DELIVERY', deliveredAt: null, inTransitAt: '2026-10-09T12:34:23Z',
    trackingInfo: [{ company: 'delhivery', number: '34812018262881' }],
    events: ev(['ATTEMPTED_DELIVERY', '2026-10-11T16:43:59Z'], ['OUT_FOR_DELIVERY', '2026-10-11T08:56:40Z'], ['IN_TRANSIT', '2026-10-09T12:34:23Z']) }],
  ...over,
});

test('Velocity\'s note: the delivery promise and the RTO state, latest state wins', () => {
  assert.deepEqual(parseNote('EDD: 2026-10-12 09:00:00 +0530'), { edd: '2026-10-12', rto: null });
  assert.deepEqual(parseNote('RTO Initiated on 2026-10-11 14:57:50'), { edd: null, rto: { state: 'initiated', on: '2026-10-11' } });
  assert.deepEqual(parseNote('RTO In Transit on 2026-10-11 09:19:31').rto, { state: 'in_transit', on: '2026-10-11' });
  assert.deepEqual(parseNote('RTO Delivered on 2026-10-03 16:04:38').rto, { state: 'delivered', on: '2026-10-03' });
  assert.equal(parseNote('RTO Initiated on 2026-10-01 10:00:00\nRTO In Transit on 2026-10-02 10:00:00').rto?.state, 'in_transit');
  assert.deepEqual(parseNote(null), { edd: null, rto: null });
  assert.deepEqual(parseNote('please leave at the gate'), { edd: null, rto: null });
});

test('how an order was paid: prepaid, COD, or part-paid', () => {
  assert.deepEqual(paymentOf(['Gokwik UPI'], [{ kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1259.1) }], 1259.1), { type: 'prepaid', codDue: 0 });
  assert.deepEqual(paymentOf(['cash_on_delivery'], [{ kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1499) }], 1499), { type: 'cod', codDue: 1499 });
  // the ₹199 PPCOD advance
  assert.deepEqual(paymentOf(['Gokwik PPCOD', 'manual'], [{ kind: 'SALE', status: 'SUCCESS', gateway: 'Gokwik PPCOD', amountSet: m(199) }], 1599), { type: 'partial', codDue: 1400 });
  // store credit spent on a COD order
  assert.equal(paymentOf(['cash_on_delivery', 'shopify_store_credit'], [{ kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_store_credit', amountSet: m(1300) }], 1699).type, 'partial');
});

test('37874: COD parcel attempted once, promised for 12 Oct → not late on the day, a COD escalation candidate once 2 days late', () => {
  const [onTime] = shipmentsOfOrder(order(), inp('2026-10-12'));
  assert.equal(onTime.kind, 'forward'); assert.equal(onTime.state, 'pending'); assert.equal(onTime.status, 'attempted');
  assert.equal(onTime.edd, '2026-10-12'); assert.equal(onTime.late_days, 0); assert.equal(onTime.escalation, null);
  assert.equal(onTime.attempts, 1); assert.equal(onTime.payment_type, 'cod'); assert.equal(onTime.cod_due, 1499);
  const [late] = shipmentsOfOrder(order(), inp('2026-10-14'));
  assert.equal(late.late_days, 2); assert.equal(late.escalation, 'consider');
});

test('a prepaid parcel one day past its promise must be escalated; COD at one day is only watched', () => {
  const prepaid = order({ paymentGatewayNames: ['Gokwik UPI'], tags: ['UPI'], transactions: [{ kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1499) }] });
  assert.equal(shipmentsOfOrder(prepaid, inp('2026-10-13'))[0].escalation, 'now');
  assert.equal(shipmentsOfOrder(prepaid, inp('2026-10-12'))[0].escalation, null);
  assert.equal(shipmentsOfOrder(order(), inp('2026-10-13'))[0].escalation, null);
});

test('37800: fulfilled again with a new courier on 9 Oct, the note still holds the first booking\'s promise of 8 Oct → that promise is not this parcel\'s', () => {
  const o = order({ name: '37800', paymentGatewayNames: ['Gokwik UPI'], transactions: [{ kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1600) }],
    note: 'EDD: 2026-10-08 09:00:00 +0530',
    fulfillments: [{ createdAt: '2026-10-09T16:50:58Z', displayStatus: 'IN_TRANSIT', deliveredAt: null, inTransitAt: '2026-10-10T05:32:48Z',
      trackingInfo: [{ company: 'shadowfax', number: 'SF4186160480VEO' }], events: ev(['IN_TRANSIT', '2026-10-10T05:32:48Z']) }] });
  const [s] = shipmentsOfOrder(o, inp('2026-10-11'));
  assert.equal(s.edd, null); assert.equal(s.late_days, 0); assert.equal(s.escalation, null);       // dispatch + 7 days is 16 Oct
  assert.equal(shipmentsOfOrder(o, inp('2026-10-17'))[0].late_days, 1);                            // …and it is late only after that
});

test('a prepaid parcel with no tracking movement for days is escalated before its date passes', () => {
  const o = order({ paymentGatewayNames: ['Gokwik UPI'], transactions: [{ kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1499) }], note: 'EDD: 2026-10-20 09:00:00 +0530' });
  const [s] = shipmentsOfOrder(o, inp('2026-10-16'));         // last event 11 Oct: five days quiet
  assert.equal(s.stuck, true); assert.equal(s.escalation, 'now'); assert.match(s.note!, /no tracking update for 5 days/);
});

test('a delivered parcel is closed and never escalated', () => {
  const o = order({ name: '37852', note: 'EDD: 2026-10-11 09:00:00 +0530', paymentGatewayNames: ['Gokwik UPI'],
    fulfillments: [{ createdAt: '2026-10-08T04:40:05Z', displayStatus: 'DELIVERED', deliveredAt: '2026-10-11T15:27:38Z', trackingInfo: [{ company: 'shadowfax', number: 'SF4185215261VEO' }], events: ev(['DELIVERED', '2026-10-11T15:27:38Z']) }] });
  const [s] = shipmentsOfOrder(o, inp('2026-10-30'));
  assert.equal(s.state, 'closed'); assert.equal(s.status, 'delivered'); assert.equal(s.escalation, null); assert.equal(s.claim_eligible, false); assert.equal(s.closed_on, '2026-10-11');
});

test('37875: the note says RTO In Transit but there is no RTO tag → still an RTO on its way back', () => {
  const o = order({ name: '37875', tags: ['GoKwik', 'online-order'], note: 'RTO In Transit on 2026-10-11 09:19:31', paymentGatewayNames: ['Gokwik UPI', 'Shopify Store Credits'],
    transactions: [{ kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(900) }] });
  const [s] = shipmentsOfOrder(o, inp('2026-10-12'));
  assert.equal(s.kind, 'rto'); assert.equal(s.status, 'rto_in_transit'); assert.equal(s.state, 'pending');
  assert.equal(s.rto_since, '2026-10-11'); assert.equal(s.escalation, null);          // RTOs are not forward escalations
  assert.match(s.note!, /RTO in transit since 2026-10-11/);
});

test('36354: RTO in transit since 31 Aug, sent 10 Aug → 62 days after dispatch, so a credit note can be requested', () => {
  const o = order({ name: '36354', createdAt: '2026-08-10T04:10:46Z', tags: ['COD', 'GoKwik'], note: 'RTO In Transit on 2026-08-31 16:51:22',
    fulfillments: [{ createdAt: '2026-08-10T22:10:35Z', displayStatus: 'IN_TRANSIT', deliveredAt: null, inTransitAt: '2026-08-12T07:38:58Z', trackingInfo: [{ company: 'delhivery', number: '34812016747436' }], events: ev(['IN_TRANSIT', '2026-08-12T07:38:58Z']) }] });
  const [s] = shipmentsOfOrder(o, inp('2026-10-12'));
  assert.equal(s.kind, 'rto'); assert.equal(s.dispatched_on, '2026-08-11');        // 22:10 UTC is already 11 Aug in India
  assert.equal(s.pending_days, 62); assert.equal(s.claim_eligible, true); assert.equal(s.stuck, true);
});

test('44 days is not yet claimable, 45 is', () => {
  const o = (day: string) => order({ fulfillments: [{ createdAt: `${day}T05:00:00Z`, displayStatus: 'IN_TRANSIT', trackingInfo: [{ company: 'delhivery', number: 'X1' }], events: ev(['IN_TRANSIT', `${day}T06:00:00Z`]) }] });
  assert.equal(shipmentsOfOrder(o('2026-08-29'), inp('2026-10-12'))[0].claim_eligible, false);   // 44 days
  assert.equal(shipmentsOfOrder(o('2026-08-28'), inp('2026-10-12'))[0].claim_eligible, true);    // 45 days
});

test('the RTO tag alone (no note) still marks the order as returning or returned', () => {
  assert.equal(shipmentsOfOrder(order({ tags: ['rto_delivered'], note: null }), inp('2026-10-12'))[0].state, 'closed');
  assert.equal(shipmentsOfOrder(order({ tags: ['rto_initiated'], note: null }), inp('2026-10-12'))[0].status, 'rto_initiated');
});

test('an order cancelled in transit is closed; split shipments are separate rows', () => {
  assert.equal(shipmentsOfOrder(order({ cancelledAt: '2026-10-10T00:00:00Z' }), inp('2026-10-12'))[0].state, 'closed');
  const two = order({ fulfillments: [
    { createdAt: '2026-10-09T05:40:30Z', displayStatus: 'DELIVERED', deliveredAt: '2026-10-10T05:00:00Z', trackingInfo: [{ company: 'delhivery', number: 'A1' }], events: ev() },
    { createdAt: '2026-10-09T05:40:30Z', displayStatus: 'IN_TRANSIT', trackingInfo: [{ company: 'delhivery', number: 'A2' }], events: ev(['IN_TRANSIT', '2026-10-10T05:00:00Z']) }] });
  const rows = shipmentsOfOrder(two, inp('2026-10-12'));
  assert.deepEqual(rows.map(r => [r.awb, r.state]), [['A1', 'closed'], ['A2', 'pending']]);
});

test('a fulfilment with no tracking number is not a shipment we can follow', () => {
  assert.deepEqual(shipmentsOfOrder(order({ fulfillments: [{ createdAt: '2026-10-09T05:40:30Z', displayStatus: 'IN_TRANSIT', trackingInfo: [], events: ev() }] }), inp('2026-10-12')), []);
});

// ── Customer returns (Return Prime reverse pickups) ──
const rp = (over: any = {}, ship: any = {}) => ({
  request_number: 'RET741', status: 'approved', created_at: '2026-10-09T14:04:36.403Z', received: { status: false }, rejected: { status: false }, archived: { status: false }, order: { name: '37700' },
  line_items: [{ shipping: [{ awb: '34812018279456', shipment_status: 'On the way to warehouse', shipping_company: 'velocityv2', tracking_updated_at: '2026-10-11T07:17:32.545Z', tracking_url: 'https://www.velocityshipping.in/track/34812018279456', ...ship }] }],
  ...over,
});

test('RET741: a customer return on its way to the warehouse is pending', () => {
  const [s] = shipmentsOfReturn(rp(), inp('2026-10-12'));
  assert.equal(s.kind, 'return'); assert.equal(s.state, 'pending'); assert.equal(s.status, 'return_on_the_way');
  assert.equal(s.order_name, '37700'); assert.equal(s.request_number, 'RET741'); assert.equal(s.courier, 'velocity'); assert.equal(s.dispatched_on, '2026-10-09');
});

test('RET744: a pickup that is only requested has not started yet', () => {
  const [s] = shipmentsOfReturn(rp({ request_number: 'RET744' }, { shipment_status: 'Requested', tracking_url: '', tracking_updated_at: null }), inp('2026-10-12'));
  assert.equal(s.status, 'return_requested'); assert.equal(s.state, 'pending');
  assert.match(s.tracking_url!, /velocityshipping\.in\/track\/34812018279456/);
});

test('a return the warehouse has received, or that was rejected, is closed', () => {
  assert.equal(shipmentsOfReturn(rp({ received: { status: true, created_at: '2026-10-11T10:00:00Z' } }), inp('2026-10-12'))[0].state, 'closed');
  assert.equal(shipmentsOfReturn(rp({ status: 'rejected', rejected: { status: true } }), inp('2026-10-12'))[0].state, 'closed');
  assert.equal(shipmentsOfReturn(rp({}, { shipment_status: 'Returned to warehouse' }), inp('2026-10-12'))[0].state, 'closed');
});

test('a return still not at the warehouse 45 days after the request can be claimed', () => {
  const [s] = shipmentsOfReturn(rp({ created_at: '2026-08-20T10:00:00Z' }, { tracking_updated_at: '2026-08-25T10:00:00Z' }), inp('2026-10-12'));
  assert.equal(s.claim_eligible, true); assert.equal(s.stuck, true);
});

test('Return Prime archives a request after refunding it: the parcel is still on its way, so it stays pending', () => {
  const [s] = shipmentsOfReturn(rp({ archived: { status: true, created_at: '2026-10-10T18:06:58.577Z' } }), inp('2026-10-12'));
  assert.equal(s.state, 'pending'); assert.equal(s.status, 'return_on_the_way');
});

test('old orders whose AWB was only typed in (FULFILLED, no courier tracking) are untracked, not "undelivered"', () => {
  const o = order({ name: '34106', fulfillments: [
    { createdAt: '2026-06-05T05:40:30Z', displayStatus: 'FULFILLED', trackingInfo: [{ company: 'dtdc', number: '7D121923861' }], events: ev() },
    { createdAt: '2026-06-03T05:40:30Z', displayStatus: 'CANCELED', trackingInfo: [{ company: 'dtdc', number: '7D121922685' }], events: ev() }] });
  const rows = shipmentsOfOrder(o, inp('2026-10-12'));
  assert.deepEqual(rows.map(r => [r.awb, r.status, r.state]), [['7D121923861', 'untracked', 'closed'], ['7D121922685', 'cancelled', 'closed']]);
  assert.equal(rows.every(r => !r.claim_eligible && !r.escalation), true);
});

test('a cancelled fulfilment is not turned into an RTO just because the order is returning', () => {
  const o = order({ note: 'RTO In Transit on 2026-10-11 09:19:31', fulfillments: [
    { createdAt: '2026-10-05T05:40:30Z', displayStatus: 'CANCELED', trackingInfo: [{ company: 'delhivery', number: 'C1' }], events: ev() },
    { createdAt: '2026-10-06T05:40:30Z', displayStatus: 'IN_TRANSIT', trackingInfo: [{ company: 'delhivery', number: 'C2' }], events: ev(['IN_TRANSIT', '2026-10-07T05:00:00Z']) }] });
  assert.deepEqual(shipmentsOfOrder(o, inp('2026-10-12')).map(r => [r.awb, r.status]), [['C1', 'cancelled'], ['C2', 'rto_in_transit']]);
});

// ── Velocity's own answer decides (applyVelocity) ──
// Shapes and values below are from Velocity's order-tracking and shipping-charges answers on 11 Oct 2026.
const vt = (status: string, over: any = {}) => parseTracking({ tracking_data: {
  shipment_status: status, estimated_delivery_date: null, original_edd: null,
  shipment_track: [{ delivered_date: null, current_status: status }],
  shipment_track_activities: [{ date: '2026-10-11 14:30:38', activity: 'Item OFD at BOM_WagleEstate' }, { date: '2026-10-10 09:00:00', activity: 'In transit' }],
  ...over,
} })!;
const NOW = '2026-10-12T04:00:00Z';
const fwd = (over: any = {}) => shipmentsOfOrder(order(over), inp('2026-10-12'))[0];
const ret = () => shipmentsOfReturn(rp(), inp('2026-10-12'))[0];

test('34838: Return Prime says the pickup is on its way, Velocity says "Closed Reverse Pickup" → the return is cancelled and closed', () => {
  const t = vt('return_cancelled', { shipment_track_activities: [{ date: '2026-07-20 00:08:53', activity: 'Closed Reverse Pickup' }] });
  const s = applyVelocity(ret(), t, undefined, inp('2026-10-12'), NOW);
  assert.equal(s.state, 'closed'); assert.equal(s.outcome, 'cancelled'); assert.equal(s.closed_on, '2026-07-20');
  assert.equal(s.attention, null); assert.equal(s.verified, true); assert.equal(s.claim_eligible, false);
});

test('34629: a return Velocity delivered back on 4 Sep is closed as returned to us', () => {
  const t = vt('return_delivered', { shipment_track_activities: [{ date: '2026-09-04 11:32:49', activity: 'Item Return To Origin Delivered at NOI_Noida_FM' }] });
  const s = applyVelocity(ret(), t, undefined, inp('2026-10-12'), NOW);
  assert.equal(s.state, 'closed'); assert.equal(s.outcome, 'returned_to_us'); assert.equal(s.closed_on, '2026-09-04');
});

test('35868: a forward parcel with a delivery date is closed as delivered, on that date', () => {
  const t = vt('delivered', { shipment_track: [{ delivered_date: '2026-07-31 14:02:57' }] });
  const s = applyVelocity(fwd(), t, undefined, inp('2026-10-12'), NOW);
  assert.equal(s.state, 'closed'); assert.equal(s.outcome, 'delivered'); assert.equal(s.closed_on, '2026-07-31'); assert.equal(s.escalation, null);
});

test('33966: Velocity says "delivered" but shows no delivery scan and no tracking → not closed, flagged to be checked', () => {
  const t = vt('delivered', { shipment_track_activities: [] });
  const s = applyVelocity(fwd(), t, undefined, inp('2026-10-12'), NOW);
  assert.equal(s.state, 'pending'); assert.equal(s.attention, 'unverified'); assert.equal(s.verified, false);
  assert.match(s.attention_reason!, /no delivery scan/);
});

test('36354: Velocity marks the RTO lost → it stays on the list, flagged as lost, not hidden', () => {
  const o = order({ name: '36354', note: 'RTO In Transit on 2026-08-31 10:00:00', createdAt: '2026-08-10T08:00:00Z', fulfillments: [{ ...order().fulfillments[0], createdAt: '2026-08-10T10:00:00Z' }] });
  const [row] = shipmentsOfOrder(o, inp('2026-10-12'));
  const t = vt('lost', { shipment_track_activities: [{ date: '2026-09-07 19:16:07', activity: 'Shipment LOST' }] });
  const s = applyVelocity(row, t, { freightDebit: 60.89, creditReceived: 0 }, inp('2026-10-12'), NOW);
  assert.equal(row.kind, 'rto'); assert.equal(s.state, 'pending'); assert.equal(s.attention, 'lost'); assert.equal(s.status, 'lost'); assert.equal(s.verified, true);
  assert.match(s.attention_reason!, /2026-09-07/); assert.equal(s.claim_eligible, true); assert.equal(s.credit_received, 0);
});

test('a failed delivery (NDR) and a failed pickup are flagged as needing action, not as "in transit"', () => {
  const f = applyVelocity(fwd(), vt('ndr_raised'), undefined, inp('2026-10-12'), NOW);
  assert.equal(f.attention, 'ndr'); assert.equal(f.state, 'pending'); assert.equal(f.status, 'ndr_raised');
  const r = applyVelocity(ret(), vt('return_ndr_raised'), undefined, inp('2026-10-12'), NOW);
  assert.equal(r.attention, 'pickup_failed');
  assert.equal(applyVelocity(ret(), vt('return_not_picked'), undefined, inp('2026-10-12'), NOW).attention, 'pickup_failed');
});

test('Velocity has no record of the number, or did not answer → pending and flagged "unverified", never trusted silently', () => {
  const none = applyVelocity(fwd(), null, undefined, inp('2026-10-12'), NOW);
  assert.equal(none.attention, 'unverified'); assert.equal(none.verified, false); assert.match(none.attention_reason!, /no record/);
  const silent = applyVelocity(fwd(), undefined, undefined, inp('2026-10-12'), NOW);
  assert.equal(silent.attention, 'unverified'); assert.match(silent.attention_reason!, /did not answer/);
  assert.equal(silent.state, 'pending');
});

test('a forward parcel Velocity has turned into an RTO becomes an RTO row', () => {
  const s = applyVelocity(fwd(), vt('rto_in_transit'), undefined, inp('2026-10-12'), NOW);
  assert.equal(s.kind, 'rto'); assert.equal(s.rto_state, 'in_transit'); assert.equal(s.state, 'pending'); assert.equal(s.escalation, null);
});

test('an order note that says RTO while Velocity says delivered is a conflict to look at, not a closed parcel', () => {
  const [row] = shipmentsOfOrder(order({ note: 'RTO In Transit on 2026-10-11 09:19:31' }), inp('2026-10-12'));
  const s = applyVelocity(row, vt('delivered', { shipment_track: [{ delivered_date: '2026-10-10 12:00:00' }] }), undefined, inp('2026-10-12'), NOW);
  assert.equal(s.state, 'pending'); assert.equal(s.attention, 'unverified'); assert.match(s.attention_reason!, /note says RTO/);
});

test('the promised date: the courier\'s original promise, else the order note, else its current estimate', () => {
  const o = (note: string | null) => order({ note });
  assert.equal(applyVelocity(fwd(), vt('in_transit', { original_edd: '2026-10-09T23:59:59+05:30', estimated_delivery_date: '2026-10-14T23:59:59+05:30' }), undefined, inp('2026-10-12'), NOW).edd, '2026-10-09');
  assert.equal(applyVelocity(fwd(), vt('in_transit', { estimated_delivery_date: '2026-10-14T23:59:59+05:30' }), undefined, inp('2026-10-12'), NOW).edd, '2026-10-12');   // the note's
  const [noNote] = shipmentsOfOrder(o(null), inp('2026-10-12'));
  assert.equal(applyVelocity(noNote, vt('in_transit', { estimated_delivery_date: '2026-10-14T23:59:59+05:30' }), undefined, inp('2026-10-12'), NOW).edd, '2026-10-14');
});

test('Velocity\'s last tracking line is when the parcel last moved: a fresh scan is not "stuck", an old one is', () => {
  const fresh = applyVelocity(fwd(), vt('in_transit'), undefined, inp('2026-10-12'), NOW);
  assert.equal(fresh.stuck, false); assert.equal(fresh.velocity_last_activity, 'Item OFD at BOM_WagleEstate'); assert.equal(fresh.last_event_at, '2026-10-11T14:30:38+05:30');
  const old = applyVelocity(fwd(), vt('in_transit', { shipment_track_activities: [{ date: '2026-10-01 09:00:00', activity: 'In transit' }] }), undefined, inp('2026-10-12'), NOW);
  assert.equal(old.stuck, true); assert.match(old.note!, /no tracking update for 11 days/);
});

test('applying Velocity twice does not repeat the note, and a closed parcel stays closed and unflagged', () => {
  const once = applyVelocity(fwd(), vt('in_transit', { shipment_track_activities: [{ date: '2026-10-01 09:00:00', activity: 'x' }] }), undefined, inp('2026-10-12'), NOW);
  const twice = applyVelocity(once, vt('in_transit', { shipment_track_activities: [{ date: '2026-10-01 09:00:00', activity: 'x' }] }), undefined, inp('2026-10-12'), NOW);
  assert.equal(twice.note, once.note);
  const closed = applyVelocity({ ...fwd(), state: 'closed' }, null, undefined, inp('2026-10-12'), NOW);
  assert.equal(closed.state, 'closed'); assert.equal(closed.attention, null);
});

test('wallet ledger: freight charged, and credits other than the COD reversal', () => {
  const lost = parseCharges({ tracking_number: 'I81168271', charges: [
    { amount_with_gst: 63.72, transaction_type: 'debit', event_type: 'shipment_debit' },
    { amount_with_gst: 32.07, transaction_type: 'debit', event_type: 'shipment_cod_debit' },
    { amount_with_gst: 32.07, transaction_type: 'credit', event_type: 'shipment_cod_credit' },
    { amount_with_gst: 44.84, transaction_type: 'debit', event_type: 'shipment_rto_debit' }] });
  assert.deepEqual(lost, { freightDebit: 63.72, creditReceived: 0 });
  const cancelled = parseCharges({ charges: [
    { amount_with_gst: 54.58, transaction_type: 'debit', event_type: 'shipment_debit' },
    { amount_with_gst: 54.58, transaction_type: 'credit', event_type: 'shipment_credit' }] });
  assert.deepEqual(cancelled, { freightDebit: 54.58, creditReceived: 54.58 });
  assert.deepEqual(parseCharges(undefined), { freightDebit: null, creditReceived: 0 });
});

test('Velocity timestamps are IST wall-clock text; an answer with no tracking data is no tracking', () => {
  assert.equal(istText('2026-10-11 14:30:38'), '2026-10-11T14:30:38+05:30');
  assert.equal(istText('2026-10-11T09:00:00Z'), '2026-10-11T09:00:00Z');
  assert.equal(istText(null), null); assert.equal(istText('garbage'), null);
  assert.equal(parseTracking({}), null); assert.equal(parseTracking(null), null);
  assert.equal(parseTracking({ tracking_data: { shipment_status: 'lost', shipment_track: [], shipment_track_activities: [] } })!.status, 'lost');
});

test('Return Prime writes "_" where a pickup has no tracking number: each such request keeps its own row, flagged, and Velocity is not asked', () => {
  const a = shipmentsOfReturn(rp({ request_number: 'RET101' }, { awb: '_', shipment_status: 'Requested', tracking_url: '' }), inp('2026-10-12'))[0];
  const b = shipmentsOfReturn(rp({ request_number: 'RET102', order: { name: '36075' } }, { awb: '_', shipment_status: 'Requested', tracking_url: '' }), inp('2026-10-12'))[0];
  assert.notEqual(a.awb, b.awb); assert.match(a.awb, /^NOAWB-RET101/); assert.equal(a.tracking_url, null);
  assert.equal(a.state, 'pending'); assert.equal(a.attention, 'unverified'); assert.match(a.attention_reason!, /no pickup tracking number/);
  const after = applyVelocity(a, undefined, undefined, inp('2026-10-12'), NOW);
  assert.equal(after.attention, 'unverified'); assert.match(after.attention_reason!, /no pickup tracking number/);   // not "Velocity did not answer"
});
