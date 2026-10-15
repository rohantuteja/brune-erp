import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readInvoicePdf, type ReadInvoice, type TextItem } from './invoice-reader.ts';
import { applyEdits, billRow, decide, matchVendor, newVendorFrom, normName, recheck, storagePath, vendorProblems, type Vendor } from './bills.ts';

const OURS = '09AALCR1014K1ZB';
const read = (f: string): ReadInvoice => {
  const { items } = JSON.parse(readFileSync(new URL(`./fixtures/invoices/${f}.json`, import.meta.url), 'utf8')) as { items: TextItem[] };
  return readInvoicePdf(items, { companyGstin: OURS, today: '2026-10-15' }).invoices[0];
};
const LEDGERS = new Set(['Marketing Expenses', 'Payment Gateway Expenses', 'Software Expenses @ 18%', 'Shipping Expenses @ 18%']);
const V = (o: Partial<Vendor>): Vendor => ({ id: 1, name: 'Vendor', tally_ledger_name: 'Vendor Ledger', gstin: null, pan: null, state_code: null, booking: 'expense', expense_ledger: 'Marketing Expenses', auto_accept: true, active: true, ...o });

test('a vendor is found by GSTIN; one with no GSTIN yet is found by name; one with a different GSTIN is never taken by name', () => {
  const meta = read('meta'), velocity = read('velocity');
  const vendors = [V({ id: 1, name: 'Meta', gstin: meta.supplier.gstin }), V({ id: 2, name: 'Sample Logistics Tech', gstin: null }), V({ id: 3, name: 'Elsewhere', gstin: '29HHHHH8888H1ZV' })];
  assert.deepEqual(matchVendor(vendors, meta), { vendor: vendors[0], by: 'gstin' });
  assert.deepEqual(matchVendor(vendors, velocity), { vendor: vendors[2], by: 'gstin' });                       // the GSTIN decides
  assert.deepEqual(matchVendor([vendors[1]], velocity), { vendor: vendors[1], by: 'name' });                    // no GSTIN on the vendor: by name
  assert.deepEqual(matchVendor([V({ name: 'Sample Logistics Tech', gstin: '07AAAAA1111A1ZY' })], velocity), { vendor: null, by: null });   // another registration: a person says
  assert.deepEqual(matchVendor([V({ name: 'Sample Logistics Tech', active: false })], velocity), { vendor: null, by: null });
  assert.equal(normName('Goexcelsior Private Limited'), 'goexcelsior'); assert.equal(normName('M/s Bharti Airtel Ltd  UP'), 'bhartiairtelup');
});

test('a bill is accepted without a person only when it read cleanly, the vendor is complete and one bill of it was confirmed before', () => {
  const inv = read('gokwik-pp-cod');
  assert.deepEqual(decide(inv, V({ name: 'GoKwik', expense_ledger: 'Payment Gateway Expenses' }), LEDGERS), { status: 'accepted', reasons: [] });
  const first = decide(inv, V({ name: 'GoKwik', expense_ledger: 'Payment Gateway Expenses', auto_accept: false }), LEDGERS);
  assert.equal(first.status, 'review'); assert.match(first.reasons[0], /first bill from GoKwik/);
  const unknown = decide(inv, null, LEDGERS);
  assert.equal(unknown.status, 'review'); assert.match(unknown.reasons[0], /new vendor/i);
  const noLedger = decide(inv, V({ name: 'GoKwik', expense_ledger: 'Nonsense' }), LEDGERS);
  assert.match(noLedger.reasons[0], /booking is incomplete: an expense vendor needs an expense ledger/);
});

test('a failed check keeps even a trusted vendor\'s bill in review, with the reason', () => {
  const inv = { ...read('velocity'), checks: [{ id: 'lines_total', ok: false, detail: 'the lines add up to ₹10.00 but the taxable value is ₹20.00' }] } as ReadInvoice;
  const d = decide(inv, V({ name: 'Velocity', expense_ledger: 'Shipping Expenses @ 18%' }), LEDGERS);
  assert.deepEqual(d, { status: 'review', reasons: ['the lines add up to ₹10.00 but the taxable value is ₹20.00'] });
});

