import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGstr3b, setOff } from './gstr3b.js';
import { buildGstReport } from './gstReport.js';
import { parseGstr2bJson, availableTotals } from './gstr2b.js';

const OWN = '09AALCR1014K1ZB';
const r2 = (n) => Math.round(n * 100) / 100;

// ── The month's sales (the GST view's own input): UP sale (CGST+SGST), Maharashtra and Karnataka sales (IGST), one return ──
const e = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => ({ order_name, entry_date, voucher, account, debit, credit, doc: null, issued_by: 'unicommerce', memo: '', part: null, qty: null, ...extra });
const o = (order_name, channel, state, state_code, rate = '0.05') => ({ order_name, channel, state, state_code, rate, sale_date: '2026-10-03', invoice_date: '2026-10-03', notes: [] });
const sale = (name, date, taxable, taxAcct, tax, extra = {}) => [
  e(name, date, 'sale', 'GST SALES', 0, taxable, { doc: `INS-${name}`, ...extra }),
  ...(Array.isArray(taxAcct) ? taxAcct.map(([a, t]) => e(name, date, 'sale', a, 0, t, { doc: `INS-${name}` })) : [e(name, date, 'sale', taxAcct, 0, tax, { doc: `INS-${name}` })])];
const entries = [
  ...sale('A', '2026-10-03', 10000, 'IGST OUTPUT UP', 500),                                              // Maharashtra
  ...sale('B', '2026-10-05', 20000, [['CGST Output UP', 500], ['SGST Output UP', 500]]),                 // Uttar Pradesh
  ...sale('C', '2026-10-06', 4000, 'IGST OUTPUT UP', 200),                                               // Karnataka (Myntra)
  e('A', '2026-10-20', 'credit_note', 'GST SALES RETURN', 2000, 0, { doc: 'ISR-A' }), e('A', '2026-10-20', 'credit_note', 'IGST OUTPUT UP', 100, 0, { doc: 'ISR-A' }),   // part return
];
const orders = [o('A', 'shopify', 'Maharashtra', '27'), o('B', 'shopify', 'Uttar Pradesh', '09'), o('C', 'myntra', 'Karnataka', '29')];
const gst = buildGstReport({ month: '2026-10', entries, orders });
// Net: taxable 10000 + 20000 + 4000 - 2000 = 32000; IGST 500 + 200 - 100 = 600; CGST 500; SGST 500.

const vendors = [
  { id: 1, name: 'Meta', gstin: '06AABCF5150G1ZZ', booking: 'expense' },
  { id: 3, name: 'Easebuzz', gstin: '27AAVCS2699M1Z5', booking: 'tie_out' },
  { id: 7, name: 'Airtel', gstin: '09AAACB2894G1ZL', booking: 'expense' },
  { id: 8, name: 'Vipul', gstin: '07AFJPJ5098M1ZS', booking: 'purchase' },
  { id: 9, name: 'Google', gstin: '06AACCG0527D1Z8', booking: 'expense' },
];
const bill = (id, vendor_id, vendor, invoice_no, invoice_date, subtotal, tax, tax_type = 'IGST', extra = {}) => ({ id, vendor_id, vendor, invoice_no, invoice_date, subtotal, tax, total: subtotal + tax, tax_type, status: 'accepted', opening: false, supplier_gstin: vendors.find(v => v.id === vendor_id)?.gstin ?? null, kind: 'goods', ...extra });
const bills = [
  bill(1, 1, 'Meta', '2380933755', '2026-10-01', 504308.3, 90775.49),
  bill(2, 7, 'Airtel', 'HF2709I013498070', '2026-10-12', 899, 161.82, 'CGST+SGST'),
  bill(3, 8, 'Vipul', '2026-27/1695', '2026-10-04', 29063, 1453.15),
  bill(4, 8, 'Vipul', '2026-27/1700', '2026-10-20', 1000, 50, 'IGST', { status: 'review' }),
  bill(5, 1, 'Meta', '2380898574', '2026-09-01', 836222.32, 150520.01, 'IGST', { opening: true }),
  bill(6, 9, 'Google', 'GOOG-1', '2026-10-09', 1000, 180, 'IGST', { status: 'void' }),
];
const ledgerInput = [
  { account: 'IGST Input  UP', voucher: 'payout', debit: 2.5, credit: 0, entry_date: '2026-10-04', order_name: 'A' },
  { account: 'IGST Input  UP', voucher: 'payout', debit: 3.5, credit: 0, entry_date: '2026-10-05', order_name: 'B' },
  { account: 'IGST Input  UP', voucher: 'settlement', debit: 40, credit: 0, entry_date: '2026-10-10', order_name: 'C' },
];
const tcsRows = [
  { account: 'Tax Collected at source 26-27', voucher: 'settlement', debit: 100.82, credit: 0.02 },
  { account: 'Tax Deducted at source 26-27', voucher: 'settlement', debit: 20.15, credit: 0 },
];

