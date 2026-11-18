// Analytics → Supplier filing: the bills the ERP holds that suppliers have not filed (they are not in GSTR-2B yet), kept track of across
// months. A bill is claimable only once the supplier files it and it shows in your GSTR-2B (which is the source of truth for the credit),
// and that can be a later month than the bill's own. So every bill is checked against every GSTR-2B that has been loaded:
//
//   claimed        it is in a loaded GSTR-2B (the month is shown): nothing to chase
//   not_available  it is in GSTR-2B but marked "ITC not available" or reverse charge: look at it on the portal
//   missing        the 2B for the bill's month (or a later one) is loaded and the bill is not in it: the supplier did not file it on time
//   load           the 2B for the bill's month should exist by now (generated on the 14th of the next month) but has not been loaded: load it to check
//   not_due        the 2B for the bill's month is not generated yet: the supplier has until the 11th (13th for a quarterly filer) to file
//
// Pure functions of rows, tested without a database. Amounts are rupees to the paisa.
import { normInvoice } from './gstr2b.js';

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const ym = (d) => String(d ?? '').slice(0, 7);
const nextMonth = (m) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export const STATUS_LABEL = { claimed: 'In GSTR-2B', not_available: 'In 2B, ITC not available', missing: 'Supplier has not filed it', load: 'Load the 2B to check', not_due: 'Not due yet' };
/** Statuses that mean "the supplier has not filed it (yet)". */
export const WAITING = ['missing', 'load', 'not_due'];

/** The last day the credit can be claimed: 30 November after the end of the financial year the invoice belongs to (section 16(4)). */
export function claimBy(invoiceDate) {
  const y = Number(String(invoiceDate).slice(0, 4)), m = Number(String(invoiceDate).slice(5, 7));
  const fyStart = m >= 4 ? y : y - 1;
  return `${fyStart + 1}-11-30`;
}

const billHeads = (b) => {
  const tax = num(b.tax), t = String(b.tax_type ?? '').toUpperCase();
  if (/CGST|SGST/.test(t)) { const c = r2(tax / 2); return { igst: 0, cgst: c, sgst: r2(tax - c) }; }
  return { igst: tax, cgst: 0, sgst: 0 };
};

/**
 * @param bills      vendor_invoices rows that are not void
 * @param vendors    vendors rows (id, name, gstin)
 * @param files      [{ month, docs }]: the GSTR-2B lines kept for each month that has been loaded
 * @param followups  gstr2b_followups rows { invoice_id, action: 'reminded' | 'note', note, by_name, at }
 * @param today      'YYYY-MM-DD'
 * @param start      the first day of the books (bills dated before it are not tracked)
 */
