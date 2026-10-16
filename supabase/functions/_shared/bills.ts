// The rules behind Analytics → Bills: which vendor an invoice belongs to, whether it can be accepted without a person, what a bill
// row looks like, what a person may correct, and what a vendor profile must have. Pure rules, no network: the bills-import function
// reads and writes the tables and hands the data in. The invoice itself is read by invoice-reader.ts.

import { gstinChecksumOk, panOf, parseInvoiceDate, type Check, type ReadInvoice } from './invoice-reader.ts';

export type Booking = 'expense' | 'purchase' | 'tie_out';
export const BOOKINGS: Booking[] = ['expense', 'purchase', 'tie_out'];
export type Vendor = {
  id: number; name: string; tally_ledger_name: string; gstin: string | null; pan: string | null; state_code: string | null;
  booking: Booking; expense_ledger: string | null; auto_accept: boolean; active: boolean;
  ledger_new?: boolean;   // its own ledger is not in Tally yet: the export creates it
};
/** The ledgers that exist in Tally (tally_ledgers, from the trial balance): which can take an expense, and every one there is. */
export type LedgerBook = { expense: Set<string>; known: Set<string> };
export const READER_VERSION = 'invoice-reader 2026-10-15';

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A name reduced to what identifies it: no case, punctuation or company suffix ("Goexcelsior Private Limited" → "goexcelsior"). */
export const normName = (s: string) => s.toLowerCase().replace(/\b(pvt|private|limited|ltd|llp|the|m\/s)\b/g, '').replace(/[^a-z0-9]/g, '');

// ── Whose invoice is it ──────────────────────────────────────────────────────────────────────
/**
 * By GSTIN, which is exact. A vendor that has no GSTIN yet (it was set up from a card statement, before any invoice) is found by name,
 * and its GSTIN is learned when the first bill is confirmed. A vendor whose GSTIN differs is never matched by name: another
 * registration of the same company is for a person to say.
 */
export function matchVendor(vendors: Vendor[], inv: ReadInvoice): { vendor: Vendor | null; by: 'gstin' | 'name' | null } {
  const live = vendors.filter(v => v.active);
  const g = inv.supplier.gstin;
  const byGstin = g ? live.find(v => v.gstin === g) : undefined;
  if (byGstin) return { vendor: byGstin, by: 'gstin' };
  const n = inv.supplier.name ? normName(inv.supplier.name) : '';
  if (n.length >= 4) {
    const byName = live.filter(v => !v.gstin && (normName(v.name) === n || normName(v.tally_ledger_name) === n || n.includes(normName(v.name)) && normName(v.name).length >= 4));
    if (byName.length === 1) return { vendor: byName[0], by: 'name' };
  }
  return { vendor: null, by: null };
}

// ── Can it be accepted without a person ──────────────────────────────────────────────────────
export type Decision = { status: 'accepted' | 'review'; reasons: string[] };

export function vendorProblems(v: Pick<Vendor, 'name' | 'tally_ledger_name' | 'gstin' | 'pan' | 'state_code' | 'booking' | 'expense_ledger' | 'ledger_new'>, book: LedgerBook): string[] {
  const out: string[] = [];
  if (!v.name?.trim()) out.push('the vendor needs a name');
  if (!v.tally_ledger_name?.trim()) out.push("the vendor needs the name of its own ledger in Tally");
  // A ledger name that Tally does not have would make the export create a second ledger: a person picks the real one, or says it is new.
  else if (!book.known.has(v.tally_ledger_name) && !v.ledger_new) out.push(`"${v.tally_ledger_name}" is not a ledger in your Tally: choose it from the list, or say that it is a new ledger to create`);
  if (!BOOKINGS.includes(v.booking)) out.push('choose how the vendor is booked: expense, purchase or tie-out only');
  if (v.booking === 'expense' && !(v.expense_ledger && book.expense.has(v.expense_ledger))) out.push('an expense vendor needs an expense ledger (choose one from the list)');
  if (v.gstin) {
    if (!gstinChecksumOk(v.gstin)) out.push(`${v.gstin} is not a valid GSTIN`);
    else {
      if (v.pan && v.pan !== panOf(v.gstin)) out.push(`the PAN ${v.pan} is not the one inside the GSTIN (${panOf(v.gstin)})`);
      if (v.state_code && v.state_code !== v.gstin.slice(0, 2)) out.push(`state code ${v.state_code} is not the one in the GSTIN (${v.gstin.slice(0, 2)})`);
    }
  }
  return out;
}

/**
 * accepted: nothing needs a person's eyes: the invoice read and every check passed, the vendor is known with a complete booking, and
 * the owner has already confirmed one bill of it. review: anything else, with the reasons in plain words.
 */
export function decide(inv: ReadInvoice, vendor: Vendor | null, book: LedgerBook): Decision {
  const reasons: string[] = [];
  if (!vendor) reasons.push('A new vendor: say once how it is booked, and this bill is accepted');
  else {
    const problems = vendorProblems(vendor, book);
    if (problems.length) reasons.push(`${vendor.name}'s booking is incomplete: ${problems.join('; ')}`);
    else if (!vendor.auto_accept) reasons.push(`The first bill from ${vendor.name}: confirm it once, and the next ones are accepted when every check passes`);
    if (vendor.booking === 'purchase' && inv.kind === 'service') reasons.push(`${vendor.name} is booked as a goods purchase but this invoice has a service code`);
    if (vendor.booking === 'expense' && inv.kind === 'goods') reasons.push(`${vendor.name} is booked as an expense but this invoice carries goods codes (HSN)`);
  }
  for (const c of inv.checks) if (!c.ok) reasons.push(c.detail);
  return { status: reasons.length ? 'review' : 'accepted', reasons };
}

