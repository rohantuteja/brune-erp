import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOKS, unitOf, billsToBook, purchaseVoucher, allocateSupplier, classifyBankLines, vendorByPayeeName, bankRef, buildBooks, bookChecks } from './tallyBooks.js';

// A small October with the shapes of the real one: a fabric supplier paid for two bills in one payment, advances paid before an invoice dated next month, Meta's
// opening bill paid on the 1st, a telephone bill part-paid before it arrived, wholesale left to the accountant.
const vendors = [
  { id: 1, name: 'CHANDRA FASHION', tally_ledger_name: 'Chandra Fashion', gstin: '24AASFC4987G1ZY', booking: 'purchase' },
  { id: 2, name: 'Shree Vinayak Fab', tally_ledger_name: 'Shree Vinayak Fab', gstin: '07ALCPJ9544R1ZD', booking: 'purchase' },
  { id: 3, name: 'Meta', tally_ledger_name: 'Facebook India Online Services Private Limited', gstin: '06AABCF5150G1ZZ', booking: 'expense', expense_ledger: 'Marketing Expenses', tds_to_confirm: true },
  { id: 4, name: 'Airtel', tally_ledger_name: 'M/s Bharti Airtel Ltd  UP', gstin: '09AAACB2894G1ZM', booking: 'expense', expense_ledger: 'Telephone and Internet Expenses GST' },
  { id: 5, name: 'AGGARWAL TRADERS', tally_ledger_name: 'Aggarwal Traders', gstin: '07AKFPR5912D1Z9', booking: 'purchase' },
  { id: 6, name: 'Easebuzz', tally_ledger_name: 'Easebuzz Private Limited', gstin: '36AAGCE6573M1ZW', booking: 'tie_out', expense_ledger: 'Payment Gateway Expenses' },
];
const bill = (o) => ({ status: 'accepted', opening: false, kind: 'goods', tax_type: 'IGST', tax_rate: 5, lines: [], ...o });
const bills = [
  bill({ id: 1, vendor: 'CHANDRA FASHION', vendor_id: 1, invoice_no: 'CF/26962', invoice_date: '2026-10-01', subtotal: 20758, tax: 1038, total: 21796, supplier_gstin: '24AASFC4987G1ZY', lines: [{ hsn: '60063200', qty: 99.32, rate: 209, unit: 'KGS', amount: 20757.88 }] }),
  bill({ id: 2, vendor: 'CHANDRA FASHION', vendor_id: 1, invoice_no: 'CF/27047', invoice_date: '2026-10-01', subtotal: 21999, tax: 1100, total: 23099, supplier_gstin: '24AASFC4987G1ZY', lines: [{ hsn: '60063200', qty: 102.32, rate: 215, unit: 'KGS', amount: 21998.8 }] }),
  bill({ id: 3, vendor: 'Shree Vinayak Fab', vendor_id: 2, invoice_no: 'SVF/26-27/265', invoice_date: '2026-10-03', subtotal: 10350, tax: 517.5, total: 10868, supplier_gstin: '07ALCPJ9544R1ZD', lines: [{ hsn: '520812', qty: 115.5, rate: 89.61, unit: 'MTR', amount: 10350 }] }),
  bill({ id: 4, vendor: 'Shree Vinayak Fab', vendor_id: 2, invoice_no: 'SVF/26-27/306', invoice_date: '2026-11-03', subtotal: 84820, tax: 4241.01, total: 89061, supplier_gstin: '07ALCPJ9544R1ZD',
    lines: [{ hsn: '520812', qty: 634.25, rate: 70, unit: 'MTR', amount: 44397.5 }, { hsn: '520812', qty: 425.5, rate: 95, unit: 'MTR', amount: 40422.5 }] }),
  bill({ id: 5, vendor: 'Meta', vendor_id: 3, invoice_no: '2380919690', invoice_date: '2026-09-01', opening: true, kind: 'service', tax_rate: 18, subtotal: 679432.69, tax: 122297.89, total: 801730.58, supplier_gstin: '06AABCF5150G1ZZ' }),
  bill({ id: 6, vendor: 'Meta', vendor_id: 3, invoice_no: '2380933755', invoice_date: '2026-10-01', kind: 'service', tax_rate: 18, subtotal: 504308.3, tax: 90775.49, total: 595083.79, supplier_gstin: '06AABCF5150G1ZZ' }),
  bill({ id: 7, vendor: 'Airtel', vendor_id: 4, invoice_no: 'HF2709I013498070', invoice_date: '2026-10-12', kind: 'service', tax_type: 'CGST+SGST', tax_rate: 18, subtotal: 899, tax: 161.82, total: 1060.82, supplier_gstin: '09AAACB2894G1ZM' }),
  bill({ id: 8, vendor: 'AGGARWAL TRADERS', vendor_id: 5, invoice_no: '1068', invoice_date: '2026-10-25', subtotal: 465204.75, tax: 23260.25, total: 488465, supplier_gstin: '07AKFPR5912D1Z9' }),
  bill({ id: 9, vendor: 'Easebuzz', vendor_id: 6, invoice_no: 'N2627/000100369', invoice_date: '2026-10-31', kind: 'service', tax_rate: 18, subtotal: 6864.71, tax: 1235.65, total: 8100.36, supplier_gstin: '36AAGCE6573M1ZW' }),
];
const handled = [{ gstin: '07AKFPR5912D1Z9', invoice_key: '1068', invoice_no: '1068' }];
const buckets = [
  { name: 'Purchase Accounts', kind: 'expense', needs_bill: true }, { name: 'Facebook India Online Services Private Limited', kind: 'liability', needs_bill: false },
  { name: 'Telephone and Internet Expenses GST', kind: 'expense', needs_bill: true }, { name: 'Labour Charges', kind: 'expense', needs_bill: false },
  { name: 'Wholesale (accountant books)', kind: 'ignore', needs_bill: false }, { name: 'Suspense', kind: 'review', needs_bill: false }, { name: 'Easebuzz Private Limited', kind: 'transfer', needs_bill: false },
];
const L = (o) => ({ status: 'matched', debit: 0, credit: 0, payee: null, remarks: '', vendor_id: null, ...o });
const lines = [
  L({ id: 1, txn_date: '2026-10-01', debit: 801730.58, bucket: 'Facebook India Online Services Private Limited', remarks: 'NEFT-META' }),
  L({ id: 17, txn_date: '2026-10-02', debit: 44895, bucket: 'Purchase Accounts', payee: 'chandrafas', remarks: 'MMT/IMPS/627514475918/fabric/ChandraFas/HDFC0001704' }),
  L({ id: 22, txn_date: '2026-10-03', debit: 10868, bucket: 'Purchase Accounts', payee: 'xxkfab', remarks: 'UPI/110822791047/fabric/XXkfab@icici' }),
  L({ id: 58, txn_date: '2026-10-10', debit: 15000, bucket: 'Purchase Accounts', payee: 'xxkfab', remarks: 'UPI/110886242994/fabricadv/XXkfab@icici' }),
  L({ id: 228, txn_date: '2026-10-27', debit: 74019, bucket: 'Purchase Accounts', payee: 'xxkfab', remarks: 'UPI/111016612294/shreevinayakpur/XXkfab@icici' }),
  L({ id: 254, txn_date: '2026-10-07', debit: 960.82, bucket: 'Telephone and Internet Expenses GST', payee: 'bhartiairtelltdgurgaonin', remarks: 'BHARTI AIRTEL LTD GURGAON IN' }),
  L({ id: 300, txn_date: '2026-10-05', debit: 4500, bucket: 'Labour Charges', payee: 'karigar', remarks: 'UPI/110900000001/labour/XX1234@ybl' }),
  L({ id: 207, txn_date: '2026-10-20', debit: 846258, bucket: 'Wholesale (accountant books)', status: 'ignored', payee: 'agarwaltraders', remarks: 'INF/INFT/046358837161/purchase /AGARWALTRADERS' }),
  L({ id: 189, txn_date: '2026-10-13', credit: 1500282, bucket: 'Wholesale (accountant books)', status: 'ignored', remarks: 'RTGS-WAKUM INDIA' }),
  L({ id: 400, txn_date: '2026-10-16', credit: 5000, bucket: 'Suspense', remarks: 'UPI/110950000002/refund' }),
  L({ id: 401, txn_date: '2026-10-17', credit: 20000, bucket: 'Easebuzz Private Limited', remarks: 'NEFT-EASEBUZZ' }),
  L({ id: 500, txn_date: '2026-10-18', debit: 777, bucket: 'Purchase Accounts', payee: 'mystery', remarks: 'UPI/110960000003/fabric/XXmyst@ybl' }),
];
const month = { from: '2026-10-01', next: '2026-11-01', start: '2026-10-01' };
const run = (o = {}) => buildBooks({ ...month, bills, vendors, handled, bankLines: lines, buckets, payeeLinks: [], ...o });
const byId = (r, id) => r.vouchers.find(v => v.id === id);

