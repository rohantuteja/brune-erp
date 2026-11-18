// Analytics → GST: one month's outward supplies, ready for GSTR-1, worked out from the stored order ledger.
//
// The rules are the owner's (14 Oct and 18 Nov 2026), and they are the ones the ledger already follows:
//   * A SALE counts in the month the ORDER was placed (Shopify's order time, Myntra's order time, both IST), whether or not any
//     money has arrived. Orders that nobody has paid yet are in the month's sales; only the money side is "still open".
//   * A RETURN reduces the month its CREDIT NOTE is dated (Unicommerce's return invoice, or the ERP's own credit note when
//     Unicommerce's is missing or short), not the month of the sale.
//   * Fees the ERP keeps from a customer on a return (the ₹99 return fee, the ₹100 COD charge) are invoiced by the ERP and are
//     sales in the month of that invoice.
//   * An order Unicommerce has not invoiced yet is not a sale: it has no entries, so it is listed apart ("not invoiced yet").
//
// Everything here is a pure function of ledger rows (ledger_entries and ledger_orders), so it can be tested without a database.
// Amounts are rupees to the paisa; GST amounts are what the ledger booked (tax = amount - amount / (1 + rate), as in the ledger).

export const MYNTRA_GSTIN = '29AAECM9636P1ZJ';        // Myntra Designs: the e-commerce operator its supplies are reported under (GSTR-1, table 14)

const A = { sales: 'GST SALES', salesReturn: 'GST SALES RETURN', igst: 'IGST OUTPUT UP', cgst: 'CGST Output UP', sgst: 'SGST Output UP' };
export const GST_ACCOUNTS = Object.values(A);
export const GST_VOUCHERS = ['sale', 'credit_note', 'invoice'];
export const CHANNELS = ['shopify', 'myntra'];
export const CHANNEL_LABEL = { shopify: 'Shopify', myntra: 'Myntra' };

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export function monthBounds(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return { from: `${month}-01`, next: `${ny}-${String(nm).padStart(2, '0')}-01` };
}
/** Every month from `startMonth` to `lastMonth`, newest first, as 'YYYY-MM'. */
export function monthsBetween(startMonth, lastMonth) {
  const out = [];
  let y = Number(startMonth.slice(0, 4)), m = Number(startMonth.slice(5, 7));
  const ey = Number(lastMonth.slice(0, 4)), em = Number(lastMonth.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out.reverse();
}

// ── A bucket of amounts ────────────────────────────────────────────────────────────────────────────────────────────
const bucket = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, docs: 0 });
function put(b, d) {
  b.taxable = r2(b.taxable + d.taxable); b.igst = r2(b.igst + d.igst); b.cgst = r2(b.cgst + d.cgst); b.sgst = r2(b.sgst + d.sgst); b.docs += 1;
}
const taxOf = (b) => r2(b.igst + b.cgst + b.sgst);
/** sales + fee invoices - credit notes */
function netOf(sales, fees, returns) {
  const f = (k) => r2(sales[k] + fees[k] - returns[k]);
  return { taxable: f('taxable'), igst: f('igst'), cgst: f('cgst'), sgst: f('sgst') };
}

// ── What a document is for, in words ───────────────────────────────────────────────────────────────────────────────
export function reasonOf(d) {
  const m = d.memo || '';
  if (d.kind === 'sale') return 'Sale';
  if (d.kind === 'fee') return /retained COD/i.test(m) ? 'COD charge kept on a return' : 'Return fee kept (₹99)';
  if (/COD charge/i.test(m)) return 'COD charge on a parcel returned to origin';
  if (/credit note for goods/i.test(m)) return 'Goods returned';
  return d.issuedBy === 'unicommerce' ? 'Return (Unicommerce credit note)' : 'Credit note';
}