test('goods are not booked as an expense and a service is not booked as a purchase', () => {
  const goods = read('a');
  assert.match(decide(goods, V({ name: 'Fabric A', booking: 'expense' }), LEDGERS).reasons.join(' '), /booked as an expense but this invoice carries goods codes/);
  assert.equal(decide(goods, V({ name: 'Fabric A', booking: 'purchase', expense_ledger: null }), LEDGERS).status, 'accepted');
  assert.match(decide(read('airtel'), V({ name: 'Airtel', booking: 'purchase', expense_ledger: null }), LEDGERS).reasons.join(' '), /goods purchase but this invoice has a service code/);
  assert.equal(decide(read('easebuzz'), V({ name: 'Easebuzz', booking: 'tie_out', expense_ledger: null }), LEDGERS).status, 'accepted');
});

test('what a vendor profile must have', () => {
  const ok = { name: 'GoKwik', tally_ledger_name: 'Gokwik Commerce Solutions Private Limited', gstin: '06MMMMM3030M1ZR', pan: 'MMMMM3030M', state_code: '06', booking: 'expense' as const, expense_ledger: 'Payment Gateway Expenses' };
  assert.deepEqual(vendorProblems(ok, LEDGERS), []);
  assert.match(vendorProblems({ ...ok, name: ' ' }, LEDGERS).join(), /needs a name/);
  assert.match(vendorProblems({ ...ok, tally_ledger_name: '' }, LEDGERS).join(), /own ledger in Tally/);
  assert.match(vendorProblems({ ...ok, booking: 'whatever' as never }, LEDGERS).join(), /choose how the vendor is booked/);
  assert.match(vendorProblems({ ...ok, expense_ledger: null }, LEDGERS).join(), /needs an expense ledger/);
  assert.deepEqual(vendorProblems({ ...ok, booking: 'purchase', expense_ledger: null }, LEDGERS), []);
  assert.match(vendorProblems({ ...ok, gstin: '06MMMMM3030M1ZZ' }, LEDGERS).join(), /not a valid GSTIN/);
  assert.match(vendorProblems({ ...ok, pan: 'ZZZZZ9999Z' }, LEDGERS).join(), /not the one inside the GSTIN/);
  assert.match(vendorProblems({ ...ok, state_code: '27' }, LEDGERS).join(), /not the one in the GSTIN/);
});

test('a bill row carries the invoice, the checks, the original file and the lines the Velocity page expects', () => {
  const inv = read('velocity');
  const row = billRow(inv, { vendor: V({ id: 7, name: 'Velocity' }), vendorName: 'Velocity', companyGstin: OURS, file: { path: 'bills/2026-10/ab.pdf', hash: 'ab', name: 'invoice.pdf' }, status: 'review', booksStart: '2026-10-01' })!;
  assert.deepEqual([row.vendor, row.vendor_id, row.invoice_no, row.invoice_date, row.status, row.kind, row.opening], ['Velocity', 7, 'SF/1026/1158', '2026-10-01', 'review', 'service', false]);
  assert.deepEqual([row.subtotal, row.tax, row.total, row.tax_type, row.tax_rate, row.round_off], [49572.84, 8923.11, 58495.95, 'IGST', 18, 0]);
  assert.deepEqual([row.period_from, row.period_to, row.bill_to_gstin, row.source, row.file_path, row.file_name], ['2026-09-01', '2026-09-30', OURS, 'upload', 'bills/2026-10/ab.pdf', 'invoice.pdf']);
  assert.deepEqual((row.lines as Array<{ sac: string; description: string; amount: number }>).map(l => [l.sac, l.description, l.amount]), [['996812', 'VAS Charges', 146.5], ['996812', 'Velocity Freight Charges', 49426.34]]);
  assert.equal((row.checks as unknown[]).length, inv.checks.length);
  // dated before the books start: an opening bill
  assert.equal(billRow({ ...inv, invoice_date: '2026-09-30' }, { vendor: null, vendorName: 'X', companyGstin: OURS, file: { path: 'p', hash: 'h', name: 'n' }, status: 'review', booksStart: '2026-10-01' })!.opening, true);
  // not readable well enough to store: no number or no amounts
  assert.equal(billRow({ ...inv, invoice_no: null }, { vendor: null, vendorName: 'X', companyGstin: OURS, file: { path: 'p', hash: 'h', name: 'n' }, status: 'review', booksStart: '2026-10-01' }), null);
  assert.equal(billRow({ ...inv, total: null }, { vendor: null, vendorName: 'X', companyGstin: OURS, file: { path: 'p', hash: 'h', name: 'n' }, status: 'review', booksStart: '2026-10-01' }), null);
});

