// Run: node --test supabase/functions/_shared/ledger-store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderLedger, type Facts } from './ledger.ts';
import { decideTick, ledgerRow, BUSY_MS, FULL_EVERY_MS, INCREMENTAL_EVERY_MS, RETRY_HELD_EVERY_MS } from './ledger-store.ts';

const CUTOFF = '2026-10-01';
const base = { rate: 0.05, igst: true };

test('a finished order is saved complete, with its lines flagged exportable only from the cutoff', () => {
  // Sold 29 Sep (carried in), delivered 6 Oct: the sale is before the cutoff, the delivery after it.
  const facts: Facts = { ...base, order: '37711', goods: 1399, codFee: 100, saleDate: '2026-09-29', saleDoc: 'INS0001',
    delivered: { date: '2026-10-06', amount: 1499 } };
  const ledger = buildOrderLedger(facts, { cutoff: CUTOFF, today: '2026-10-12' });
  const row = ledgerRow({ order: '37711', orderId: 7_000_000_000_001, facts, notes: [], ledger }, CUTOFF);
  assert.equal(row.status, 'complete');
  assert.equal(row.net, 0);
  assert.equal(row.opening, 1499);
  assert.equal(row.exception_type, null);
  assert.equal(row.sale_date, '2026-09-29');
  const flags = row.entries.map(e => [e.voucher, e.exportable]);
  assert.deepEqual(flags.filter(([v]) => v === 'sale').map(f => f[1]), [false, false, false, false]);
  assert.deepEqual(flags.filter(([v]) => v === 'delivery').map(f => f[1]), [true, true]);
});

test('an open order keeps its exception type and amount', () => {
  const facts: Facts = { ...base, order: '37850', goods: 1499, codFee: 100, saleDate: '2026-10-08', payments: [{ date: '2026-10-07', amount: 199, ref: 'p' }] };
  const ledger = buildOrderLedger(facts, { cutoff: CUTOFF, today: '2026-10-11' });
  const row = ledgerRow({ order: '37850', orderId: 1, facts, notes: [], ledger }, CUTOFF);
  assert.equal(row.status, 'open');
  assert.equal(row.exception_type, 'in_transit');
  assert.equal(row.net, 1400);
  assert.equal((row.exceptions as any[])[0].amount, 1400);
});

test('an order that was never a sale is saved with no lines, no facts and the reason', () => {
  const facts: Facts = { ...base, order: '37740', goods: 0, codFee: 0, saleDate: '2026-10-09' };
  const ledger = buildOrderLedger(facts, { cutoff: CUTOFF, today: '2026-10-11' });
  const row = ledgerRow({ order: '37740', orderId: 2, facts, notes: ['cancelled before dispatch: never a sale'], skip: 'cancelled before dispatch', ledger }, CUTOFF);
  assert.equal(row.status, 'not_a_sale');
  assert.deepEqual(row.entries, []);
  assert.equal(row.facts, null);
  assert.deepEqual(row.notes, ['cancelled before dispatch']);
});

test('balancing documents are saved with the order', () => {
  const facts: Facts = { ...base, order: '37586', goods: 1499, codFee: 0, saleDate: '2026-09-24', payments: [{ date: '2026-09-24', amount: 1499, ref: 'p' }],
    returns: [{ kind: 'rto', date: '2026-10-11', goodsReturned: 1499, storeCredit: [] }] };
  const ledger = buildOrderLedger(facts, { cutoff: CUTOFF, today: '2026-10-11' });
  const row = ledgerRow({ order: '37586', orderId: 3, facts, notes: [], ledger }, CUTOFF);
  assert.equal(row.status, 'attention');
  assert.equal(row.exception_type, 'refund_due');
  assert.deepEqual((row.balancing as any[]).map(b => b.type), ['credit_note_goods']);
});

const now = Date.UTC(2026, 9, 12, 6, 0, 0);

test('tick: a run that was just touched is busy; one that has gone quiet is continued', () => {
  assert.equal(decideTick(now, { kind: 'full', status: 'running', startedAt: now - 600_000, updatedAt: now - 30_000 }, null, null), 'busy');
  assert.equal(decideTick(now, { kind: 'full', status: 'running', startedAt: now - 3_600_000, updatedAt: now - BUSY_MS - 1 }, null, null), 'continue');
});

test('tick: the first run is a full one', () => {
  assert.equal(decideTick(now, null, null, null), 'full');
});

test('tick: a full run each day, an incremental one each hour, otherwise wait', () => {
  const fullAt = now - 2 * 3_600_000;
  assert.equal(decideTick(now, null, now - 10 * 60_000, fullAt), 'wait');
  assert.equal(decideTick(now, null, now - INCREMENTAL_EVERY_MS, fullAt), 'incremental');
  assert.equal(decideTick(now, null, now - 10 * 60_000, now - FULL_EVERY_MS), 'full');
});

test('tick: orders a run held back are retried after ten minutes, and only then', () => {
  const fullAt = now - 2 * 3_600_000;
  const done = now - 20 * 60_000;
  assert.equal(decideTick(now, null, done, fullAt, { startedAt: now - RETRY_HELD_EVERY_MS + 1, count: 3 }), 'wait');
  assert.equal(decideTick(now, null, done, fullAt, { startedAt: now - RETRY_HELD_EVERY_MS, count: 3 }), 'retry');
  assert.equal(decideTick(now, null, done, fullAt, { startedAt: now - 3_600_000, count: 0 }), 'wait');
  assert.equal(decideTick(now, null, done, fullAt, null), 'wait');
});

test('tick: a scheduled run that is due comes before a retry, and a running run before both', () => {
  const held = { startedAt: now - 30 * 60_000, count: 2 };
  assert.equal(decideTick(now, null, now - INCREMENTAL_EVERY_MS, now - 3_600_000, held), 'incremental');
  assert.equal(decideTick(now, null, now - 20 * 60_000, now - FULL_EVERY_MS, held), 'full');
  assert.equal(decideTick(now, { kind: 'manual', status: 'running', startedAt: now - 60_000, updatedAt: now - 10_000 }, now - 20 * 60_000, now - 3_600_000, held), 'busy');
});

test('the state of the order is saved with it, as the GST name and the GST code; no state saves as null', () => {
  const facts: Facts = { ...base, order: '37900', goods: 1399, codFee: 100, saleDate: '2026-10-08', state: { code: '27', name: 'Maharashtra', source: 'shopify' } };
  const ledger = buildOrderLedger(facts, { cutoff: CUTOFF, today: '2026-10-12', requireState: true });
  const row = ledgerRow({ order: '37900', orderId: 5, facts, notes: [], ledger }, CUTOFF);
  assert.equal(row.state, 'Maharashtra'); assert.equal(row.state_code, '27');
  const none = { ...facts, state: undefined };
  const row2 = ledgerRow({ order: '37901', orderId: 6, facts: none, notes: [], ledger: buildOrderLedger(none, { cutoff: CUTOFF, today: '2026-10-12', requireState: true }) }, CUTOFF);
  assert.equal(row2.state, null); assert.equal(row2.state_code, null);
  assert.equal(row2.status, 'attention'); assert.equal(row2.exception_type, 'no_state');
});
