import test from 'node:test';
import assert from 'node:assert/strict';
import { groupOrderVouchers, voucherPlan, accountTotals } from './tallyVouchers.js';

const e = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => ({ order_name, entry_date, voucher, account, debit, credit, doc: null, issued_by: 'x', memo: '', part: null, qty: null, ...extra });
const entries = [
  // a sale: Customer Dr 1050, GST SALES Cr 1000, IGST Cr 50
  e('A', '2026-10-03', 'sale', 'Customer (order control)', 1050, 0, { doc: 'INS1' }), e('A', '2026-10-03', 'sale', 'GST SALES', 0, 1000, { doc: 'INS1' }), e('A', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 50, { doc: 'INS1' }),
  // the gateway collects: Easebuzz Dr / Customer Cr
  e('A', '2026-10-03', 'payment', 'Easebuzz Private Limited', 1050, 0), e('A', '2026-10-03', 'payment', 'Customer (order control)', 0, 1050),
  // one payout (UTR U1) settling two orders: bank net + fee + GST against Easebuzz gross
  e('A', '2026-10-06', 'payout', 'ICICI Bank', 1030, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'Payment Gateway Expenses', 17, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'IGST Input  UP', 3, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'Easebuzz Private Limited', 0, 1050, { doc: 'U1' }),
  e('B', '2026-10-06', 'payout', 'ICICI Bank', 500, 0, { doc: 'U1' }), e('B', '2026-10-06', 'payout', 'Easebuzz Private Limited', 0, 500, { doc: 'U1' }),
  // a return: credit note
  e('A', '2026-10-10', 'credit_note', 'GST SALES RETURN', 200, 0, { doc: 'ISR1' }), e('A', '2026-10-10', 'credit_note', 'IGST OUTPUT UP', 10, 0, { doc: 'ISR1' }), e('A', '2026-10-10', 'credit_note', 'Customer (order control)', 0, 210, { doc: 'ISR1' }),
  // an ERP fee invoice
  e('A', '2026-10-10', 'invoice', 'Customer (order control)', 99, 0, { doc: 'ERP/IN/2627/0001', issued_by: 'erp' }), e('A', '2026-10-10', 'invoice', 'GST SALES', 0, 94.29, { doc: 'ERP/IN/2627/0001', part: 'return_fee' }), e('A', '2026-10-10', 'invoice', 'IGST OUTPUT UP', 0, 4.71, { doc: 'ERP/IN/2627/0001' }),
  // an unbalanced set (a bug in the ledger would show up like this)
  e('C', '2026-10-11', 'goodwill', 'Goodwill credits', 100, 0), e('C', '2026-10-11', 'goodwill', 'STORE CREDIT BY SHOPIFY', 0, 90),
];

test('entries become one voucher per invoice, credit note, UTR and clearing event, typed for Tally', () => {
  const v = groupOrderVouchers(entries);
  assert.deepEqual(v.map(x => [x.type, x.source, x.doc]).sort((a, b) => String(a).localeCompare(String(b))), [
    ['credit_note', 'credit_note', 'ISR1'], ['journal', 'goodwill', null], ['journal', 'payment', null], ['receipt', 'payout', 'U1'], ['sales', 'invoice', 'ERP/IN/2627/0001'], ['sales', 'sale', 'INS1']].sort((a, b) => String(a).localeCompare(String(b))));
});

test('a payout is one receipt for the UTR with a line per order, dated by the bank', () => {
  const r = groupOrderVouchers(entries).find(x => x.type === 'receipt');
  assert.deepEqual(r.orders, ['A', 'B']);
  assert.equal(r.date, '2026-10-06');
  assert.equal(r.lines.length, 6);
  assert.equal(r.debit, 1550);
  assert.equal(r.balanced, true);
});

test('every voucher is checked for balance; an unbalanced one is flagged, never silently exported', () => {
  const v = groupOrderVouchers(entries);
  assert.equal(v.filter(x => !x.balanced).length, 1);
  assert.equal(v.find(x => !x.balanced).source, 'goodwill');
});

test('the plan counts vouchers by type and amount, and says how many are unbalanced', () => {
  const p = voucherPlan(groupOrderVouchers(entries));
  assert.equal(p.sales.count, 2);
  assert.equal(p.receipt.count, 1);
  assert.equal(p.journal.count, 2);
  assert.equal(p.journal.unbalanced, 1);
  assert.deepEqual(p.sales.sources, { sale: 1, invoice: 1 });
});

test('account totals over the vouchers equal the ledger entries\' own totals (the built-in check)', () => {
  const t = accountTotals(groupOrderVouchers(entries));
  const direct = {};
  for (const x of entries) { const a = direct[x.account] ?? (direct[x.account] = { debit: 0, credit: 0 }); a.debit = Math.round((a.debit + x.debit) * 100) / 100; a.credit = Math.round((a.credit + x.credit) * 100) / 100; }
  assert.deepEqual(t, direct);
});
