// Run: node --test supabase/functions/_shared/myntra-returns.test.ts
// Shapes are the real Unicommerce answers for Myntra orders read on 17 Nov 2026 (oms/saleorder/get): a Customer Returned
// return (RP codes) is COURIER_ALLOCATED with tracking CIR_*, a Courier Returned one (BRUN codes) is RETURN_EXPECTED with RTO_*.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACK_STATUSES, CLAIM_STALE_MS, MAX_ATTEMPTS, decide, isReceivedReturn, kindOf, readReturns, receivedIn, remarksFor, retryAt, returnInvoiceOf,
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