const twoBJson = (docdata, extra = {}) => parseGstr2bJson(JSON.stringify({ data: { gstin: OWN, rtnprd: '102026', docdata, ...extra } }));
const inv = (inum, dt, txval, igst, cgst = 0, sgst = 0, extra = {}) => ({ inum, typ: 'R', dt, val: txval + igst + cgst + sgst, rev: 'N', itcavl: 'Y', txval, igst, cgst, sgst, cess: 0, ...extra });
const full2b = () => twoBJson({
  b2b: [
    { ctin: '06AABCF5150G1ZZ', trdnm: 'Facebook', inv: [inv('2380933755', '01-10-2026', 504308.3, 90775.49)] },
    { ctin: '09AAACB2894G1ZL', trdnm: 'Airtel', inv: [inv('HF2709I013498070', '12-10-2026', 899, 0, 80.91, 80.91)] },
    { ctin: '07AFJPJ5098M1ZS', trdnm: 'Vipul', inv: [inv('2026-27/1695', '04-10-2026', 29063, 1453.15), inv('2026-27/1700', '20-10-2026', 1000, 50)] },
    { ctin: '27AAVCS2699M1Z5', trdnm: 'Easebuzz', inv: [inv('EB/1', '01-10-2026', 100, 18)] },
    { ctin: '29AAECM9636P1ZJ', trdnm: 'Myntra', inv: [inv('MYN/1', '31-10-2026', 200, 36), inv('MYN/2', '31-10-2026', 50, 9, 0, 0, { itcavl: 'N', rsn: 'POS' })] },
    { ctin: '07AAMCP7214N1ZW', trdnm: 'Stranger', inv: [inv('S/1', '07-10-2026', 500, 90)] },
  ],
  cdnr: [{ ctin: '06AABCF5150G1ZZ', trdnm: 'Facebook', nt: [{ ntnum: 'CN-1', typ: 'C', dt: '20-10-2026', val: 11.8, itcavl: 'Y', txval: 10, igst: 1.8, cgst: 0, sgst: 0, cess: 0 }] }],
});

const base = { month: '2026-10', gst, ownGstin: OWN, bills, vendors, ledgerInput, tcsRows };

// ── 3.1 and 3.2 ──
test('Table 3.1(a) is the GST view\'s net, and Table 3.2 is the inter-state part by place of supply', () => {
  const r = buildGstr3b(base);
  assert.deepEqual([r.outward.taxable, r.outward.igst, r.outward.cgst, r.outward.sgst], [32000, 600, 500, 500]);
  assert.equal(r.outward.tax, 1600);
  assert.deepEqual(r.interstate.rows.map(x => [x.state, x.taxable, x.igst]), [['Maharashtra', 8000, 400], ['Karnataka', 4000, 200]]);
  assert.equal(r.interstate.taxable, 12000);
  assert.equal(r.interstate.igst, 600);
  assert.deepEqual([r.intra.taxable, r.intra.cgst, r.intra.sgst], [20000, 500, 500]);
  assert.equal(r.checks.some(c => c.id === 'igstsum' || c.id === 'state'), false);
});

test('a home-state sale that carries IGST, or an out-of-state sale with CGST, is flagged', () => {
  const bad = buildGstReport({ month: '2026-10', entries: [...sale('X', '2026-10-02', 1000, 'IGST OUTPUT UP', 50)], orders: [o('X', 'shopify', 'Uttar Pradesh', '09')] });
  const r = buildGstr3b({ ...base, gst: bad });
  assert.ok(r.checks.find(c => c.id === 'taxtype'));
});

