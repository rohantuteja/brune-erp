import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowup, bySupplier, reminderText, claimBy, monthName } from './gstr2bFollowup.js';

const vendors = [{ id: 1, name: 'Meta', gstin: '06AABCF5150G1ZZ' }, { id: 8, name: 'Vipul', gstin: '07AFJPJ5098M1ZS' }, { id: 11, name: 'Shree Vinayak', gstin: '07ALCPJ9544R1ZD' }, { id: 9, name: 'Google', gstin: null }];
const bill = (id, vendor_id, vendor, invoice_no, invoice_date, subtotal, tax, extra = {}) => ({ id, vendor_id, vendor, invoice_no, invoice_date, subtotal, tax, total: subtotal + tax, tax_type: 'IGST', supplier_gstin: vendors.find(v => v.id === vendor_id)?.gstin ?? null, status: 'accepted', opening: false, ...extra });
const doc = (ctin, no, date, taxable, igst, extra = {}) => ({ kind: 'invoice', ctin, supplier: 'S', no, date, value: taxable + igst, taxable, igst, cgst: 0, sgst: 0, cess: 0, itc: 'Y', reason: '', rcm: false, supplierPeriod: '', ...extra });
const START = '2026-10-01';
const octFile = { month: '2026-10', docs: [doc('06AABCF5150G1ZZ', '2380933755', '2026-10-01', 1000, 180), doc('07AFJPJ5098M1ZS', '2026-27/1695', '2026-10-04', 29063, 1453.15), doc('07ALCPJ9544R1ZD', 'SVF/26-27/999', '2026-10-09', 100, 5)] };
const bills = [
  bill(1, 1, 'Meta', '2380933755', '2026-10-01', 1000, 180),
  bill(2, 8, 'Vipul', '2026-27/1695', '2026-10-04', 29063, 1453.15),
  bill(3, 11, 'Shree Vinayak', 'SVF/26-27/265', '2026-10-03', 10350, 517.5),            // the supplier filed another invoice of theirs but not this one
  bill(4, 11, 'Shree Vinayak', 'SVF/26-27/306', '2026-11-03', 84820, 4241.01),           // November
];
const at = (o) => buildFollowup({ bills, vendors, files: [octFile], followups: [], today: '2026-11-18', start: START, ...o });
const byNo = (r) => Object.fromEntries(r.rows.map(x => [x.no, x]));

test('a bill in a loaded 2B is claimed (with the month); one missing from its own month\'s 2B is the supplier\'s failure to file', () => {
  const r = byNo(at());
  assert.deepEqual([r['2380933755'].status, r['2380933755'].foundMonth], ['claimed', '2026-10']);
  assert.equal(r['SVF/26-27/265'].status, 'missing');
  assert.equal(r['SVF/26-27/265'].monthsMissing, 1);
  assert.equal(r['SVF/26-27/265'].supplierFiled, 1);                                    // they did file one other invoice that month: this one was left out
});

test('a bill whose month\'s 2B is not generated yet is not due; once it should exist but is not loaded, load it', () => {
  assert.equal(byNo(at())['SVF/26-27/306'].status, 'not_due');                          // November's 2B comes on 14 December
  assert.equal(byNo(at({ today: '2026-12-15' }))['SVF/26-27/306'].status, 'load');
  assert.equal(byNo(at({ today: '2026-12-14' }))['SVF/26-27/306'].status, 'not_due');   // the 14th itself is not late
});

test('a bill that turns up in a later month\'s 2B becomes claimed in that month, and counts as claimed later', () => {
  const nov = { month: '2026-11', docs: [doc('07ALCPJ9544R1ZD', 'SVF/26-27/265', '2026-10-03', 10350, 517.5)] };
  const r = at({ files: [octFile, nov] });
  assert.deepEqual([byNo(r)['SVF/26-27/265'].status, byNo(r)['SVF/26-27/265'].foundMonth], ['claimed', '2026-11']);
  assert.equal(r.summary.claimedLater, 1);
  assert.equal(byNo(r)['SVF/26-27/306'].status, 'missing');                              // and the November bill, now that November's 2B is loaded without it, is the new one to chase
});

test('a bill still missing from several loaded months counts them', () => {
  const nov = { month: '2026-11', docs: [] };
  assert.equal(byNo(at({ files: [octFile, nov] }))['SVF/26-27/265'].monthsMissing, 2);
});

test('a supplier with nothing at all in the 2B is told apart from one that left only this invoice out', () => {
  const r = byNo(at({ files: [{ month: '2026-10', docs: [doc('06AABCF5150G1ZZ', '2380933755', '2026-10-01', 1000, 180)] }] }));
  assert.equal(r['SVF/26-27/265'].supplierFiled, 0);
});

