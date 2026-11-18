// The Tally vouchers that come from the Bills page and the Bank & card page (the order ledger's own vouchers are in tallyVouchers.js):
//
//   Purchase   one per accepted bill dated in the month. A fabric bill whose lines are kilos or metres is an ITEM invoice (KNITTED FABRIC / Shirting Fabric,
//              as the accountant books them today); every other bill is an ACCOUNTING invoice (Dr the supplier's expense ledger, like his GST EXPENSES vouchers).
//              Input GST on IGST Input UP, or CGST Input UP + SGST Input UP, the paise on ROUND OFF, tax deducted at source when the supplier has it set.
//   Payment    one per bank payment. A payment to a supplier is posted to the SUPPLIER's ledger against the bill it pays (Agst Ref), or as an Advance when no
//              bill is there yet; the expense is already in the bill, so posting it again would count it twice. Any other payment goes to its bucket's ledger.
//   Receipt    a bank credit that is not an order payout (those are the order ledger's own receipts).
//
// Wholesale (bills the owner marked "the accountant books this one", the bucket "Wholesale (accountant books)"), returned pairs and the founder's own card
// payments make no entry. Pure functions of the rows, tested without a database. Rules and reasoning: docs/accounting-page.md.
import { isHandledBill } from './gstr2b.js';
import { stateOfGstin, stateByCode } from './gstStates.js';

