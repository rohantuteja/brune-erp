// The invoices in fixtures/invoices are real supplier PDFs from five billing programs (TallyPrime twice, Synactis, Crystal
// Reports, Chandni), kept as the text items pdf.js produced, with every name, GSTIN, address, phone number and bank detail
// replaced. Their layouts are untouched, so these tests read them the way the ERP will.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gstinChecksumOk, normalizeUnit, panOf, parseInvoiceDate, parsePeriod, readInvoicePdf, solveAmounts, type ReadInvoice, type TextItem } from './invoice-reader.ts';

const OURS = '09AALCR1014K1ZB';
const fixture = (name: string): { pages: number; items: TextItem[] } => JSON.parse(readFileSync(new URL(`./fixtures/invoices/${name}.json`, import.meta.url), 'utf8'));
const read = (items: TextItem[], today = '2026-10-15') => readInvoicePdf(items, { companyGstin: OURS, today });
const only = (items: TextItem[], today?: string): ReadInvoice => { const r = read(items, today); assert.equal(r.invoices.length, 1); return r.invoices[0]; };
const failed = (inv: ReadInvoice) => inv.checks.filter(c => !c.ok).map(c => c.id);
const edit = (items: TextItem[], from: string | RegExp, to: string): TextItem[] => {
  let hit = 0;
  const out = items.map(i => { const s = i.s.replace(from, () => { hit++; return to; }); return { ...i, s }; });
  assert.ok(hit > 0, `nothing to replace for ${String(from)}`);
  return out;
};

// What each invoice says (checked against the PDFs by eye).
const CASES: Array<[string, Record<string, unknown>]> = [
  ['a', { gstin: '07AAAAA1111A1ZY', name: 'SAMPLE FABRICS A', no: 'SVF/26-27/265', date: '2026-10-03', pos: 'Uttar Pradesh', taxable: 10350, tax: 517.5, ro: 0.5, total: 10868,
    lines: [{ description: 'Shirting Fabric 520812 CHETAK (YARN DYED OXFORD STRIPES)- D NO-111390-BLUE-55.5+60', hsn: '520812', qty: 115.5, unit: 'MTR', rate: 89.61, amount: 10350 }] }],
  ['b', { gstin: '07BBBBB2222B1ZJ', name: 'SAMPLE ENTERPRISES B', no: '2026-27/1695', date: '2026-10-04', pos: 'Uttar Pradesh', taxable: 29063, tax: 1453.15, ro: -0.15, total: 30516, irn: true,
    lines: [{ description: 'FABRIC - 540710', hsn: '540710', qty: 1453.15, unit: 'MTR', rate: 20, amount: 29063 }] }],
  ['c', { gstin: '24CCCCC3333C1Z8', name: 'SAMPLE FASHION C', no: 'CF/26962', date: '2026-10-01', pos: null, taxable: 20758, tax: 1038, ro: 0, total: 21796,
    lines: [{ description: 'SUPER STAR (MARIO)', hsn: '60063200', qty: 99.32, unit: 'KGS', rate: 209, amount: 20757.88 }] }],
  ['d', { gstin: '24CCCCC3333C1Z8', name: 'SAMPLE FASHION C', no: 'CF/27047', date: '2026-10-01', pos: null, taxable: 21999, tax: 1100, ro: 0, total: 23099,
    lines: [{ description: 'MICRO CRAPE', hsn: '60063200', qty: 102.32, unit: 'KGS', rate: 215, amount: 21998.8 }] }],
  ['e', { gstin: '24EEEEE5555E1ZE', name: 'SAMPLE FASHION E', no: '2386', date: '2026-10-03', pos: null, taxable: 11580.8, tax: 579.04, ro: 0.16, total: 12160,
    lines: [{ description: 'VALENTINO', hsn: '60063100', qty: 49.28, unit: 'KGS', rate: 235, amount: 11580.8 }] }],
  ['f', { gstin: '07FFFFF6666F1ZV', name: 'Sample Hosiery Private Limited (Delhi)', no: 'MHPLD26-27/12244', date: '2026-10-04', pos: 'Uttar Pradesh', taxable: 2300, tax: 115, ro: 0, total: 2415, irn: true, copies: 2,
    lines: [{ description: '120 GSM POLY KNIT', hsn: '60062200', qty: 10, unit: 'KGS', rate: 230, amount: 2300 }] }],
];