test('in 2B but marked ITC not available (or reverse charge) is its own status, with the reason', () => {
  const f = { month: '2026-10', docs: [doc('07ALCPJ9544R1ZD', 'SVF/26-27/265', '2026-10-03', 10350, 517.5, { itc: 'N', reason: 'POS' })] };
  const x = byNo(at({ files: [f] }))['SVF/26-27/265'];
  assert.deepEqual([x.status, x.itcNote], ['not_available', 'POS']);
});

test('opening, void, undated and pre-books bills are not tracked; a payment gateway tie-out bill is', () => {
  const extra = [bill(10, 1, 'Meta', 'OLD', '2026-09-01', 1, 1, { opening: true }), bill(11, 1, 'Meta', 'VOID', '2026-10-05', 1, 1, { status: 'void' }), bill(12, 1, 'Meta', 'PRE', '2026-09-30', 1, 1), bill(13, 1, 'Meta', 'NODATE', null, 1, 1)];
  const r = buildFollowup({ bills: [...bills, ...extra], vendors, files: [octFile], today: '2026-11-18', start: START });
  assert.equal(r.rows.length, 4);
});

test('a bill with no GSTIN anywhere is matched by invoice number and tax amount', () => {
  const g = [bill(20, 9, 'Google', '5732193357', '2026-10-31', 325, 58.5)];
  const f = { month: '2026-10', docs: [doc('06AACCG0527D1Z8', '5732193357', '2026-10-31', 325, 58.5)] };
  assert.equal(buildFollowup({ bills: g, vendors, files: [f], today: '2026-11-18', start: START }).rows[0].status, 'claimed');
  const wrongAmount = { month: '2026-10', docs: [doc('06AACCG0527D1Z8', '5732193357', '2026-10-31', 325, 99)] };
  assert.equal(buildFollowup({ bills: g, vendors, files: [wrongAmount], today: '2026-11-18', start: START }).rows[0].status, 'missing');
});

test('CGST+SGST bills split their tax in half', () => {
  const a = bill(30, 1, 'Airtel', 'HF1', '2026-10-12', 899, 161.82, { tax_type: 'CGST+SGST' });
  const x = buildFollowup({ bills: [a], vendors, files: [], today: '2026-11-18', start: START }).rows[0];
  assert.deepEqual([x.heads.cgst, x.heads.sgst, x.tax], [80.91, 80.91, 161.82]);
});

test('reminders and notes are kept against the bill, the latest first', () => {
  const followups = [{ invoice_id: 3, action: 'reminded', note: 'called Mr Jain', by_name: 'rohan', at: '2026-11-10T10:00:00Z' }, { invoice_id: 3, action: 'reminded', note: null, by_name: 'rohan', at: '2026-11-16T10:00:00Z' }, { invoice_id: 3, action: 'note', note: 'says filing in the next return', by_name: 'rohan', at: '2026-11-17T10:00:00Z' }];
  const r = byNo(at({ followups }))['SVF/26-27/265'];
  assert.equal(r.reminderCount, 2);
  assert.equal(r.lastReminder.at, '2026-11-16T10:00:00Z');
  assert.equal(r.lastNote.note, 'says filing in the next return');
  assert.equal(at({ followups }).summary.reminded, 1);
});

test('the summary counts each status and the tax still waiting; rows are ordered missing first', () => {
  const r = at();
  assert.deepEqual([r.summary.claimed.count, r.summary.missing.count, r.summary.notDue.count, r.summary.waiting.count], [2, 1, 1, 2]);
  assert.equal(r.summary.waiting.tax, 4758.51);
  assert.deepEqual(r.rows.map(x => x.status), ['missing', 'not_due', 'claimed', 'claimed']);
  assert.deepEqual(r.summary.loadedMonths, ['2026-10']);
});

test('the last day to claim is 30 November after the financial year ends', () => {
  assert.equal(claimBy('2026-10-03'), '2027-11-30');
  assert.equal(claimBy('2026-04-01'), '2027-11-30');
  assert.equal(claimBy('2027-03-31'), '2027-11-30');
  assert.equal(claimBy('2027-04-01'), '2028-11-30');
});

test('the reminder message names the invoices, the 2B months and the supplier, grouped by supplier', () => {
  const r = at();
  const groups = bySupplier(r.rows.filter(x => x.status !== 'claimed'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tax, 4758.51);
  const text = reminderText({ ...groups[0], rows: groups[0].rows.filter(x => x.status === 'missing') }, '09AALCR1014K1ZB');
  assert.match(text, /Hello Shree Vinayak,/);
  assert.match(text, /Invoice SVF\/26-27\/265 dated 03\/10\/2026: ₹10,867\.50 \(GST ₹517\.50\)/);
  assert.match(text, /October 2026/);
  assert.match(text, /GSTIN 09AALCR1014K1ZB/);
  assert.equal(monthName('2026-10'), 'October 2026');
});
