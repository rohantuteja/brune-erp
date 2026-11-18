import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, excelDate } from './xlsxWrite.js';
import { xlsxSheets } from '../../supabase/functions/_shared/statements.ts';       // the ERP's own .xlsx reader: what it can read back, Excel can open

const read = async (sheets) => xlsxSheets(buildXlsx(sheets, new Date('2026-11-18T10:00:00')));

test('sheets, text, numbers and dates survive a round trip through the ERP\'s own reader', async () => {
  const out = await read([
    { name: 'Summary', rows: [[{ v: 'GST sales', s: 'title' }], [], [{ v: 'Net', s: 'h' }, { v: 'Amount', s: 'h' }], ['Shopify & Co <x>', { v: 1234.5, s: 'm' }], ['Date', { v: '2026-10-31', s: 'd' }], ['Count', { v: 7, s: 'i' }]] },
    { name: 'Second', rows: [['₹ rupee', 'आदेश', true]] },
  ]);
  assert.deepEqual([...out.keys()], ['Summary', 'Second']);
  const s = out.get('Summary');
  assert.equal(s[0][0], 'GST sales');
  assert.equal(s[3][0], 'Shopify & Co <x>');
  assert.equal(Number(s[3][1]), 1234.5);
  assert.equal(Number(s[4][1]), excelDate('2026-10-31'));
  assert.equal(excelDate('2026-10-31'), 46326);            // 31 Oct 2026 as Excel counts it
  assert.equal(Number(s[5][1]), 7);
  assert.deepEqual(out.get('Second')[0].slice(0, 2), ['₹ rupee', 'आदेश']);
});

test('sheet names are made safe and unique; empty and non-finite cells are left out', async () => {
  const out = await read([{ name: 'A/B:C?', rows: [[null, undefined, '', Infinity, 'x']] }, { name: 'a/b:c?', rows: [['y']] }, { name: 'x'.repeat(50), rows: [['z']] }]);
  const names = [...out.keys()];
  assert.equal(names.length, 3);
  assert.ok(names.every(n => n.length <= 31 && !/[\[\]:*?/\\]/.test(n)));
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 3);
  assert.equal(out.get(names[0])[0][4], 'x');
});

test('the file is a valid zip: signature, entry count and a central directory the reader can follow', () => {
  const bytes = buildXlsx([{ name: 'One', rows: [['a']] }]);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b);                  // "PK"
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(v.getUint32(bytes.length - 22, true), 0x06054b50);              // end of central directory
  assert.equal(v.getUint16(bytes.length - 22 + 10, true), 6);                  // content types, rels, workbook, workbook rels, styles, 1 sheet
});

test('a frozen header and column widths are written', () => {
  const bytes = buildXlsx([{ name: 'One', freeze: 2, cols: [10, 20], rows: [['a'], ['b']] }]);
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(text, /<col min="2" max="2" width="20" customWidth="1"\/>/);
});
