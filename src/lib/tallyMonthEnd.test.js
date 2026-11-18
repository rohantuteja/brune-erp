import test from 'node:test';
import assert from 'node:assert/strict';
import { monthEndJournals, MONTH_END } from './tallyMonthEnd.js';

const month = { from: '2026-10-01', next: '2026-11-01' };
// His September figures (Day Book #100 and #300931): output 33,111.23 IGST + 1,282.06 + 1,282.06; input 141,731.95 IGST + 80.91 + 80.91.
const totals = { 'IGST OUTPUT UP': { debit: 0, credit: 33111.23 }, 'CGST Output UP': { debit: 0, credit: 1282.06 }, 'SGST Output UP': { debit: 0, credit: 1282.06 },
  'IGST Input  UP': { debit: 141731.95, credit: 0 }, 'CGST Input UP': { debit: 80.91, credit: 0 }, 'SGST Input UP': { debit: 80.91, credit: 0 } };
const lines = (j) => j.lines.map(l => [l.account, l.debit, l.credit]);

test('the GST journals are his own #100 and #300931: the ledgers into the credit ledger, whole rupees, the paise on ROUND OFF', () => {
  const r = monthEndJournals({ ...month, totals });
  const out = r.journals.find(j => j.id === 'gstout|2026-10'), inp = r.journals.find(j => j.id === 'gstin|2026-10');
  assert.deepEqual(lines(out), [['IGST OUTPUT UP', 33111.23, 0], ['CGST Output UP', 1282.06, 0], ['SGST Output UP', 1282.06, 0], ['GST Credit Ledger UP', 0, 35675], [MONTH_END.roundOff, 0, 0.35]]);
  assert.deepEqual(lines(inp), [['IGST Input  UP', 0, 141731.95], ['CGST Input UP', 0, 80.91], ['SGST Input UP', 0, 80.91], ['GST Credit Ledger UP', 141894, 0], [MONTH_END.roundOff, 0, 0.23]]);
  assert.deepEqual([out.date, out.number, out.balanced, inp.balanced], ['2026-10-31', 'ERP/GS/2627/OUT2610', true, true]);
});

test('a ledger with no balance, or a balance the other way, is left out and said so', () => {
  const r = monthEndJournals({ ...month, totals: { 'IGST OUTPUT UP': { debit: 500, credit: 400 }, 'CGST Output UP': { debit: 0, credit: 90 }, 'IGST Input  UP': { debit: 100.4, credit: 0 } } });
  assert.deepEqual(lines(r.journals.find(j => j.id === 'gstout|2026-10')), [['CGST Output UP', 90, 0], ['GST Credit Ledger UP', 0, 90]]);
  assert.match(r.notes[0], /IGST OUTPUT UP is a debit balance of 100/);
  assert.deepEqual(lines(r.journals.find(j => j.id === 'gstin|2026-10')), [['IGST Input  UP', 0, 100.4], ['GST Credit Ledger UP', 100, 0], [MONTH_END.roundOff, 0.4, 0]]);
});

test('directors: ₹50,000 each from Director Salary to their payables, as every month of his year', () => {
  const j = monthEndJournals({ ...month, totals: {} }).journals.find(x => x.id === 'directors|2026-10');
  assert.deepEqual(lines(j), [['Director Salary', 100000, 0], ['Director Salary Payable- Rohan Tuteja', 0, 50000], ['Director Salary Payable- Adrija Halder', 0, 50000]]);
});

test('staff salary: what the bank paid in the first days of the next month, or the owner\'s figure; without either it is asked for', () => {
  const paid = [{ txn_date: '2026-11-03', debit: 17294 }, { txn_date: '2026-11-07', debit: 16200 }];
  const a = monthEndJournals({ ...month, totals: {}, salaryNext: paid });
  assert.deepEqual(lines(a.journals.find(j => j.id === 'salary|2026-10')), [['Salary Expenses', 33494, 0], ['Salary Payable', 0, 33494]]);
  assert.match(a.journals.find(j => j.id === 'salary|2026-10').memo, /2 payments made in the first days of 2026-11/);
  const b = monthEndJournals({ ...month, totals: {}, salaryNext: paid, salaryOverride: { '2026-10': 140000 } });
  assert.equal(b.journals.find(j => j.id === 'salary|2026-10').debit, 140000);
  const c = monthEndJournals({ ...month, totals: {} });
  assert.equal(c.journals.some(j => j.id === 'salary|2026-10'), false); assert.match(c.missing.join(' '), /Salary for 2026-10: it is paid in the first days of 2026-11/);
});

test('rent: ₹18,000 a month from his own September journal; the setting replaces it; it never blocks the file', () => {
  const dflt = monthEndJournals({ ...month, totals: {} });
  assert.deepEqual(lines(dflt.journals.find(j => j.id === 'rent|2026-10')), [['Rent Sector 63 Noida', 18000, 0], ['Rent Payable', 0, 18000]]);
  assert.equal(dflt.missing.some(m => /Rent for/.test(m)), false);
  assert.match(dflt.notes.join(' '), /Rent for 2026-10: 18,000 a month, the figure of the accountant's September rent journal/);
  const set = monthEndJournals({ ...month, totals: {}, rentMonthly: 20000 });
  assert.deepEqual(lines(set.journals.find(j => j.id === 'rent|2026-10')), [['Rent Sector 63 Noida', 20000, 0], ['Rent Payable', 0, 20000]]);
  assert.equal(set.notes.some(m => /Rent for/.test(m)), false);
});
