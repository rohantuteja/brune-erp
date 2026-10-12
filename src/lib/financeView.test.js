import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketTotals, effectiveRange, payeeGroups, signed, statusCounts, toBase64 } from './financeView.js';

test('a file of any size is encoded to base64 without overflowing, and decodes back to the same bytes', () => {
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
  const back = Uint8Array.from(atob(toBase64(bytes)), c => c.charCodeAt(0));
  assert.equal(back.length, bytes.length);
  assert.ok(back.every((b, i) => b === bytes[i]));
  assert.equal(toBase64(new TextEncoder().encode('hello')), 'aGVsbG8=');
});

test('the screen starts at the accounting start date; "all" shows everything; a typed range wins', () => {
  assert.deepEqual(effectiveRange({ from: '', to: '', all: false }, '2026-10-01'), ['2026-10-01', '']);
  assert.deepEqual(effectiveRange({ from: '', to: '', all: true }, '2026-10-01'), ['', '']);
  assert.deepEqual(effectiveRange({ from: '2026-09-01', to: '2026-09-30', all: false }, '2026-10-01'), ['2026-09-01', '2026-09-30']);
  assert.deepEqual(effectiveRange({ from: '', to: '2026-10-05', all: false }, '2026-10-01'), ['', '2026-10-05']);
  assert.deepEqual(effectiveRange({ from: '', to: '', all: false }, undefined), ['', '']);
});

const L = (id, status, o = {}) => ({ id, status, debit: 0, credit: 0, payee: null, bucket: null, remarks: `line ${id}`, decided_at: null, ...o });

test('counts and money per status', () => {
  const c = statusCounts([L(1, 'needs_review', { debit: 100 }), L(2, 'needs_review', { debit: 50.5 }), L(3, 'matched', { credit: 200 }), L(4, 'ignored', { debit: 5 }), L(5, 'ignored', { credit: 5 })]);
  assert.deepEqual(c.needs_review, [2, 150.5]); assert.deepEqual(c.matched, [1, 200]); assert.deepEqual(c.ignored, [2, 10]); assert.deepEqual(c.suggested, [0, 0]);
});

test('undecided lines are grouped by payee, biggest group first, with the bucket most of the group already points at', () => {
  const g = payeeGroups([
    L(1, 'needs_review', { payee: 'ramachal', debit: 750 }), L(2, 'suggested', { payee: 'ramachal', debit: 300, bucket: 'Fabric and Consumbale' }), L(3, 'suggested', { payee: 'ramachal', debit: 100, bucket: 'Fabric and Consumbale' }),
    L(4, 'needs_review', { payee: 'seema', debit: 4000 }),
    L(5, 'matched', { payee: 'seema', debit: 9, decided_at: '2026-10-01' }),           // decided: not in the queue
    L(6, 'ignored', { payee: 'seema', debit: 9 }),                                       // needs no entry: not in the queue
    L(7, 'needs_review', { payee: null, debit: 9 }),                                     // nobody to remember
  ]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0], { payee: 'ramachal', ids: [1, 2, 3], count: 3, out: 1150, in: 0, sample: 'line 1', hint: 'Fabric and Consumbale' });
  assert.equal(g[1].payee, 'seema'); assert.equal(g[1].hint, null); assert.deepEqual(g[1].ids, [4]);
});

test('totals per bucket, with the lines that have no bucket yet kept together', () => {
  const t = bucketTotals([L(1, 'matched', { bucket: 'Labour Charges', debit: 100 }), L(2, 'matched', { bucket: 'Labour Charges', debit: 50 }), L(3, 'needs_review', { debit: 500 }), L(4, 'matched', { bucket: 'GoKwik payout', credit: 1000 })]);
  assert.deepEqual(t.map(x => [x.bucket, x.count, x.out, x.in]), [['GoKwik payout', 1, 0, 1000], [null, 1, 500, 0], ['Labour Charges', 2, 150, 0]]);
});

test('a line is signed by direction: money out is negative', () => {
  assert.equal(signed(L(1, 'x', { debit: 10.1 })), -10.1);
  assert.equal(signed(L(1, 'x', { credit: 25 })), 25);
});