test('the unit of an invoice line is Tally\'s: kilos or metres, anything else is not an item', () => {
  assert.equal(unitOf({ unit: 'KGS' }), 'KGS'); assert.equal(unitOf({ unit: 'kg' }), 'KGS'); assert.equal(unitOf({ unit: 'MTR' }), 'MTR'); assert.equal(unitOf({ unit: 'Meters' }), 'MTR');
  assert.equal(unitOf({ unit: 'PCS' }), null); assert.equal(unitOf({}), null);
});

test('a fabric bill in kilos or metres is an item invoice; the paise of the invoice go to ROUND OFF on the right side', () => {
  const book = billsToBook({ bills, vendors, handled }).list;
  const chandra = purchaseVoucher(book.find(t => t.bill.id === 1)).voucher;
  assert.equal(chandra.mode, 'Item Invoice'); assert.equal(chandra.items[0].name, 'KNITTED FABRIC'); assert.equal(chandra.items[0].unit, 'KGS');
  assert.deepEqual(chandra.lines.map(l => [l.account, l.debit, l.credit]), [['Chandra Fashion', 0, 21796], [BOOKS.igst, 1038, 0], [BOOKS.roundOff, 0.12, 0]]);
  assert.equal(chandra.debit, 21796); assert.equal(chandra.credit, 21796); assert.equal(chandra.balanced, true);
  const sv = purchaseVoucher(book.find(t => t.bill.id === 4)).voucher;                              // two lines in metres, the invoice rounded 1 paisa down
  assert.equal(sv.items[0].name, 'Shirting Fabric'); assert.equal(sv.items.length, 2); assert.deepEqual(sv.lines.at(-1), { account: BOOKS.roundOff, debit: 0, credit: 0.01 }); assert.equal(sv.balanced, true);
});

