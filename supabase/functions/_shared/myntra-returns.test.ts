// Run: node --test supabase/functions/_shared/myntra-returns.test.ts
// Shapes are the real Unicommerce answers for Myntra orders read on 17 Nov 2026 (oms/saleorder/get): a Customer Returned
// return (RP codes) is COURIER_ALLOCATED with tracking CIR_*, a Courier Returned one (BRUN codes) is RETURN_EXPECTED with RTO_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACK_STATUSES, CLAIM_STALE_MS, MAX_ATTEMPTS, decide, detailRequest, isReceivedReturn, istToIso, kindOf, needsDetail, openReturnsOf, openRow,
  parseDetail, readReturns, receivedIn, remarksFor, retryAt, returnInvoiceOf, staleCodes, unsettledOrders,
} from './myntra-returns.ts';

const item = (code: string, sku = 'TOBY-BLACK-DRESS-49-M', statusCode = 'DELIVERED') => ({ code, itemSku: sku, statusCode });
const cir = (code: string, itemCode: string, over: Record<string, unknown> = {}) => ({
  code, type: 'Customer Returned', actionCode: 'WAC', statusCode: 'COURIER_ALLOCATED', putawayCode: null,
  returnItems: [{ itemSku: 'TOBY-BLACK-DRESS-49-M', inventoryType: 'GOOD_INVENTORY', saleOrderItemCode: itemCode }],
  providerStatus: 'CUSTOMER_RETURN-DELIVERED', trackingNumber: 'MYSR1255487120', trackingStatus: 'CIR_DELIVERED_TO_SELLER', shippingProvider: 'ML',
  returnInvoiceCode: null, returnInvoiceDisplayCode: null, returnCompletedDate: null, inventoryReceivedDate: null, ...over,
});
const rto = (code: string, itemCode: string, over: Record<string, unknown> = {}) => ({
  code, type: 'Courier Returned', actionCode: null, statusCode: 'RETURN_EXPECTED', putawayCode: null,
  returnItems: [{ itemSku: 'TARA-WHITE-DRESS-51-M', inventoryType: 'GOOD_INVENTORY', saleOrderItemCode: itemCode }],
  providerStatus: 'COURIER_RETURN-DELIVERED', trackingNumber: 'MYSC1351039292', trackingStatus: 'RTO_DELIVERED_TO_SELLER', shippingProvider: 'flipkartlogistics',
  returnInvoiceCode: null, returnInvoiceDisplayCode: null, returnCompletedDate: null, inventoryReceivedDate: null, ...over,
});
const order = (over: Record<string, unknown> = {}) => ({ code: 'c4e29be1', saleOrderItems: [item('11415172345')], returns: [], ...over });

test('a customer return the courier has delivered to us is received', () => {
  const r = readReturns(order({ returns: [cir('RP0003', '11415172345')] }));
  assert.equal(r.receive.length, 1);
  assert.deepEqual(r.receive[0], {
    code: 'RP0003', kind: 'customer', ucStatus: 'COURIER_ALLOCATED', tracking: 'CIR_DELIVERED_TO_SELLER', awb: 'MYSR1255487120', courier: 'ML',
    items: [{ code: '11415172345', sku: 'TOBY-BLACK-DRESS-49-M', status: 'DELIVERED' }],
  });
  assert.deepEqual([r.waiting.length, r.attention.length, r.received], [0, 0, 0]);
});

test('an RTO delivered back to us is received', () => {
  const r = readReturns(order({ saleOrderItems: [item('11427946796', 'TARA-WHITE-DRESS-51-M', 'DISPATCHED')], returns: [rto('BRUN00068', '11427946796')] }));
  assert.equal(r.receive.length, 1);
  assert.equal(r.receive[0].kind, 'rto');
  assert.equal(r.receive[0].code, 'BRUN00068');
  assert.equal(r.receive[0].items[0].status, 'DISPATCHED');
});

test('a return still on its way waits: pickup arranged, RTO initiated, status not defined, or a status nobody has seen', () => {
  for (const [make, tracking] of [
    [cir, 'CIR_COURIER_ASSIGNED'], [rto, 'RTO_INITIATED'], [rto, 'STATUS_NOT_DEFINED'], [cir, 'CIR_SOMETHING_NEW'], [cir, ''],
  ] as const) {
    const r = readReturns(order({ returns: [make('R1', '11415172345', { trackingStatus: tracking })] }));
    assert.equal(r.receive.length, 0, tracking);
    assert.equal(r.waiting.length, 1, tracking);
    assert.equal(r.waiting[0].tracking, tracking);
  }
});

