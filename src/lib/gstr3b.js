// Analytics → GSTR-3B: one month's return worked out from what the ERP already knows, as a working sheet to check before filing on the
// GST portal. It files nothing and changes nothing.
//
//   1. Outward supplies (Tables 3.1 and 3.2): the month's net sales from the GST view (buildGstReport), by tax head, and the
//      inter-state sales to consumers by place of supply. Since July 2025 the portal fills these two tables from GSTR-1 and they cannot be
//      edited, so this part is a cross-check of what the portal will show once GSTR-1 is filed.
//   2. Input tax credit (Table 4): what the ERP's books hold (accepted supplier bills; the GST on gateway fees and on Myntra's fees that
//      the order ledger books at each payout and settlement) against GSTR-2B, the portal's list of what suppliers reported about you.
//      Only credit that is in GSTR-2B can be claimed. Bills are matched to it by supplier GSTIN and invoice number; the gateway and Myntra
//      are matched by supplier, because the ERP does not hold their invoice numbers.
//   3. TCS: what Myntra deducted (section 52), to compare with the TCS credit in the portal's electronic cash ledger.
//   4. Payment (Table 6.1): output tax less input credit, using the portal's own order of set-off (sections 49 and 49A, Rule 88A).
//
// Pure functions of rows, so everything is tested without a database. Rupees to the paisa.
import { MYNTRA_GSTIN, stateTable, monthLabel } from './gstReport.js';
import { normInvoice, signOf, GSTIN_RE } from './gstr2b.js';
export { MYNTRA_GSTIN };

export const HEADS = ['igst', 'cgst', 'sgst'];
export const HEAD_LABEL = { igst: 'Integrated tax', cgst: 'Central tax', sgst: 'State/UT tax' };
export const LIMIT_86B = 5_000_000;       // Rule 86B: above this much taxable value in a month, at least 1% of the tax is paid in cash

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const h3 = (igst = 0, cgst = 0, sgst = 0) => ({ igst: r2(igst), cgst: r2(cgst), sgst: r2(sgst) });
const add = (a, b, k = 1) => h3(a.igst + k * b.igst, a.cgst + k * b.cgst, a.sgst + k * b.sgst);
const total = (a) => r2(a.igst + a.cgst + a.sgst);
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
const money = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── The portal's order of set-off ──────────────────────────────────────────────────────────────────────────────────
// Credit of one tax pays that tax first. IGST credit goes against IGST, then against CGST and SGST (any order). CGST credit goes against
// CGST, then IGST; SGST credit against SGST, then IGST; CGST and SGST credit never pay each other, and they pay IGST only once the IGST
// credit is used up (Rule 88A). The order below uses own-head credit first, so that cash is paid only when nothing else can cover it.
export function setOff(liability, credit) {
  const L = { ...liability }, C = { ...credit };
  const used = { igst: h3(), cgst: h3(), sgst: h3() };            // used[liability][credit]
  const use = (lh, ch) => { const x = r2(Math.min(Math.max(L[lh], 0), Math.max(C[ch], 0))); if (x > 0) { L[lh] = r2(L[lh] - x); C[ch] = r2(C[ch] - x); used[lh][ch] = r2(used[lh][ch] + x); } };
  use('igst', 'igst');
  use('cgst', 'cgst'); use('sgst', 'sgst');
  use('cgst', 'igst'); use('sgst', 'igst');
  use('igst', 'cgst'); use('igst', 'sgst');
  return { used, cash: h3(L.igst, L.cgst, L.sgst), closing: h3(C.igst, C.cgst, C.sgst) };
}