for (const [file, want] of CASES) {
  test(`invoice ${file}: supplier, number, date, amounts and line items are read, and every check passes`, () => {
    const inv = only(fixture(file).items);
    assert.equal(inv.status, 'ok', inv.checks.filter(c => !c.ok).map(c => c.detail).join('; '));
    assert.equal(inv.supplier.gstin, want.gstin);
    assert.equal(inv.supplier.pan, panOf(want.gstin as string));
    assert.equal(inv.supplier.name, want.name);
    assert.equal(inv.supplier.name_source, 'signature');
    assert.equal(inv.buyer_gstin, OURS);
    assert.equal(inv.invoice_no, want.no);
    assert.equal(inv.invoice_date, want.date);
    assert.equal(inv.place_of_supply, want.pos);
    assert.equal(inv.tax_type, 'IGST'); assert.equal(inv.tax_rate, 5);
    assert.deepEqual([inv.taxable, inv.tax, inv.round_off, inv.total], [want.taxable, want.tax, want.ro, want.total]);
    assert.deepEqual(inv.lines, want.lines);
    assert.equal(inv.irn !== null, !!want.irn);
    assert.equal(inv.copies, want.copies ?? 1);
  });
}

// Invoices that are not for fabric: a service has a SAC instead of an HSN and no quantities, and is booked from its totals.
test('a service invoice (an ad platform\'s, a courier\'s) is read from its totals: SAC not HSN, no quantities to check, lines only when they are a plain table', () => {
  const meta = only(fixture('meta').items);
  assert.equal(meta.status, 'ok', meta.checks.filter(c => !c.ok).map(c => c.detail).join('; '));
  assert.equal(meta.kind, 'service');
  assert.deepEqual([meta.supplier.gstin, meta.supplier.state, meta.supplier.name, meta.supplier.name_source], ['06GGGGG7777G1ZI', 'Haryana', 'Sample Ads India Pvt. Ltd.', 'header']);
  assert.deepEqual([meta.invoice_no, meta.invoice_date, meta.place_of_supply], ['2300000001', '2026-10-01', 'Uttar Pradesh']);
  assert.deepEqual([meta.taxable, meta.tax_type, meta.tax_rate, meta.tax, meta.round_off, meta.total], [504308.3, 'IGST', 18, 90775.49, 0, 595083.79]);
  assert.deepEqual(meta.lines, []);          // a campaign list, not a table of SAC / description / amount: the totals are what is booked
  assert.equal(meta.copies, 1);              // "Page 2 of 2" repeats the header but is the next page, not a copy

  const velocity = only(fixture('velocity').items);
  assert.equal(velocity.status, 'ok', velocity.checks.filter(c => !c.ok).map(c => c.detail).join('; '));
  assert.equal(velocity.kind, 'service');
  assert.deepEqual([velocity.supplier.gstin, velocity.supplier.state, velocity.supplier.name], ['29HHHHH8888H1ZV', 'Karnataka', 'Sample Logistics Tech Pvt. Ltd.']);
  assert.deepEqual([velocity.invoice_no, velocity.invoice_date], ['SF/1026/1158', '2026-10-01']);
  // the taxable value is not printed anywhere: it is the two lines added up
  assert.deepEqual([velocity.taxable, velocity.tax, velocity.total], [49572.84, 8923.11, 58495.95]);
  assert.deepEqual(velocity.lines.map(l => [l.description, l.hsn, l.amount]), [['VAS Charges', '996812', 146.5], ['Velocity Freight Charges', '996812', 49426.34]]);
});

