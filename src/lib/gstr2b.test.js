import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGstr2bJson, parseGstr2bSheets, parseGstr2bFile, normInvoice, parseDate, availableTotals, signOf } from './gstr2b.js';
import { buildXlsx } from './xlsxWrite.js';
import { xlsxSheets } from './xlsxRead.js';

// The JSON the portal produces for GSTR-2B (invoice-level amounts), October 2026, for the company GSTIN.
const json = (over = {}) => JSON.stringify({ data: {
  gstin: '09AALCR1014K1ZB', rtnprd: '102026', gendt: '14-11-2026', version: '1.0',
  itcsumm: { itcavl: { nonrevsup: { igst: 99680.6, cgst: 80.91, sgst: 80.91, cess: 0 } } },
  docdata: {
    b2b: [
      { ctin: '06AABCF5150G1ZZ', trdnm: 'Facebook India Online Services Private Limited', supprd: '102026', supfildt: '11-11-2026', inv: [
        { inum: '2380933755', typ: 'R', dt: '01-10-2026', val: 595083.79, pos: '09', rev: 'N', itcavl: 'Y', diffprcnt: 1, txval: 504308.3, igst: 90775.49, cgst: 0, sgst: 0, cess: 0 }] },
      { ctin: '29AACCW3721H1ZA', trdnm: 'Velocity', supprd: '102026', inv: [
        { inum: 'SF/1026/1158', typ: 'R', dt: '01-10-2026', val: 58495.95, pos: '09', rev: 'N', itcavl: 'Y', txval: 49572.84, igst: 8923.11, cgst: 0, sgst: 0, cess: 0 }] },
      { ctin: '09AAACB2894G1ZL', trdnm: 'Bharti Airtel', supprd: '102026', inv: [
        { inum: 'HF2709I013498070', typ: 'R', dt: '12-10-2026', val: 1060.82, pos: '09', rev: 'N', itcavl: 'Y', items: [{ num: 1, rt: 18, txval: 899, igst: 0, cgst: 80.91, sgst: 80.91, cess: 0 }] }] },
      { ctin: '07AAMCP7214N1ZW', trdnm: 'PicknPack', supprd: '102026', inv: [
        { inum: 'ECOM/26-27/24115', typ: 'R', dt: '27-10-2026', val: 879.1, pos: '09', rev: 'N', itcavl: 'N', rsn: 'POS', txval: 745, igst: 134.1, cgst: 0, sgst: 0, cess: 0 }] },
    ],
    cdnr: [{ ctin: '06AABCF5150G1ZZ', trdnm: 'Facebook', nt: [{ ntnum: 'CN-1', typ: 'C', dt: '20-10-2026', val: 118, itcavl: 'Y', txval: 100, igst: 18, cgst: 0, sgst: 0, cess: 0 }] }],
    ...over,
  } } });

test('JSON: invoices and credit notes are read with their amounts, dates and ITC flags', () => {
  const p = parseGstr2bJson(json());
  assert.equal(p.gstin, '09AALCR1014K1ZB');
  assert.equal(p.period, '2026-10');
  assert.equal(p.generatedOn, '2026-11-14');
  assert.equal(p.docs.length, 5);
  const meta = p.docs.find(d => d.no === '2380933755');
  assert.deepEqual([meta.kind, meta.ctin, meta.date, meta.taxable, meta.igst, meta.itc, meta.rcm], ['invoice', '06AABCF5150G1ZZ', '2026-10-01', 504308.3, 90775.49, 'Y', false]);
  const airtel = p.docs.find(d => d.supplier === 'Bharti Airtel');
  assert.deepEqual([airtel.taxable, airtel.cgst, airtel.sgst, airtel.igst], [899, 80.91, 80.91, 0]);         // amounts taken from the items
  const na = p.docs.find(d => d.no === 'ECOM/26-27/24115');
  assert.deepEqual([na.itc, na.reason], ['N', 'POS']);
  const cn = p.docs.find(d => d.kind === 'credit_note');
  assert.deepEqual([cn.no, cn.igst, signOf(cn)], ['CN-1', 18, -1]);
});