test('an expense bill is an accounting invoice against the supplier\'s expense ledger; CGST and SGST split the tax; the paise are exact', () => {
  const book = billsToBook({ bills, vendors, handled }).list;
  const airtel = purchaseVoucher(book.find(t => t.bill.id === 7)).voucher;
  assert.equal(airtel.mode, 'Accounting Invoice');
  assert.deepEqual(airtel.lines.map(l => [l.account, l.debit, l.credit]), [['M/s Bharti Airtel Ltd  UP', 0, 1060.82], ['Telephone and Internet Expenses GST', 899, 0], [BOOKS.cgst, 80.91, 0], [BOOKS.sgst, 80.91, 0]]);
  assert.equal(airtel.balanced, true); assert.equal(airtel.partyState, 'Uttar Pradesh');
  const meta = purchaseVoucher(book.find(t => t.bill.id === 6)).voucher;
  assert.equal(meta.partyState, 'Haryana'); assert.equal(meta.balanced, true);
});

test('tax deducted at source: the supplier is credited the invoice less TDS and the TDS ledger the TDS', () => {
  const withTds = vendors.map(v => v.id === 3 ? { ...v, tds_rate: 2, tds_ledger: 'TDS Payable', tds_to_confirm: false } : v);
  const t = billsToBook({ bills, vendors: withTds, handled }).list.find(x => x.bill.id === 6);
  assert.equal(t.tds, 10086); assert.equal(t.net, 584997.79);
  const v = purchaseVoucher(t).voucher;
  assert.deepEqual(v.lines.slice(0, 2).map(l => [l.account, l.credit]), [['Facebook India Online Services Private Limited', 584997.79], ['TDS Payable', 10086]]);
  assert.equal(v.balanced, true);
});