// A gateway, a payment company, a software vendor and a telecom bill: the rest of the vendors that send invoices.
const failedIds = (inv: ReadInvoice) => inv.checks.filter(c => !c.ok).map(c => c.id);
const VENDORS: Array<[string, Record<string, unknown>]> = [
  ['easebuzz', { name: 'Sample Payments Pvt. Ltd.', gstin: '27JJJJJ9999J1Z8', state: 'Maharashtra', no: 'N2627/000000000', date: '2026-09-30', taxable: 10693.94, type: 'IGST', tax: 1924.91, total: 12618.85, irn: true }],
  ['airtel', { name: 'Sample Telecom Limited', gstin: '09LLLLL2020L1ZY', state: 'Uttar Pradesh', no: 'HF2709I013498070', date: '2026-10-12', taxable: 899, type: 'CGST+SGST', tax: 161.82, total: 1060.82, irn: true }],
  ['gokwik-pp-cod', { name: 'SAMPLE GATEWAY SOLUTIONS PVT LTD', gstin: '06MMMMM3030M1ZR', state: 'Haryana', no: 'GKHR/2627/035032', date: '2026-10-01', taxable: 716.37, type: 'IGST', tax: 128.95, total: 845, irn: false, ro: -0.32 }],
  ['gokwik-pp-cod-paid', { name: 'SAMPLE GATEWAY SOLUTIONS PVT LTD', gstin: '06MMMMM3030M1ZR', state: 'Haryana', no: 'GKHR/2627/028279', date: '2026-09-01', taxable: 1136.72, type: 'IGST', tax: 204.61, total: 1341, irn: true, ro: -0.33 }],
];
for (const [file, want] of VENDORS) {
  test(`vendor invoice ${file}: read from its totals, every check passes`, () => {
    const inv = only(fixture(file).items);
    assert.equal(inv.status, 'ok', inv.checks.filter(c => !c.ok).map(c => c.detail).join('; '));
    assert.equal(inv.kind, 'service');
    assert.deepEqual([inv.supplier.name, inv.supplier.gstin, inv.supplier.state], [want.name, want.gstin, want.state]);
    assert.deepEqual([inv.invoice_no, inv.invoice_date], [want.no, want.date]);
    assert.deepEqual([inv.taxable, inv.tax_type, inv.tax_rate, inv.tax, inv.total], [want.taxable, want.type, 18, want.tax, want.total]);
    if (want.ro !== undefined) assert.equal(inv.round_off, want.ro);
    assert.equal(inv.irn !== null, want.irn);
  });
}

test('a telecom bill from a supplier in our own state is CGST + SGST: the GST is printed once, as a total, and the headings name CGST and SGST only', () => {
  const inv = only(fixture('airtel').items);
  assert.equal(inv.tax_type, 'CGST+SGST'); assert.equal(inv.supplier.state_code, '09'); assert.equal(inv.place_of_supply, 'Uttar Pradesh');
  assert.ok(inv.checks.find(c => c.id === 'tax_type')!.ok);
  assert.equal(only(edit(fixture('airtel').items, 'Uttar Pradesh', 'Uttar Pradesh')).tax_type, 'CGST+SGST');
});

test('an invoice that prints our PAN and state code instead of the GSTIN (Google\'s format) is accepted: that is the body of the GSTIN, and the GST shows in GSTR-2B', () => {
  const inv = only(fixture('google').items);
  assert.equal(inv.status, 'ok', inv.checks.filter(c => !c.ok).map(c => c.detail).join('; '));
  assert.equal(inv.buyer_gstin, OURS);
  assert.match(inv.checks.find(c => c.id === 'billed_to_us')!.detail, /our PAN with state code 09/);
  assert.deepEqual([inv.taxable, inv.tax, inv.total, inv.invoice_date, inv.kind], [975, 175.5, 1150.5, '2026-09-30', 'service']);
});

test('but a different PAN, or our PAN with no state code, is not our invoice', () => {
  const other = only(edit(fixture('google').items, /AALCR1014K/g, 'ZZZZZ9999Z'));
  assert.equal(other.status, 'review'); assert.deepEqual(failedIds(other), ['billed_to_us']);
  const noState = only(edit(fixture('google').items, /Place of Supply\/State Code: 09/, 'Place of Supply'));
  assert.deepEqual(failedIds(noState), ['billed_to_us']);
});

test('a GoKwik commission invoice keeps the number of transactions and the GMV it was charged on, and the commission is 2% of that GMV', () => {
  const inv = only(fixture('gokwik-pp-cod').items);
  const line = inv.lines[0];
  assert.equal(line.hsn, '997158'); assert.equal(line.amount, 716.37);
  assert.match(line.description, /Commission on PP COD/); assert.match(line.description, /No of Transactions:21/); assert.match(line.description, /GMV :35818\.55/);
  assert.equal(Math.round(35818.55 * 0.02 * 100) / 100, 716.37);
});

test('a service invoice whose lines do not add up to its total is still flagged, and the fabric invoices are goods', () => {
  const inv = only(edit(fixture('velocity').items, '₹146.50', '₹100.50'));
  assert.equal(inv.status, 'review'); assert.ok(failed(inv).includes('amounts') || failed(inv).includes('lines_total'));
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) assert.equal(only(fixture(f).items).kind, 'goods', f);
});

test('the supplier\'s state comes from its GSTIN: Delhi and Gujarat here, selling into Uttar Pradesh, so IGST', () => {
  assert.deepEqual(['a', 'b', 'f'].map(f => only(fixture(f).items).supplier.state), ['Delhi', 'Delhi', 'Delhi']);
  assert.deepEqual(['c', 'e'].map(f => only(fixture(f).items).supplier.state), ['Gujarat', 'Gujarat']);
});

