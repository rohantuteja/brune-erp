import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTallyFile, tallyVoucher, tallyState, guid } from './tallyJson.js';
import { groupOrderVouchers } from './tallyVouchers.js';

const e = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => ({ order_name, entry_date, voucher, account, debit, credit, doc: null, issued_by: 'x', memo: '', part: null, qty: null, ...extra });
const entries = [
  e('A', '2026-10-03', 'sale', 'Customer (order control)', 1050, 0, { doc: 'INS1' }), e('A', '2026-10-03', 'sale', 'GST SALES', 0, 1000, { doc: 'INS1' }), e('A', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 50, { doc: 'INS1' }),
  e('A', '2026-10-03', 'payment', 'Easebuzz Private Limited', 1050, 0), e('A', '2026-10-03', 'payment', 'Customer (order control)', 0, 1050),
  e('A', '2026-10-06', 'payout', 'ICICI Bank', 1030, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'Payment Gateway Expenses', 17, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'IGST Input  UP', 3, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'Easebuzz Private Limited', 0, 1050, { doc: 'U1' }),
  e('A', '2026-10-10', 'credit_note', 'GST SALES RETURN', 200, 0, { doc: 'ISR1' }), e('A', '2026-10-10', 'credit_note', 'IGST OUTPUT UP', 10, 0, { doc: 'ISR1' }), e('A', '2026-10-10', 'credit_note', 'Customer (order control)', 0, 210, { doc: 'ISR1' }),
];
const orders = new Map([['A', { state: 'Jammu and Kashmir', saleDoc: 'INS1', channel: 'shopify' }]]);
const find = (file, type) => file.tallymessage.find(m => m.vouchertypename === type);

test('a sale: party on top, place of supply in Tally\'s spelling, debits negative and credits positive, a New Ref bill named by the invoice', () => {
  const { file, errors } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  assert.deepEqual(errors, []);
  const s = find(file, 'Sales');
  assert.deepEqual([s.date, s.vouchernumber, s.partyledgername, s.placeofsupply, s.gstregistrationtype, s.vchentrymode], ['20261003', 'INS1', 'Customer (order control)', 'Jammu & Kashmir', 'Unregistered/Consumer', 'Accounting Invoice']);
  const cust = s.ledgerentries.find(x => x.ledgername === 'Customer (order control)');
  assert.deepEqual([cust.isdeemedpositive, cust.amount, cust.ispartyledger], [true, '-1050.00', true]);
  assert.deepEqual(cust.billallocations, [{ name: 'INS1', billtype: 'New Ref', amount: '-1050.00' }]);
  assert.deepEqual(s.ledgerentries.filter(x => !x.isdeemedpositive).map(x => [x.ledgername, x.amount]), [['GST SALES', '1000.00'], ['IGST OUTPUT UP', '50.00']]);
});

test('a credit note clears the customer\'s bill against the sale invoice; a payout is a receipt with the UTR on the bank line and a bill per order', () => {
  const { file } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  const cn = find(file, 'Credit Note');
  assert.deepEqual(cn.ledgerentries.find(x => x.ledgername === 'Customer (order control)').billallocations, [{ name: 'INS1', billtype: 'Agst Ref', amount: '210.00' }]);
  const rc = find(file, 'Receipt');
  const bank = rc.allledgerentries.find(x => x.ledgername === 'ICICI Bank');
  assert.deepEqual([bank.amount, bank.bankallocations[0].instrumentnumber, bank.isdeemedpositive], ['-1030.00', 'U1', true]);
  assert.deepEqual(rc.allledgerentries.find(x => x.ledgername === 'Easebuzz Private Limited').billallocations, [{ name: 'A', billtype: 'Agst Ref', amount: '1050.00' }]);
  assert.equal(rc.partyledgername, 'Easebuzz Private Limited');
});

test('a clearing journal: the gateway receivable starts a bill named by the order, the customer\'s bill is cleared against the invoice', () => {
  const { file } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  const j = find(file, 'Journal');
  assert.match(j.vouchernumber, /^GW\/A\/1003$/);
  assert.deepEqual(j.allledgerentries.find(x => x.ledgername === 'Easebuzz Private Limited').billallocations, [{ name: 'A', billtype: 'New Ref', amount: '-1050.00' }]);
  assert.deepEqual(j.allledgerentries.find(x => x.ledgername === 'Customer (order control)').billallocations, [{ name: 'INS1', billtype: 'Agst Ref', amount: '1050.00' }]);
});

test('every voucher in the file sums to zero and the ledger totals equal the ledger\'s: the built-in checks pass', () => {
  const { file, checks } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  for (const m of file.tallymessage) assert.equal(Math.round((m.ledgerentries ?? m.allledgerentries).reduce((s, x) => s + Number(x.amount), 0) * 100) / 100, 0, m.vouchernumber);
  assert.deepEqual(checks.map(c => c.ok), [true, true, true]);
});