export function buildFollowup({ bills = [], vendors = [], files = [], followups = [], today, start }) {
  const vendorById = new Map(vendors.map(v => [v.id, v]));
  const loaded = [...new Set(files.map(f => f.month))].sort();
  const byKey = new Map(), byGstin = new Map(), anyDocs = [];
  for (const f of files) for (const d of f.docs ?? []) {
    if (d.kind === 'credit_note') continue;
    const k = `${d.ctin}|${normInvoice(d.no)}`;
    byKey.set(k, [...(byKey.get(k) ?? []), { month: f.month, doc: d }]);
    anyDocs.push({ month: f.month, doc: d });
    const g = byGstin.get(d.ctin) ?? new Map();
    g.set(f.month, (g.get(f.month) ?? 0) + 1);
    byGstin.set(d.ctin, g);
  }
  const fu = new Map();
  for (const x of followups) fu.set(x.invoice_id, [...(fu.get(x.invoice_id) ?? []), x]);

  const rows = [];
  for (const b of bills) {
    if (b.status === 'void' || b.opening || !b.invoice_date || (start && b.invoice_date < start)) continue;
    const v = vendorById.get(b.vendor_id);
    const gstin = String(b.supplier_gstin || v?.gstin || '').toUpperCase() || null;
    const heads = billHeads(b);
    const tax = r2(heads.igst + heads.cgst + heads.sgst);
    const billMonth = ym(b.invoice_date);

    const hits = gstin
      ? byKey.get(`${gstin}|${normInvoice(b.invoice_no)}`) ?? []
      : anyDocs.filter(x => x.doc.kind === 'invoice' && normInvoice(x.doc.no) === normInvoice(b.invoice_no) && Math.abs(num(x.doc.igst) + num(x.doc.cgst) + num(x.doc.sgst) - tax) <= 1);
    hits.sort((a, c) => a.month.localeCompare(c.month));
    const hit = hits[0];

    const checked = loaded.filter(m => m >= billMonth);
    let status, foundMonth = null, itcNote = '';
    if (hit) {
      foundMonth = hit.month;
      status = hit.doc.itc === 'N' || hit.doc.rcm ? 'not_available' : 'claimed';
      if (status === 'not_available') itcNote = hit.doc.rcm ? 'reverse charge' : (hit.doc.reason || 'ITC not available');
    } else if (checked.length) status = 'missing';
    else status = (today && today > `${nextMonth(billMonth)}-14`) ? 'load' : 'not_due';

    // Does this supplier file at all? (other invoices of theirs in the 2B months checked)
    let supplierFiled = null;
    if (!hit && gstin && checked.length) supplierFiled = checked.reduce((n, m) => n + (byGstin.get(gstin)?.get(m) ?? 0), 0);

    const history = (fu.get(b.id) ?? []).slice().sort((a, c) => String(c.at).localeCompare(String(a.at)));
    const reminders = history.filter(x => x.action === 'reminded');
    rows.push({
      id: b.id, vendor: v?.name ?? b.vendor, vendorId: b.vendor_id ?? null, gstin, no: b.invoice_no, date: b.invoice_date, billMonth,
      taxable: r2(num(b.subtotal)), tax, heads, total: r2(num(b.total)), billStatus: b.status,
      status, foundMonth, itcNote, monthsMissing: status === 'missing' ? checked.length : 0, checkedMonths: checked,
      supplierFiled, age: today ? Math.max(0, daysBetween(b.invoice_date, today)) : null, claimBy: claimBy(b.invoice_date),
      lastReminder: reminders[0] ?? null, reminderCount: reminders.length, lastNote: history.find(x => x.action === 'note') ?? null, history,
    });
  }

  const order = { missing: 0, load: 1, not_due: 2, not_available: 3, claimed: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.date.localeCompare(b.date) || String(a.vendor).localeCompare(String(b.vendor)) || String(a.no).localeCompare(String(b.no)));

  const waiting = rows.filter(r => WAITING.includes(r.status));
  const sum = (list) => r2(list.reduce((s, r) => s + r.tax, 0));
  const summary = {
    loadedMonths: loaded,
    waiting: { count: waiting.length, tax: sum(waiting) },
    missing: { count: rows.filter(r => r.status === 'missing').length, tax: sum(rows.filter(r => r.status === 'missing')) },
    load: { count: rows.filter(r => r.status === 'load').length, tax: sum(rows.filter(r => r.status === 'load')) },
    notDue: { count: rows.filter(r => r.status === 'not_due').length, tax: sum(rows.filter(r => r.status === 'not_due')) },
    notAvailable: { count: rows.filter(r => r.status === 'not_available').length, tax: sum(rows.filter(r => r.status === 'not_available')) },
    claimed: { count: rows.filter(r => r.status === 'claimed').length, tax: sum(rows.filter(r => r.status === 'claimed')) },
    claimedLater: rows.filter(r => r.status === 'claimed' && r.foundMonth > r.billMonth).length,
    reminded: waiting.filter(r => r.reminderCount > 0).length,
  };
  return { rows, summary };
}

/** Waiting bills grouped by supplier (largest tax first), for the reminders. */
export function bySupplier(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = r.gstin || `name:${r.vendor}`;
    const x = g.get(k) ?? { key: k, vendor: r.vendor, gstin: r.gstin, rows: [], tax: 0 };
    x.rows.push(r); x.tax = r2(x.tax + r.tax);
    g.set(k, x);
  }
  return [...g.values()].sort((a, b) => b.tax - a.tax || a.vendor.localeCompare(b.vendor));
}

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (d) => { const [y, m, dd] = String(d).split('-'); return `${dd}/${m}/${y}`; };

/** A message to send a supplier about the bills of theirs that are not in the GSTR-2B. */
export function reminderText(group, ownGstin) {
  const months = [...new Set(group.rows.map(r => r.billMonth))].sort();
  const lines = group.rows.map(r => `- Invoice ${r.no} dated ${dmy(r.date)}: ${inr(r.total)} (GST ${inr(r.tax)})`);
  return [
    `Hello ${group.vendor},`,
    '',
    `The following invoice${group.rows.length === 1 ? '' : 's'} you issued to us ${group.rows.length === 1 ? 'does' : 'do'} not appear in our GSTR-2B${ownGstin ? ` (GSTIN ${ownGstin})` : ''} for ${months.map(monthName).join(' / ')}:`,
    ...lines,
    '',
    `Please file ${group.rows.length === 1 ? 'it' : 'them'} in your GSTR-1 (or IFF) now, so that we can claim the input tax credit, and let us know once ${group.rows.length === 1 ? 'it is' : 'they are'} filed.`,
    'Thank you.',
  ].join('\n');
}