export const BOOKS = {
  purchaseLedger: 'Purchase Raw Material', roundOff: 'ROUND OFF', bank: 'ICICI Bank',
  igst: 'IGST Input  UP', cgst: 'CGST Input UP', sgst: 'SGST Input UP',
  items: { KGS: 'KNITTED FABRIC', MTR: 'Shirting Fabric' },                      // by the unit the invoice line is billed in
  godown: 'Main Location', batch: 'Primary Batch',
  purchaseGroup: 'Purchase Accounts',                                              // a Tally GROUP: a payment filed here must be linked to a supplier
  // Receivables the order ledger already posts the bank credits of (one Receipt per UTR): these bank credits make no second voucher.
  orderLedgers: new Set(['Easebuzz Private Limited', 'COD receivable (Velocity)', 'Razorpay Payment Private Limited', 'Myntra receivable (order control)']),
  ourState: 'Uttar Pradesh',
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => p / 100;
const GENERIC = new Set(['private', 'limited', 'pvt', 'ltd', 'india', 'services', 'solutions', 'online', 'esolutions', 'enterprises', 'traders', 'fashion', 'textiles', 'hosiery', 'delhi', 'company', 'the']);

// ───────────────────────── Purchase vouchers ─────────────────────────

/** The unit of an invoice line as Tally's: kilos or metres, else null (the bill is then booked as an accounting invoice, not an item invoice). */
export function unitOf(line) {
  const u = String(line?.unit ?? '').trim().toUpperCase();
  if (/^(KG|KGS|KILO|KILOS|KILOGRAM|KILOGRAMS)$/.test(u)) return 'KGS';
  if (/^(M|MTR|MTRS|METER|METERS|METRE|METRES)$/.test(u)) return 'MTR';
  return null;
}

/** The bills the ERP books: accepted, supplier not tie-out only, not marked "the accountant books this one". Opening bills are in (they take payments) but make no voucher. */
export function billsToBook({ bills, vendors, handled }) {
  const vendorById = new Map((vendors || []).map(v => [v.id, v]));
  const out = [], problems = [];
  for (const b of bills || []) {
    if (b.status !== 'accepted') continue;
    const v = vendorById.get(b.vendor_id);
    if (!v) { problems.push({ kind: 'no_vendor', bill: b, text: `${b.vendor} ${b.invoice_no}: the bill is not linked to a supplier` }); continue; }
    if (v.booking === 'tie_out') continue;
    if (isHandledBill(b, handled)) continue;
    const total = Number(b.total) || 0;
    const tds = v.tds_rate && v.tds_ledger ? Math.round(Number(b.subtotal) * Number(v.tds_rate) / 100) : 0;
    out.push({ bill: b, vendor: v, tds, net: r2(total - tds) });
  }
  return { list: out, problems };
}

/** One bill → one Purchase voucher (without its bill references: the allocation fills those in), or { problem }. */
export function purchaseVoucher({ bill: b, vendor: v, tds, net }) {
  const subtotal = Number(b.subtotal) || 0, tax = Number(b.tax) || 0, total = Number(b.total) || 0;
  const cgstSgst = /CGST/i.test(b.tax_type || '') && !/IGST/i.test(b.tax_type || '');
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const items = lines.map(l => ({ unit: unitOf(l), name: BOOKS.items[unitOf(l)], qty: Number(l.qty), rate: Number(l.rate), amount: Number(l.amount), hsn: l.hsn || l.sac || '', description: l.description || '' }));
  const itemsTotal = items.reduce((s, i) => s + i.amount, 0);
  const asItems = v.booking === 'purchase' && items.length > 0 && items.every(i => i.name && i.qty > 0 && Number.isFinite(i.amount)) && Math.abs(itemsTotal - subtotal) <= 1;
  const ledger = asItems || v.booking === 'purchase' ? BOOKS.purchaseLedger : v.expense_ledger;
  if (!ledger) return { problem: `${v.name} ${b.invoice_no}: the supplier has no expense ledger` };
  if (!v.tally_ledger_name) return { problem: `${v.name} ${b.invoice_no}: the supplier has no Tally ledger` };

  const goods = asItems ? r2(itemsTotal) : r2(subtotal);                       // what is debited to the purchase / expense side
  const rows = [];
  rows.push({ account: v.tally_ledger_name, debit: 0, credit: net, party: true });
  if (tds) rows.push({ account: v.tds_ledger, debit: 0, credit: tds });
  if (!asItems) rows.push({ account: ledger, debit: goods, credit: 0, expense: true });
  if (cgstSgst) {
    const c = r2(tax / 2); rows.push({ account: BOOKS.cgst, debit: c, credit: 0 }, { account: BOOKS.sgst, debit: r2(tax - c), credit: 0 });
  } else if (tax) rows.push({ account: BOOKS.igst, debit: r2(tax), credit: 0 });
  const credit = r2(net + tds);
  const debitSoFar = r2((asItems ? goods : 0) + rows.reduce((s, r) => s + r.debit, 0));
  const diff = r2(credit - debitSoFar);                                         // what ROUND OFF takes up: the paise the invoice rounded off
  if (Math.abs(diff) > 0.004) rows.push(diff > 0 ? { account: BOOKS.roundOff, debit: diff, credit: 0, round: true } : { account: BOOKS.roundOff, debit: 0, credit: -diff, round: true });
  const debit = r2(rows.reduce((s, r) => s + r.debit, 0) + (asItems ? goods : 0));
  const credits = r2(rows.reduce((s, r) => s + r.credit, 0));
  const state = stateOfGstin(b.supplier_gstin || v.gstin) || stateByCode(v.state_code);
  return {
    voucher: {
      id: `purchase|${b.id}`, type: 'purchase', source: asItems ? 'fabric bill (items)' : v.booking === 'purchase' ? 'fabric bill' : 'expense bill',
      date: String(b.invoice_date).slice(0, 10), number: b.invoice_no, reference: b.invoice_no, memo: `${v.name} invoice ${b.invoice_no}`,
      vendorId: v.id, vendor: v.name, party: v.tally_ledger_name, partyGstin: b.supplier_gstin || v.gstin || '', partyState: state,
      mode: asItems ? 'Item Invoice' : 'Accounting Invoice', items: asItems ? items : [], expense: asItems ? BOOKS.purchaseLedger : ledger,
      taxRate: Number(b.tax_rate) || null, cgstSgst, sac: items[0]?.hsn || '', services: b.kind === 'service', net, tds, billId: b.id, billRefs: [],
      lines: rows.map(({ account, debit: d, credit: c }) => ({ account, debit: d, credit: c })), itemLines: asItems ? items.map(i => ({ account: BOOKS.purchaseLedger, debit: r2(i.amount), credit: 0 })) : [],
      debit, credit: credits, balanced: Math.abs(debit - credits) < 0.005,
    },
    note: !asItems && v.booking === 'purchase' && lines.length ? `${v.name} ${b.invoice_no}: booked as an accounting invoice (a line is not in kilos or metres, or the lines do not add up to the invoice)` : null,
  };
}

// ───────────────────────── Matching payments to bills ─────────────────────────

/** Subsets of up to three bills whose remaining amounts add up to exactly `target` (paise); the smallest, then the oldest. */
function exactSubset(bills, remaining, target) {
  const open = bills.filter(b => remaining.get(b.id) > 0);
  for (let size = 1; size <= 3; size++) {
    let found = null;
    const walk = (start, picked, sum) => {
      if (found) return;
      if (picked.length === size) { if (sum === target) found = picked.slice(); return; }
      for (let i = start; i < open.length && !found; i++) {
        const r = remaining.get(open[i].id);
        if (sum + r <= target) { picked.push(open[i]); walk(i + 1, picked, sum + r); picked.pop(); }
      }
    };
    walk(0, [], 0);
    if (found) return found;
  }
  return null;
}

/**
 * Tally tracks a supplier bill by bill: the Purchase voucher opens a bill (New Ref), a payment settles it (Agst Ref), a payment with no bill yet is an Advance that the
 * bill, when it comes, settles. One supplier at a time, oldest first, on the day's order: bills of the day first, then payments.
 *   bills     [{ id, name, date, net, opening }]      payments  [{ id, date, amount, ref }]
 * Returns { billRefs: Map id → [{ name, kind, amount }], payRefs: Map id → [...], advances: [{ name, left, date }], open: [{ id, name, left }] }  (amounts in rupees).
 */
export function allocateSupplier(bills, payments) {
  const remaining = new Map(bills.map(b => [b.id, paise(b.net)]));
  const events = [...bills.map(b => ({ t: 0, date: b.date, id: b.id, b })), ...payments.map(p => ({ t: 1, date: p.date, id: p.id, p }))]
    .sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const billRefs = new Map(), payRefs = new Map(), advances = [], arrived = [];
  for (const ev of events) {
    if (ev.t === 0) {
      const b = ev.b; let left = remaining.get(b.id); const refs = [];
      if (!b.opening) {
        for (const adv of advances) {                                         // an advance paid before the bill settles it first
          if (left <= 0) break;
          if (adv.left <= 0) continue;
          const use = Math.min(adv.left, left); adv.left -= use; left -= use; refs.push({ name: adv.name, kind: 'Agst Ref', amount: rupees(use) });
        }
        if (left > 0) refs.push({ name: b.name, kind: 'New Ref', amount: rupees(left) });
      }
      remaining.set(b.id, left); billRefs.set(b.id, refs); arrived.push(b);
    } else {
      const p = ev.p; let left = paise(p.amount); const refs = [];
      const combo = exactSubset(arrived, remaining, left);
      const pick = combo ?? arrived.filter(b => remaining.get(b.id) > 0);
      for (const b of pick) {
        if (left <= 0) break;
        const pay = Math.min(remaining.get(b.id), left);
        remaining.set(b.id, remaining.get(b.id) - pay); left -= pay; refs.push({ name: b.name, kind: 'Agst Ref', amount: rupees(pay) });
      }
      if (left > 0) { const name = `ADV-${p.ref}`; refs.push({ name, kind: 'Advance', amount: rupees(left) }); advances.push({ name, left, date: p.date }); }
      payRefs.set(p.id, refs);
    }
  }
  return { billRefs, payRefs, advances: advances.filter(a => a.left > 0).map(a => ({ name: a.name, left: rupees(a.left), date: a.date })),
    open: arrived.filter(b => remaining.get(b.id) > 0).map(b => ({ id: b.id, name: b.name, left: rupees(remaining.get(b.id)), date: b.date, opening: !!b.opening })) };
}

// ───────────────────────── Bank lines ─────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const tokens = (v) => [...new Set([v.name, v.tally_ledger_name].flatMap(s => String(s ?? '').toLowerCase().split(/[^a-z]+/)).filter(t => t.length >= 4 && !GENERIC.has(t)))];

/** The supplier a payee's name points to, only when it points to exactly one. */
export function vendorByPayeeName(payee, vendors) {
  const p = norm(payee);
  if (p.length < 4) return null;
  const hits = (vendors || []).filter(v => tokens(v).some(t => p.includes(t)));
  return hits.length === 1 ? hits[0] : null;
}

/** The reference Tally shows for a bank line: the long number inside the narration (the UPI / NEFT / IMPS reference), else the line's own id. */
export function bankRef(line) {
  const m = String(line.remarks ?? '').match(/(\d{9,})/);
  return m ? m[1] : `L${line.id}`;
}

const pad = (n) => String(n).padStart(5, '0');

/**
 * Every bank line from the books' start to the end of the month → what it becomes.
 *   lines      finance_lines of the BANK account(s): { id, txn_date, debit, credit, status, bucket, remarks, payee, vendor_id }
 *   buckets    [{ name, kind, needs_bill }]            payeeLinks  [{ payee, vendor_id }]
 *   timeline   billsToBook(...).list (all dates up to the month's end)
 * Returns { payments: [{ line, vendor|null, ledger }], receipts: [...], skipped: [{ line, why }], unlinked: [line] }.
 */
export function classifyBankLines({ lines, buckets, vendors, payeeLinks, timeline, start, next }) {
  const bucket = new Map((buckets || []).map(b => [b.name, b]));
  const vendorById = new Map((vendors || []).map(v => [v.id, v]));
  const vendorByLedger = new Map((vendors || []).filter(v => v.tally_ledger_name).map(v => [v.tally_ledger_name, v]));
  const saved = new Map((payeeLinks || []).map(l => [l.payee, vendorById.get(l.vendor_id)]).filter(([, v]) => v));
  const billsOf = new Map();
  for (const t of timeline) { const a = billsOf.get(t.vendor.id) ?? []; a.push(t); billsOf.set(t.vendor.id, a); }
  const out = { payments: [], receipts: [], skipped: [], unlinked: [] };
  const learned = new Map();
  const pending = [];

  // Which supplier(s) have bills adding up exactly to this amount (up to three bills of one supplier)?
  const exactVendors = (line) => {
    const target = paise(line.debit), day = String(line.txn_date).slice(0, 10), hits = [];
    for (const [vid, list] of billsOf) {
      const near = list.filter(t => t.bill.invoice_date >= shift(day, -400) && t.bill.invoice_date <= shift(day, 45));
      const rem = new Map(near.map(t => [t.bill.id, paise(t.net)]));
      if (exactSubset(near.map(t => ({ id: t.bill.id })), rem, target)) hits.push(vendorById.get(vid));
    }
    return hits;
  };

  for (const l of lines || []) {
    const day = String(l.txn_date).slice(0, 10);
    if (day < start || day >= next) continue;
    if (l.status === 'ignored' || bucket.get(l.bucket)?.kind === 'ignore') { out.skipped.push({ line: l, why: 'ignored' }); continue; }
    if (l.status !== 'matched') { out.skipped.push({ line: l, why: 'undecided' }); continue; }
    const b = bucket.get(l.bucket);
    if (Number(l.credit) > 0) {
      if (BOOKS.orderLedgers.has(l.bucket)) { out.skipped.push({ line: l, why: 'order ledger receipt' }); continue; }
      out.receipts.push({ line: l, ledger: l.bucket }); continue;
    }
    if (!(Number(l.debit) > 0)) continue;
    const needsSupplier = l.bucket === BOOKS.purchaseGroup || !!b?.needs_bill;
    // A person's link wins; a bucket that IS a supplier's ledger names the supplier; a remembered payee counts only on a line that needs a supplier (a petty cash
    // purchase from the same shop is not a payment to it).
    let vendor = vendorById.get(l.vendor_id) || vendorByLedger.get(l.bucket) || (needsSupplier ? saved.get(l.payee) : null) || null;
    if (!vendor && needsSupplier) {
      const hits = exactVendors(l);
      if (hits.length === 1) { vendor = hits[0]; if (l.payee) learned.set(l.payee, vendor); }
      else pending.push(l);
      if (vendor) { out.payments.push({ line: l, vendor, ledger: vendor.tally_ledger_name }); continue; }
      continue;
    }
    out.payments.push({ line: l, vendor, ledger: vendor ? vendor.tally_ledger_name : l.bucket });
  }
  // Second look at the lines no exact amount placed: the payee was matched to a supplier on another line this run, or its name says which supplier it is.
  for (const l of pending) {
    // The payee's name, then the word the payer typed on the payment ("AirtelOfficeBil"), and the whole narration only when both are empty.
    const vendor = learned.get(l.payee) || vendorByPayeeName(l.payee, vendors) || vendorByPayeeName(l.note, vendors) || (!l.payee && !l.note ? vendorByPayeeName(l.remarks, vendors) : null);
    if (vendor) out.payments.push({ line: l, vendor, ledger: vendor.tally_ledger_name });
    else out.unlinked.push(l);
  }
  out.payments.sort((a, b) => String(a.line.txn_date).localeCompare(String(b.line.txn_date)) || a.line.id - b.line.id);
  return out;
}

function shift(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ───────────────────────── Everything for one month ─────────────────────────

/**
 * @param { from, next, start, bills, vendors, handled, bankLines, buckets, payeeLinks }  (all bills and bank lines from the books' start to the end of the month)
 * @returns { vouchers, problems, notes, unlinked, advances, unpaid, tdsPending, summary }
 */
export function buildBooks({ from, next, start, bills, vendors, handled, bankLines, buckets, payeeLinks }) {
  const { list, problems } = billsToBook({ bills: (bills || []).filter(b => String(b.invoice_date).slice(0, 10) < next), vendors, handled });
  const notes = [];
  const cls = classifyBankLines({ lines: bankLines, buckets, vendors, payeeLinks, timeline: list, start: start || from, next });

  // A prepaid account (Velocity's wallet) is not a supplier to settle bill by bill: a top-up adds to the wallet, the monthly invoice uses it up, each is its own reference.
  const prepaidLedgers = new Set((buckets || []).filter(b => b.kind === 'asset').map(b => b.name));
  const isPrepaid = (v) => !!v && prepaidLedgers.has(v.tally_ledger_name);
  // One allocation per supplier: its bills and the payments linked to it.
  const perVendor = new Map();
  const slot = (id) => perVendor.get(id) ?? (perVendor.set(id, { bills: [], payments: [] }), perVendor.get(id));
  for (const t of list) if (!isPrepaid(t.vendor)) slot(t.vendor.id).bills.push({ id: t.bill.id, name: t.bill.invoice_no, date: String(t.bill.invoice_date).slice(0, 10), net: t.net, opening: !!t.bill.opening });
  for (const p of cls.payments) if (p.vendor && !isPrepaid(p.vendor)) slot(p.vendor.id).payments.push({ id: p.line.id, date: String(p.line.txn_date).slice(0, 10), amount: Number(p.line.debit), ref: bankRef(p.line) });
  const billRefs = new Map(), payRefs = new Map(), advances = [], unpaid = [];
  for (const [vid, s] of perVendor) {
    const a = allocateSupplier(s.bills, s.payments);
    a.billRefs.forEach((v, k) => billRefs.set(k, v)); a.payRefs.forEach((v, k) => payRefs.set(k, v));
    const vendor = (vendors || []).find(v => v.id === vid);
    for (const adv of a.advances) advances.push({ vendor: vendor?.name, ...adv });
    for (const o of a.open) if (!o.opening) unpaid.push({ vendor: vendor?.name, ...o });
  }

  const vouchers = [];
  for (const t of list) {
    const d = String(t.bill.invoice_date).slice(0, 10);
    if (t.bill.opening || d < from || d >= next) continue;
    const r = purchaseVoucher(t);
    if (r.problem) { problems.push({ kind: 'bill', text: r.problem }); continue; }
    r.voucher.billRefs = isPrepaid(t.vendor) ? [{ name: t.bill.invoice_no, kind: 'New Ref', amount: t.net }] : (billRefs.get(t.bill.id) ?? []);
    if (r.note) notes.push(r.note);
    vouchers.push(r.voucher);
  }
  for (const p of cls.payments) {
    const l = p.line, day = String(l.txn_date).slice(0, 10);
    if (day < from) continue;
    const amount = r2(l.debit), number = `ERP/PY/2627/${pad(l.id)}`;
    vouchers.push({
      id: `payment|${l.id}`, type: 'payment', source: p.vendor ? (isPrepaid(p.vendor) ? 'wallet top-up' : 'supplier payment') : 'bank payment', date: day, number, memo: String(l.remarks ?? '').slice(0, 200),
      lineId: l.id, vendorId: p.vendor?.id ?? null, vendor: p.vendor?.name ?? null, party: p.ledger, ref: bankRef(l), favouring: p.ledger,
      billRefs: p.vendor ? (isPrepaid(p.vendor) ? [{ name: number, kind: 'New Ref', amount }] : (payRefs.get(l.id) ?? [])) : [],
      lines: [{ account: p.ledger, debit: amount, credit: 0 }, { account: BOOKS.bank, debit: 0, credit: amount }], debit: amount, credit: amount, balanced: true,
    });
  }
  for (const rc of cls.receipts) {
    const l = rc.line, day = String(l.txn_date).slice(0, 10);
    if (day < from) continue;
    const amount = r2(l.credit);
    vouchers.push({
      id: `receipt|${l.id}`, type: 'receipt', source: 'bank receipt', date: day, number: `ERP/RC/2627/${pad(l.id)}`, memo: String(l.remarks ?? '').slice(0, 200),
      lineId: l.id, party: rc.ledger, ref: bankRef(l), favouring: rc.ledger, billRefs: [],
      lines: [{ account: BOOKS.bank, debit: amount, credit: 0 }, { account: rc.ledger, debit: 0, credit: amount }], debit: amount, credit: amount, balanced: true,
    });
  }
  const rank = { purchase: 0, payment: 1, receipt: 1 };
  vouchers.sort((a, b) => a.date.localeCompare(b.date) || rank[a.type] - rank[b.type] || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));

  const monthBills = list.filter(t => !t.bill.opening && String(t.bill.invoice_date).slice(0, 10) >= from);
  const tdsPending = [...new Set(monthBills.filter(t => t.vendor.tds_to_confirm && !t.vendor.tds_rate).map(t => t.vendor.name))];
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));
  const purchases = vouchers.filter(v => v.type === 'purchase'), payments = vouchers.filter(v => v.type === 'payment'), receipts = vouchers.filter(v => v.type === 'receipt');
  const inMonth = (l) => String(l.txn_date).slice(0, 10) >= from;
  return {
    vouchers, problems, notes, tdsPending,
    unlinked: cls.unlinked.filter(inMonth), advances: advances.filter(a => a.date < next), unpaid,
    summary: {
      purchases: { count: purchases.length, party: sum(purchases, v => v.net), tds: sum(purchases, v => v.tds), expected: sum(monthBills, t => t.net) , expectedCount: monthBills.length },
      payments: { count: payments.length, amount: sum(payments, v => v.debit), expected: sum(cls.payments.filter(p => String(p.line.txn_date).slice(0, 10) >= from), p => Number(p.line.debit)) },
      receipts: { count: receipts.length, amount: sum(receipts, v => v.debit) },
      skipped: cls.skipped.filter(s => inMonth(s.line)).reduce((m, s) => { m[s.why] = (m[s.why] ?? 0) + 1; return m; }, {}),
    },
  };
}

/** The checks printed with the file: every bill and every settled bank line is in a voucher, and the totals agree. */
export function bookChecks(books) {
  const s = books.summary;
  const okP = s.purchases.count === s.purchases.expectedCount && Math.abs(s.purchases.party - s.purchases.expected) < 0.01;
  const okB = Math.abs(s.payments.amount - s.payments.expected) < 0.01;
  return [
    { id: 'purchases', ok: okP && books.problems.length === 0, detail: okP && books.problems.length === 0 ? `${s.purchases.count} purchase voucher${s.purchases.count === 1 ? '' : 's'}: the amounts payable to suppliers add up to the bills (${s.purchases.party.toLocaleString('en-IN', { minimumFractionDigits: 2 })}).` : `Purchase vouchers: ${books.problems.length ? books.problems.slice(0, 3).map(p => p.text).join('; ') : 'the totals differ from the bills'}.` },
    { id: 'payments', ok: okB && books.unlinked.length === 0, detail: okB && books.unlinked.length === 0 ? `${s.payments.count} payment voucher${s.payments.count === 1 ? '' : 's'} add up to the bank payments (${s.payments.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}).` : `${books.unlinked.length} bank payment(s) are not linked to a supplier.` },
  ];
}