test('an invoice printed twice in one file (original for the recipient, duplicate for the transporter) is one invoice, read once', () => {
  const f = fixture('f');
  assert.equal(f.pages, 2);
  const r = read(f.items);
  assert.equal(r.invoices.length, 1); assert.equal(r.invoices[0].copies, 2); assert.equal(r.pages, 2);
});

test('two different invoices in one file are two invoices', () => {
  const c = fixture('c').items, d = fixture('d').items;
  const r = read([...c.map(i => ({ ...i, page: 1 })), ...d.map(i => ({ ...i, page: 2 }))]);
  assert.deepEqual(r.invoices.map(i => i.invoice_no), ['CF/26962', 'CF/27047']);
});

test('a page with no supplier and no invoice number is the next page of the invoice before it, not a new invoice', () => {
  const e = fixture('e').items;
  const next: TextItem[] = [{ page: 2, x: 30, y: 700, w: 200, s: 'Terms & Conditions' }, { page: 2, x: 30, y: 680, w: 300, s: 'Goods once sold will not be taken back.' }];
  const r = read([...e, ...next]);
  assert.equal(r.invoices.length, 1); assert.equal(r.invoices[0].invoice_no, '2386'); assert.equal(r.invoices[0].status, 'ok');
});

test('a PDF with no text (a scan) and a PDF that is not an invoice are told apart', () => {
  assert.deepEqual(read([]), { invoices: [], pages: 0, problem: 'no_text' });
  assert.equal(read([{ page: 1, x: 10, y: 10, w: 50, s: '  ' }]).problem, 'no_text');
  const letter: TextItem[] = [{ page: 1, x: 10, y: 700, w: 200, s: 'Dear Sir, please find the price list attached.' }, { page: 1, x: 10, y: 680, w: 100, s: 'Regards' }];
  const r = read(letter);
  assert.equal(r.problem, 'no_invoice'); assert.equal(r.invoices.length, 0);
});

// ── doubtful invoices are held, not accepted ──

test('a total that does not agree with the taxable value and the GST is held for review, with the figures shown', () => {
  const inv = only(edit(fixture('b').items, /30,516\.00/g, '30,616.00'));
  assert.equal(inv.status, 'review'); assert.ok(failed(inv).includes('amounts'));
  assert.equal(inv.total, null); assert.equal(inv.invoice_no, '2026-27/1695');        // what could be read is still shown
});

test('a GSTIN whose check digit fails (misprinted, or misread) is flagged', () => {
  const inv = only(edit(fixture('b').items, '07BBBBB2222B1ZJ', '07BBBBB2222B1ZK'));
  assert.equal(inv.status, 'review'); assert.deepEqual(failed(inv), ['supplier_gstin']);
  assert.match(inv.checks[0].detail, /check digit/);
});

test('an invoice that is not addressed to our GSTIN is flagged', () => {
  const inv = only(edit(fixture('a').items, /09AALCR1014K1ZB/g, '24CCCCC3333C1Z8'));       // addressed to another company
  assert.equal(inv.status, 'review'); assert.ok(failed(inv).includes('billed_to_us'));
});

test('IGST charged on a sale from our own state (or CGST + SGST on one from another) is flagged', () => {
  const upGstin = (() => { const base = '09ZZZZZ9999Z1Z'; const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; let s = 0; for (let i = 0; i < 14; i++) { const p = CH.indexOf(base[i]) * (i % 2 ? 2 : 1); s += Math.floor(p / 36) + (p % 36); } return base + CH[(36 - (s % 36)) % 36]; })();
  assert.ok(gstinChecksumOk(upGstin));
  const inv = only(edit(fixture('a').items, '07AAAAA1111A1ZY', upGstin));
  assert.equal(inv.status, 'review'); assert.deepEqual(failed(inv), ['tax_type']);
  assert.match(inv.checks.find(c => c.id === 'tax_type')!.detail, /needs CGST \+ SGST/);
});

test('a line whose quantity × rate is not its amount is flagged (the case of a wrong quantity or unit on the bill)', () => {
  const inv = only(edit(fixture('e').items, '49.28', '4.28'));
  assert.equal(inv.status, 'review'); assert.ok(failed(inv).includes('line_math'));
});

test('an invoice dated in the future is flagged', () => {
  const inv = only(fixture('a').items, '2026-10-02');
  assert.equal(inv.status, 'review'); assert.deepEqual(failed(inv), ['invoice_date']);
});