// ── Entries → documents ────────────────────────────────────────────────────────────────────────────────────────────
// A document is one sale invoice, one credit note or one ERP fee invoice: the entries of one order, one voucher type and one
// date that share a document number (or, for the ERP's own documents, a memo).
export function documentsOf(entries, orders, month) {
  const docs = new Map();
  for (const e of entries) {
    if (!GST_VOUCHERS.includes(e.voucher) || !GST_ACCOUNTS.includes(e.account)) continue;
    if (month && String(e.entry_date).slice(0, 7) !== month) continue;
    const key = [e.order_name, e.voucher, e.entry_date, e.doc ?? e.memo ?? ''].join('|');
    let d = docs.get(key);
    if (!d) {
      d = { key, order: e.order_name, voucher: e.voucher, kind: e.voucher === 'sale' ? 'sale' : e.voucher === 'invoice' ? 'fee' : 'return',
            date: e.entry_date, number: e.doc ?? null, issuedBy: e.issued_by ?? null, memo: e.memo ?? '', taxable: 0, igst: 0, cgst: 0, sgst: 0, qty: 0 };
      docs.set(key, d);
    }
    // A sale or a fee invoice is credited to sales and to output tax; a credit note is debited to them.
    const v = e.voucher === 'credit_note' ? num(e.debit) - num(e.credit) : num(e.credit) - num(e.debit);
    if (e.account === A.sales || e.account === A.salesReturn) {
      d.taxable = r2(d.taxable + v);
      if (e.voucher === 'sale' ? e.account === A.sales : e.account === A.salesReturn) d.qty += num(e.qty);
    } else if (e.account === A.igst) d.igst = r2(d.igst + v);
    else if (e.account === A.cgst) d.cgst = r2(d.cgst + v);
    else if (e.account === A.sgst) d.sgst = r2(d.sgst + v);
  }
  const out = [];
  for (const d of docs.values()) {
    const o = orders.get(d.order) || {};
    const tax = r2(d.igst + d.cgst + d.sgst);
    // The rate the ledger used for this order; if the order is missing, the rate the amounts imply, to the nearest GST slab.
    let rate = o.rate !== undefined && o.rate !== null && o.rate !== '' ? Number(o.rate) : NaN;
    if (!Number.isFinite(rate)) {
      const implied = d.taxable ? tax / d.taxable : 0;
      rate = [0, 0.05, 0.12, 0.18, 0.28].reduce((best, s) => Math.abs(s - implied) < Math.abs(best - implied) ? s : best, 0.05);
    }
    out.push({ ...d, channel: o.channel || 'shopify', state: o.state || null, stateCode: o.state_code || null, ratePct: r2(rate * 100),
               orderDate: o.sale_date || null, invoiceDate: o.invoice_date || null, tax, total: r2(d.taxable + tax), reason: null });
    out[out.length - 1].reason = reasonOf(d);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.number ?? a.order).localeCompare(String(b.number ?? b.order)) || a.key.localeCompare(b.key));
}

