import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGstReport, stateTable, monthBounds, monthsBetween, monthLabel, documentsOf } from './gstReport.js';

const e = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => ({ order_name, entry_date, voucher, account, debit, credit, doc: null, issued_by: 'unicommerce', memo: '', part: null, qty: null, ...extra });
const order = (order_name, channel, state, state_code, rate = '0.05', extra = {}) => ({ order_name, channel, state, state_code, rate, sale_date: '2026-10-03', invoice_date: '2026-10-03', notes: [], ...extra });

// A: Shopify, Maharashtra (IGST), 1 piece + ₹100 COD charge; sold 3 Oct, whole order returned 20 Oct on a Unicommerce credit note.
// B: Shopify, Uttar Pradesh (CGST + SGST), sold 5 Oct.   C: Myntra, Karnataka, sold 6 Oct.
// D: Shopify RTO, Delhi: the ERP's ₹100 credit note for the COD charge.   E: Shopify, Telangana: the ERP's ₹99 return fee invoice.
// F: placed in September, its credit note is dated October (it reduces October).
const orders = [
  order('INS1', 'shopify', 'Maharashtra', '27'), order('INS2', 'shopify', 'Uttar Pradesh', '09'), order('I1006', 'myntra', 'Karnataka', '29'),
  order('37700', 'shopify', 'Delhi', '07'), order('37701', 'shopify', 'Telangana', '36'), order('37100', 'shopify', 'Gujarat', '24', '0.05', { sale_date: '2026-09-28' }),
];
const entries = [
  // A, the sale: goods 952.38 + COD 95.24 taxable, IGST 52.38
  e('INS1', '2026-10-03', 'sale', 'Customer (order control)', 1100, 0, { doc: 'INS0001' }),
  e('INS1', '2026-10-03', 'sale', 'GST SALES', 0, 952.38, { doc: 'INS0001', part: 'goods', qty: 1 }),
  e('INS1', '2026-10-03', 'sale', 'GST SALES', 0, 95.24, { doc: 'INS0001', part: 'cod_charge' }),
  e('INS1', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 52.38, { doc: 'INS0001' }),
  // A, the return on 20 Oct (Unicommerce credit note)
  e('INS1', '2026-10-20', 'credit_note', 'GST SALES RETURN', 952.38, 0, { doc: 'ISR0001', part: 'goods', qty: 1 }),
  e('INS1', '2026-10-20', 'credit_note', 'GST SALES', 95.24, 0, { doc: 'ISR0001', part: 'cod_charge' }),
  e('INS1', '2026-10-20', 'credit_note', 'IGST OUTPUT UP', 52.38, 0, { doc: 'ISR0001' }),
  e('INS1', '2026-10-20', 'credit_note', 'Customer (order control)', 0, 1100, { doc: 'ISR0001' }),
  // B, UP: CGST + SGST
  e('INS2', '2026-10-05', 'sale', 'GST SALES', 0, 1000, { doc: 'INS0002', part: 'goods', qty: 2 }),
  e('INS2', '2026-10-05', 'sale', 'CGST Output UP', 0, 25, { doc: 'INS0002' }),
  e('INS2', '2026-10-05', 'sale', 'SGST Output UP', 0, 25, { doc: 'INS0002' }),
  // C, Myntra
  e('I1006', '2026-10-06', 'sale', 'GST SALES', 0, 1200, { doc: 'I1006', part: 'goods', qty: 1 }),
  e('I1006', '2026-10-06', 'sale', 'IGST OUTPUT UP', 0, 60, { doc: 'I1006' }),
  // D, the ERP's own credit note for the COD charge (no document number)
  e('37700', '2026-10-08', 'credit_note', 'GST SALES', 95.24, 0, { issued_by: 'erp', part: 'cod_charge', memo: 'return 1 (rto): credit note for the COD charge' }),
  e('37700', '2026-10-08', 'credit_note', 'IGST OUTPUT UP', 4.76, 0, { issued_by: 'erp', memo: 'return 1 (rto): credit note for the COD charge' }),
  // E, the ERP's own invoice for the return fee kept
  e('37701', '2026-10-09', 'invoice', 'GST SALES', 0, 94.29, { issued_by: 'erp', part: 'return_fee', memo: 'return 1 (customer): return fee' }),
  e('37701', '2026-10-09', 'invoice', 'IGST OUTPUT UP', 0, 4.71, { issued_by: 'erp', memo: 'return 1 (customer): return fee' }),
  // F, sold in September, credit note in October
  e('37100', '2026-10-12', 'credit_note', 'GST SALES RETURN', 400, 0, { issued_by: 'erp', part: 'goods', qty: 1, memo: 'return 1 (customer): credit note for goods' }),
  e('37100', '2026-10-12', 'credit_note', 'IGST OUTPUT UP', 20, 0, { issued_by: 'erp', memo: 'return 1 (customer): credit note for goods' }),
  // the September sale of F and an entry of November must not appear in October
  e('37100', '2026-09-28', 'sale', 'GST SALES', 0, 400, { part: 'goods', qty: 1 }),
  e('INS2', '2026-11-02', 'sale', 'GST SALES', 0, 999, { doc: 'INS9999', part: 'goods' }),
];