test('only the two delivered-to-seller statuses count as back', () => {
  assert.deepEqual([...BACK_STATUSES].sort(), ['CIR_DELIVERED_TO_SELLER', 'RTO_DELIVERED_TO_SELLER']);
});

test('a return Unicommerce has already received is counted and never received again', () => {
  const done = [
    cir('R1', 'A', { statusCode: 'RETURNED' }),
    rto('R2', 'B', { inventoryReceivedDate: 1_794_451_025_000 }),
    cir('R3', 'C', { returnCompletedDate: 1_794_451_025_000 }),
  ];
  const r = readReturns(order({ saleOrderItems: [item('A'), item('B'), item('C')], returns: done }));
  assert.equal(r.received, 3);
  assert.deepEqual(r.receivedCodes, ['R1', 'R2', 'R3']);
  assert.deepEqual([r.receive.length, r.waiting.length, r.attention.length], [0, 0, 0]);
  assert.ok(done.every(isReceivedReturn));
});

test('a cancelled return is ignored', () => {
  const r = readReturns(order({ returns: [cir('R1', '11415172345', { statusCode: 'CANCELLED' })] }));
  assert.deepEqual([r.receive.length, r.waiting.length, r.attention.length, r.received], [0, 0, 0, 0]);
});

test('an order can hold a return that is back and one that is not: only the first is received', () => {
  const r = readReturns(order({
    saleOrderItems: [item('A'), item('B', 'TULA-PINK-DRESS-54-XL')],
    returns: [cir('RP0004', 'A'), cir('RP0005', 'B', { trackingStatus: 'CIR_COURIER_ASSIGNED' })],
  }));
  assert.deepEqual(r.receive.map(x => x.code), ['RP0004']);
  assert.deepEqual(r.waiting.map(x => x.code), ['RP0005']);
});

test('a return with several items is received whole, never in part', () => {
  const two = cir('RP9', 'A', { returnItems: [{ itemSku: 'X-1', saleOrderItemCode: 'A' }, { itemSku: 'X-2', saleOrderItemCode: 'B' }] });
  const r = readReturns(order({ saleOrderItems: [item('A', 'X-1'), item('B', 'X-2')], returns: [two] }));
  assert.equal(r.receive.length, 1);
  assert.deepEqual(r.receive[0].items.map(i => i.code), ['A', 'B']);
});

test('things that look wrong are left for a person, with the reason', () => {
  const cases: Array<[string, any, RegExp]> = [
    ['a Unicommerce state this job does not receive', cir('R1', 'A', { statusCode: 'CREATED' }), /CREATED/],
    ['a Courier Returned return with a customer-return tracking', rto('R1', 'A', { trackingStatus: 'CIR_DELIVERED_TO_SELLER' }), /Courier Returned return with tracking CIR_/],
    ['a Customer Returned return with an RTO tracking', cir('R1', 'A', { trackingStatus: 'RTO_DELIVERED_TO_SELLER' }), /Customer Returned return with tracking RTO_/],
    ['a return with no items', cir('R1', 'A', { returnItems: [] }), /no items/],
    ['an item that is not on the order', cir('R1', 'ZZZ'), /not on the order/],
  ];
  for (const [name, ret, why] of cases) {
    const r = readReturns(order({ saleOrderItems: [item('A')], returns: [ret] }));
    assert.equal(r.receive.length, 0, name);
    assert.equal(r.attention.length, 1, name);
    assert.match(r.attention[0].reason, why, name);
  }
});

test('an item that was cancelled or is already returned is not received again', () => {
  for (const status of ['CANCELLED', 'RETURNED', 'PROCESSING']) {
    const r = readReturns(order({ saleOrderItems: [item('A', 'X-1', status)], returns: [cir('R1', 'A')] }));
    assert.equal(r.receive.length, 0, status);
    assert.match(r.attention[0].reason, new RegExp(status), status);
  }
});

test('the same item on two open returns is received once, the second goes to a person', () => {
  const r = readReturns(order({ saleOrderItems: [item('A')], returns: [cir('R1', 'A'), rto('R2', 'A')] }));
  assert.deepEqual(r.receive.map(x => x.code), ['R1']);
  assert.match(r.attention[0].reason, /two open returns/);
});

test('kindOf follows Unicommerce\'s own names', () => {
  assert.equal(kindOf('Courier Returned'), 'rto');
  assert.equal(kindOf('Customer Returned'), 'customer');
  assert.equal(kindOf(undefined), 'customer');
});

