import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGstReport, stateTable, hsnSummary, documentSeries } from './gstReport.js';
import { buildGstSheets, gstFileName } from './gstWorkbook.js';
import { buildXlsx } from './xlsxWrite.js';
import { xlsxSheets } from '../../supabase/functions/_shared/statements.ts';

const e = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => ({ order_name, entry_date, voucher, account, debit, credit, doc: null, issued_by: 'unicommerce', memo: '', part: null, qty: null, ...extra });
const entries = [
  e('INS1', '2026-10-03', 'sale', 'GST SALES', 0, 952.38, { doc: 'INS0001', part: 'goods', qty: 1 }), e('INS1', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 47.62, { doc: 'INS0001' }),
  e('INS1', '2026-10-20', 'credit_note', 'GST SALES RETURN', 476.19, 0, { doc: 'ISR0001', part: 'goods', qty: 1 }), e('INS1', '2026-10-20', 'credit_note', 'IGST OUTPUT UP', 23.81, 0, { doc: 'ISR0001' }),
  e('M1', '2026-10-06', 'sale', 'GST SALES', 0, 1200, { doc: 'I1006', part: 'goods', qty: 1 }), e('M1', '2026-10-06', 'sale', 'CGST Output UP', 0, 30, { doc: 'I1006' }), e('M1', '2026-10-06', 'sale', 'SGST Output UP', 0, 30, { doc: 'I1006' }),
  e('37701', '2026-10-09', 'invoice', 'GST SALES', 0, 94.29, { issued_by: 'erp', part: 'return_fee', memo: 'return 1 (customer): return fee' }), e('37701', '2026-10-09', 'invoice', 'IGST OUTPUT UP', 0, 4.71, { issued_by: 'erp', memo: 'return 1 (customer): return fee' }),
];
const orders = [
  { order_name: 'INS1', channel: 'shopify', state: 'Maharashtra', state_code: '27', rate: '0.05', sale_date: '2026-10-03', invoice_date: '2026-10-03', notes: [] },
  { order_name: 'M1', channel: 'myntra', state: 'Uttar Pradesh', state_code: '09', rate: '0.05', sale_date: '2026-10-06', invoice_date: '2026-10-07', notes: [] },
  { order_name: '37701', channel: 'shopify', state: 'Telangana', state_code: '36', rate: '0.05', sale_date: '2026-09-20', notes: [] },
];
const report = buildGstReport({ month: '2026-10', entries, orders, waiting: [{ order_name: '38500', channel: 'shopify', sale_date: '2026-10-31', state: 'Kerala', exceptions: [] }] });

test('the workbook has one sheet per thing an accountant looks up, in a fixed order', () => {
  assert.deepEqual(buildGstSheets(report).map(s => s.name), ['Summary', 'B2C all (Table 7)', 'HSN summary (Table 12)', 'Documents issued (Table 13)', 'Myntra (Table 14)', 'Shopify by state', 'Sales invoices', 'Fee invoices (ERP)', 'Credit notes', 'Not invoiced yet']);
  assert.equal(gstFileName(report), 'GST-sales-2026-10.xlsx');
});

test('read back from the file: totals, state rows and documents are the report\'s numbers', async () => {
  const out = await xlsxSheets(buildXlsx(buildGstSheets(report)));
  const sum = out.get('Summary');
  const row = (label) => sum.find(r => r[0] === label);
  assert.equal(sum[0][0], 'GST sales: October 2026');
  assert.equal(Number(row('Shopify')[1]), 952.38);          // sales
  assert.equal(Number(row('Shopify')[2]), 94.29);           // fee invoices
  assert.equal(Number(row('Shopify')[3]), 476.19);          // credit notes
  assert.equal(Number(row('Shopify')[4]), 570.48);          // net taxable
  assert.equal(Number(row('Myntra')[9]), 30); assert.equal(Number(row('Myntra')[10]), 30);   // CGST = SGST
  assert.equal(Number(row('Total')[4]), 1770.48);
  assert.equal(Number(row('Orders placed this month, not invoiced yet')[1]), 1);

  const shop = out.get('Shopify by state');
  assert.match(shop[0][0], /Shopify on its own, October 2026/);
  const mh = shop.find(r => r[0] === 'Maharashtra');
  assert.equal(Number(mh[6]), 476.19); assert.equal(Number(mh[10]), 23.81);     // net taxable, IGST for GSTR-1
  const total = shop.find(r => r[0] === 'Total');
  assert.equal(Number(total[6]), 570.48);

  const my = out.get('Myntra (Table 14)');
  assert.match(my[0][0], /Table 14\(a\).*09AAECM9636P1CW/);
  assert.equal(my.find(r => r[0] === 'Uttar Pradesh')[1], '09');

  // Table 7 holds BOTH channels' consumer sales by state and rate; Myntra's are in it too
  const b2c = out.get('B2C all (Table 7)');
  assert.match(b2c[0][0], /Table 7/);
  assert.equal(Number(b2c.find(r => r[0] === 'Total')[6]), 1770.48);                       // Shopify 570.48 + Myntra 1,200
  assert.equal(Number(b2c.find(r => r[0] === 'Uttar Pradesh')[6]), 1200);                 // only Myntra sold to UP in the fixture
  const where = sum.find(r => String(r[0]).startsWith('Table 14(a)'));
  assert.equal(Number(where[2]), 1200);                                                    // Myntra's net taxable value
  assert.equal(Number(sum.find(r => String(r[0]).startsWith('Table 7'))[2]), 1770.48);

  assert.deepEqual(out.get('Sales invoices').slice(1).map(r => r[0]), ['INS0001', 'I1006']);
  assert.equal(out.get('Fee invoices (ERP)')[1][1], 'not numbered yet');
  const cn = out.get('Credit notes')[1];
  assert.equal(cn[1], 'ISR0001'); assert.equal(cn[2], 'Unicommerce');
  assert.equal(out.get('Not invoiced yet')[1][0], '38500');
});

