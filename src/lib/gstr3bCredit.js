// The electronic credit ledger kept by the ERP (Analytics → GSTR-3B, section 4), so that nobody types it in each month.
//
//   October 2026 opens with the owner's Tally figure (migration 045: "GST Credit Ledger UP" at 30 Sep 2026).
//   Every later month opens with the closing credit of the previous month's return, once that return is recorded as filed.
//   A typed opening is a correction (the portal showing something else), kept as such.
//
// Pure functions of the stored rows (gstr3b_months), tested without a database.
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const HEADS = ['igst', 'cgst', 'sgst'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export function prevMonth(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function nextMonth(month) {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** A gstr3b_months row → plain numbers (null when there is no row). */
export function readRow(r) {
  if (!r) return null;
  return {
    month: r.month, source: r.source ?? 'manual', note: r.note || '', by: r.updated_by_name ?? null, at: r.updated_at ?? null,
    opening: { igst: num(r.opening_igst), cgst: num(r.opening_cgst), sgst: num(r.opening_sgst) },
    filedAt: r.filed_at ?? null, filedBy: r.filed_by_name ?? null, filed: r.filed ?? null,
    closing: r.filed_at ? { igst: num(r.closing_igst), cgst: num(r.closing_cgst), sgst: num(r.closing_sgst) } : null,
  };
}

/**
 * The credit that opens `month`, and where it came from.
 *   row   this month's stored row (readRow), if any
 *   prev  the previous month's stored row, if any
 * Returns { opening: {igst,cgst,sgst,note} | null, source: 'tally' | 'manual' | 'carried' | null, text, filed } where `filed` is this month's own
 * filed record (or null). A row that was only created by filing has the carried opening in it, so it is used as it is.
 */
export function resolveOpening({ month, row, prev }) {
  const stamp = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const filed = row?.filedAt ? { at: row.filedAt, by: row.filedBy, figures: row.filed, closing: row.closing } : null;
  if (row && (row.source === 'tally' || row.source === 'manual' || (row.source === 'carried' && row.filedAt))) {
    const text = row.source === 'tally' ? 'From your Tally trial balance (GST Credit Ledger UP, 30 Sep 2026)'
      : row.source === 'carried' ? `Carried from the ${label(prevMonth(month))} return`
      : `Entered by hand${row.by ? ` by ${row.by}` : ''}${row.at ? ` on ${stamp(row.at)}` : ''}`;
    return { opening: { ...row.opening, note: row.note }, source: row.source, text, filed };
  }
  if (prev?.filedAt && prev.closing) {
    return { opening: { ...prev.closing, note: '' }, source: 'carried', text: `Carried from the ${label(prev.month)} return you filed on ${stamp(prev.filedAt)}`, filed };
  }
  return { opening: null, source: null, text: prev ? `The ${label(prev.month)} return is not recorded as filed, so its closing credit cannot be carried forward yet` : 'No opening credit', filed };
}

/** What is kept when the owner records the month's return as filed with the figures on the screen. */
export function filedSnapshot(r, { opening, source, twoBFile }) {
  const P = r.payment;
  return {
    payload: {
      opening: { igst: P.opening.igst, cgst: P.opening.cgst, sgst: P.opening.sgst }, source: source || 'manual',
      closing: { ...P.closing },
      filed: {
        outward: { taxable: r.outward.taxable, igst: r.outward.igst, cgst: r.outward.cgst, sgst: r.outward.sgst },
        liability: { ...P.liability }, claim: { ...P.claim }, used: P.used, cash: { ...P.cash }, cashTotal: P.cashTotal, closing: { ...P.closing },
        basis: r.itc.basis, twoB: twoBFile ? { file: twoBFile.fileName ?? null, lines: (twoBFile.docs ?? []).length } : null,
        tcs: r.tcs.tcs, openingSource: source || null,
      },
    },
    opening,
  };
}

/** The figures that differ between what was filed and what the screen works out now (a late credit note, a bill accepted later, ...). */
export function changedSinceFiled(filed, r) {
  if (!filed) return [];
  const out = [];
  const cmp = (what, was, now) => { for (const k of HEADS) if (Math.abs(num(was?.[k]) - num(now?.[k])) > 1) out.push({ what, head: k, was: r2(num(was?.[k])), now: r2(num(now?.[k])) }); };
  cmp('Tax on sales', filed.liability, r.payment.liability);
  cmp('Credit claimed', filed.claim, r.payment.claim);
  return out;
}