test('a line that is not in kilos or metres makes the whole bill an accounting invoice, and a supplier with no expense ledger is a problem', () => {
  const odd = bills.map(b => b.id === 1 ? { ...b, lines: [{ ...b.lines[0], unit: 'PCS' }] } : b);
  const t = billsToBook({ bills: odd, vendors, handled }).list.find(x => x.bill.id === 1);
  const r = purchaseVoucher(t);
  assert.equal(r.voucher.mode, 'Accounting Invoice'); assert.equal(r.voucher.lines[1].account, BOOKS.purchaseLedger); assert.match(r.note, /accounting invoice/);
  assert.equal(r.voucher.balanced, true);
  const noLedger = purchaseVoucher({ ...billsToBook({ bills, vendors, handled }).list.find(x => x.bill.id === 7), vendor: { ...vendors[3], expense_ledger: null } });
  assert.match(noLedger.problem, /no expense ledger/);
});

test('bills marked "the accountant books this one", easebuzz (tie-out) and unaccepted bills are not booked', () => {
  const { list } = billsToBook({ bills: [...bills, bill({ id: 10, vendor: 'Meta', vendor_id: 3, invoice_no: 'X', status: 'review', subtotal: 1, tax: 0, total: 1 })], vendors, handled });
  assert.deepEqual(list.map(t => t.bill.id), [1, 2, 3, 4, 5, 6, 7]);
});

test('payments settle bills: one payment for two bills, an advance before the bill, and the bill then settled by the advance', () => {
  const a = allocateSupplier(
    [{ id: 1, name: 'CF/1', date: '2026-10-01', net: 21796 }, { id: 2, name: 'CF/2', date: '2026-10-01', net: 23099 }],
    [{ id: 17, date: '2026-10-02', amount: 44895, ref: 'R17' }]);
  assert.deepEqual(a.payRefs.get(17), [{ name: 'CF/1', kind: 'Agst Ref', amount: 21796 }, { name: 'CF/2', kind: 'Agst Ref', amount: 23099 }]);
  assert.deepEqual(a.open, []);
  const b = allocateSupplier([{ id: 4, name: 'SVF/306', date: '2026-11-03', net: 89061 }],
    [{ id: 58, date: '2026-10-10', amount: 15000, ref: 'A' }, { id: 228, date: '2026-10-27', amount: 74019, ref: 'B' }]);
  assert.deepEqual(b.payRefs.get(58), [{ name: 'ADV-A', kind: 'Advance', amount: 15000 }]);
  assert.deepEqual(b.billRefs.get(4), [{ name: 'ADV-A', kind: 'Agst Ref', amount: 15000 }, { name: 'ADV-B', kind: 'Agst Ref', amount: 74019 }, { name: 'SVF/306', kind: 'New Ref', amount: 42 }]);
  assert.deepEqual(b.open.map(o => [o.name, o.left]), [['SVF/306', 42]]);
  const c = allocateSupplier([{ id: 9, name: 'B1', date: '2026-10-05', net: 1000 }], [{ id: 1, date: '2026-10-05', amount: 400, ref: 'p' }]);   // a part payment, same day
  assert.deepEqual(c.payRefs.get(1), [{ name: 'B1', kind: 'Agst Ref', amount: 400 }]); assert.deepEqual(c.open.map(o => o.left), [600]);
});

test('an opening bill (before the books start) takes a payment but makes no New Ref of its own', () => {
  const a = allocateSupplier([{ id: 5, name: 'M1', date: '2026-09-01', net: 801730.58, opening: true }, { id: 6, name: 'M2', date: '2026-10-01', net: 595083.79 }],
    [{ id: 1, date: '2026-10-01', amount: 801730.58, ref: 'x' }]);
  assert.deepEqual(a.billRefs.get(5), []); assert.deepEqual(a.payRefs.get(1), [{ name: 'M1', kind: 'Agst Ref', amount: 801730.58 }]);
  assert.deepEqual(a.billRefs.get(6), [{ name: 'M2', kind: 'New Ref', amount: 595083.79 }]);
});