test('numbers the ledger has given the ERP\'s own documents are in the Excel file', async () => {
  const numbered = entries.map(x => x.issued_by === 'erp' ? { ...x, doc: 'ERP/IN/2627/0001' } : x);
  const erpNote = [e('INS1', '2026-10-21', 'credit_note', 'GST SALES RETURN', 100, 0, { issued_by: 'erp', doc: 'ERP/CN/2627/0007', memo: 'return 1 (customer): credit note for goods', part: 'goods', qty: 1 }),
                   e('INS1', '2026-10-21', 'credit_note', 'IGST OUTPUT UP', 5, 0, { issued_by: 'erp', doc: 'ERP/CN/2627/0007', memo: 'return 1 (customer): credit note for goods' })];
  const rep = buildGstReport({ month: '2026-10', entries: [...numbered, ...erpNote], orders, waiting: [] });
  const out = await xlsxSheets(buildXlsx(buildGstSheets(rep)));
  assert.equal(out.get('Fee invoices (ERP)')[1][1], 'ERP/IN/2627/0001');
  const cn = out.get('Credit notes').find(r => r[1] === 'ERP/CN/2627/0007');
  assert.equal(cn[2], 'ERP');
  assert.equal(rep.checks.find(c => c.id === 'unnumbered').level, 'info');
});

// ── What the accountant found wrong (19 Nov 2026): CGST and SGST apart, no goods / shipping split, no HSN summary, no documents summary ──
const e2 = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => e(order_name, entry_date, voucher, account, debit, credit, extra);
const ups = [
  // two Uttar Pradesh invoices whose halves differ by a paisa, as Unicommerce rounds each invoice on its own
  e2('UP1', '2026-10-04', 'sale', 'GST SALES', 0, 1000.01, { doc: 'INS0010', part: 'goods', qty: 1 }), e2('UP1', '2026-10-04', 'sale', 'CGST Output UP', 0, 25.01, { doc: 'INS0010' }), e2('UP1', '2026-10-04', 'sale', 'SGST Output UP', 0, 25, { doc: 'INS0010' }),
  e2('UP1', '2026-10-04', 'sale', 'GST SALES', 0, 95.24, { doc: 'INS0010', part: 'cod_charge' }), e2('UP1', '2026-10-04', 'sale', 'CGST Output UP', 0, 2.38, { doc: 'INS0010' }), e2('UP1', '2026-10-04', 'sale', 'SGST Output UP', 0, 2.38, { doc: 'INS0010' }),
  e2('UP2', '2026-10-05', 'sale', 'GST SALES', 0, 1000.03, { doc: 'INS0013', part: 'goods', qty: 2 }), e2('UP2', '2026-10-05', 'sale', 'CGST Output UP', 0, 25.01, { doc: 'INS0013' }), e2('UP2', '2026-10-05', 'sale', 'SGST Output UP', 0, 25, { doc: 'INS0013' }),
  e2('UP1', '2026-10-12', 'credit_note', 'GST SALES', 95.24, 0, { issued_by: 'erp', doc: 'ERP/CN/2627/0001', part: 'cod_charge', memo: 'COD charge on a parcel returned to origin' }),
  e2('UP1', '2026-10-12', 'credit_note', 'CGST Output UP', 2.38, 0, { issued_by: 'erp', doc: 'ERP/CN/2627/0001' }), e2('UP1', '2026-10-12', 'credit_note', 'SGST Output UP', 2.38, 0, { issued_by: 'erp', doc: 'ERP/CN/2627/0001' }),
];
const upOrders = [{ order_name: 'UP1', channel: 'shopify', state: 'Uttar Pradesh', state_code: '09', rate: '0.05', sale_date: '2026-10-04', notes: [] }, { order_name: 'UP2', channel: 'shopify', state: 'Uttar Pradesh', state_code: '09', rate: '0.05', sale_date: '2026-10-05', notes: [] }];
const upReport = buildGstReport({ month: '2026-10', entries: [...entries, ...ups], orders: [...orders, ...upOrders], waiting: [] });