test('sales with no state are warned about, not silently placed', () => {
  const none = buildGstReport({ month: '2026-10', entries: sale('Y', '2026-10-02', 1000, 'IGST OUTPUT UP', 50), orders: [o('Y', 'shopify', null, null)] });
  const r = buildGstr3b({ ...base, gst: none });
  assert.ok(r.checks.find(c => c.id === 'state'));
  assert.equal(r.interstate.rows.length, 0);
});

// ── Set-off ──
test('set-off: own-head credit first, IGST credit then covers what is left, CGST/SGST never pay each other', () => {
  let s = setOff({ igst: 100, cgst: 50, sgst: 50 }, { igst: 120, cgst: 10, sgst: 0 });
  // IGST credit pays the IGST liability (100); its leftover 20 and the CGST credit 10 pay CGST (30 of 50); nothing is left for SGST.
  assert.deepEqual(s.cash, { igst: 0, cgst: 20, sgst: 50 });
  assert.deepEqual(s.closing, { igst: 0, cgst: 0, sgst: 0 });
  assert.equal(s.used.igst.igst, 100);
  assert.equal(s.used.cgst.cgst, 10);
  assert.equal(s.used.cgst.igst, 20);
  s = setOff({ igst: 0, cgst: 100, sgst: 0 }, { igst: 0, cgst: 0, sgst: 100 });
  assert.deepEqual(s.cash, { igst: 0, cgst: 100, sgst: 0 });   // SGST credit cannot pay CGST
  assert.deepEqual(s.closing, { igst: 0, cgst: 0, sgst: 100 });
  s = setOff({ igst: 100, cgst: 0, sgst: 0 }, { igst: 0, cgst: 60, sgst: 60 });
  assert.deepEqual(s.cash, { igst: 0, cgst: 0, sgst: 0 });     // after IGST credit is used up, CGST/SGST credit pay IGST
  assert.deepEqual(s.closing, { igst: 0, cgst: 0, sgst: 20 });   // CGST credit (60) first, then 40 of the SGST credit
  s = setOff({ igst: 0, cgst: 0, sgst: 100 }, { igst: 100, cgst: 100, sgst: 0 });
  assert.deepEqual(s.used.sgst, { igst: 100, cgst: 0, sgst: 0 });   // IGST credit pays SGST; CGST credit is kept
  assert.deepEqual(s.closing, { igst: 0, cgst: 100, sgst: 0 });
});

test('set-off never uses credit that is not there and always conserves: liability = credit used + cash', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 300; i++) {
    const L = { igst: r2(rnd() * 100), cgst: r2(rnd() * 100), sgst: r2(rnd() * 100) }, C = { igst: r2(rnd() * 100), cgst: r2(rnd() * 100), sgst: r2(rnd() * 100) };
    const s = setOff(L, C);
    for (const lh of ['igst', 'cgst', 'sgst']) {
      const paid = r2(Object.values(s.used[lh]).reduce((a, b) => a + b, 0));
      assert.equal(r2(paid + s.cash[lh]), L[lh], `liability ${lh}`);
    }
    for (const ch of ['igst', 'cgst', 'sgst']) {
      const spent = r2(['igst', 'cgst', 'sgst'].reduce((a, lh) => a + s.used[lh][ch], 0));
      assert.equal(r2(spent + s.closing[ch]), C[ch], `credit ${ch}`);
    }
    assert.equal(r2(s.used.cgst.sgst + s.used.sgst.cgst), 0);   // never across
    if (s.cash.igst > 0) assert.equal(s.closing.igst + s.closing.cgst + s.closing.sgst, 0, 'cash is paid only when every usable credit is spent');
  }
});