const report = buildGstReport({ month: '2026-10', entries, orders, waiting: [
  { order_name: '38500', channel: 'shopify', sale_date: '2026-10-31', state: 'Kerala', exceptions: [{ reason: 'ordered 3 days ago and Unicommerce has not invoiced it' }] },
  { order_name: '38600', channel: 'shopify', sale_date: '2026-11-02', state: 'Kerala', exceptions: [] },
] });

test('month helpers', () => {
  assert.deepEqual(monthBounds('2026-10'), { from: '2026-10-01', next: '2026-11-01' });
  assert.deepEqual(monthBounds('2026-12'), { from: '2026-12-01', next: '2027-01-01' });
  assert.deepEqual(monthsBetween('2026-10', '2027-01'), ['2027-01', '2026-12', '2026-11', '2026-10']);
  assert.equal(monthLabel('2026-10'), 'October 2026');
});

test('a sale counts on its order date and carries the order\'s state, channel and rate; other months and control lines are ignored', () => {
  const sales = report.docs.sales;
  assert.deepEqual(sales.map(d => d.number), ['INS0001', 'INS0002', 'I1006']);
  const a = sales[0];
  assert.equal(a.taxable, 1047.62); assert.equal(a.igst, 52.38); assert.equal(a.total, 1100); assert.equal(a.qty, 1);
  assert.equal(a.state, 'Maharashtra'); assert.equal(a.stateCode, '27'); assert.equal(a.ratePct, 5); assert.equal(a.channel, 'shopify');
  const b = sales[1];
  assert.equal(b.igst, 0); assert.equal(b.cgst, 25); assert.equal(b.sgst, 25); assert.equal(b.qty, 2);
  assert.equal(sales.some(d => d.order === 'INS2' && d.taxable === 999), false, 'the November entry is not in October');
  assert.equal(report.docs.sales.some(d => d.order === '37100'), false, 'the September sale is not in October');
});

test('a credit note reduces the month it is dated in, whatever month the sale was in, and an ERP credit note has no number', () => {
  const r = report.docs.returns;
  assert.equal(r.length, 3);
  assert.equal(r.filter(d => d.number === null).length, 2, 'the two ERP credit notes have no number yet');
  const uc = r.find(d => d.number === 'ISR0001');
  assert.equal(uc.taxable, 1047.62); assert.equal(uc.igst, 52.38); assert.equal(uc.reason, 'Return (Unicommerce credit note)');
  const cod = r.find(d => d.order === '37700');
  assert.equal(cod.number, null); assert.equal(cod.issuedBy, 'erp'); assert.equal(cod.taxable, 95.24); assert.equal(cod.reason, 'COD charge on a parcel returned to origin');
  const old = r.find(d => d.order === '37100');
  assert.equal(old.state, 'Gujarat'); assert.equal(old.taxable, 400); assert.equal(old.reason, 'Goods returned'); assert.equal(old.orderDate, '2026-09-28');
});

test('an ERP fee invoice is a sale in the month of the invoice, listed apart', () => {
  assert.equal(report.docs.fees.length, 1);
  const f = report.docs.fees[0];
  assert.equal(f.taxable, 94.29); assert.equal(f.igst, 4.71); assert.equal(f.state, 'Telangana'); assert.equal(f.reason, 'Return fee kept (₹99)');
});