test('a bank line is placed by its bucket, by the exact amount of a supplier\'s bills, by a payee seen on another line, or by the payee\'s name; the rest is asked about', () => {
  const list = billsToBook({ bills, vendors, handled }).list.filter(t => t.bill.invoice_date < month.next);
  const c = classifyBankLines({ lines, buckets, vendors, payeeLinks: [], timeline: list, start: month.start, next: month.next });
  const who = (id) => c.payments.find(p => p.line.id === id)?.ledger;
  assert.equal(who(1), 'Facebook India Online Services Private Limited');                         // the bucket is the supplier's ledger
  assert.equal(who(17), 'Chandra Fashion');                                                       // two bills add up to the amount
  assert.equal(who(22), 'Shree Vinayak Fab');                                                     // one bill
  assert.equal(who(58), 'Shree Vinayak Fab'); assert.equal(who(228), 'Shree Vinayak Fab');        // the same handle, seen above
  assert.equal(who(254), 'M/s Bharti Airtel Ltd  UP');                                            // "BHARTI AIRTEL" names Airtel
  assert.equal(who(300), 'Labour Charges');                                                       // no bill needed: its own ledger
  assert.deepEqual(c.unlinked.map(l => l.id), [500]);
  assert.deepEqual(c.receipts.map(r => [r.line.id, r.ledger]), [[400, 'Suspense']]);
  assert.deepEqual(c.skipped.map(s => [s.line.id, s.why]).sort((a, b) => a[0] - b[0]), [[189, 'ignored'], [207, 'ignored'], [401, 'order ledger receipt']]);
});

test('a person\'s link and a remembered payee decide before the guesses do', () => {
  const list = billsToBook({ bills, vendors, handled }).list;
  const linked = lines.map(l => l.id === 500 ? { ...l, vendor_id: 1 } : l);
  const c = classifyBankLines({ lines: linked, buckets, vendors, payeeLinks: [], timeline: list, start: month.start, next: month.next });
  assert.equal(c.payments.find(p => p.line.id === 500).ledger, 'Chandra Fashion'); assert.equal(c.unlinked.length, 0);
  const d = classifyBankLines({ lines, buckets, vendors, payeeLinks: [{ payee: 'mystery', vendor_id: 2 }], timeline: list, start: month.start, next: month.next });
  assert.equal(d.payments.find(p => p.line.id === 500).ledger, 'Shree Vinayak Fab');
  assert.equal(vendorByPayeeName('XX1234', vendors), null); assert.equal(vendorByPayeeName('chandrafas', vendors).id, 1);
  assert.equal(bankRef({ id: 3, remarks: 'UPI/110822791047/fabric/XXkfab@icici' }), '110822791047'); assert.equal(bankRef({ id: 254, remarks: 'BHARTI AIRTEL' }), 'L254');
});

test('the month: purchase vouchers before payments on a day, every voucher balanced, wholesale and the tie-out left out, advances and what is still unpaid reported', () => {
  const r = run();
  assert.deepEqual(r.vouchers.filter(v => v.type === 'purchase').map(v => v.id), ['purchase|6', 'purchase|1', 'purchase|2', 'purchase|3', 'purchase|7']);   // by date, then number
  assert.equal(r.vouchers.filter(v => v.type === 'payment').length, 7); assert.equal(r.vouchers.filter(v => v.type === 'receipt').length, 1);
  assert.ok(r.vouchers.every(v => v.balanced), 'all balanced');
  assert.equal(r.vouchers.some(v => v.vendor === 'AGGARWAL TRADERS' || v.lineId === 207 || v.lineId === 189), false);
  const order = r.vouchers.map(v => `${v.date}|${v.type}`);
  assert.ok(order.indexOf('2026-10-01|purchase') < order.indexOf('2026-10-01|payment'), 'bills of the day come before the payments');
  assert.deepEqual(byId(r, 'payment|17').billRefs.map(x => x.name), ['CF/26962', 'CF/27047']);
  assert.deepEqual(byId(r, 'payment|1').billRefs, [{ name: '2380919690', kind: 'Agst Ref', amount: 801730.58 }]);
  assert.deepEqual(byId(r, 'purchase|7').billRefs, [{ name: 'ADV-L254', kind: 'Agst Ref', amount: 960.82 }, { name: 'HF2709I013498070', kind: 'New Ref', amount: 100 }]);
  assert.deepEqual(r.advances.map(a => [a.vendor, a.left]), [['Shree Vinayak Fab', 15000], ['Shree Vinayak Fab', 74019]]);
  assert.deepEqual(r.unlinked.map(l => l.id), [500]); assert.deepEqual(r.tdsPending, ['Meta']);
  assert.deepEqual(r.unpaid.map(u => [u.vendor, u.name, u.left]), [['Meta', '2380933755', 595083.79], ['Airtel', 'HF2709I013498070', 100]]);
  assert.equal(r.summary.purchases.count, 5); assert.equal(r.summary.payments.count, 7);
});