// ── A supplier bill → its tax by head ──────────────────────────────────────────────────────────────────────────────
function billHeads(b) {
  const tax = num(b.tax), t = String(b.tax_type ?? '').toUpperCase();
  if (/CGST|SGST/.test(t)) { const c = r2(tax / 2); return { heads: h3(0, c, tax - c), known: true }; }
  if (/IGST/.test(t) || !t) return { heads: h3(tax, 0, 0), known: !!t };
  return { heads: h3(tax, 0, 0), known: false };
}
const docHeads = (d) => h3(d.igst, d.cgst, d.sgst);
const avail = (d) => d.itc === 'Y' && !d.rcm ? add(h3(), docHeads(d), signOf(d)) : h3();      // what a 2B line adds to the credit

const headOfAccount = (a) => /^igst/i.test(a) ? 'igst' : /^cgst/i.test(a) ? 'cgst' : /^sgst/i.test(a) ? 'sgst' : null;

export function buildGstr3b({ month, gst, ownGstin, bills = [], vendors = [], ledgerInput = [], trueups = [], tcsRows = [], twoB = null, opening = null, claimUnmatched = false }) {
  const own = String(ownGstin ?? '').slice(0, 2);
  const checks = [];
  const note = (level, id, text) => checks.push({ id, level, text });

  // ── 1. Outward supplies ──
  const net = gst.totals.all.net;
  const outward = { taxable: net.taxable, ...h3(net.igst, net.cgst, net.sgst), cess: 0 };
  outward.tax = total(outward);
  const st = stateTable(gst, 'all');
  const byState = new Map();
  const intra = { taxable: 0, ...h3() };
  const unknownState = { taxable: 0, ...h3() };
  const odd = [];
  for (const r of st.rows) {
    if (r.stateCode && r.stateCode === own) {
      intra.taxable = r2(intra.taxable + r.net.taxable); intra.igst = r2(intra.igst + r.net.igst); intra.cgst = r2(intra.cgst + r.net.cgst); intra.sgst = r2(intra.sgst + r.net.sgst);
      if (r.net.igst) odd.push(`${r.state} (home state) has IGST`);
    } else if (r.stateCode) {
      const x = byState.get(r.stateCode) ?? { stateCode: r.stateCode, state: r.state, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      x.taxable = r2(x.taxable + r.net.taxable); x.igst = r2(x.igst + r.net.igst); x.cgst = r2(x.cgst + r.net.cgst); x.sgst = r2(x.sgst + r.net.sgst);
      byState.set(r.stateCode, x);
      if (r.net.cgst || r.net.sgst) odd.push(`${r.state} has CGST/SGST`);
    } else { unknownState.taxable = r2(unknownState.taxable + r.net.taxable); unknownState.igst = r2(unknownState.igst + r.net.igst); unknownState.cgst = r2(unknownState.cgst + r.net.cgst); unknownState.sgst = r2(unknownState.sgst + r.net.sgst); }
  }
  const interRows = [...byState.values()].sort((a, b) => b.taxable - a.taxable || a.state.localeCompare(b.state));
  const inter = { taxable: r2(interRows.reduce((s, r) => s + r.taxable, 0)), igst: r2(interRows.reduce((s, r) => s + r.igst, 0)) };
  if (unknownState.taxable || total(unknownState)) note('warn', 'state', `Sales of ${money(unknownState.taxable)} have no state on the order, so they cannot be placed in Table 3.2 or told apart as home-state sales. Fix the states in the GST view first.`);
  if (odd.length) note('warn', 'taxtype', `The ledger charged the wrong kind of tax for the state: ${odd.slice(0, 3).join('; ')}.`);
  if (Math.abs(r2(inter.igst + unknownState.igst) - outward.igst) > 0.01) note('error', 'igstsum', `The IGST in Table 3.2 (${money(inter.igst)}) does not equal the IGST in Table 3.1 (${money(outward.igst)}). Do not use these figures.`);
  const negative = HEADS.filter(k => outward[k] < -0.005);
  if (negative.length) note('warn', 'negative', `Credit notes are larger than sales in ${negative.map(k => HEAD_LABEL[k]).join(', ')} this month, so the tax is below zero. Only tax above zero is paid; ask your accountant how the balance is adjusted.`);
  if (outward.taxable >= LIMIT_86B) note('warn', '86b', `Taxable sales are ${money(outward.taxable)}, above ₹50 lakh: Rule 86B limits paying tax with credit to 99%, so at least 1% of the tax has to be paid in cash unless an exception applies. Ask your accountant.`);

  // ── 2. Input tax credit: the books ──
  const vendorById = new Map(vendors.map(v => [v.id, v]));
  const tieOut = vendors.filter(v => v.booking === 'tie_out');
  const gatewayGstins = new Set(tieOut.map(v => String(v.gstin ?? '').toUpperCase()).filter(Boolean));
  const groups = [
    { id: 'gateway', name: tieOut.length ? `${tieOut.map(v => v.name).join(', ')} (payment gateway)` : 'Payment gateway', gstins: gatewayGstins, vouchers: ['payout'] },
    { id: 'myntra', name: 'Myntra', gstins: new Set([MYNTRA_GSTIN]), vouchers: ['settlement'] },
  ].map(g => ({ ...g, books: h3(), lines: 0 }));
  const other = { id: 'other', name: 'Other ledger lines', gstins: new Set(), vouchers: [], books: h3(), lines: 0 };
  for (const e of ledgerInput) {
    const head = headOfAccount(String(e.account ?? ''));
    if (!head) continue;
    const g = groups.find(x => x.vouchers.includes(e.voucher)) ?? other;
    g.books[head] = r2(g.books[head] + num(e.debit) - num(e.credit)); g.lines++;
  }
  const gw = groups[0];
  for (const t of trueups) { gw.books.igst = r2(gw.books.igst + num(t.gst_diff)); gw.lines++; }
  if (other.lines) { groups.push(other); note('warn', 'otherinput', `${plural(other.lines, 'input-GST ledger line')} came from something other than a gateway payout or a Myntra settlement (${money(total(other.books))}). They are counted in the books but cannot be matched to a supplier.`); }

  const nowInMonth = (d) => !!d && String(d).slice(0, 7) === month;
  const live = bills.filter(b => b.status !== 'void');
  const normBills = live.filter(b => vendorById.get(b.vendor_id)?.booking !== 'tie_out').map(b => {
    const { heads, known } = billHeads(b);
    const gstin = String(b.supplier_gstin || vendorById.get(b.vendor_id)?.gstin || '').toUpperCase() || null;
    return { id: b.id, vendor: b.vendor, no: b.invoice_no, date: b.invoice_date, gstin, status: b.status, opening: !!b.opening, kind: b.kind, taxType: b.tax_type, taxable: num(b.subtotal), heads, tax: total(heads), taxKnown: known, fileName: b.file_name ?? null };
  });
  for (const b of normBills) {
    if (b.gstin && GSTIN_RE.test(b.gstin) && b.taxKnown) {
      const expectIgst = b.gstin.slice(0, 2) !== own;
      const hasIgst = b.heads.igst > 0;
      if (expectIgst !== hasIgst && b.tax > 0) b.issue = `${b.vendor} ${b.no} charges ${expectIgst ? 'CGST + SGST' : 'IGST'} but the supplier is ${expectIgst ? 'in another state' : 'in your state'}: it cannot be claimed as charged.`;
    }
    if (!b.taxKnown) b.issue = `${b.vendor} ${b.no} has a tax type the ERP does not recognise (${b.taxType || 'none'}); it is counted as IGST.`;
  }
  for (const b of normBills) if (b.issue) note('warn', `bill-${b.id}`, b.issue);

  const booksBills = normBills.filter(b => b.status === 'accepted' && !b.opening && nowInMonth(b.date));
  const heldBills = normBills.filter(b => b.status === 'review' && !b.opening && nowInMonth(b.date));
  const billsBooks = booksBills.reduce((a, b) => add(a, b.heads), h3());
  const ledgerBooks = groups.reduce((a, g) => add(a, g.books), h3());
  const books = { bills: billsBooks, groups: groups.map(g => ({ id: g.id, name: g.name, heads: g.books, lines: g.lines })), ledger: ledgerBooks, total: add(billsBooks, ledgerBooks), billCount: booksBills.length };

  // ── 2b. Against GSTR-2B ──
  const lists = { matched: [], differs: [], notIn2b: [], held: [], onlyIn2b: [], unavailable: [], rcm: [], notes: [], suppliers: [] };
  let claim, basis, twoBTotals = null;
  if (!twoB) {
    claim = books.total; basis = 'books';
    lists.notIn2b = booksBills.map(b => ({ ...b }));
    lists.held = heldBills.map(b => ({ ...b }));
    note('warn', 'no2b', 'No GSTR-2B has been loaded for this month, so the input credit below is what your books hold, not what you may claim. Only credit that is in GSTR-2B can be claimed: load the file to check.');
  } else {
    basis = 'twob';
    const docs = twoB.docs.map((d, i) => ({ ...d, _i: i }));
    const used = new Set();
    const byKey = new Map();
    for (const d of docs) if (d.kind !== 'credit_note') { const k = `${d.ctin}|${normInvoice(d.no)}`; byKey.set(k, [...(byKey.get(k) ?? []), d]); }
    const pairs = [];
    for (const b of normBills) {
      const cands = b.gstin
        ? (byKey.get(`${b.gstin}|${normInvoice(b.no)}`) ?? []).filter(d => !used.has(d._i))
        : docs.filter(d => !used.has(d._i) && d.kind === 'invoice' && normInvoice(d.no) === normInvoice(b.no) && near(total(docHeads(d)), b.tax));
      if (cands[0]) { used.add(cands[0]._i); pairs.push({ b, d: cands[0] }); }
    }
    let claimBills = h3(), excess = h3(), heldIn2b = h3();
    for (const { b, d } of pairs) {
      const row = { ...b, doc: d, twoB: docHeads(d), taxable2b: d.taxable, itc: d.itc, reason: d.reason, supplierPeriod: d.supplierPeriod };
      if (b.opening) note('info', `opening-${b.id}`, `${b.vendor} ${b.no} is dated before the books started but is in this month's GSTR-2B. Check that it was not claimed in an earlier return.`);
      if (d.rcm) { lists.rcm.push(row); continue; }
      if (d.itc === 'N') { lists.unavailable.push(row); continue; }
      if (b.status === 'review') { lists.held.push({ ...row, in2b: true }); heldIn2b = add(heldIn2b, avail(d)); continue; }
      if (b.status !== 'accepted') continue;
      const a = avail(d);
      const same = near(total(a), b.tax) && near(d.taxable, b.taxable);
      // Never claim more than the bill supports: per head, the smaller of the two.
      const mine = h3(Math.min(a.igst, b.heads.igst), Math.min(a.cgst, b.heads.cgst), Math.min(a.sgst, b.heads.sgst));
      claimBills = add(claimBills, mine);
      excess = add(excess, a, 1); excess = add(excess, mine, -1);
      (same ? lists.matched : lists.differs).push({ ...row, claim: mine });
    }
    for (const b of booksBills) if (!pairs.some(p => p.b === b)) lists.notIn2b.push({ ...b });
    for (const b of heldBills) if (!pairs.some(p => p.b === b)) lists.held.push({ ...b });

    const groupOf = (ctin) => groups.find(g => g.gstins.has(ctin));
    let supplierClaim = h3(), notesClaim = h3(), onlyAvail = h3();
    const bySupplier = new Map();
    for (const d of docs) {
      if (used.has(d._i)) continue;
      const g = groupOf(d.ctin);
      if (d.rcm) { lists.rcm.push({ vendor: d.supplier, no: d.no, date: d.date, gstin: d.ctin, twoB: docHeads(d), reason: d.reason, doc: d }); continue; }
      if (d.itc === 'N') { lists.unavailable.push({ vendor: d.supplier, no: d.no, date: d.date, gstin: d.ctin, twoB: docHeads(d), reason: d.reason, doc: d }); continue; }
      const a = avail(d);
      if (g) { const s = bySupplier.get(g.id) ?? { group: g, docs: 0, twoB: h3() }; s.docs++; s.twoB = add(s.twoB, a); bySupplier.set(g.id, s); supplierClaim = add(supplierClaim, a); continue; }
      if (d.kind !== 'invoice') { lists.notes.push({ vendor: d.supplier, no: d.no, date: d.date, gstin: d.ctin, kind: d.kind, twoB: a, doc: d }); notesClaim = add(notesClaim, a); continue; }
      lists.onlyIn2b.push({ vendor: d.supplier, no: d.no, date: d.date, gstin: d.ctin, twoB: a, supplierPeriod: d.supplierPeriod, taxable: d.taxable, doc: d });
      onlyAvail = add(onlyAvail, a);
    }
    for (const g of groups) {
      if (g.id === 'other') continue;
      const s = bySupplier.get(g.id);
      lists.suppliers.push({ id: g.id, name: g.name, docs: s?.docs ?? 0, twoB: s?.twoB ?? h3(), books: g.books, diff: add(s?.twoB ?? h3(), g.books, -1) });
    }
    claim = add(add(claimBills, supplierClaim), add(notesClaim, claimUnmatched ? onlyAvail : h3()));
    twoBTotals = { portal: docs.reduce((a, d) => add(a, avail(d)), h3()), claimBills, supplierClaim, notesClaim, unmatched: onlyAvail, excess, held: heldIn2b, claimedUnmatched: claimUnmatched };

    const negClaim = HEADS.filter(k => claim[k] < -0.005);
    if (negClaim.length) note('warn', 'negclaim', `Credit notes from suppliers are larger than the credit in ${negClaim.map(k => HEAD_LABEL[k]).join(', ')} this month. The excess is reversed in Table 4(B); ask your accountant.`);
    // Checks on the file itself
    if (twoB.period && twoB.period !== month) note('error', 'period', `This GSTR-2B is for ${monthLabel(twoB.period)}, not ${monthLabel(month)}. Load the file for ${monthLabel(month)}.`);
    if (ownGstin && twoB.gstin && twoB.gstin !== ownGstin) note('error', 'gstin', `This GSTR-2B is for GSTIN ${twoB.gstin}, not yours (${ownGstin}).`);
    for (const w of twoB.warnings ?? []) note('info', 'twob-not-read', w);
    for (const c of twoB.checks ?? []) if (!c.ok && c.id !== 'read') note('warn', `twob-${c.id}`, c.detail);
    if (lists.notIn2b.length) note('warn', 'not2b', `${plural(lists.notIn2b.length, 'bill')} dated this month ${lists.notIn2b.length === 1 ? 'is' : 'are'} not in GSTR-2B (${money(total(lists.notIn2b.reduce((a, b) => add(a, b.heads), h3())))} of tax): the supplier has not reported ${lists.notIn2b.length === 1 ? 'it' : 'them'} yet, so ${lists.notIn2b.length === 1 ? 'it' : 'they'} cannot be claimed this month. ${lists.notIn2b.length === 1 ? 'It appears' : 'They appear'} in the month the supplier reports ${lists.notIn2b.length === 1 ? 'it' : 'them'}.`);
    if (lists.onlyIn2b.length) note('warn', 'only2b', `${plural(lists.onlyIn2b.length, 'invoice')} in GSTR-2B ${lists.onlyIn2b.length === 1 ? 'has' : 'have'} no bill in the ERP (${money(total(onlyAvail))} of tax). ${claimUnmatched ? 'They are counted as claimed because you chose to.' : 'They are not counted. Upload the bill, or leave the credit unclaimed if it is not yours.'}`);
    if (lists.differs.length) note('warn', 'differs', `${plural(lists.differs.length, 'bill')} differ${lists.differs.length === 1 ? 's' : ''} from GSTR-2B in tax or taxable value. The smaller figure is claimed.`);
    if (lists.held.length) note('warn', 'held', `${plural(lists.held.length, 'bill')} dated this month ${lists.held.length === 1 ? 'is' : 'are'} still waiting for your review on the Bills page (${money(total(lists.held.reduce((a, b) => add(a, b.heads), h3())))} of tax), so ${lists.held.length === 1 ? 'it is' : 'they are'} not claimed yet.`);
    if (lists.unavailable.length) note('info', 'unavailable', `${plural(lists.unavailable.length, 'line')} in GSTR-2B ${lists.unavailable.length === 1 ? 'is' : 'are'} marked "ITC not available" (${money(total(lists.unavailable.reduce((a, b) => add(a, b.twoB), h3())))} of tax), so ${lists.unavailable.length === 1 ? 'it is' : 'they are'} left out.`);
    if (lists.rcm.length) note('warn', 'rcm', `${plural(lists.rcm.length, 'line')} in GSTR-2B ${lists.rcm.length === 1 ? 'is' : 'are'} reverse charge: that tax is reported in Table 3.1(d) and claimed in Table 4(A)(3), which this screen does not work out. Ask your accountant.`);
    for (const s of lists.suppliers) {
      if (s.docs && Math.abs(total(s.diff)) > 1) note('info', `supplier-${s.id}`, `${s.name}: GSTR-2B has ${money(total(s.twoB))} of tax and your books booked ${money(total(s.books))} this month (a difference of ${money(Math.abs(total(s.diff)))}). Their invoices and your payout lines fall in different months, so some difference is normal; the ERP does not hold their invoice numbers.`);
      if (!s.docs && total(s.books) > 1) note('warn', `supplier-${s.id}`, `${s.name}: your books booked ${money(total(s.books))} of input GST this month but GSTR-2B has no invoice from them, so none of it is claimed yet. It is claimed in the month their invoice appears in GSTR-2B.`);
    }
  }

  // ── 3. TCS and TDS ──
  const tcs = { tcs: 0, tds: 0, tcsLines: 0, tdsLines: 0 };
  for (const e of tcsRows) {
    const a = String(e.account ?? ''), v = num(e.debit) - num(e.credit);
    if (/tax collected at source/i.test(a)) { tcs.tcs = r2(tcs.tcs + v); tcs.tcsLines++; }
    else if (/tax deducted at source/i.test(a)) { tcs.tds = r2(tcs.tds + v); tcs.tdsLines++; }
  }

  // ── 4. Payment ──
  const openingSet = !!opening;
  const open = opening ? h3(opening.igst, opening.cgst, opening.sgst) : h3();
  const liability = h3(Math.max(0, outward.igst), Math.max(0, outward.cgst), Math.max(0, outward.sgst));
  const creditTotal = add(open, claim);
  const so = setOff(liability, creditTotal);
  const payment = { liability, opening: open, claim, credit: creditTotal, ...so, cashTotal: total(so.cash), closingTotal: total(so.closing), itcUsedTotal: r2(HEADS.reduce((s, lh) => s + total(so.used[lh]), 0)) };
  if (!openingSet) note('warn', 'opening', 'The credit you carried into this month (from the portal\'s electronic credit ledger) has not been entered, so the payment below counts it as nil. Enter it under "Payment".');

  return {
    month, ownGstin: ownGstin ?? null, ownState: own,
    outward, interstate: { rows: interRows, ...inter }, intra, unknownState,
    itc: { basis, hasTwoB: !!twoB, books, twoB: twoBTotals, claim, lists, claimUnmatched },
    tcs, payment, openingSet, notes: opening?.note ?? '',
    checks,
  };
}