test('state-wise: sales + fee invoices - credit notes = net, per channel, state and rate', () => {
  const shop = stateTable(report, 'shopify');
  const by = (code) => shop.rows.find(r => r.stateCode === code);
  assert.equal(by('27').sales.taxable, 1047.62); assert.equal(by('27').returns.taxable, 1047.62); assert.equal(by('27').net.taxable, 0); assert.equal(by('27').net.igst, 0);
  assert.equal(by('09').net.taxable, 1000); assert.equal(by('09').net.cgst, 25); assert.equal(by('09').net.sgst, 25); assert.equal(by('09').net.igst, 0);
  assert.equal(by('36').fees.taxable, 94.29); assert.equal(by('36').net.taxable, 94.29); assert.equal(by('36').net.igst, 4.71);
  assert.equal(by('07').net.taxable, -95.24); assert.equal(by('07').net.igst, -4.76);
  assert.equal(by('24').net.taxable, -400);
  const my = stateTable(report, 'myntra');
  assert.equal(my.rows.length, 1); assert.equal(my.rows[0].state, 'Karnataka'); assert.equal(my.total.net.taxable, 1200); assert.equal(my.total.net.igst, 60);
});

test('totals per channel and overall add up to the documents', () => {
  const t = report.totals;
  assert.equal(t.shopify.sales.taxable, 2047.62);       // 1047.62 + 1000
  assert.equal(t.shopify.fees.taxable, 94.29);
  assert.equal(t.shopify.returns.taxable, 1542.86);     // 1047.62 + 95.24 + 400
  assert.equal(t.shopify.net.taxable, 599.05);          // 2047.62 + 94.29 - 1542.86
  assert.equal(t.myntra.net.taxable, 1200);
  assert.equal(t.all.net.taxable, 1799.05);
  assert.equal(t.all.net.igst, r2(52.38 + 60 + 4.71 - 52.38 - 4.76 - 20));
  assert.equal(t.all.sales.docs, 3); assert.equal(t.all.returns.docs, 3); assert.equal(t.all.fees.docs, 1);
  assert.equal(report.checks.find(c => c.id === 'sums'), undefined);
});
const r2 = (n) => Math.round(n * 100) / 100;

test('orders not invoiced yet are listed apart, only for this month, and flagged', () => {
  assert.equal(report.waiting.length, 1);
  assert.equal(report.waiting[0].order, '38500');
  assert.equal(report.checks.find(c => c.id === 'waiting').level, 'warn');
  const un = report.checks.find(c => c.id === 'unnumbered');
  assert.equal(un.level, 'warn');
  assert.match(un.text, /3 documents issued by the ERP have no number yet/);
});

test('once the ERP\'s documents carry numbers the check is only information', () => {
  const numbered = entries.map(x => x.issued_by === 'erp' && x.voucher === 'credit_note' ? { ...x, doc: `ERP/CN/2627/${x.order_name}` } : x.issued_by === 'erp' && x.voucher === 'invoice' ? { ...x, doc: 'ERP/IN/2627/0001' } : x);
  const rep = buildGstReport({ month: '2026-10', entries: numbered, orders, waiting: [] });
  const c = rep.checks.find(k => k.id === 'unnumbered');
  assert.equal(c.level, 'info');
  assert.match(c.text, /2 credit notes and 1 fee invoice were issued by the ERP, not Unicommerce\. They carry ERP\/CN and ERP\/IN numbers\./);
  assert.deepEqual(rep.docs.returns.filter(d => d.issuedBy === 'erp').map(d => d.number).sort(), ['ERP/CN/2627/37100', 'ERP/CN/2627/37700']);
});

test('a document whose order has no state is grouped and warned about', () => {
  const rep = buildGstReport({ month: '2026-10', entries: [e('X1', '2026-10-02', 'sale', 'GST SALES', 0, 100, { doc: 'INS5', part: 'goods' }), e('X1', '2026-10-02', 'sale', 'IGST OUTPUT UP', 0, 5, { doc: 'INS5' })], orders: [{ order_name: 'X1', channel: 'shopify', state: null, state_code: null, rate: '0.05' }] });
  assert.equal(rep.checks.find(c => c.id === 'state').level, 'warn');
  assert.equal(rep.states[0].state, 'No state on the order');
});