// ── ITC, books only ──
test('without a GSTR-2B: the claim is the books (accepted bills dated in the month + gateway and Myntra lines), with a warning', () => {
  const r = buildGstr3b(base);
  assert.equal(r.itc.basis, 'books');
  assert.deepEqual(r.itc.books.bills, { igst: r2(90775.49 + 1453.15), cgst: 80.91, sgst: 80.91 });
  assert.equal(r.itc.books.billCount, 3);
  assert.deepEqual(r.itc.books.ledger, { igst: 46, cgst: 0, sgst: 0 });
  assert.deepEqual(r.itc.claim, { igst: r2(90775.49 + 1453.15 + 46), cgst: 80.91, sgst: 80.91 });
  assert.ok(r.checks.find(c => c.id === 'no2b' && c.level === 'warn'));
  assert.equal(r.itc.lists.held.length, 1);                      // the bill still under review is not claimed
  assert.equal(r.itc.lists.notIn2b.length, 3);
});

test('void bills and opening bills never count; Easebuzz\'s own invoices (tie-out) are not counted twice', () => {
  const withEb = [...bills, bill(20, 3, 'Easebuzz', 'EB/1', '2026-10-01', 100, 18)];
  const r = buildGstr3b({ ...base, bills: withEb });
  assert.equal(r.itc.books.billCount, 3);
  assert.equal(r.itc.books.bills.igst, r2(90775.49 + 1453.15));
});

test('trueups add to the gateway\'s books', () => {
  const r = buildGstr3b({ ...base, trueups: [{ voucher_date: '2026-10-01', gst_diff: 5.25 }] });
  assert.equal(r.itc.books.groups.find(g => g.id === 'gateway').heads.igst, r2(2.5 + 3.5 + 5.25));
});

// ── ITC against GSTR-2B: it is the source of truth ──
test('with a GSTR-2B the claim is everything it lists as available, with or without a bill in the ERP', () => {
  const r = buildGstr3b({ ...base, twoB: full2b() });
  assert.equal(r.itc.basis, 'twob');
  assert.deepEqual(r.itc.lists.matched.map(x => x.no).sort(), ['2026-27/1695', '2380933755', 'HF2709I013498070']);
  assert.deepEqual(r.itc.lists.held.map(x => x.no), ['2026-27/1700']);                // the bill is still in review, but it is in 2B: claimed
  assert.equal(r.itc.lists.held[0].in2b, true);
  assert.deepEqual(r.itc.lists.toUpload.map(x => [x.no, x.why]), [['EB/1', 'gateway'], ['S/1', 'bill']]);      // no bill in the ERP: to upload (Easebuzz's invoice is uploaded for the tie-out)
  assert.deepEqual(r.itc.lists.unavailable.map(x => x.no), ['MYN/2']);                 // marked ITC not available: left out
  assert.deepEqual(r.itc.lists.notes.map(x => x.no), ['CN-1']);                        // Meta's credit note reduces the credit
  const sup = Object.fromEntries(r.itc.lists.suppliers.map(s => [s.id, s]));
  assert.deepEqual(sup.gateway.twoB, { igst: 18, cgst: 0, sgst: 0 });
  assert.deepEqual(sup.myntra.twoB, { igst: 36, cgst: 0, sgst: 0 });
  // claim = 2B: Meta 90775.49 + Vipul 1453.15 and 50 + Easebuzz 18 + Myntra 36 + the stranger 90 - Meta credit note 1.8
  assert.deepEqual(r.itc.claim, { igst: r2(90775.49 + 1453.15 + 50 + 18 + 36 + 90 - 1.8), cgst: 80.91, sgst: 80.91 });
  assert.deepEqual(r.itc.claim, r.itc.twoB.portal);
  const { cess, ...heads } = availableTotals(full2b().docs);
  assert.deepEqual(r.itc.claim, heads);
});

test('the 2B total splits exactly into with a bill, gateway and Myntra, supplier notes and no bill: nothing is lost between them', () => {
  const r = buildGstr3b({ ...base, twoB: full2b() });
  const t = r.itc.twoB;
  for (const k of ['igst', 'cgst', 'sgst']) assert.equal(r2(t.withBill[k] + t.suppliers[k] + t.notes[k] + t.noBill[k]), t.portal[k], k);
  assert.equal(t.noBill.igst, 90);                                  // only the stranger's invoice has no bill and no supplier-level home
});