test('an order with no state is left out and said so; an unbalanced voucher is left out too', () => {
  const noState = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders: new Map([['A', { saleDoc: 'INS1' }]]) });
  assert.equal(noState.errors.filter(x => /no state on order A/.test(x.problem)).length, 2);   // the sale and the credit note
  assert.equal(noState.checks.find(c => c.id === 'skipped').ok, false);
  const bad = buildTallyFile({ vouchers: groupOrderVouchers([...entries, e('Z', '2026-10-11', 'goodwill', 'Goodwill credits', 100, 0), e('Z', '2026-10-11', 'goodwill', 'STORE CREDIT BY SHOPIFY', 0, 90)]), orders });
  assert.match(bad.errors.find(x => /goodwill/.test(x.id)).problem, /does not balance/);
});

test('the same voucher always gets the same GUID, so a second import is recognised', () => {
  const a = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders }).file.tallymessage.map(m => m.guid);
  const b = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders }).file.tallymessage.map(m => m.guid);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.match(a[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(guid('x'), guid('y'));
});

test('the test file keeps only the first few vouchers of each type', () => {
  const many = [];
  for (let i = 0; i < 6; i++) many.push(e(`O${i}`, '2026-10-03', 'payment', 'Easebuzz Private Limited', 10, 0), e(`O${i}`, '2026-10-03', 'payment', 'Customer (order control)', 0, 10));
  const { file, counts } = buildTallyFile({ vouchers: groupOrderVouchers(many), orders: new Map(), limit: 3 });
  assert.equal(file.tallymessage.length, 3);
  assert.equal(counts.journal, 3);
});

test('state names follow Tally\'s spelling', () => {
  assert.equal(tallyState('Jammu and Kashmir'), 'Jammu & Kashmir');
  assert.equal(tallyState('Andaman and Nicobar Islands'), 'Andaman & Nicobar Islands');
  assert.equal(tallyState('Dadra and Nagar Haveli and Daman and Diu'), 'Dadra & Nagar Haveli and Daman & Diu');
  assert.equal(tallyState('Uttar Pradesh'), 'Uttar Pradesh');
  assert.equal(tallyState(null), '');
});

test('two clearing journals of one order on one day get different voucher numbers', () => {
  const two = [e('Q', '2026-10-03', 'payment', 'Easebuzz Private Limited', 10, 0, { doc: 'T1' }), e('Q', '2026-10-03', 'payment', 'Customer (order control)', 0, 10, { doc: 'T1' }),
    e('Q', '2026-10-03', 'payment', 'Easebuzz Private Limited', 20, 0, { doc: 'T2' }), e('Q', '2026-10-03', 'payment', 'Customer (order control)', 0, 20, { doc: 'T2' })];
  const { file } = buildTallyFile({ vouchers: groupOrderVouchers(two), orders: new Map() });
  assert.deepEqual(file.tallymessage.map(m => m.vouchernumber), ['GW/Q/1003', 'GW/Q/1003-2']);
});

// ── Purchase, payment and receipt vouchers (tallyBooks.js) ──
import { buildBooks } from './tallyBooks.js';
import { entriesOf } from './tallyJson.js';

const bVendors = [{ id: 1, name: 'CHANDRA FASHION', tally_ledger_name: 'Chandra Fashion', gstin: '24AASFC4987G1ZY', booking: 'purchase' },
  { id: 4, name: 'Airtel', tally_ledger_name: 'M/s Bharti Airtel Ltd  UP', gstin: '09AAACB2894G1ZM', booking: 'expense', expense_ledger: 'Telephone and Internet Expenses GST' }];
const bBills = [
  { id: 1, status: 'accepted', vendor: 'CHANDRA FASHION', vendor_id: 1, invoice_no: 'CF/26962', invoice_date: '2026-10-01', subtotal: 20758, tax: 1038, total: 21796, tax_type: 'IGST', tax_rate: 5, supplier_gstin: '24AASFC4987G1ZY', kind: 'goods',
    lines: [{ hsn: '60063200', qty: 99.32, rate: 209, unit: 'KGS', amount: 20757.88 }] },
  { id: 7, status: 'accepted', vendor: 'Airtel', vendor_id: 4, invoice_no: 'CF/26962', invoice_date: '2026-10-12', subtotal: 899, tax: 161.82, total: 1060.82, tax_type: 'CGST+SGST', tax_rate: 18, supplier_gstin: '09AAACB2894G1ZM', kind: 'service', lines: [] },
];
const bBuckets = [{ name: 'Purchase Accounts', kind: 'expense', needs_bill: true }, { name: 'Suspense', kind: 'review', needs_bill: false }];
const bLines = [{ id: 17, status: 'matched', txn_date: '2026-10-01', debit: 21796, credit: 0, bucket: 'Purchase Accounts', payee: 'chandrafas', remarks: 'MMT/IMPS/627514475918/fabric/ChandraFas' },
  { id: 40, status: 'matched', txn_date: '2026-10-16', debit: 0, credit: 5000, bucket: 'Suspense', payee: null, remarks: 'UPI/110950000002/refund' }];
