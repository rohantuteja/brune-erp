import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGstr3b } from './gstr3b.js';
import { buildGstr3bSheets, gstr3bFileName } from './gstr3bWorkbook.js';
import { buildGstReport } from './gstReport.js';
import { buildXlsx } from './xlsxWrite.js';
import { xlsxSheets } from './xlsxRead.js';
import { parseGstr2bJson } from './gstr2b.js';

const e = (order_name, entry_date, voucher, account, debit, credit) => ({ order_name, entry_date, voucher, account, debit, credit, doc: 'D1', issued_by: 'unicommerce', memo: '', part: null, qty: null });
const gst = buildGstReport({ month: '2026-10', entries: [e('A', '2026-10-03', 'sale', 'GST SALES', 0, 10000), e('A', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 500)],
  orders: [{ order_name: 'A', channel: 'shopify', state: 'Maharashtra', state_code: '27', rate: '0.05', sale_date: '2026-10-03', invoice_date: '2026-10-03', notes: [] }] });
const vendors = [{ id: 1, name: 'Meta', gstin: '06AABCF5150G1ZZ', booking: 'expense' }];
const bills = [{ id: 1, vendor_id: 1, vendor: 'Meta', invoice_no: '1', invoice_date: '2026-10-01', subtotal: 1000, tax: 180, tax_type: 'IGST', status: 'accepted', opening: false }];
const two = parseGstr2bJson(JSON.stringify({ data: { gstin: '09AALCR1014K1ZB', rtnprd: '102026', docdata: { b2b: [{ ctin: '06AABCF5150G1ZZ', trdnm: 'Meta', inv: [{ inum: '1', dt: '01-10-2026', txval: 1000, igst: 180, itcavl: 'Y' }, { inum: '2', dt: '02-10-2026', txval: 100, igst: 18, itcavl: 'Y' }] }] } } }));

test('the workbook has the seven sheets, opens through the reader, and its figures are the screen\'s', async () => {
  for (const twoB of [null, two]) {
    const r = buildGstr3b({ month: '2026-10', gst, ownGstin: '09AALCR1014K1ZB', bills, vendors, twoB, opening: { igst: 100, cgst: 0, sgst: 0 } });
    const sheets = buildGstr3bSheets(r);
    assert.deepEqual(sheets.map(s => s.name), ['Summary', '3.2 by state', 'ITC bills', 'Bills to upload', 'Other 2B lines', 'Suppliers', 'Payment 6.1']);
    const back = await xlsxSheets(buildXlsx(sheets));
    assert.equal(back.size, 7);
    const summary = back.get('Summary').map(r => r.join(' | ')).join('\n');
    assert.match(summary, /GSTR-3B working sheet: October 2026/);
    assert.match(summary, /10000/);                              // taxable value
    assert.match(summary, /Table 6\.1/);
    const pay = back.get('Payment 6.1').map(r => r.join(' | ')).join('\n');
    assert.match(pay, /Cash to pay/);
  }
  assert.equal(gstr3bFileName({ month: '2026-10' }), 'GSTR-3B-2026-10.xlsx');
});

test('with a 2B the bill appears as matched and the extra 2B line on the list of bills to upload', async () => {
  const r = buildGstr3b({ month: '2026-10', gst, ownGstin: '09AALCR1014K1ZB', bills, vendors, twoB: two });
  const back = await xlsxSheets(buildXlsx(buildGstr3bSheets(r)));
  assert.match(back.get('ITC bills').map(x => x.join('|')).join('\n'), /In GSTR-2B: agrees/);
  const up = back.get('Bills to upload').map(x => x.join('|')).join('\n');
  assert.match(up, /Meta\|06AABCF5150G1ZZ\|yes\|2\|/);                // the second Meta invoice has no bill; Meta is already a vendor
  assert.match(up, /1 invoice/);
});