// ── The report ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildGstReport({ month, entries = [], orders = [], waiting = [] }) {
  const byOrder = new Map(orders.map(o => [String(o.order_name), o]));
  const docs = documentsOf(entries, byOrder, month);

  const rows = new Map();             // channel | state code | rate  ->  one row of the state-wise table
  const totals = { shopify: { sales: bucket(), fees: bucket(), returns: bucket() }, myntra: { sales: bucket(), fees: bucket(), returns: bucket() } };
  for (const d of docs) {
    const ch = CHANNELS.includes(d.channel) ? d.channel : 'shopify';
    const k = `${ch}|${d.stateCode || '??'}|${d.ratePct}`;
    let r = rows.get(k);
    if (!r) { r = { channel: ch, stateCode: d.stateCode || '', state: d.state || 'No state on the order', ratePct: d.ratePct, sales: bucket(), fees: bucket(), returns: bucket() }; rows.set(k, r); }
    const slot = d.kind === 'sale' ? 'sales' : d.kind === 'fee' ? 'fees' : 'returns';
    put(r[slot], d); put(totals[ch][slot], d);
  }
  const states = [...rows.values()].map(r => ({ ...r, net: netOf(r.sales, r.fees, r.returns) }))
    .sort((a, b) => a.channel.localeCompare(b.channel) || b.net.taxable - a.net.taxable || a.state.localeCompare(b.state));
  for (const ch of CHANNELS) totals[ch].net = netOf(totals[ch].sales, totals[ch].fees, totals[ch].returns);
  const sum = (slot) => { const b = bucket(); for (const ch of CHANNELS) for (const k of ['taxable', 'igst', 'cgst', 'sgst', 'docs']) b[k] = k === 'docs' ? b[k] + totals[ch][slot][k] : r2(b[k] + totals[ch][slot][k]); return b; };
  totals.all = { sales: sum('sales'), fees: sum('fees'), returns: sum('returns') };
  totals.all.net = netOf(totals.all.sales, totals.all.fees, totals.all.returns);

  // ── Things to know before filing ──
  const checks = [];
  const noState = docs.filter(d => !d.stateCode);
  checks.push(noState.length
    ? { id: 'state', level: 'warn', text: `${noState.length} document${noState.length === 1 ? '' : 's'} (order ${[...new Set(noState.map(d => d.order))].slice(0, 5).join(', ')}) ${noState.length === 1 ? 'has' : 'have'} no state, so ${noState.length === 1 ? 'it is' : 'they are'} grouped under "No state on the order".` }
    : { id: 'state', level: 'ok', text: 'Every document has the state the goods were sent to.' });
  const waitingIn = waiting.filter(w => !month || String(w.sale_date).slice(0, 7) === month);
  checks.push(waitingIn.length
    ? { id: 'waiting', level: 'warn', text: `${waitingIn.length} order${waitingIn.length === 1 ? '' : 's'} placed this month ${waitingIn.length === 1 ? 'has' : 'have'} no Unicommerce invoice yet, so ${waitingIn.length === 1 ? 'it is' : 'they are'} not in these figures. ${waitingIn.length === 1 ? 'It is' : 'They are'} added when the invoice is issued.` }
    : { id: 'waiting', level: 'ok', text: 'Every order placed this month has its Unicommerce invoice.' });
  const erpReturns = docs.filter(d => d.kind === 'return' && d.issuedBy === 'erp'), erpFees = docs.filter(d => d.kind === 'fee');
  if (erpReturns.length || erpFees.length) {
    checks.push({ id: 'unnumbered', level: 'info', text: `${erpReturns.length} credit note${erpReturns.length === 1 ? '' : 's'} and ${erpFees.length} fee invoice${erpFees.length === 1 ? '' : 's'} were issued by the ERP, not Unicommerce. They get their ERP/CN and ERP/IN numbers when they are exported to Tally.` });
  }
  const earlier = orders.filter(o => (o.notes || []).some(n => /before the books started/i.test(String(n))) && docs.some(d => d.order === o.order_name && d.kind === 'sale'));
  if (earlier.length) {
    checks.push({ id: 'earlier', level: 'info', text: `${earlier.length} Myntra order${earlier.length === 1 ? ' was' : 's were'} placed before the books started and ${earlier.length === 1 ? 'is' : 'are'} booked in this month, as decided (${earlier.map(o => o.order_name).join(', ')}).` });
  }
  const stateSum = states.reduce((s, r) => r2(s + r.net.taxable), 0);
  if (Math.abs(stateSum - totals.all.net.taxable) > 0.01) checks.push({ id: 'sums', level: 'error', text: `The state-wise table (${stateSum}) does not add up to the documents (${totals.all.net.taxable}). Do not use these figures.` });

  const w = waitingIn.map(x => ({ order: x.order_name, channel: x.channel || 'shopify', date: x.sale_date, state: x.state || null,
    reason: (Array.isArray(x.exceptions) && x.exceptions[0]?.reason) || 'Waiting for the Unicommerce invoice' })).sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order));

  return {
    month, label: monthLabel(month), ...monthBounds(month),
    states, totals, checks, waiting: w,
    docs: { sales: docs.filter(d => d.kind === 'sale'), fees: docs.filter(d => d.kind === 'fee'), returns: docs.filter(d => d.kind === 'return') },
  };
}

/** The rows of the state-wise table for one channel ('shopify' | 'myntra') with a total line; 'all' merges states across both. */
export function stateTable(report, channel) {
  const list = channel === 'all' ? report.states : report.states.filter(r => r.channel === channel);
  const total = { sales: bucket(), fees: bucket(), returns: bucket() };
  for (const r of list) for (const slot of ['sales', 'fees', 'returns']) for (const k of ['taxable', 'igst', 'cgst', 'sgst']) total[slot][k] = r2(total[slot][k] + r[slot][k]);
  for (const r of list) for (const slot of ['sales', 'fees', 'returns']) total[slot].docs += r[slot].docs;
  return { rows: list, total: { ...total, net: netOf(total.sales, total.fees, total.returns) } };
}
export { taxOf };