// ── the pieces ──
test('GSTIN check digit', () => {
  assert.ok(gstinChecksumOk(OURS));
  for (const f of ['a', 'b', 'c', 'e', 'f']) assert.ok(gstinChecksumOk(only(fixture(f).items).supplier.gstin!), f);
  assert.ok(!gstinChecksumOk('09AALCR1014K1ZC'));       // one character off
  assert.ok(!gstinChecksumOk('09AALCR1014K1Z'));        // too short
  assert.ok(!gstinChecksumOk('ABAALCR1014K1ZB'));       // the state code is two digits
  assert.equal(panOf(OURS), 'AALCR1014K');
});

test('dates as billing programs print them', () => {
  assert.equal(parseInvoiceDate('04-10-2026'), '2026-10-04');
  assert.equal(parseInvoiceDate('4/10/26'), '2026-10-04');
  assert.equal(parseInvoiceDate('3-Oct-26'), '2026-10-03');
  assert.equal(parseInvoiceDate('03 October 2026'), '2026-10-03');
  assert.equal(parseInvoiceDate('04.10.2026 ( 06:40 PM )'), '2026-10-04');
  assert.equal(parseInvoiceDate('31-02-2026'), null);
  assert.equal(parseInvoiceDate('13/13/2026'), null);
  assert.equal(parseInvoiceDate('abc'), null);
});

test('units: one spelling for kilos, metres and pieces', () => {
  for (const u of ['kgs', 'KGS', 'Kg', 'KG', 'kilo', 'Kilogram']) assert.equal(normalizeUnit(u), 'KGS', u);
  for (const u of ['Mtr', 'MTR', 'Metre', 'metres', 'Meter', 'm', 'Mtrs.']) assert.equal(normalizeUnit(u), 'MTR', u);
  for (const u of ['Pcs', 'PCS', 'piece', 'Nos']) assert.equal(normalizeUnit(u), 'PCS', u);
  assert.equal(normalizeUnit('Roll'), 'ROLL'); assert.equal(normalizeUnit(''), null); assert.equal(normalizeUnit(null), null);
});

test('the amounts are solved among every number on the page: IGST, CGST + SGST, round-off, and no solution', () => {
  const igst = solveAmounts('Taxable 1,000.00\nIGST 5% 50.00\nGrand Total 1,050.00\nBalance 9,999.00');
  assert.deepEqual(igst, { taxable: 1000, rate: 5, kind: 'IGST', tax: 50, total: 1050, round_off: 0 });
  // CGST and SGST are both printed, and the total tax is printed too: still CGST + SGST, 12% in all
  const split = solveAmounts('Taxable Amount 1,000.00\nCGST 6% 60.00\nSGST 6% 60.00\nTotal Tax 120.00\nNet 1,120.00');
  assert.deepEqual(split, { taxable: 1000, rate: 12, kind: 'CGST+SGST', tax: 120, total: 1120, round_off: 0 });
  const rounded = solveAmounts('Taxable 1,234.56\nIGST 5% 61.73\nTotal 1,296.00');
  assert.equal(rounded?.round_off, -0.29); assert.equal(rounded?.total, 1296);
  assert.equal(solveAmounts('Taxable 1,000.00\nIGST 5% 50.00\nTotal 1,300.00'), null);          // nothing agrees
  assert.equal(solveAmounts('Page 1 of 1'), null);
});

test('the billing period: a range, or a month alone (its first and last day)', () => {
  assert.deepEqual(parsePeriod('01/09/2026 to 30/09/2026'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(parsePeriod('11 Sep 2026 to 10 Oct 2026'), { from: '2026-09-11', to: '2026-10-10' });
  assert.deepEqual(parsePeriod("Sep'26"), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(parsePeriod('Sep-26'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(parsePeriod('February-2028'), { from: '2028-02-01', to: '2028-02-29' });
  assert.equal(parsePeriod('30/09/2026 to 01/09/2026'), null);       // backwards
  assert.equal(parsePeriod('whenever'), null);
  const p = (f: string) => { const i = only(fixture(f).items); return [i.period, i.period_from, i.period_to]; };
  assert.deepEqual(p('velocity'), ['01/09/2026 to 30/09/2026', '2026-09-01', '2026-09-30']);      // what the Velocity wallet page needs
  assert.deepEqual(p('meta'), ['Sep-26', '2026-09-01', '2026-09-30']);
  assert.deepEqual(p('gokwik-pp-cod'), ["Sep'26", '2026-09-01', '2026-09-30']);
  assert.deepEqual(p('airtel'), ['11 Sep 2026 to 10 Oct 2026', '2026-09-11', '2026-10-10']);
  assert.deepEqual(p('a'), [null, null, null]);                                                   // a fabric invoice has no period
});
