import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceVerdict, monthLabel, splitKinds, topupCounts, topupStatus } from './velocityView.js';

test('a month key is shown as a month name and year', () => {
  assert.equal(monthLabel('2026-09'), 'Sep 2026'); assert.equal(monthLabel('2026-12'), 'Dec 2026'); assert.equal(monthLabel('nonsense'), 'nonsense');
});

test('a month of kinds becomes two ordered lists (charges, then credits) with labels, leaving out what did not happen', () => {
  const s = splitKinds({
    'debit:rto': { n: 2, amount: 100, ex_gst: 84.74 }, 'debit:shipping': { n: 5, amount: 500, ex_gst: 423.73 },
    'credit:cod_reversal': { n: 1, amount: 40, ex_gst: 33.9 }, 'credit:recharge': { n: 1, amount: 10000, ex_gst: 0 },
  });
  assert.deepEqual(s.debits.map(r => r.label), ['Shipping charges', 'RTO charges']);
  assert.deepEqual(s.credits.map(r => r.label), ['Wallet top-ups', 'COD charges reversed']);
  assert.equal(s.debits[0].amount, 500);
  assert.deepEqual(splitKinds(undefined), { debits: [], credits: [] });
});

test('a top-up is in the bank, missing from a bank statement that covers its date, or has no statement to check against', () => {
  const t = (o) => ({ date: '2026-09-17', amount: 10000, bank_line_id: null, bank_statement_covers: false, ...o });
  assert.equal(topupStatus(t({ bank_line_id: 7 })), 'matched');
  assert.equal(topupStatus(t({ bank_statement_covers: true })), 'not_in_bank');
  assert.equal(topupStatus(t({})), 'no_statement');
  const c = topupCounts([t({ bank_line_id: 1 }), t({ bank_line_id: 2 }), t({ bank_statement_covers: true }), t({ date: '2026-10-05', bank_line_id: 3 })], '2026-09');
  assert.deepEqual(c, { total: 3, amount: 30000, matched: 2, not_in_bank: 1, no_statement: 0 });
});

const freight = (diff, invoice = 49426.34) => ({ invoice, closest: { label: 'all charges, less shipping-charge reversals and lost-shipment credits', ledger: invoice + diff, diff }, variants: [] });

test('an invoice that agrees with the ledger to the paisa is reported as agreeing', () => {
  const v = invoiceVerdict({ has_ledger: true, vas: { invoice: 146.5, ledger: 146.5, diff: 0 }, freight: freight(0) });
  assert.equal(v.tone, 'ok'); assert.equal(v.vas.level, 'exact'); assert.equal(v.freight.level, 'exact');
});

test('a small difference is "close" and a large one is flagged; the closest way of counting is named', () => {
  const close = invoiceVerdict({ has_ledger: true, vas: { invoice: 146.5, ledger: 146.5, diff: 0 }, freight: freight(-87.93) });
  assert.equal(close.tone, 'close'); assert.equal(close.freight.level, 'close'); assert.match(close.freight.text, /0\.18%/); assert.match(close.freight.text, /shipping-charge reversals/);
  const off = invoiceVerdict({ has_ledger: true, vas: { invoice: 146.5, ledger: 100, diff: -46.5 }, freight: freight(-3000) });
  assert.equal(off.tone, 'warn'); assert.equal(off.vas.level, 'off'); assert.equal(off.freight.level, 'off');
});

test('with no ledger lines for the invoice period the screen asks for the ledger report', () => {
  assert.match(invoiceVerdict({ has_ledger: false }).headline, /upload the Velocity ledger report/);
  assert.match(invoiceVerdict(null).headline, /upload the Velocity ledger report/);
});
