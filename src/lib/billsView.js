// Pure helpers for Analytics → Bills: no React, no network, tested with `node --test`.

export const STATUS_LABEL = { review: 'Needs review', accepted: 'Accepted', void: 'Void' };
export const BOOKING_LABEL = { expense: 'Expense: a GST EXPENSES voucher', purchase: 'Goods purchase: a Purchase UP voucher', tie_out: 'Tie-out only: never posted' };
export const BOOKING_SHORT = { expense: 'Expense', purchase: 'Purchase', tie_out: 'Tie-out only' };

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Counts for the status cards. Opening bills (dated before the books start) are counted apart: they are matched, never exported. */
export function billSummary(bills) {
  const out = { review: 0, accepted: 0, void: 0, opening: 0, noFile: 0, reviewAmount: 0 };
  for (const b of bills) {
    out[b.status] = (out[b.status] ?? 0) + 1;
    if (b.status === 'void') continue;
    if (b.opening) out.opening++;
    if (!b.file_path) out.noFile++;
    if (b.status === 'review') out.reviewAmount = money(out.reviewAmount + Number(b.total));
  }
  return out;
}

/** The status pills, the vendor filter and the search box. The search looks at the vendor, the invoice number, the GSTIN and the amount. */
export function filterBills(bills, { status = 'review', vendor = '', q = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return bills.filter(b => {
    if (status === 'open') { if (b.status === 'void') return false; }
    else if (status === 'nofile') { if (b.status === 'void' || b.file_path) return false; }   // the "No PDF yet" card: bills still waiting for their PDF
    else if (status !== 'all' && b.status !== status) return false;
    if (vendor && String(b.vendor_id ?? '') !== vendor) return false;
    if (needle && ![b.vendor, b.invoice_no, b.supplier_gstin, String(money(b.total))].some(v => v && String(v).toLowerCase().includes(needle))) return false;
    return true;
  });
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
export function newVendorDraft(bill) {
  const name = String(bill.vendor ?? '').replace(/\s+/g, ' ').trim();
  return { name, tally_ledger_name: name, gstin: bill.supplier_gstin ?? '', booking: bill.kind === 'goods' ? 'purchase' : 'expense', expense_ledger: '' };
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