const books = () => buildBooks({ from: '2026-10-01', next: '2026-11-01', start: '2026-10-01', bills: bBills, vendors: bVendors, handled: [], bankLines: bLines, buckets: bBuckets, payeeLinks: [] });

test('a fabric purchase is an item invoice in the shape of the accountant\'s own: party and GSTIN, place of supply, the stock item with godown and batch, the bill on the supplier', () => {
  const r = books();
  const t = buildTallyFile({ vouchers: [], orders: new Map(), books: r.vouchers });
  const p = t.file.tallymessage.find(m => m.vouchertypename === 'Purchase' && m.reference === 'CF/26962' && m.partyledgername === 'Chandra Fashion');
  assert.deepEqual([p.vchentrymode, p.isinvoice, p.statename, p.placeofsupply, p.partygstin, p.vouchernumber, p.date], ['Item Invoice', true, 'Gujarat', 'Uttar Pradesh', '24AASFC4987G1ZY', 'CF/26962', '20261001']);
  const item = p.allinventoryentries[0];
  assert.deepEqual([item.stockitemname, item.rate, item.amount, item.billedqty, item.batchallocations[0].godownname, item.batchallocations[0].batchname, item.accountingallocations[0].ledgername],
    ['KNITTED FABRIC', '209.00/KGS', '-20757.88', ' 99.32 KGS', 'Main Location', 'Primary Batch', 'Purchase Raw Material']);
  const party = p.ledgerentries.find(e => e.ispartyledger);
  assert.deepEqual([party.amount, party.isdeemedpositive, party.billallocations], ['21796.00', false, [{ name: 'CF/26962', billtype: 'New Ref', amount: '21796.00' }]]);   // the bill opens here; the payment below settles it
});

test('every voucher sums to zero, items included; a bill opens before the payment that settles it; two suppliers with one invoice number get different voucher numbers', () => {
  const r = books();
  const t = buildTallyFile({ vouchers: [], orders: new Map(), books: r.vouchers });
  assert.ok(t.checks.find(c => c.id === 'balanced').ok, JSON.stringify(t.checks));
  const same = t.file.tallymessage.filter(m => m.vouchertypename === 'Purchase').map(m => m.vouchernumber);
  assert.deepEqual(same, ['CF/26962', 'CF/26962-2']);
  const order = t.file.tallymessage.filter(m => m.date === '20261001').map(m => m.vouchertypename);
  assert.deepEqual(order, ['Purchase', 'Payment']);
});

test('a payment: the supplier is debited against its bill, the bank credited with the reference and the bank\'s date; an unlinked receipt goes to its ledger', () => {
  const t = buildTallyFile({ vouchers: [], orders: new Map(), books: books().vouchers });
  const pay = t.file.tallymessage.find(m => m.vouchertypename === 'Payment');
  const [sup, bank] = pay.allledgerentries;
  assert.deepEqual([sup.ledgername, sup.amount, sup.isdeemedpositive, sup.billallocations], ['Chandra Fashion', '-21796.00', true, [{ name: 'CF/26962', billtype: 'Agst Ref', amount: '-21796.00' }]]);
  assert.deepEqual([bank.ledgername, bank.amount, bank.bankallocations[0].instrumentnumber, bank.bankallocations[0].bankersdate, bank.bankallocations[0].transactiontype, bank.bankallocations[0].paymentfavouring],
    ['ICICI Bank', '21796.00', '627514475918', '20261001', 'Others', 'Chandra Fashion']);
  assert.equal(pay.vouchernumber, 'ERP/PY/2627/00017'); assert.equal(pay.persistedview, 'Accounting Voucher View');
  const rc = t.file.tallymessage.find(m => m.vouchertypename === 'Receipt');
  assert.deepEqual(rc.allledgerentries.map(e => [e.ledgername, e.amount]), [['ICICI Bank', '-5000.00'], ['Suspense', '5000.00']]);
  assert.deepEqual(entriesOf(rc), rc.allledgerentries);
});

