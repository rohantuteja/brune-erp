import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustmentLines, tieOut, TOLERANCE, type TieOutInput } from './gateway-tieout.ts';

const PERIOD = { from: '2026-10-01', to: '2026-10-31', assumed: false };
const INV = { no: 'N2627/000090001', date: '2026-10-31', taxable: 10693.94, gst: 1924.91, taxType: 'IGST' };
const I = (o: Partial<TieOutInput>): TieOutInput => ({ invoice: INV, period: PERIOD, report: { count: 424, fee: 10693.73, gst: 1925.12 }, booked: { count: 424, fee: 10693.73, gst: 1925.12 }, opening: false, ...o });
const sum = (t: ReturnType<typeof tieOut>, k: 'debit' | 'credit') => Math.round(t.lines.reduce((s, l) => s + l[k], 0) * 100) / 100;

test('September, as if it were in the books: the total is identical, the split differs by ₹0.21, and one two-line voucher removes it', () => {
  const t = tieOut(I({}));
  assert.equal(t.status, 'adjust');
  assert.deepEqual(t.diff, { expense: 0.21, gst: -0.21, gateway: 0 });
  assert.deepEqual(t.lines, [{ account: 'Payment Gateway Expenses', debit: 0.21, credit: 0 }, { account: 'IGST Input  UP', debit: 0, credit: 0.21 }]);   // the ledger's own account names, two spaces included
  assert.equal(sum(t, 'debit'), sum(t, 'credit'));
  assert.match(t.reasons[0], /more expense by ₹0\.21 and less input GST by ₹0\.21/);
  assert.deepEqual([t.invoice.total, t.booked.total, t.report.total], [12618.85, 12618.85, 12618.85]);
});

test('the invoice and the ledger agree: nothing to post', () => {
  const t = tieOut(I({ invoice: { ...INV, taxable: 10693.73, gst: 1925.12 } }));
  assert.equal(t.status, 'agrees'); assert.deepEqual(t.lines, []); assert.deepEqual(t.diff, { expense: 0, gst: 0, gateway: 0 });
});

test('an invoice for more than was booked: expense and input GST debited, Easebuzz credited, and the voucher balances', () => {
  const t = tieOut(I({ invoice: { ...INV, taxable: 10695.73, gst: 1925.43 } }));
  assert.equal(t.status, 'adjust');
  assert.deepEqual(t.diff, { expense: 2, gst: 0.31, gateway: 2.31 });
  assert.deepEqual(t.lines, [{ account: 'Payment Gateway Expenses', debit: 2, credit: 0 }, { account: 'IGST Input  UP', debit: 0.31, credit: 0 }, { account: 'Easebuzz Private Limited', debit: 0, credit: 2.31 }]);
  assert.equal(sum(t, 'debit'), sum(t, 'credit'));
});

test('an invoice for less than was booked: the same voucher the other way round', () => {
  const t = tieOut(I({ invoice: { ...INV, taxable: 10691.73, gst: 1924.51 } }));
  assert.deepEqual(t.lines, [{ account: 'Payment Gateway Expenses', debit: 0, credit: 2 }, { account: 'IGST Input  UP', debit: 0, credit: 0.61 }, { account: 'Easebuzz Private Limited', debit: 2.61, credit: 0 }]);
  assert.equal(sum(t, 'debit'), sum(t, 'credit'));
});

test('a difference above the tolerance is investigated by a person before it is posted, but the voucher is still shown', () => {
  const t = tieOut(I({ invoice: { ...INV, taxable: 10693.73 + TOLERANCE + 20, gst: 1925.12 } }));
  assert.equal(t.status, 'investigate'); assert.ok(t.lines.length > 0); assert.match(t.reasons[0], /more than a rounding difference/);
});

test('payouts the ledger has not booked yet (an order waiting for its invoice) are never covered by an adjustment: wait', () => {
  const t = tieOut(I({ booked: { count: 410, fee: 10500, gst: 1890 } }));
  assert.equal(t.status, 'wait'); assert.deepEqual(t.lines, []);
  assert.match(t.reasons[0], /booked ₹12,390\.00 of the ₹12,618\.85/); assert.match(t.reasons[0], /count them twice/);
  // booked MORE than the report shows is also a gap, said the other way round
  assert.match(tieOut(I({ booked: { count: 430, fee: 10800, gst: 1944 } })).reasons[0], /booked fees are not in the report/);
});

test('an invoice dated before the books start is only compared with the GoKwik report: never posted, whatever the difference', () => {
  const t = tieOut(I({ opening: true, period: { from: '2026-09-01', to: '2026-09-30', assumed: false }, booked: { count: 68, fee: 1720.8, gst: 309.92 } }));
  assert.equal(t.status, 'opening'); assert.deepEqual(t.lines, []);
  assert.deepEqual(t.diff, { expense: 0.21, gst: -0.21, gateway: 0 });
  assert.match(t.reasons[0], /agrees with the GoKwik report for the month \(₹12,618\.85\), the split differs by ₹0\.21/);
  assert.match(tieOut(I({ opening: true, invoice: { ...INV, taxable: 11000 } })).reasons[0], /differs by ₹/);
});

test('an invoice that charges CGST + SGST is not adjusted as IGST', () => {
  const t = tieOut(I({ invoice: { ...INV, taxType: 'CGST+SGST' } }));
  assert.equal(t.status, 'investigate'); assert.deepEqual(t.lines, []); assert.match(t.reasons[0], /CGST\+SGST.*IGST/);
});

test('the voucher always balances, whatever the two differences are', () => {
  for (const [e, g] of [[0.21, -0.21], [1, 1], [-1, -1], [3, -0.5], [-0.01, 0.02], [0.5, 0]] as const) {
    const lines = adjustmentLines({ expense: e, gst: g, gateway: Math.round((e + g) * 100) / 100 });
    const dr = Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100, cr = Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100;
    assert.equal(dr, cr, `${e} / ${g}`);
  }
});