test('a person may correct the number, the date and the amounts, and the amounts must still agree', () => {
  const row = { invoice_no: 'CF/26962', invoice_date: '2026-10-01', subtotal: 20758, tax: 1038, total: 21796 };
  const r = applyEdits(row, { invoice_no: 'CF/26963', invoice_date: '02-10-2026' });
  assert.ok(r.ok); if (r.ok) { assert.equal(r.values.invoice_no, 'CF/26963'); assert.equal(r.values.invoice_date, '2026-10-02'); assert.deepEqual(r.fixed.sort(), ['invoice_date', 'invoice_number']); assert.deepEqual(r.edited.invoice_no, { read: 'CF/26962', now: 'CF/26963' }); }
  const same = applyEdits(row, { invoice_no: 'CF/26962', total: 21796 });
  assert.ok(same.ok); if (same.ok) { assert.deepEqual(same.edited, {}); assert.deepEqual(same.fixed, []); }        // typing the same value changes nothing
  const fix = applyEdits({ ...row, total: 27796 }, { total: 21796 });
  assert.ok(fix.ok); if (fix.ok) { assert.deepEqual(fix.fixed, ['amounts']); assert.equal(fix.values.total, 21796); }
  const bad = applyEdits(row, { total: 22000 });
  assert.equal(bad.ok, false); if (!bad.ok) assert.match(bad.error, /must agree to within ₹1/);
  assert.equal(applyEdits(row, { invoice_no: ' ' }).ok, false);
  assert.equal(applyEdits(row, { invoice_date: '31-02-2026' }).ok, false);
  assert.equal(applyEdits(row, { tax: -5 }).ok, false);
  assert.equal(applyEdits(row, { taxable: NaN }).ok, false);
});

test('a corrected field\'s check passes, saying who corrected it; the others stay as they were', () => {
  const checks = [{ id: 'invoice_date', ok: false, detail: 'no valid invoice date found' }, { id: 'amounts', ok: false, detail: 'could not find' }, { id: 'billed_to_us', ok: false, detail: 'not ours' }];
  const after = recheck(checks, ['invoice_date'], 'rohan');
  assert.deepEqual(after.map(c => c.ok), [true, false, false]);
  assert.match(after[0].detail, /invoice date corrected by rohan/);
});

test('a new vendor is offered with everything the invoice says about it, and the original is stored once per file', () => {
  const nv = newVendorFrom(read('a'));
  assert.deepEqual(nv, { name: 'SAMPLE FABRICS A', tally_ledger_name: 'SAMPLE FABRICS A', gstin: '07AAAAA1111A1ZY', pan: 'AAAAA1111A', state_code: '07', booking: 'purchase', expense_ledger: null });
  assert.equal(newVendorFrom(read('meta')).booking, 'expense');
  assert.equal(storagePath('2026-10-15', 'abc123'), 'bills/2026-10/abc123.pdf');
});