// ── The row ──────────────────────────────────────────────────────────────────────────────────
export type FileInfo = { path: string; hash: string; name: string };

/** A bill as vendor_invoices stores it; null when the invoice could not be read well enough to store (no number, no amounts). */
export function billRow(inv: ReadInvoice, o: { vendor: Vendor | null; vendorName: string; companyGstin: string; file: FileInfo; status: 'accepted' | 'review'; booksStart: string }): Record<string, unknown> | null {
  if (!inv.invoice_no || inv.taxable === null || inv.tax === null || inv.total === null) return null;
  return {
    vendor: o.vendorName, vendor_id: o.vendor?.id ?? null,
    invoice_no: inv.invoice_no, invoice_date: inv.invoice_date,
    period: inv.period, period_from: inv.period_from, period_to: inv.period_to,
    subtotal: inv.taxable, tax: inv.tax, total: inv.total, tax_type: inv.tax_type ?? 'IGST', tax_rate: inv.tax_rate, round_off: inv.round_off,
    place_of_supply: inv.place_of_supply, irn: inv.irn, kind: inv.kind, status: o.status,
    opening: !!inv.invoice_date && inv.invoice_date < o.booksStart,
    supplier_gstin: inv.supplier.gstin, bill_to_gstin: inv.buyer_gstin ? o.companyGstin : null,
    checks: inv.checks, reader: READER_VERSION, source: 'upload',
    file_path: o.file.path, file_hash: o.file.hash, file_name: o.file.name,
    // the Velocity page reads these lines: it wants a SAC and a description, and has no use for the rest
    lines: inv.lines.map(l => ({ sac: l.hsn, description: l.description, amount: l.amount, hsn: l.hsn, qty: l.qty, unit: l.unit, rate: l.rate })),
  };
}

// ── What a person may correct ────────────────────────────────────────────────────────────────
export type Edits = Partial<{ invoice_no: string; invoice_date: string; taxable: number; tax: number; total: number }>;
type Figures = { invoice_no: string; invoice_date: string | null; subtotal: number; tax: number; total: number };

/**
 * The invoice number, the date and the three amounts can be corrected; nothing else. The amounts must still agree (taxable + GST =
 * total within a rupee of rounding), so a correction can fix a misread digit but never make a bill that does not add up.
 */
export function applyEdits(row: Figures, edits: Edits): { ok: true; values: Figures; edited: Record<string, { read: unknown; now: unknown }>; fixed: string[] } | { ok: false; error: string } {
  const values: Figures = { ...row };
  const edited: Record<string, { read: unknown; now: unknown }> = {};
  const fixed: string[] = [];
  if (edits.invoice_no !== undefined) {
    const no = String(edits.invoice_no).trim();
    if (!no || no.length > 40) return { ok: false, error: 'the invoice number is empty or too long' };
    if (no !== row.invoice_no) { values.invoice_no = no; edited.invoice_no = { read: row.invoice_no, now: no }; fixed.push('invoice_number'); }
  }
  if (edits.invoice_date !== undefined) {
    const d = parseInvoiceDate(String(edits.invoice_date));
    if (!d) return { ok: false, error: 'the invoice date is not a real date' };
    if (d !== row.invoice_date) { values.invoice_date = d; edited.invoice_date = { read: row.invoice_date, now: d }; fixed.push('invoice_date'); }
  }
  for (const [field, col] of [['taxable', 'subtotal'], ['tax', 'tax'], ['total', 'total']] as const) {
    const v = edits[field];
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `the ${field === 'tax' ? 'GST' : field} amount is not a valid amount` };
    if (r2(v) !== r2(row[col])) { values[col] = r2(v); edited[field] = { read: row[col], now: r2(v) }; if (!fixed.includes('amounts')) fixed.push('amounts'); }
  }
  if (fixed.includes('amounts') && Math.abs(r2(values.subtotal + values.tax - values.total)) > 1) {
    return { ok: false, error: `taxable ${money(values.subtotal)} + GST ${money(values.tax)} is ${money(r2(values.subtotal + values.tax))}, not the total ${money(values.total)}: they must agree to within ₹1 of rounding` };
  }
  return { ok: true, values, edited, fixed };
}

/** The checks after a person corrected a field: the check of that field now passes, saying who fixed it. */
export function recheck(checks: Check[], fixed: string[], by: string): Check[] {
  return checks.map(c => (fixed.includes(c.id) ? { ...c, ok: true, detail: `${c.id.replace('_', ' ')} corrected by ${by}` } : c));
}

/** What to offer when a bill belongs to a vendor the ERP does not know yet: everything the invoice says about it. */
export function newVendorFrom(inv: ReadInvoice): Pick<Vendor, 'name' | 'tally_ledger_name' | 'gstin' | 'pan' | 'state_code' | 'booking' | 'expense_ledger'> {
  const name = (inv.supplier.name ?? '').replace(/\s+/g, ' ').trim();
  return { name, tally_ledger_name: name, gstin: inv.supplier.gstin, pan: inv.supplier.pan, state_code: inv.supplier.state_code, booking: inv.kind === 'goods' ? 'purchase' : 'expense', expense_ledger: null };
}

/** Where the original goes in the vendor-bills bucket: by the month it was uploaded and the file's own fingerprint, so one file is stored once. */
export const storagePath = (uploadedOn: string, hash: string) => `bills/${uploadedOn.slice(0, 7)}/${hash}.pdf`;