test('the note Unicommerce keeps names the return and the parcel, and fits its 100 characters', () => {
  assert.equal(remarksFor(readReturns(order({ returns: [cir('RP0003', '11415172345')] })).receive[0]), 'Auto: Myntra return RP0003 delivered to seller MYSR1255487120');
  const long = { code: 'R'.repeat(80), kind: 'rto' as const, ucStatus: 'RETURN_EXPECTED', tracking: 'RTO_DELIVERED_TO_SELLER', awb: 'A'.repeat(40), courier: null, items: [] };
  assert.equal(remarksFor(long).length, 100);
});

test('received is proved from a fresh read: the return itself, or every one of its items shown as returned', () => {
  const ret = { code: 'RP0003', items: [{ code: 'A', sku: 'X', status: 'DELIVERED' }] };
  assert.equal(receivedIn(order({ saleOrderItems: [item('A')], returns: [cir('RP0003', 'A')] }), ret), false);
  assert.equal(receivedIn(order({ saleOrderItems: [item('A')], returns: [cir('RP0003', 'A', { statusCode: 'RETURNED' })] }), ret), true);
  assert.equal(receivedIn(order({ saleOrderItems: [item('A')], returns: [cir('RP0003', 'A', { inventoryReceivedDate: 1 })] }), ret), true);
  assert.equal(receivedIn(order({ saleOrderItems: [item('A', 'X', 'RETURNED')], returns: [cir('RP0003', 'A')] }), ret), true);
  assert.equal(receivedIn(order({ saleOrderItems: [item('A', 'X', 'RETURNED'), item('B')], returns: [cir('RP0003', 'A')] }), { code: 'RP0003', items: [{ code: 'A', sku: 'X', status: '' }, { code: 'B', sku: 'X', status: '' }] }), false);
  assert.equal(receivedIn(order({ returns: [] }), { code: 'RP0003', items: [] }), false);
});

test('the return invoice (credit note) is read once Unicommerce shows it', () => {
  assert.equal(returnInvoiceOf(order({ returns: [cir('RP0003', 'A')] }), 'RP0003'), null);
  assert.equal(returnInvoiceOf(order({ returns: [cir('RP0003', 'A', { returnInvoiceDisplayCode: 'ISR0010' })] }), 'RP0003'), 'ISR0010');
  assert.equal(returnInvoiceOf(order(), 'RP0003'), null);
});

// ── Exactly once ────────────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-11-17T10:00:00Z');
const known = (over: Record<string, unknown> = {}) => ({ status: 'failed', attempts: 1, next_try_at: null, claimed_at: null, ...over });

test('a return nobody has tried is tried', () => {
  assert.equal(decide(undefined, NOW), 'try');
});

test('a failed receive is tried again only when its back-off has passed, and not after the last attempt', () => {
  assert.equal(decide(known({ next_try_at: new Date(NOW + 60_000).toISOString() }), NOW), 'skip');
  assert.equal(decide(known({ next_try_at: new Date(NOW - 60_000).toISOString() }), NOW), 'try');
  assert.equal(decide(known({ next_try_at: null }), NOW), 'try');
  assert.equal(decide(known({ attempts: MAX_ATTEMPTS, next_try_at: new Date(NOW - 60_000).toISOString() }), NOW), 'skip');
});

test('a fresh claim belongs to another run; a stale one is checked against Unicommerce first', () => {
  assert.equal(decide(known({ status: 'working', claimed_at: new Date(NOW - 60_000).toISOString() }), NOW), 'skip');
  assert.equal(decide(known({ status: 'working', claimed_at: new Date(NOW - CLAIM_STALE_MS - 1).toISOString() }), NOW), 'reconcile');
  assert.equal(decide(known({ status: 'working', claimed_at: null }), NOW), 'skip');
});

test('anything a person has to look at, or that is done, is never retried by the job', () => {
  for (const status of ['received', 'unverified', 'attention', 'resolved']) assert.equal(decide(known({ status }), NOW), 'skip', status);
});

test('the back-off grows: 30 min, 2 h, 6 h, 24 h, and stays at 24 h', () => {
  const mins = (n: number) => (Date.parse(retryAt(n, NOW)) - NOW) / 60_000;
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(mins), [30, 120, 360, 1440, 1440, 1440]);
  assert.equal(mins(0), 30);
});

// ── The list of returns still on their way ────────────────────────────────────────────────────
// Shapes are the real oms/return/get answers read on 17 Nov 2026 (customer return RP0036, RTO BRUN00052).

