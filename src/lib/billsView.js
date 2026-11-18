// Pure helpers for Analytics → Bills: no React, no network, tested with `node --test`.

export const STATUS_LABEL = { review: 'Needs review', accepted: 'Accepted', void: 'Void' };
export const BOOKING_LABEL = { expense: 'Expense: a GST EXPENSES voucher', purchase: 'Goods purchase: a Purchase UP voucher', tie_out: 'Tie-out only: never posted' };
export const BOOKING_SHORT = { expense: 'Expense', purchase: 'Purchase', tie_out: 'Tie-out only' };

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Counts for the status cards. Opening bills (dated before the books start) are counted apart: they are matched, never exported. */
export function billSummary(bills) {
  const out = { review: 0, accepted: 0, void: 0, opening: 0, reviewAmount: 0 };
  for (const b of bills) {
    out[b.status] = (out[b.status] ?? 0) + 1;
    if (b.status === 'void') continue;
    if (b.opening) out.opening++;
    if (b.status === 'review') out.reviewAmount = money(out.reviewAmount + Number(b.total));
  }
  return out;
}

/** The status pills, the vendor filter and the search box. The search looks at the vendor, the invoice number, the GSTIN and the amount. */
export function filterBills(bills, { status = 'review', vendor = '', q = '', month = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return bills.filter(b => {
    if (month && String(b.invoice_date ?? '').slice(0, 7) !== month) return false;
    if (status === 'open') { if (b.status === 'void') return false; }
    else if (status !== 'all' && b.status !== status) return false;
    if (vendor && String(b.vendor_id ?? '') !== vendor) return false;
    if (needle && ![b.vendor, b.invoice_no, b.supplier_gstin, String(money(b.total))].some(v => v && String(v).toLowerCase().includes(needle))) return false;
    return true;
  });
}

/** The months that have bills (by invoice date), newest first: the month filter's choices. */
export const billMonths = (bills) => [...new Set(bills.map(b => String(b.invoice_date ?? '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort().reverse();

/** The bills of a month that are in the books' records (voided ones are kept but are not bills any more), with their total. */
export function billsOfMonth(bills, month) {
  const list = bills.filter(b => b.status !== 'void' && String(b.invoice_date ?? '').slice(0, 7) === month);
  return { list, count: list.length, withPdf: list.filter(b => b.file_path).length, total: money(list.reduce((s, b) => s + Number(b.total || 0), 0)) };
}

const cleanName = (s) => String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
/** The file name of each bill's PDF in the zip: "2026-10-12 Airtel HF2709I013498070.pdf", unique within the zip. */
export function pdfNames(bills) {
  const used = new Set(), out = new Map();
  for (const b of bills) {
    const base = `${String(b.invoice_date ?? '').slice(0, 10)} ${cleanName(b.vendor)} ${cleanName(b.invoice_no)}`.trim();
    let name = `${base}.pdf`, k = 1;
    while (used.has(name.toLowerCase())) name = `${base} (${++k}).pdf`;
    used.add(name.toLowerCase()); out.set(b.id, name);
  }
  return out;
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** index.csv of the zip: every bill of the month, the file it is in, or why there is none. */
export function indexCsv(bills, names, missing = new Map()) {
  const head = ['Invoice date', 'Vendor', 'Invoice number', 'Supplier GSTIN', 'Taxable value', 'GST', 'Total', 'Status', 'PDF in this zip'];
  const rows = bills.map(b => [String(b.invoice_date ?? '').slice(0, 10), b.vendor, b.invoice_no, b.supplier_gstin ?? '', money(b.subtotal), money(b.tax), money(b.total), STATUS_LABEL[b.status] ?? b.status,
    b.file_path && !missing.has(b.id) ? names.get(b.id) : missing.get(b.id) ?? 'no PDF kept for this bill (booked from the GSTR-2B)']);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export const failedChecks = (bill) => (bill.checks ?? []).filter(c => !c.ok);

/** One sentence for each file in an upload: what happened to every invoice found in it. */
export function outcomeText(r) {
  const who = `${r.vendor ? `${r.vendor} ` : ''}${r.invoice_no ?? ''}`.trim();
  switch (r.outcome) {
    case 'accepted': return { tone: 'ok', text: `${who}: read, every check passed, accepted.` };
    case 'review': return { tone: 'warn', text: `${who}: read, held for you. ${(r.reasons ?? [])[0] ?? ''}`.trim() };
    case 'attached': return { tone: 'ok', text: `${who} was already in the system without its PDF: the original is now attached.${r.differs?.length ? ` The PDF differs from what was stored: ${r.differs.join('; ')}.` : ' Its stored figures agree with the PDF.'}`, warn: !!r.differs?.length };
    case 'already_uploaded': return { tone: 'info', text: `${who}: this exact file was uploaded before. Nothing changed.` };
    case 'duplicate': return { tone: 'info', text: `${who}: that invoice is already in the system with its PDF. Nothing changed.` };
    case 'unreadable': return { tone: 'bad', text: `${r.invoice_no ? `${r.invoice_no}: ` : ''}could not be read well enough to store. ${(r.reasons ?? []).join('; ')}` };
    default: return { tone: 'info', text: who };
  }
}

/** The new-vendor form, filled with what the invoice says about the vendor. */
// ── Tally's own ledgers ─────────────────────────────────────────────────────────────────────
// `ledgers` is the tally_ledgers table: every ledger of the owner's Tally (his trial balance), plus the renames and new ledgers agreed
// with his accountant. A vendor's own ledger and its expense ledger are chosen from it, never typed: a typo would make Tally create a
// second ledger.

const COMPANY_WORDS = /\b(pvt|private|limited|ltd|llp|the|m\/s)\b/g;
const GENERIC = new Set(['enterprises', 'enterprise', 'traders', 'trading', 'fashion', 'fashions', 'textile', 'textiles', 'industries', 'company', 'india', 'services', 'solutions', 'technologies', 'exports', 'fabrics', 'fabric']);

/** A name reduced to what identifies it: no case, brackets, punctuation or company suffix ("Mittal Hosiery Private Limited (Delhi)" → "mittalhosiery"). */
export const normLedger = (s) => String(s ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(COMPANY_WORDS, ' ').replace(/[^a-z0-9]/g, '');

/** The ledger a name stands for: exactly as Tally has it, or the one party ledger that is the same name spelled differently. */
export function findLedger(name, ledgers) {
  const n = String(name ?? '');
  if (!n.trim()) return null;
  const exact = ledgers.find(l => l.name === n);
  if (exact) return exact;
  const key = normLedger(n);
  if (key.length < 4) return null;
  const hits = ledgers.filter(l => l.role === 'party' && normLedger(l.name) === key);
  return hits.length === 1 ? hits[0] : null;
}

/** Up to three party ledgers that share a distinctive word with the name: "did you mean". */
export function similarLedgers(name, ledgers, limit = 3) {
  const words = String(name ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(COMPANY_WORDS, ' ').split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !GENERIC.has(w));
  if (!words.length) return [];
  return ledgers
    .filter(l => l.role === 'party' && l.name !== name)
    .map(l => ({ l, hits: words.filter(w => l.name.toLowerCase().includes(w)).length }))
    .filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.l.name.localeCompare(b.l.name))
    .slice(0, limit).map(x => x.l);
}

/** What to tell a person about the ledger name in front of them (null when it is empty). tone: ok | info | warn. */
export function ledgerNote(name, ledgers) {
  const n = String(name ?? '');
  if (!n.trim()) return null;
  const hit = ledgers.find(l => l.name === n);
  if (hit) {
    if (hit.status === 'will_rename') return { kind: 'rename', tone: 'info', text: `Agreed rename: Tally still calls it "${hit.renamed_from}". Rename it there before the first import.`, ledger: hit };
    if (hit.status === 'will_create') return { kind: 'create', tone: 'info', text: 'Agreed new ledger: create it in Tally before the first import.', ledger: hit };
    return { kind: 'tally', tone: 'ok', text: `In your Tally, under ${hit.under}.`, ledger: hit };
  }
  const near = findLedger(n, ledgers);
  if (near) return { kind: 'spelling', tone: 'warn', text: `Tally spells it "${near.name}": use that, or the export would create a second ledger.`, suggest: near.name };
  return { kind: 'missing', tone: 'warn', text: 'Not in your Tally (trial balance of 30 Sep 2026).', similar: similarLedgers(n, ledgers).map(l => l.name) };
}

/** A vendor's own ledger is acceptable when Tally has it exactly, or the person has said it is a new one to create. */
export const ledgerOk = (vendor, ledgers) => !!String(vendor.tally_ledger_name ?? '').trim() && (ledgers.some(l => l.name === vendor.tally_ledger_name) || vendor.ledger_new === true);

/** The expense ledgers Tally has, by the group they sit under, for a grouped list. A ledger already chosen is kept in the list. */
export function expenseGroups(ledgers, current = '') {
  const items = ledgers.filter(l => l.role === 'expense' || (current && l.name === current));
  const by = new Map();
  for (const l of items) by.set(l.under, [...(by.get(l.under) ?? []), l]);
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([under, list]) => ({ under, items: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** A new vendor is offered with what the invoice says: its name, the ledger Tally already has for it (when it has one), a goods invoice as a purchase and anything else as an expense. */
export function newVendorDraft(bill, ledgers = []) {
  const name = String(bill.vendor ?? '').replace(/\s+/g, ' ').trim();
  const found = findLedger(name, ledgers);
  return { name, tally_ledger_name: found ? found.name : name, gstin: bill.supplier_gstin ?? '', booking: bill.kind === 'goods' ? 'purchase' : 'expense', expense_ledger: '', ledger_new: false };
}

/** Which of the reader's own numbers a person has changed: only those are sent. */
export function changedEdits(bill, fields) {
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const out = {};
  if (String(fields.invoice_no).trim() !== String(bill.invoice_no)) out.invoice_no = String(fields.invoice_no).trim();
  if (fields.invoice_date && fields.invoice_date !== bill.invoice_date) out.invoice_date = fields.invoice_date;
  for (const [k, col] of [['taxable', 'subtotal'], ['tax', 'tax'], ['total', 'total']]) {
    const v = num(fields[k]);
    if (Number.isFinite(v) && money(v) !== money(bill[col])) out[k] = money(v);
  }
  return out;
}
