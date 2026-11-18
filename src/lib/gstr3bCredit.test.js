import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpening, readRow, prevMonth, nextMonth, filedSnapshot, changedSinceFiled } from './gstr3bCredit.js';
import { buildGstr3b } from './gstr3b.js';
import { buildGstReport } from './gstReport.js';

const row = (o) => readRow({ month: '2026-10', opening_igst: 1341161, opening_cgst: 0, opening_sgst: 0, note: 'n', source: 'tally', updated_by_name: 'Tally trial balance', updated_at: '2026-11-18T10:00:00Z', filed_at: null, ...o });

test('October opens with the Tally figure, as stored', () => {
  const r = resolveOpening({ month: '2026-10', row: row({}), prev: null });
  assert.deepEqual([r.opening.igst, r.opening.cgst, r.opening.sgst, r.source], [1341161, 0, 0, 'tally']);
  assert.match(r.text, /Tally trial balance/);
  assert.equal(r.filed, null);
});

test('a later month opens with the previous month\'s closing once that return is recorded as filed', () => {
  const prev = row({ filed_at: '2026-11-20T09:00:00Z', filed_by_name: 'rohan', closing_igst: 1_300_000.5, closing_cgst: 10, closing_sgst: 0 });
  const r = resolveOpening({ month: '2026-11', row: null, prev });
  assert.deepEqual([r.opening.igst, r.opening.cgst, r.source], [1300000.5, 10, 'carried']);
  assert.match(r.text, /Carried from the October 2026 return you filed on 20 Nov 2026/);
});

test('if the previous return is not recorded as filed, nothing is carried and the page says why', () => {
  const r = resolveOpening({ month: '2026-11', row: null, prev: row({}) });
  assert.equal(r.opening, null);
  assert.match(r.text, /October 2026 return is not recorded as filed/);
});

test('a typed opening for the month is a correction and wins over the carried one', () => {
  const prev = row({ filed_at: '2026-11-20T09:00:00Z', closing_igst: 100 });
  const mine = row({ month: '2026-11', source: 'manual', opening_igst: 5000, updated_by_name: 'rohan' });
  const r = resolveOpening({ month: '2026-11', row: mine, prev });
  assert.deepEqual([r.opening.igst, r.source], [5000, 'manual']);
  assert.match(r.text, /Entered by hand by rohan/);
});

test('a month that was recorded as filed keeps the opening it was filed with', () => {
  const filedRow = row({ month: '2026-11', source: 'carried', opening_igst: 100, filed_at: '2026-12-20T00:00:00Z', closing_igst: 50 });
  const r = resolveOpening({ month: '2026-11', row: filedRow, prev: null });
  assert.deepEqual([r.opening.igst, r.source], [100, 'carried']);
  assert.equal(r.filed.closing.igst, 50);
});

test('month arithmetic', () => {
  assert.equal(prevMonth('2027-01'), '2026-12');
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(prevMonth('2026-10'), '2026-09');
});

// ── the snapshot, and what changed after filing ──
const e = (order_name, entry_date, voucher, account, debit, credit) => ({ order_name, entry_date, voucher, account, debit, credit, doc: 'D1', issued_by: 'unicommerce', memo: '', part: null, qty: null });
const gst = (igst) => buildGstReport({ month: '2026-10', entries: [e('A', '2026-10-03', 'sale', 'GST SALES', 0, 10000), e('A', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, igst)],
  orders: [{ order_name: 'A', channel: 'shopify', state: 'Maharashtra', state_code: '27', rate: '0.05', sale_date: '2026-10-03', invoice_date: '2026-10-03', notes: [] }] });
const report = (igst, opening) => buildGstr3b({ month: '2026-10', gst: gst(igst), ownGstin: '09AALCR1014K1ZB', bills: [], vendors: [], twoB: { docs: [{ kind: 'invoice', ctin: '06AABCF5150G1ZZ', supplier: 'M', no: '1', date: '2026-10-01', value: 1180, taxable: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0, itc: 'Y', reason: '', rcm: false }], warnings: [], checks: [], period: '2026-10', gstin: '09AALCR1014K1ZB' }, opening });

test('the snapshot keeps the opening, the figures and the closing credit that carries forward', () => {
  const r = report(500, { igst: 1000, cgst: 0, sgst: 0 });
  const s = filedSnapshot(r, { opening: { igst: 1000, cgst: 0, sgst: 0 }, source: 'tally', twoBFile: { fileName: 'f.xlsx', docs: [1, 2] } });
  assert.deepEqual(s.payload.opening, { igst: 1000, cgst: 0, sgst: 0 });
  assert.equal(s.payload.closing.igst, 1000 + 180 - 500);                       // opening + claimed - tax paid with credit
  assert.deepEqual([s.payload.filed.twoB.lines, s.payload.filed.cash.igst, s.payload.filed.outward.taxable], [2, 0, 10000]);
  assert.equal(s.payload.source, 'tally');
});

test('a change after filing (a late credit note moves the tax on sales) is reported', () => {
  const filed = filedSnapshot(report(500, { igst: 1000, cgst: 0, sgst: 0 }), { opening: null, source: 'tally' }).payload.filed;
  assert.deepEqual(changedSinceFiled(filed, report(500, { igst: 1000, cgst: 0, sgst: 0 })), []);
  const changed = changedSinceFiled(filed, report(450, { igst: 1000, cgst: 0, sgst: 0 }));
  assert.deepEqual(changed.map(c => [c.what, c.head, c.was, c.now]), [['Tax on sales', 'igst', 500, 450]]);
  assert.deepEqual(changedSinceFiled(null, report(500, null)), []);
});
