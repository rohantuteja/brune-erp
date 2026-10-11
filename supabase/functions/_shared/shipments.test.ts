// Run: node --test supabase/functions/_shared/shipments.test.ts
// Shapes are the real Shopify and Return Prime responses for orders 37874, 37875, 37852, 36354 (Oct 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, parseNote, paymentOf, shipmentsOfOrder, shipmentsOfReturn } from './shipments.ts';

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
