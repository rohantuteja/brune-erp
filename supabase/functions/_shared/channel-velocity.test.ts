// Run: node --test supabase/functions/_shared/channel-velocity.test.ts
// Shapes are the real Unicommerce answers for Myntra orders read on 31 Oct 2026 (oms/saleorder/get): one item per piece,
// item statusCode DELIVERED / DISPATCHED / CANCELLED, and returns that are COURIER_ALLOCATED or RETURN_EXPECTED until they arrive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, linesFromOrder, ordersToFetch, searchWindows, splitSku, DAY_MS, REFRESH_MS, SEARCH_WINDOW_MS, type KnownOrder } from './channel-velocity.ts';

const T0 = Date.parse('2026-10-05T06:00:00Z');
const NOW = Date.parse('2026-10-31T06:00:00Z');

const item = (code: string, sku: string, statusCode = 'DELIVERED') => ({ code, itemSku: sku, statusCode, totalQuantity: 1 });
const order = (over: Record<string, unknown> = {}) => ({ code: 'b210977e', created: T0, updated: T0 + 3_600_000, saleOrderItems: [item('I1', 'TULA-BLUE-DRESS-56-XS')], returns: [], ...over });
const ret = (itemCode: string, over: Record<string, unknown> = {}) => ({
  code: 'R1', type: 'Customer Returned', statusCode: 'COURIER_ALLOCATED', actionCode: 'WAC', returnItems: [{ saleOrderItemCode: itemCode, itemSku: 'X' }], ...over,
});

test('a SKU is the style and the size after its last dash, as shopify-sync reads it', () => {
  assert.deepEqual(splitSku('TULA-BLUE-DRESS-56-XS'), { style_code: 'TULA-BLUE-DRESS-56', size: 'XS' });
  assert.deepEqual(splitSku(' MONA-WHITE-DRESS-58-S '), { style_code: 'MONA-WHITE-DRESS-58', size: 'S' });
  assert.equal(splitSku('NODASH'), null);
  assert.equal(splitSku('TULA-'), null);
  assert.equal(splitSku(undefined), null);
});

test('a delivered piece is one sale on the day its order was placed', () => {
  const { lines, skipped } = linesFromOrder(order());
  assert.deepEqual(skipped, []);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    item_code: 'I1', order_code: 'b210977e', sku: 'TULA-BLUE-DRESS-56-XS', style_code: 'TULA-BLUE-DRESS-56', size: 'XS',
    ordered_at: '2026-10-05T06:00:00.000Z', cancelled: false, return_state: null, returned_at: null, uc_updated_at: '2026-10-05T07:00:00.000Z',
  });
});

test('a cancelled piece is kept but marked, so it is not counted', () => {
  const { lines } = linesFromOrder(order({ saleOrderItems: [item('I1', 'MONA-WHITE-DRESS-58-S', 'CANCELLED')] }));
  assert.equal(lines[0].cancelled, true);
  assert.equal(lines[0].return_state, null);
});

test('a return still on its way (courier allocated, return expected) is not taken off yet', () => {
  const customer = linesFromOrder(order({ returns: [ret('I1')] })).lines[0];
  assert.equal(customer.return_state, 'expected');
  assert.equal(customer.returned_at, null);
  const rto = linesFromOrder(order({ returns: [ret('I1', { type: 'Courier Returned', statusCode: 'RETURN_EXPECTED', actionCode: null })] })).lines[0];
  assert.equal(rto.return_state, 'expected');
  assert.equal(rto.returned_at, null);
});

test('a return received at the warehouse is taken off on the day it arrived', () => {
  const arrived = Date.parse('2026-10-20T09:30:00Z');
  const byDate = linesFromOrder(order({ returns: [ret('I1', { statusCode: 'RETURNED', inventoryReceivedDate: arrived })] })).lines[0];
  assert.equal(byDate.return_state, 'received');
  assert.equal(byDate.returned_at, '2026-10-20T09:30:00.000Z');
  // completed without a received date: the completion date; without either: the order's update time
  assert.equal(linesFromOrder(order({ returns: [ret('I1', { returnCompletedDate: arrived })] })).lines[0].returned_at, '2026-10-20T09:30:00.000Z');
  assert.equal(linesFromOrder(order({ returns: [ret('I1', { statusCode: 'RETURNED' })] })).lines[0].returned_at, '2026-10-05T07:00:00.000Z');
  // the item itself marked RETURNED with no return record
  assert.equal(linesFromOrder(order({ saleOrderItems: [item('I1', 'TULA-BLUE-DRESS-56-XS', 'RETURNED')] })).lines[0].return_state, 'received');
});