test('only the vouchers dated in the month are written, but earlier months\' advances still settle this month\'s bills', () => {
  const nov = buildBooks({ from: '2026-11-01', next: '2026-12-01', start: '2026-10-01', bills, vendors, handled, bankLines: lines, buckets, payeeLinks: [] });
  assert.deepEqual(nov.vouchers.map(v => v.id), ['purchase|4']);
  assert.deepEqual(nov.vouchers[0].billRefs, [{ name: 'ADV-110886242994', kind: 'Agst Ref', amount: 15000 }, { name: 'ADV-111016612294', kind: 'Agst Ref', amount: 74019 }, { name: 'SVF/26-27/306', kind: 'New Ref', amount: 42 }]);
  assert.equal(nov.advances.length, 0);
});

test('the checks say so when a payment is not linked to a supplier', () => {
  const r = run();
  const c = bookChecks(r);
  assert.equal(c.find(k => k.id === 'purchases').ok, true);
  assert.equal(c.find(k => k.id === 'payments').ok, false); assert.match(c.find(k => k.id === 'payments').detail, /1 bank payment/);
  const ok = bookChecks(run({ bankLines: lines.filter(l => l.id !== 500) }));
  assert.equal(ok.every(k => k.ok), true);
});

test('a prepaid wallet is not settled bill by bill: a top-up and the monthly invoice are each a new reference', () => {
  const velocity = { id: 7, name: 'Velocity', tally_ledger_name: 'Velocity Prepaid Recharge Account', gstin: '06AAECW1234F1Z5', booking: 'expense', expense_ledger: 'Shipping Expenses @ 18%' };
  const wBills = [bill({ id: 20, vendor: 'Velocity', vendor_id: 7, invoice_no: 'SF/1026/1158', invoice_date: '2026-10-01', kind: 'service', tax_rate: 18, subtotal: 49572.84, tax: 8923.11, total: 58495.95, supplier_gstin: '06AAECW1234F1Z5' })];
  const wLines = [L({ id: 183, txn_date: '2026-10-12', debit: 10000, bucket: 'Velocity Prepaid Recharge Account', remarks: 'UPI/110900000009/UPI Pay/shipfast.cf@axi' })];
  const wBuckets = [...buckets, { name: 'Velocity Prepaid Recharge Account', kind: 'asset', needs_bill: false }];
  const r = buildBooks({ ...month, bills: wBills, vendors: [velocity], handled: [], bankLines: wLines, buckets: wBuckets, payeeLinks: [] });
  const pur = r.vouchers.find(v => v.type === 'purchase'), pay = r.vouchers.find(v => v.type === 'payment');
  assert.deepEqual(pur.billRefs, [{ name: 'SF/1026/1158', kind: 'New Ref', amount: 58495.95 }]);
  assert.deepEqual(pay.billRefs, [{ name: 'ERP/PY/2627/00183', kind: 'New Ref', amount: 10000 }]);
  assert.equal(pay.source, 'wallet top-up'); assert.deepEqual(r.advances, []); assert.deepEqual(r.unpaid, []);
});