test('a bill that differs from 2B: the GSTR-2B figure is claimed and the bill is flagged, whichever is larger', () => {
  const higher = twoBJson({ b2b: [{ ctin: '07AFJPJ5098M1ZS', trdnm: 'Vipul', inv: [inv('2026-27/1695', '04-10-2026', 29063, 1600)] }] });
  const r = buildGstr3b({ ...base, twoB: higher });
  assert.equal(r.itc.lists.differs.length, 1);
  assert.equal(r.itc.claim.igst, 1600);
  assert.ok(r.checks.find(c => c.id === 'differs'));
  const lower = twoBJson({ b2b: [{ ctin: '07AFJPJ5098M1ZS', trdnm: 'Vipul', inv: [inv('2026-27/1695', '04-10-2026', 29063, 1000)] }] });
  assert.equal(buildGstr3b({ ...base, twoB: lower }).itc.claim.igst, 1000);
});

test('a bill the supplier has not filed is not claimed and is listed; nothing else changes', () => {
  const two = twoBJson({ b2b: [{ ctin: '06AABCF5150G1ZZ', trdnm: 'Facebook', inv: [inv('2380933755', '01-10-2026', 504308.3, 90775.49)] }] });
  const r = buildGstr3b({ ...base, twoB: two });
  assert.deepEqual(r.itc.lists.notIn2b.map(x => x.no).sort(), ['2026-27/1695', 'HF2709I013498070']);
  assert.ok(r.checks.find(c => c.id === 'not2b'));
  assert.deepEqual(r.itc.claim, { igst: 90775.49, cgst: 0, sgst: 0 });
});

test('Easebuzz\'s invoice drops off the upload list once it is uploaded as a tie-out bill, and is still claimed once', () => {
  const eb = [...bills, bill(20, 3, 'Easebuzz', 'EB/1', '2026-10-01', 100, 18)];
  const r = buildGstr3b({ ...base, bills: eb, twoB: full2b() });
  assert.deepEqual(r.itc.lists.toUpload.map(x => x.no), ['S/1']);
  assert.equal(r.itc.lists.suppliers.find(s => s.id === 'gateway').twoB.igst, 18);
  assert.equal(r.itc.claim.igst, r2(90775.49 + 1453.15 + 50 + 18 + 36 + 90 - 1.8));
  assert.equal(r.itc.books.billCount, 3);                           // and it is still not in the books totals
});

test('the upload list says whether the supplier is already a vendor in the ERP, and carries the invoice value', () => {
  const r = buildGstr3b({ ...base, twoB: full2b() });
  const s1 = r.itc.lists.toUpload.find(x => x.no === 'S/1');
  assert.deepEqual([s1.knownVendor, s1.taxable, s1.value, s1.gstin], [false, 500, 590, '07AAMCP7214N1ZW']);
});

test('a bill with no supplier GSTIN is matched by invoice number and amount', () => {
  const noG = [bill(30, 9, 'Google', 'GOOG-77', '2026-10-09', 1000, 180, 'IGST', { supplier_gstin: null })];
  const withNoGstinVendor = vendors.map(v => v.id === 9 ? { ...v, gstin: null } : v);
  const two = twoBJson({ b2b: [{ ctin: '06AACCG0527D1Z8', trdnm: 'Google', inv: [inv('GOOG-77', '09-10-2026', 1000, 180)] }] });
  const r = buildGstr3b({ ...base, bills: noG, vendors: withNoGstinVendor, twoB: two });
  assert.equal(r.itc.lists.matched.length, 1);
});

test('a 2B for another month or another GSTIN is an error, not a quiet mismatch', () => {
  const wrongMonth = parseGstr2bJson(JSON.stringify({ data: { gstin: OWN, rtnprd: '092026', docdata: { b2b: [] } } }));
  assert.ok(buildGstr3b({ ...base, twoB: wrongMonth }).checks.find(c => c.id === 'period' && c.level === 'error'));
  const wrongGstin = parseGstr2bJson(JSON.stringify({ data: { gstin: '27AAVCS2699M1Z5', rtnprd: '102026', docdata: { b2b: [] } } }));
  assert.ok(buildGstr3b({ ...base, twoB: wrongGstin }).checks.find(c => c.id === 'gstin' && c.level === 'error'));
});