test('a return is matched to its own piece, and a cancelled return is ignored', () => {
  const o = order({
    saleOrderItems: [item('I1', 'TULA-BLUE-DRESS-56-XS'), item('I2', 'TULA-BLUE-DRESS-56-S')],
    returns: [ret('I2', { statusCode: 'RETURNED', inventoryReceivedDate: T0 + DAY_MS }), ret('I1', { code: 'R2', statusCode: 'CANCELLED' })],
  });
  const [a, b] = linesFromOrder(o).lines;
  assert.equal(a.return_state, null);
  assert.equal(b.return_state, 'received');
});

test('an item whose SKU is not style-size is reported, not lost', () => {
  const { lines, skipped } = linesFromOrder(order({ saleOrderItems: [item('I1', 'TULA-BLUE-DRESS-56-XS'), item('I2', 'ODDSKU')] }));
  assert.equal(lines.length, 1);
  assert.deepEqual(skipped, ['I2']);
});

test('an order with no created time gives nothing', () => {
  assert.deepEqual(linesFromOrder(order({ created: undefined })), { lines: [], skipped: [] });
  assert.deepEqual(linesFromOrder(null), { lines: [], skipped: [] });
});

test('an order stays open while a piece could still come back', () => {
  assert.equal(isOpen([{ cancelled: false, return_state: null }]), true);
  assert.equal(isOpen([{ cancelled: false, return_state: 'expected' }]), true);
  assert.equal(isOpen([{ cancelled: false, return_state: 'received' }]), false);
  assert.equal(isOpen([{ cancelled: true, return_state: null }]), false);
  assert.equal(isOpen([{ cancelled: false, return_state: 'received' }, { cancelled: false, return_state: null }]), true);
});

test('which orders to read: new first, then changed, then the longest-unread that could still be returned', () => {
  const known = new Map<string, KnownOrder>([
    ['same-fresh', { updated_ms: 100, synced_ms: NOW - 1 * 3_600_000, ordered_ms: NOW - 10 * DAY_MS, open: true }],           // read an hour ago: leave
    ['changed', { updated_ms: 100, synced_ms: NOW - 1 * 3_600_000, ordered_ms: NOW - 10 * DAY_MS, open: true }],
    ['stale-new', { updated_ms: 100, synced_ms: NOW - 8 * 3_600_000, ordered_ms: NOW - 10 * DAY_MS, open: true }],
    ['stale-old', { updated_ms: 100, synced_ms: NOW - 20 * 3_600_000, ordered_ms: NOW - 12 * DAY_MS, open: true }],
    ['closed', { updated_ms: 100, synced_ms: NOW - 30 * 3_600_000, ordered_ms: NOW - 12 * DAY_MS, open: false }],               // return received: final
    ['too-old', { updated_ms: 100, synced_ms: NOW - 30 * 3_600_000, ordered_ms: NOW - 60 * DAY_MS, open: true }],               // past the return window
  ]);
  const el = (code: string, created: number, updated = 100) => ({ code, created, updated });
  const got = ordersToFetch([
    el('same-fresh', 1), el('changed', 2, 200), el('stale-new', 3), el('stale-old', 4), el('closed', 5), el('too-old', 6),
    el('new-old', 10), el('new-new', 20),
  ], known, NOW);
  assert.deepEqual(got, ['new-new', 'new-old', 'changed', 'stale-old', 'stale-new']);
});

test('an order read just under the refresh interval ago is not read again', () => {
  const known = new Map<string, KnownOrder>([['a', { updated_ms: 100, synced_ms: NOW - REFRESH_MS + 1000, ordered_ms: NOW - DAY_MS, open: true }]]);
  assert.deepEqual(ordersToFetch([{ code: 'a', created: 1, updated: 100 }], known, NOW), []);
});

test('search windows never exceed the 31 days Unicommerce allows and cover the whole range', () => {
  const from = NOW - 75 * DAY_MS;
  const w = searchWindows(from, NOW);
  assert.equal(w.length, 3);
  assert.equal(w[0][0], from);
  assert.equal(w[w.length - 1][1], NOW);
  for (const [a, b] of w) assert.ok(b - a <= SEARCH_WINDOW_MS);
  for (let i = 1; i < w.length; i++) assert.equal(w[i][0], w[i - 1][1]);
  assert.deepEqual(searchWindows(NOW, NOW), []);
});