test('the rate the amounts imply is used when the order is unknown, and an 18% order stays in its own row', () => {
  const rep = buildGstReport({ month: '2026-10', entries: [
    e('Y1', '2026-10-02', 'sale', 'GST SALES', 0, 1000, { doc: 'INS6', part: 'goods' }), e('Y1', '2026-10-02', 'sale', 'IGST OUTPUT UP', 0, 180, { doc: 'INS6' }),
    e('Y2', '2026-10-02', 'sale', 'GST SALES', 0, 1000, { doc: 'INS7', part: 'goods' }), e('Y2', '2026-10-02', 'sale', 'IGST OUTPUT UP', 0, 50, { doc: 'INS7' }),
  ], orders: [{ order_name: 'Y2', channel: 'shopify', state: 'Kerala', state_code: '32', rate: '0.05' }] });
  assert.deepEqual(rep.docs.sales.map(d => d.ratePct), [18, 5]);
  assert.equal(rep.states.length, 2);
});

test('Myntra orders placed before the books started are booked in the month and the report says so', () => {
  const rep = buildGstReport({ month: '2026-10', entries: [e('I0927', '2026-10-01', 'sale', 'GST SALES', 0, 500, { doc: 'I0927', part: 'goods' })],
    orders: [order('I0927', 'myntra', 'Karnataka', '29', '0.05', { notes: ["placed on 2026-09-30, before the books started: booked on 2026-10-01 (the earlier months' books had no Myntra sales)"] })] });
  assert.match(rep.checks.find(c => c.id === 'earlier').text, /1 Myntra order was placed before the books started/);
});

test('documentsOf keeps two credit notes of one order apart', () => {
  const d = documentsOf([
    e('Z', '2026-10-05', 'credit_note', 'GST SALES RETURN', 100, 0, { doc: 'ISR1' }), e('Z', '2026-10-05', 'credit_note', 'GST SALES RETURN', 200, 0, { doc: 'ISR2' }),
  ], new Map(), '2026-10');
  assert.deepEqual(d.map(x => x.taxable), [100, 200]);
});

test('"all" merges Shopify and Myntra by state and rate (GSTR-1 Table 7); Myntra on its own is the Table 14(a) summary', () => {
  const rep = buildGstReport({ month: '2026-10', orders: [
      { order_name: 'S1', channel: 'shopify', state: 'Karnataka', state_code: '29', rate: '0.05', sale_date: '2026-10-03' },
      { order_name: 'M1', channel: 'myntra', state: 'Karnataka', state_code: '29', rate: '0.05', sale_date: '2026-10-04' },
      { order_name: 'M2', channel: 'myntra', state: 'Kerala', state_code: '32', rate: '0.05', sale_date: '2026-10-05' } ],
    entries: [
      e('S1', '2026-10-03', 'sale', 'GST SALES', 0, 1000, { doc: 'INS1', part: 'goods', qty: 1 }), e('S1', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 50, { doc: 'INS1' }),
      e('M1', '2026-10-04', 'sale', 'GST SALES', 0, 2000, { doc: 'I1', part: 'goods', qty: 1 }), e('M1', '2026-10-04', 'sale', 'IGST OUTPUT UP', 0, 100, { doc: 'I1' }),
      e('M2', '2026-10-05', 'sale', 'GST SALES', 0, 500, { doc: 'I2', part: 'goods', qty: 1 }), e('M2', '2026-10-05', 'sale', 'IGST OUTPUT UP', 0, 25, { doc: 'I2' }),
    ] });
  const all = stateTable(rep, 'all');
  assert.equal(all.rows.length, 2);                                                       // Karnataka once, Kerala once
  const ka = all.rows.find(r => r.stateCode === '29');
  assert.equal(ka.sales.taxable, 3000); assert.equal(ka.net.igst, 150); assert.equal(ka.sales.docs, 2); assert.equal(ka.channel, 'all');
  assert.equal(all.total.net.taxable, 3500);
  const my = stateTable(rep, 'myntra');                                                   // Table 14(a): Myntra only
  assert.equal(my.total.net.taxable, 2500); assert.equal(my.total.net.igst, 125);
  assert.equal(stateTable(rep, 'shopify').total.net.taxable, 1000);
  assert.equal(all.total.net.taxable, my.total.net.taxable + stateTable(rep, 'shopify').total.net.taxable);
});