test('an expense bill is an accounting invoice with the expense line carrying its GST source and rates', () => {
  const t = buildTallyFile({ vouchers: [], orders: new Map(), books: books().vouchers });
  const a = t.file.tallymessage.find(m => m.partyledgername === 'M/s Bharti Airtel Ltd  UP');
  assert.equal(a.vchentrymode, 'Accounting Invoice'); assert.equal(a.allinventoryentries, undefined);
  const exp = a.ledgerentries.find(e => e.ledgername === 'Telephone and Internet Expenses GST');
  assert.deepEqual([exp.amount, exp.gstovrdntypeofsupply, exp.ratedetails.map(r => r.gstratedutyhead)], ['-899.00', 'Services', ['CGST', 'SGST/UTGST']]);
  assert.deepEqual(a.ledgerentries.filter(e => /Input/.test(e.ledgername)).map(e => [e.ledgername, e.amount]), [['CGST Input UP', '-80.91'], ['SGST Input UP', '-80.91']]);
});

test('invoice vouchers keep their entries under ledgerentries and accounting vouchers under allledgerentries, as in the accountant\'s own export', () => {
  const t = buildTallyFile({ vouchers: [], orders: new Map(), books: books().vouchers });
  for (const m of t.file.tallymessage) {
    if (m.isinvoice) { assert.ok(m.ledgerentries, m.vouchernumber); assert.equal(m.allledgerentries, undefined); }
    else { assert.ok(m.allledgerentries, m.vouchernumber); assert.equal(m.ledgerentries, undefined); }
  }
});

// ── Stock items on sales and credit notes ──
test('a sale with pieces is an item invoice: BRUNE LADIES DRESSES with quantity and rate; the COD charge and the tax stay ledger lines; the voucher still sums to zero', () => {
  const ents = [
    e('B', '2026-10-04', 'sale', 'Customer (order control)', 3294.76, 0, { doc: 'INS9' }),
    e('B', '2026-10-04', 'sale', 'GST SALES', 0, 2809.52, { doc: 'INS9', part: 'goods', qty: 2 }),
    e('B', '2026-10-04', 'sale', 'GST SALES', 0, 95.24, { doc: 'INS9', part: 'cod_charge' }),
    e('B', '2026-10-04', 'sale', 'IGST OUTPUT UP', 0, 145.2 + 244.8 - 0, { doc: 'INS9' }),
  ];
  const ord = new Map([['B', { state: 'Delhi', saleDoc: 'INS9', channel: 'shopify' }]]);
  const t = buildTallyFile({ vouchers: groupOrderVouchers(ents), orders: ord, books: [] });
  const s = find(t.file, 'Sales');
  assert.equal(s.vchentrymode, 'Item Invoice');
  const it = s.allinventoryentries[0];
  assert.deepEqual([it.stockitemname, it.rate, it.amount, it.actualqty, it.gsthsnname, it.batchallocations[0].godownname, it.accountingallocations[0].ledgername], ['BRUNE LADIES DRESSES', '1404.76/Pcs', '2809.52', ' 2 Pcs', '6204', 'Main Location', 'GST SALES']);
  assert.deepEqual(s.ledgerentries.filter(x => x.ledgername === 'GST SALES').map(x => x.amount), ['95.24']);      // the COD charge only: the goods are in the item
  assert.deepEqual(t.checks.find(c => c.id === 'balanced').ok, true);
});

test('a return with pieces puts them back: the item is a debit with a negative amount, the credit note clears the sale\'s bill', () => {
  const ents = [
    e('B', '2026-10-09', 'credit_note', 'GST SALES RETURN', 1284.76, 0, { doc: 'ISR9', part: 'goods', qty: 1 }),
    e('B', '2026-10-09', 'credit_note', 'IGST OUTPUT UP', 64.24, 0, { doc: 'ISR9' }),
    e('B', '2026-10-09', 'credit_note', 'Customer (order control)', 0, 1349, { doc: 'ISR9' }),
  ];
  const ord = new Map([['B', { state: 'Delhi', saleDoc: 'INS9', channel: 'shopify' }]]);
  const t = buildTallyFile({ vouchers: groupOrderVouchers(ents), orders: ord, books: [] });
  const c = find(t.file, 'Credit Note'), it = c.allinventoryentries[0];
  assert.deepEqual([c.vchentrymode, it.amount, it.isdeemedpositive, it.actualqty, it.accountingallocations[0].ledgername, it.accountingallocations[0].isdeemedpositive], ['Item Invoice', '-1284.76', true, ' 1 Pcs', 'GST SALES RETURN', true]);
  assert.equal(c.ledgerentries.some(x => x.ledgername === 'GST SALES RETURN'), false);
  assert.equal(t.checks.find(x => x.id === 'balanced').ok, true); assert.equal(t.checks.find(x => x.id === 'totals').ok, true);
});

test('goods with no pieces recorded stay an accounting invoice', () => {
  const t = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders, books: [] });
  assert.equal(find(t.file, 'Sales').vchentrymode, 'Accounting Invoice'); assert.equal(find(t.file, 'Sales').allinventoryentries, undefined);
});
