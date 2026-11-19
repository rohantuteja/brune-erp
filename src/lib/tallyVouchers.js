// The Tally vouchers a month's order ledger turns into. Each voucher is a balanced set of ledger lines, built from ledger_entries
// exactly as the ledger holds them (the owner's rule: the Tally file reproduces the ERP ledger event by event, nothing lumped into monthly
// journals, nothing changed).
//
//   sales          the sale invoices (Unicommerce's) and the ERP's own fee invoices            Dr Customer / Cr GST SALES + output tax
//   credit_note    returns (Unicommerce's credit notes and the ERP's own)                       Dr GST SALES RETURN + output tax / Cr Customer
//   receipt        money reaching the bank: one per UTR, a line per order                       gateway payouts, COD remittances, Myntra settlements
//   journal        the per-order clearing of the customer's bill: gateway payment, COD delivery, store credit used or issued, goodwill, round off
//
// Purchase (bills), payment and receipt (bank lines) and the card journal come from the Bills and Bank & card data (tallyBooks.js).
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const SALES = new Set(['sale', 'invoice']);
const RECEIPT = new Set(['payout', 'remittance', 'settlement']);

/** ledger_entries rows → vouchers { id, type, source, date, doc, memo, orders, lines: [{ account, debit, credit, part, qty }], debit, credit, balanced }. */
export function groupOrderVouchers(entries) {
  const groups = new Map();
  for (const e of entries) {
    let type, key;
    if (SALES.has(e.voucher)) { type = 'sales'; key = [e.voucher, e.order_name, e.entry_date, e.doc ?? e.memo ?? ''].join('|'); }
    else if (e.voucher === 'credit_note') { type = 'credit_note'; key = [e.voucher, e.order_name, e.entry_date, e.doc ?? e.memo ?? ''].join('|'); }
    else if (RECEIPT.has(e.voucher)) { type = 'receipt'; key = e.doc ? [e.voucher, e.doc, e.entry_date].join('|') : [e.voucher, e.order_name, e.entry_date].join('|'); }
    else { type = 'journal'; key = [e.voucher, e.order_name, e.entry_date, e.doc ?? ''].join('|'); }
    let g = groups.get(key);
    if (!g) { g = { id: key, type, source: e.voucher, date: e.entry_date, doc: e.doc ?? null, memo: e.memo ?? '', issuedBy: e.issued_by ?? null, orders: new Set(), lines: [] }; groups.set(key, g); }
    g.orders.add(e.order_name);
    g.lines.push({ order: e.order_name, account: e.account, debit: Number(e.debit) || 0, credit: Number(e.credit) || 0, part: e.part ?? null, qty: e.qty ?? null, memo: e.memo ?? '' });
  }
  const out = [];
  for (const g of groups.values()) {
    const debit = r2(g.lines.reduce((s, l) => s + l.debit, 0)), credit = r2(g.lines.reduce((s, l) => s + l.credit, 0));
    out.push({ ...g, orders: [...g.orders].sort(), debit, credit, balanced: Math.abs(debit - credit) < 0.005 });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || String(a.doc ?? a.id).localeCompare(String(b.doc ?? b.id)) || a.id.localeCompare(b.id));
}

export const TYPE_LABEL = { ledger: 'Ledger', sales: 'Sales', credit_note: 'Credit Note', receipt: 'Receipt', journal: 'Journal', payment: 'Payment', purchase: 'Purchase' };

/** How many vouchers of each kind, and how much, for the preview. */
export function voucherPlan(vouchers) {
  const by = {};
  for (const v of vouchers) {
    const x = by[v.type] ?? (by[v.type] = { count: 0, amount: 0, unbalanced: 0, sources: {} });
    x.count++; x.amount = r2(x.amount + v.debit); if (!v.balanced) x.unbalanced++;
    x.sources[v.source] = (x.sources[v.source] ?? 0) + 1;
  }
  return by;
}

/** The ledger account totals of a set of vouchers, to be checked against the ERP ledger's own totals: { account: { debit, credit } }. */
export function accountTotals(vouchers) {
  const t = {};
  for (const v of vouchers) for (const l of v.lines) { const x = t[l.account] ?? (t[l.account] = { debit: 0, credit: 0 }); x.debit = r2(x.debit + l.debit); x.credit = r2(x.credit + l.credit); }
  return t;
}

/**
 * A payout the bank paid short of (the gateway took its own invoices out): the receipt is booked at what the bank really received, and the rest is a debit on the gateway's
 * SUPPLIER ledger against the bills it settles: Dr bank (what came) + Dr the supplier (what was taken) / Cr the gateway's receivable (what it settled), all in one voucher.
 *   recoveries  [{ doc, amount, ledger, refs: [{ name, kind, amount }], memo? }]  (tallyBooks.js: the ones `findRecoveries` found, with the bills each settles)
 */
export function applyRecoveries(vouchers, recoveries = []) {
  if (!recoveries.length) return vouchers;
  const by = new Map(recoveries.map(r => [r.doc, r]));
  return vouchers.map(v => {
    const r = v.type === 'receipt' && v.source === 'payout' && v.doc ? by.get(v.doc) : null;
    if (!r) return v;
    const memo = r.memo ?? 'taken from this payout by the gateway for its own invoices';
    const lines = [...v.lines,
      { order: '(deduction)', account: 'ICICI Bank', debit: 0, credit: r.amount, part: null, qty: null, memo },
      { order: '(deduction)', account: r.ledger, debit: r.amount, credit: 0, part: null, qty: null, memo, refs: r.refs }];
    const debit = r2(lines.reduce((s, l) => s + l.debit, 0)), credit = r2(lines.reduce((s, l) => s + l.credit, 0));
    return { ...v, lines, debit, credit, balanced: Math.abs(debit - credit) < 0.005, recovery: r.amount };
  });
}
