// Run: node --test supabase/functions/_shared/upstream.test.ts
// An outage of Velocity or Unicommerce must never be read as "no data" (13 Oct 2026: a Velocity 503 made a full
// sync save 56 delivered COD orders without their remittances).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Unreachable, heldKeys, lookupVelocity, partitionHeld, ucUnreachable } from './upstream.ts';

// ── Unicommerce ──────────────────────────────────────────────────────────────

test('Unicommerce: an HTTP failure or an unreadable body is not an answer', () => {
  assert.match(ucUnreachable({ successful: false, errors: [{ description: 'HTTP 503' }] })!, /HTTP 503/);
  assert.match(ucUnreachable({ successful: false, errors: [{ description: "HTTP 403: Unicommerce refused the database's IP address" }] })!, /HTTP 403/);
  assert.equal(ucUnreachable({}), 'no usable response');          // ucPost's result for a body that is not JSON
  assert.equal(ucUnreachable(undefined), 'no usable response');
  assert.equal(ucUnreachable(null), 'no usable response');
});

test('Unicommerce: "no such order" and "no invoice yet" are answers, so legacy orders keep Shopify amounts', () => {
  assert.equal(ucUnreachable({ successful: true, saleOrderDTO: { code: '1' } }), null);
  // What saleorder/get returns for a September order Unicommerce never had (checked on order 37613).
  assert.equal(ucUnreachable({ successful: false, errors: [{ code: 40005, description: 'INVALID_SALE_ORDER_CODE', message: 'INVALID_SALE_ORDER_CODE' }] }), null);
  assert.equal(ucUnreachable({ successful: false, errors: [{ description: 'Invoice not generated yet' }] }), null);
  assert.equal(ucUnreachable({ successful: false }), null);
});

test('Unreachable names the system and the reason', () => {
  const e = new Unreachable('Velocity', 'HTTP 503');
  assert.equal(e.system, 'Velocity');
  assert.equal(e.message, 'Velocity could not be reached: HTTP 503');
  assert.ok(e instanceof Error);
});

// ── Velocity ─────────────────────────────────────────────────────────────────

const rec = (awb: string, extra: object = {}) => ({ tracking_number: awb, delivery_date: '2026-10-05', cod_amount: 1499, remittance_date: null, utr_no: null, ...extra });
const noPause = async () => {};

test('Velocity: an answer gives a record per parcel, and a parcel it answers with an error is a record with nothing in it', async () => {
  const asked: string[][] = [];
  const out = await lookupVelocity(['A1', 'A2', 'A1'], async awbs => {
    asked.push(awbs);
    return { status: 200, body: { data: [rec('A1', { utr_no: 'U1', remittance_date: '2026-10-09' }), { tracking_number: 'A2', error: 'AWB A2 is a prepaid order.' }] } };
  }, noPause);
  assert.deepEqual(asked, [['A1', 'A2']]);                      // duplicates asked once
  assert.equal(out.unreachable.size, 0);
  assert.equal(out.recs.get('A1')!.utr_no, 'U1');
  assert.deepEqual(out.recs.get('A2'), { delivery_date: null, cod_amount: null, remittance_date: null, utr_no: null });
});

test('Velocity: a 503 makes every parcel in the batch unreachable, not empty', async () => {
  const out = await lookupVelocity(['A1', 'A2'], async () => ({ status: 503, body: null }), noPause);
  assert.deepEqual([...out.unreachable].sort(), ['A1', 'A2']);
  assert.equal(out.recs.size, 0);
});

test('Velocity: a 200 without a data list (an error body) is unreachable too', async () => {
  for (const body of [{ message: 'Unauthorized' }, { data: 'nope' }, null, {}]) {
    const out = await lookupVelocity(['A1'], async () => ({ status: 200, body }), noPause);
    assert.deepEqual([...out.unreachable], ['A1']);
  }
  const refused = await lookupVelocity(['A1'], async () => ({ status: 401, body: { data: [rec('A1')] } }), noPause);
  assert.deepEqual([...refused.unreachable], ['A1']);
});

test('Velocity: a 429 is retried once after a pause; a second 429 is unreachable', async () => {
  let calls = 0; const pauses: number[] = [];
  const ok = await lookupVelocity(['A1'], async () => (++calls === 1 ? { status: 429, body: null } : { status: 200, body: { data: [rec('A1')] } }), async ms => { pauses.push(ms); });
  assert.equal(calls, 2);
  assert.deepEqual(pauses, [30_000]);
  assert.equal(ok.recs.has('A1'), true);
  assert.equal(ok.unreachable.size, 0);

  const never = await lookupVelocity(['A1'], async () => ({ status: 429, body: null }), noPause);
  assert.deepEqual([...never.unreachable], ['A1']);
});

test('Velocity: only the batch that failed is unreachable', async () => {
  const awbs = Array.from({ length: 150 }, (_, i) => `W${i}`);
  let call = 0;
  const out = await lookupVelocity(awbs, async batch => (++call === 1 ? { status: 503, body: null } : { status: 200, body: { data: batch.map(a => rec(a)) } }), noPause);
  assert.equal(call, 2);
  assert.equal(out.unreachable.size, 100);
  assert.equal(out.unreachable.has('W0'), true);
  assert.equal(out.unreachable.has('W120'), false);
  assert.equal(out.recs.size, 50);
});

test('Velocity: nothing to ask means no call', async () => {
  let calls = 0;
  const out = await lookupVelocity([], async () => { calls++; return { status: 200, body: { data: [] } }; }, noPause);
  assert.equal(calls, 0);
  assert.equal(out.recs.size + out.unreachable.size, 0);
});

// ── Holding orders back ──────────────────────────────────────────────────────

test('held orders are not saved and are recorded under the key the queue uses', () => {
  const results = [
    { order: '37613', orderId: 7347308364035, facts: {} },
    { order: '37700', orderId: 7347308364099, facts: {}, held: 'Velocity could not be reached: HTTP 503' },
    { order: 'I0927RE0001', orderId: null, facts: { channelRef: 'abc-uuid' }, held: 'Unicommerce could not be reached: HTTP 503' },
  ];
  const { save, held } = partitionHeld(results);
  assert.deepEqual(save.map(r => r.order), ['37613']);
  assert.deepEqual(held, [
    { key: 7347308364099, order: '37700', why: 'Velocity could not be reached: HTTP 503' },
    { key: 'M:abc-uuid', order: 'I0927RE0001', why: 'Unicommerce could not be reached: HTTP 503' },
  ]);
});

test('the next run queues the orders the last one held back', () => {
  assert.deepEqual(heldKeys({ held: [{ key: 5, order: 'a', why: 'x' }, { key: 'M:abc', order: 'b', why: 'y' }, { key: 5, order: 'a', why: 'x' }] }), [5, 'M:abc']);
  assert.deepEqual(heldKeys({ held: [{ key: 'abc' }, { key: NaN }, { key: 'M:' }, null, {}] }), []);   // junk is ignored
  assert.deepEqual(heldKeys({ held: 'nope' }), []);
  assert.deepEqual(heldKeys(null), []);
  assert.deepEqual(heldKeys({}), []);
});