const detailCustomer = {
  successful: true,
  returnSaleOrderItems: [{ skuCode: 'MONA-WHITE-DRESS-58-M', marketplaceReturnReason: 'Product image was better than the actual product', trackingStatus: 'CIR_COURIER_ASSIGNED' }],
  returnSaleOrderValue: { returnStatus: 'COURIER_ALLOCATED', returnCreatedDate: '2026-10-23 18:01:34', channelReturnCreatedDate: '2026-10-23 17:54:18', rtoReason: null },
};
const detailRto = {
  successful: true,
  returnSaleOrderItems: [{ skuCode: 'MONA-WHITE-DRESS-58-L', marketplaceReturnReason: null, trackingStatus: 'RTO_INITIATED' }],
  returnSaleOrderValue: { returnStatus: 'RETURN_EXPECTED', returnCreatedDate: '2026-10-10 03:30:49', channelReturnCreatedDate: '2026-10-10 03:23:22', rtoReason: null },
};

test('a customer return is asked for by its reverse pickup code, an RTO by its shipment code', () => {
  assert.deepEqual(detailRequest({ code: 'RP0036', kind: 'customer' }), { reversePickupCode: 'RP0036' });
  assert.deepEqual(detailRequest({ code: 'BRUN00052', kind: 'rto' }), { shipmentCode: 'BRUN00052' });
});

test('Unicommerce dates are Indian time: 23 Oct 17:54:18 IST is 12:24:18 UTC', () => {
  assert.equal(istToIso('2026-10-23 17:54:18'), '2026-10-23T12:24:18.000Z');
  assert.equal(istToIso('2026-10-10 03:23:22'), '2026-10-09T21:53:22.000Z');   // before 05:30 IST is the day before in UTC
  assert.equal(istToIso(null), null);
  assert.equal(istToIso('not a date'), null);
});

test('the detail gives when Myntra opened the return (not Unicommerce) and the customer reason', () => {
  assert.deepEqual(parseDetail(detailCustomer), { openedAt: '2026-10-23T12:24:18.000Z', reason: 'Product image was better than the actual product' });
  assert.deepEqual(parseDetail(detailRto), { openedAt: '2026-10-09T21:53:22.000Z', reason: null });
});

test('the detail falls back to Unicommerce\'s own date, to the RTO reason, and ignores a failed answer', () => {
  const d = parseDetail({ successful: true, returnSaleOrderItems: [], returnSaleOrderValue: { returnCreatedDate: '2026-10-23 18:01:34', channelReturnCreatedDate: null, rtoReason: 'Customer not available' } });
  assert.deepEqual(d, { openedAt: '2026-10-23T12:31:34.000Z', reason: 'Customer not available' });
  assert.equal(parseDetail({ successful: false, errors: [{ description: 'no such return' }] }), null);
  assert.equal(parseDetail(undefined), null);
  // two pieces with the same reason say it once
  const two = parseDetail({ successful: true, returnSaleOrderItems: [{ marketplaceReturnReason: 'Size too big' }, { marketplaceReturnReason: 'Size too big' }], returnSaleOrderValue: {} });
  assert.equal(two?.reason, 'Size too big');
});

const waitingCir = () => readReturns(order({ returns: [cir('RP0036', '11415172345', { trackingStatus: 'CIR_COURIER_ASSIGNED' })] })).waiting[0];

test('an open return becomes one row with the parcel, the pieces and what Myntra says', () => {
  const row = openRow('so-1', waitingCir(), undefined, parseDetail(detailCustomer), '2026-11-17T12:00:00.000Z');
  assert.deepEqual(row, {
    return_code: 'RP0036', order_code: 'so-1', kind: 'customer', skus: ['TOBY-BLACK-DRESS-49-M'],
    tracking_status: 'CIR_COURIER_ASSIGNED', awb: 'MYSR1255487120', courier: 'ML', uc_status: 'COURIER_ALLOCATED',
    opened_at: '2026-10-23T12:24:18.000Z', reason: 'Product image was better than the actual product',
    detail_fetched_at: '2026-11-17T12:00:00.000Z', seen_at: '2026-11-17T12:00:00.000Z',
  });
});

test('a later run keeps what is already known and only moves the tracking on', () => {
  const before = { opened_at: '2026-10-23T12:24:18.000Z', reason: 'Size too big', detail_fetched_at: '2026-11-01T00:00:00.000Z' };
  const ret = { ...waitingCir(), tracking: 'CIR_DELIVERED_TO_SELLER' };
  const row = openRow('so-1', ret, before, null, '2026-11-17T13:00:00.000Z');
  assert.equal(row.tracking_status, 'CIR_DELIVERED_TO_SELLER');
  assert.equal(row.opened_at, before.opened_at);
  assert.equal(row.reason, 'Size too big');
  assert.equal(row.detail_fetched_at, before.detail_fetched_at);
  assert.equal(row.seen_at, '2026-11-17T13:00:00.000Z');
});