test('JSON: available credit = invoices - credit notes, only lines marked available and not reverse charge', () => {
  const t = availableTotals(parseGstr2bJson(json()).docs);
  assert.deepEqual(t, { igst: r(90775.49 + 8923.11 - 18), cgst: 80.91, sgst: 80.91, cess: 0 });
});
const r = (n) => Math.round(n * 100) / 100;

test('JSON: the file\'s own summary is compared with what was read', () => {
  const ok = parseGstr2bJson(json());
  assert.equal(ok.checks.find(c => c.id === 'summary').ok, true);
  const bad = JSON.parse(json()); bad.data.itcsumm.itcavl.nonrevsup.igst = 5;
  assert.equal(parseGstr2bJson(JSON.stringify(bad)).checks.find(c => c.id === 'summary').ok, false);
});

test('JSON: sections that are not read are reported, not ignored', () => {
  const p = parseGstr2bJson(json({ impg: [{ refdt: '01-10-2026' }], b2ba: [{ ctin: 'x' }] }));
  assert.equal(p.warnings.length, 2);
  assert.match(p.warnings.join(' '), /imports of goods/);
});

test('JSON: a file that is not a 2B is refused with a sentence', () => {
  assert.throws(() => parseGstr2bJson('{"hello": 1}'), /no "docdata"/);
  assert.throws(() => parseGstr2bJson('not json'), /not a readable JSON/);
});

test('invoice numbers are compared without case, punctuation or leading zeros', () => {
  assert.equal(normInvoice('SVF/26-27/265'), normInvoice('svf 2627 265'));
  assert.equal(normInvoice('00123'), '123');
  assert.equal(normInvoice('0'), '0');
  assert.notEqual(normInvoice('CF/26962'), normInvoice('CF/26963'));
});

test('dates in the portal\'s forms', () => {
  assert.equal(parseDate('05-10-2026'), '2026-10-05');
  assert.equal(parseDate('05/10/2026'), '2026-10-05');
  assert.equal(parseDate('2026-10-05'), '2026-10-05');
  assert.equal(parseDate('5-Oct-2026'), '2026-10-05');
  assert.equal(parseDate('46300'), '2026-10-05');                 // an Excel date number
  assert.equal(parseDate('31-13-2026'), null);
  assert.equal(parseDate(''), null);
});