test('CGST and SGST are equal in every row and in the total, even when the books are a paisa apart', () => {
  const all = stateTable(upReport, 'all');
  const up = all.rows.find(r => r.stateCode === '09' && r.ratePct === 5);
  assert.notEqual(up.net.cgst, up.net.sgst);                                    // the books ARE apart (that is the accountant's complaint)
  assert.equal(up.gstr1.cgst, up.gstr1.sgst);                                    // the figures for GSTR-1 are not
  for (const ch of ['all', 'shopify', 'myntra']) {
    const t7 = stateTable(upReport, ch);
    for (const r of t7.rows) assert.equal(r.gstr1.cgst, r.gstr1.sgst, `${ch} ${r.state}`);
    assert.equal(t7.total.gstr1.cgst, t7.total.gstr1.sgst, `${ch} total`);
  }
  // the tax is the rate on the net taxable value, to the paisa, in each row
  for (const r of all.rows) assert.ok(Math.abs(r.gstr1.tax - r.net.taxable * r.ratePct / 100) < 0.011, r.state);
});

test('the taxable value is split into goods, the COD / shipping charge and the return fee, and the three add up to it', () => {
  for (const ch of ['all', 'shopify', 'myntra']) for (const r of stateTable(upReport, ch).rows) assert.ok(Math.abs(r.net.goods + r.net.cod + r.net.retFee - r.net.taxable) < 0.005, `${ch} ${r.state}`);
  const t = stateTable(upReport, 'all').total.net;
  assert.equal(t.cod, 0);                                                        // the COD charge was sold (95.24) and reversed (95.24)
  assert.equal(t.retFee, 94.29);                                                 // the return fee of the fixture
  const sold = stateTable(buildGstReport({ month: '2026-10', entries: ups.slice(0, 6), orders: upOrders, waiting: [] }), 'all').total.net;
  assert.equal(sold.cod, 95.24); assert.equal(sold.goods, 1000.01);
});

test('the HSN summary (Table 12) holds the same taxable value and tax as Table 7, with pieces sold minus returned, and the services apart', () => {
  const h = hsnSummary(upReport), t7 = stateTable(upReport, 'all').total;
  assert.equal(h.total.taxable, t7.net.taxable);
  assert.equal(h.total.igst, t7.gstr1.igst); assert.equal(h.total.cgst, t7.gstr1.cgst); assert.equal(h.total.sgst, t7.gstr1.sgst);   // exactly, head by head
  const goods = h.rows.find(r => r.kind === 'goods');
  assert.equal(goods.code, '6204'); assert.equal(goods.qty, 1 - 1 + 1 + 1 + 2);   // INS1 1 sold, 1 returned; M1 1; UP1 1; UP2 2
  assert.ok(h.rows.some(r => r.kind === 'retFee'));
});

test('documents issued (Table 13): first and last number of each series, how many, and the numbers in between that are not in the month\'s file', () => {
  const s = documentSeries(upReport);
  const uc = s.find(x => x.nature === 'Invoices for outward supply: Unicommerce' && x.prefix === 'INS');
  assert.equal(uc.from, 'INS0001'); assert.equal(uc.to, 'INS0013'); assert.equal(uc.total, 3);          // INS0001, INS0010, INS0013
  assert.equal(uc.missing, 13 - 3); assert.deepEqual(uc.missingList.slice(0, 3), ['INS0002', 'INS0003', 'INS0004']);
  assert.ok(s.some(x => x.nature === 'Credit notes: Unicommerce' && x.from === 'ISR0001'));
  assert.ok(s.some(x => x.nature === 'Credit notes: issued by the ERP' && x.from === 'ERP/CN/2627/0001'));
});