test('the detail is asked for once: when never fetched, not when it already was (even with no reason)', () => {
  assert.equal(needsDetail(undefined), true);
  assert.equal(needsDetail({ opened_at: null, reason: null, detail_fetched_at: null }), true);
  assert.equal(needsDetail({ opened_at: '2026-10-23T12:24:18.000Z', reason: null, detail_fetched_at: '2026-11-01T00:00:00.000Z' }), false);
});

test('the list holds every open return: on its way, back and about to be received, and one a person must look at', () => {
  const so = order({
    saleOrderItems: [item('A'), item('B'), item('C'), item('D')],
    returns: [
      cir('R1', 'A', { trackingStatus: 'CIR_COURIER_ASSIGNED' }),
      rto('R2', 'B'),                                        // back, will be received
      cir('R3', 'C', { statusCode: 'WEIRD' }),               // back but odd: attention
      rto('R4', 'D', { inventoryReceivedDate: 1 }),          // already received: not on the list
    ],
  });
  assert.deepEqual(openReturnsOf(readReturns(so)).map(r => r.code).sort(), ['R1', 'R2', 'R3']);
});

test('rows go when the order has no open piece, or was read this run and the return is no longer open on it', () => {
  const existing = [
    { return_code: 'R1', order_code: 'so-1' },   // still open
    { return_code: 'R2', order_code: 'so-1' },   // order read, R2 not seen any more: received
    { return_code: 'R3', order_code: 'so-2' },   // order not read this run: kept
    { return_code: 'R4', order_code: 'so-3' },   // order has no open piece any more
  ];
  const stale = staleCodes(existing, new Set(['so-1', 'so-2']), new Set(['so-1']), new Set(['R1']));
  assert.deepEqual(stale.sort(), ['R2', 'R4']);
  assert.deepEqual(staleCodes([], new Set(), new Set(), new Set()), []);
});

// RP0037, 19 Nov 2026: the receive call timed out at 7 s, Unicommerce finished a moment later. A customer return that has been received
// leaves the order CANCELLED with the return COMPLETE, so the sweep no longer lists it as an order with a return open.
const receivedCir = (code: string, itemCode: string) =>
  cir(code, itemCode, { statusCode: 'COMPLETE', putawayCode: 'PT0083', returnInvoiceCode: 'ISR0081', returnInvoiceDisplayCode: 'ISR0081', returnCompletedDate: 1795079830000, inventoryReceivedDate: 1795079835000 });

test('a customer return received after a timed-out call is seen as received on the cancelled order, with its credit note', () => {
  const so = order({ status: 'CANCELLED', saleOrderItems: [item('11475305761', 'MONA-WHITE-DRESS-58-M', 'CANCELLED')], returns: [receivedCir('RP0037', '11475305761')] });
  const r = readReturns(so);
  assert.deepEqual(r.receivedCodes, ['RP0037']);
  assert.equal(r.receive.length + r.waiting.length + r.attention.length, 0);
  assert.equal(returnInvoiceOf(so, 'RP0037'), 'ISR0081');
});

test('orders read only to settle the log: rows a read can close, whose order has no return open, once each, in code order', () => {
  const rows = [
    { order_code: 'so-9', status: 'failed' },       // the RP0037 case: its order is no longer open
    { order_code: 'so-9', status: 'attention' },    // same order, read once
    { order_code: 'so-2', status: 'unverified' },
    { order_code: 'so-5', status: 'working' },
    { order_code: 'so-1', status: 'failed' },       // its order is open: the sweep reads it anyway
    { order_code: 'so-3', status: 'received' },     // finished
    { order_code: 'so-4', status: 'resolved' },     // finished
    { order_code: '', status: 'failed' },           // no order on record: nothing to read
  ];
  assert.deepEqual(unsettledOrders(rows, new Set(['so-1'])), ['so-2', 'so-5', 'so-9']);
  assert.deepEqual(unsettledOrders(rows, new Set(['so-1']), 2), ['so-2', 'so-5']);   // capped
  assert.deepEqual(unsettledOrders(rows, new Set(['so-1']), 0), []);
  assert.deepEqual(unsettledOrders([], new Set()), []);
});