// ── Excel: the portal's workbook has a Read me sheet and two-line headers ──
const cell = (v) => v;
const readMe = [['Goods and Services Tax - GSTR-2B'], ['Financial Year', '2026-27'], ['Tax Period', 'October'], ['GSTIN', '09AALCR1014K1ZB'], ['Legal name', 'RUMAAN'], ['Date of generation', '14/11/2026']];
const b2bHeader1 = ['GSTIN of supplier', 'Trade/Legal name', 'Invoice details', '', '', '', 'Place of supply', 'Supply Attract Reverse Charge', 'Rate(%)', 'Taxable Value (₹)', 'Tax Amount', '', '', '', 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason', 'Applicable % of Tax Rate', 'Source', 'IRN', 'IRN Date'];
const b2bHeader2 = ['', '', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', '', '', '', '', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', '', '', '', '', '', '', '', ''];
const row = (g, n, name, no, dt, val, rate, tx, i, c, s, itc, rsn = '') => [g, n, no, 'Regular', dt, val, 'Uttar Pradesh', 'No', rate, tx, i, c, s, 0, 'Oct-26', '11-11-2026', itc, rsn, '', 'e-Invoice', '', ''];
const b2b = [['Table title'], ['note'], [''], b2bHeader1, b2bHeader2,
  row('06AABCF5150G1ZZ', 'Facebook', 'x', '2380933755', '01-10-2026', 595083.79, 18, 504308.3, 90775.49, 0, 0, 'Yes'),
  row('09AAACB2894G1ZL', 'Bharti Airtel', 'x', 'HF2709I013498070', '12-10-2026', 1060.82, 9, 449.5, 0, 40.46, 40.46, 'Yes'),
  row('09AAACB2894G1ZL', 'Bharti Airtel', 'x', 'HF2709I013498070', '12-10-2026', 1060.82, 9, 449.5, 0, 40.45, 40.45, 'Yes'),          // the second rate line of the same invoice
  row('07AAMCP7214N1ZW', 'PicknPack', 'x', 'ECOM/26-27/24115', '27-10-2026', 879.1, 18, 745, 134.1, 0, 0, 'No', 'POS')];
const cdn = [['Title'], [''], [''], ['GSTIN of supplier', 'Trade/Legal name', 'Note details', '', '', '', '', 'Supply Attract Reverse Charge', 'Rate(%)', 'Taxable Value (₹)', 'Tax Amount', '', '', '', 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason'],
  ['', '', 'Note number', 'Note type', 'Note Supply type', 'Note date', 'Note Value (₹)', '', '', '', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', '', '', '', ''],
  ['06AABCF5150G1ZZ', 'Facebook', 'CN-1', 'Credit Note', 'Regular', '20-10-2026', 118, 'No', 18, 100, 18, 0, 0, 0, 'Oct-26', '11-11-2026', 'Yes', '']];

async function viaFile(sheets) {
  const bytes = buildXlsx(sheets.map(([name, rows]) => ({ name, rows })));
  return parseGstr2bFile('GSTR2B_102026.xlsx', bytes);
}

test('Excel: the B2B and credit note sheets are read through their two-line headers, one invoice over two rate lines is added up', async () => {
  const p = await viaFile([['Read me', readMe], ['B2B', b2b], ['B2B-CDNR', cdn]]);
  assert.equal(p.source, 'excel');
  assert.equal(p.fileName, 'GSTR2B_102026.xlsx');
  assert.equal(p.period, '2026-10');
  assert.equal(p.gstin, '09AALCR1014K1ZB');
  assert.equal(p.generatedOn, '2026-11-14');
  assert.equal(p.docs.length, 4);
  const airtel = p.docs.find(d => d.supplier === 'Bharti Airtel');
  assert.deepEqual([airtel.taxable, airtel.cgst, airtel.sgst, airtel.igst, airtel.date, airtel.value], [899, 80.91, 80.91, 0, '2026-10-12', 1060.82]);
  const pnp = p.docs.find(d => d.no === 'ECOM/26-27/24115');
  assert.deepEqual([pnp.itc, pnp.reason], ['N', 'POS']);
  const cn = p.docs.find(d => d.kind === 'credit_note');
  assert.deepEqual([cn.no, cn.igst, cn.date], ['CN-1', 18, '2026-10-20']);
});

test('Excel: a file with no B2B sheet is refused; a B2B sheet with missing columns says which', async () => {
  await assert.rejects(() => viaFile([['Read me', readMe], ['ITC Available', [['x']]]]), /no "B2B" sheet/);
  const broken = [['GSTIN of supplier', 'Trade/Legal name', 'Invoice number'], ['', '', ''], ['06AABCF5150G1ZZ', 'F', '1']];
  await assert.rejects(() => viaFile([['B2B', broken]]), /could not find the columns for date, taxable, igst, cgst, sgst/);
});

test('Excel: the period is the month of the Read me sheet, year from the financial year', async () => {
  for (const [period, fy, want] of [['October', '2026-27', '2026-10'], ['March', '2026-27', '2027-03'], ['April', '2026-27', '2026-04'], ['102026', '', '2026-10']]) {
    const p = await viaFile([['Read me', [['Financial Year', fy], ['Tax Period', period], ['GSTIN', '09AALCR1014K1ZB']]], ['B2B', b2b]]);
    assert.equal(p.period, want, `${period} ${fy}`);
  }
  const none = await viaFile([['B2B', b2b]]);
  assert.equal(none.period, null);
});

test('Excel through the file dispatcher and JSON through it too', async () => {
  const j = await parseGstr2bFile('x.json', new TextEncoder().encode(json()));
  assert.equal(j.docs.length, 5);
  assert.equal(j.fileName, 'x.json');
});

test('the reader round-trips what the writer makes (shared and inline strings)', async () => {
  const bytes = buildXlsx([{ name: 'A', rows: [['a', 1, { v: 'b' }], [null, 'c']] }]);
  const sheets = await xlsxSheets(bytes);
  assert.deepEqual(sheets.get('A'), [['a', '1', 'b'], ['', 'c']]);
});