test('reverse charge lines are left out and said so', () => {
  const two = twoBJson({ b2b: [{ ctin: '07AAMCP7214N1ZW', trdnm: 'GTA', inv: [inv('R/1', '05-10-2026', 1000, 50, 0, 0, { rev: 'Y' })] }] });
  const r = buildGstr3b({ ...base, twoB: two });
  assert.equal(r.itc.lists.rcm.length, 1);
  assert.ok(r.checks.find(c => c.id === 'rcm'));
  assert.equal(r.itc.twoB.portal.igst, 0);
});

test('a bill that charges the wrong kind of tax for the supplier\'s state is flagged', () => {
  const wrong = [bill(40, 7, 'Airtel', 'W1', '2026-10-05', 100, 18, 'IGST')];     // an Uttar Pradesh supplier charging IGST to an Uttar Pradesh buyer
  const r = buildGstr3b({ ...base, bills: wrong });
  assert.ok(r.checks.find(c => c.id === 'bill-40'));
});

// ── TCS and payment ──
test('TCS and TDS from the settlements', () => {
  const r = buildGstr3b(base);
  assert.deepEqual([r.tcs.tcs, r.tcs.tds, r.tcs.tcsLines, r.tcs.tdsLines], [100.8, 20.15, 1, 1]);
});

test('payment: opening credit plus this month\'s claim pays the output tax; cash is what is left; closing is carried', () => {
  const r = buildGstr3b({ ...base, twoB: full2b(), opening: { igst: 1000, cgst: 0, sgst: 0 } });
  assert.deepEqual(r.payment.liability, { igst: 600, cgst: 500, sgst: 500 });
  assert.equal(r.payment.cashTotal, 0);
  const total = r2(r.payment.closing.igst + r.payment.closing.cgst + r.payment.closing.sgst);
  assert.equal(total, r2(1000 + r.itc.claim.igst + r.itc.claim.cgst + r.itc.claim.sgst - 1600));
  assert.equal(r.openingSet, true);
});

test('payment: with too little credit, the shortfall is paid in cash, by head', () => {
  const r = buildGstr3b({ ...base, bills: [], ledgerInput: [], opening: { igst: 100, cgst: 0, sgst: 0 } });
  assert.deepEqual(r.payment.cash, { igst: 500, cgst: 500, sgst: 500 });      // 100 of IGST credit pays 100 of the IGST
  assert.equal(r.payment.cashTotal, 1500);                       // 1600 - 100 of IGST credit
  assert.ok(r.checks.find(c => c.id === 'no2b'));
});

test('no opening credit entered: the payment says so', () => {
  const r = buildGstr3b(base);
  assert.equal(r.openingSet, false);
  assert.ok(r.checks.find(c => c.id === 'opening'));
});

test('Rule 86B: above ₹50 lakh a month the use of credit is limited, and the sheet says so', () => {
  const big = buildGstReport({ month: '2026-10', entries: sale('Z', '2026-10-02', 6_000_000, 'IGST OUTPUT UP', 300000), orders: [o('Z', 'shopify', 'Maharashtra', '27')] });
  assert.ok(buildGstr3b({ ...base, gst: big }).checks.find(c => c.id === '86b'));
  assert.equal(buildGstr3b(base).checks.find(c => c.id === '86b'), undefined);
});

test('a supplier counts as already a vendor by name when the vendor has no GSTIN on file', () => {
  const two = twoBJson({ b2b: [{ ctin: '06AAJCG9963C1ZD', trdnm: 'GOEXCELSIOR PRIVATE LIMITED', inv: [inv('HR/1', '18-10-2026', 5000, 900)] }, { ctin: '07AKFPR5912D1Z9', trdnm: 'AGGARWAL TRADERS', inv: [inv('1068', '25-10-2026', 465205, 23260.25)] }] });
  const r = buildGstr3b({ ...base, vendors: [...vendors, { id: 30, name: 'Goexcelsior', gstin: null, booking: 'expense' }], twoB: two });
  const byNo = Object.fromEntries(r.itc.lists.toUpload.map(x => [x.no, x.knownVendor]));
  assert.deepEqual(byNo, { 'HR/1': true, '1068': false });
});
