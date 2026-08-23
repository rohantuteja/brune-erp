// Shared constants and pure utilities used by both the component and the data hook.

/**
 * Returns true if a run is "active" — meaning it still has open work:
 *   1. Any size has cuttings still available to issue (cut > total issued), OR
 *   2. Any production batch is not yet marked complete.
 *
 * A run is inactive ONLY when every cut piece has been issued AND every
 * production batch has been marked complete.
 */
export function isRunActive(run, productionBatches) {
  const batches = productionBatches.filter(b => b.run_id === run.id);
  // Condition 2: any batch still in progress
  if (batches.some(b => b.status !== 'completed')) return true;
  // Condition 1: any size still has cuttings available
  const issuedBySize = {};
  batches.forEach(b => {
    Object.entries(b.issued_sizes || {}).forEach(([size, qty]) => {
      issuedBySize[size] = (issuedBySize[size] || 0) + (parseInt(qty) || 0);
    });
  });
  return run.pieces.some(p => p.quantity > (issuedBySize[p.size] || 0));
}


export const STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL'];

/**
 * Classify a completed batch's Shopify sync state → 'synced' | 'partial' | 'not_synced'.
 * Single source of truth for the batch card badge, the sync filter, and the
 * retry logic — so the label, the filter, and "what counts as failed" never diverge.
 */
export function getBatchSyncStatus(batch) {
  const adj = batch.shopify_adjustment;
  if (!adj || (adj.adjusted?.length === 0 && (adj.failed?.length > 0 || adj.skipped?.length > 0))) return 'not_synced';
  if (adj.status === 'partial') return 'partial';
  return 'synced';
}

/** Formats a Date as YYYY-MM-DD in LOCAL time (not UTC). */
export const localDate = (d) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/** Returns today's date as YYYY-MM-DD in LOCAL time (not UTC). */
export const localToday = () => localDate(new Date());

/** Inclusive first/last day of a YYYY-MM month, as YYYY-MM-DD strings. */
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);        // m is 1-based
  return { from: `${ym}-01`, to: localDate(new Date(y, m, 0)) };  // day 0 = last day of prev month
}

/**
 * Resolves a named date-range preset to inclusive { from, to } YYYY-MM-DD strings.
 * Empty strings mean "no bound" (all time). Single source of truth for the preset
 * date maths, which was previously inlined in the Analytics date filter.
 *
 * Uses the `new Date(y, m + delta, 1)` form rather than `setMonth()` then `setDate(1)`:
 * the latter overflows on month-end days (on 31 Jul, setMonth(-3) lands on 31 Apr → 1 May,
 * so "Last 3 months" silently became "Last 2 months").
 */
export function presetRange(key) {
  const today = localToday();
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();   // m is 0-based
  switch (key) {
    case 'today':     return { from: today, to: today };
    case '7d':        return { from: localDate(new Date(y, m, now.getDate() - 6)),  to: today };
    case '30d':       return { from: localDate(new Date(y, m, now.getDate() - 29)), to: today };
    case 'mtd':       return { from: localDate(new Date(y, m, 1)), to: today };
    case 'lastmonth': return monthRange(localDate(new Date(y, m - 1, 1)).slice(0, 7));
    case '3m':        return { from: localDate(new Date(y, m - 3, 1)), to: today };
    case 'all':
    default:          return { from: '', to: '' };
  }
}

/**
 * Elapsed calendar days from issue to completion, floored at 1 (same-day = 1 day).
 * Returns null when either date is missing.
 *
 * Single source of truth: the Analytics summary previously used Math.max(1, days)
 * while Karigar Performance used Math.max(1, days) + 1, so the same batch reported
 * different turnaround on two screens.
 */
export function batchTurnaroundDays(batch) {
  if (!batch?.issued_date || !batch?.completed_date) return null;
  const ms = new Date(batch.completed_date + 'T00:00:00') - new Date(batch.issued_date + 'T00:00:00');
  return Math.max(1, Math.round(ms / 86400000));
}

/**
 * Attributes a batch's pieces to its karigars by EQUAL SPLIT.
 *
 * ⚠️ ATTRIBUTED, NOT MEASURED. Several karigars work one batch and the system does
 * not record who stitched what, so this is an even division rather than observed
 * output. Any UI built on this must say "attributed", never "produced".
 *
 * Returns [{ id, name, pieces }] with `pieces` as a FLOAT — round only at display
 * time so per-karigar figures stay reconcilable against the batch total. A batch
 * with no karigars yields a single 'Unassigned' row so pieces are never dropped.
 */
export function attributeBatch(batch, field = 'completed_qty') {
  const ids = batch?.karigar_ids || [];
  const total = batch?.[field] || 0;
  if (ids.length === 0) return total > 0 ? [{ id: 0, name: 'Unassigned', pieces: total }] : [];
  const share = total / ids.length;
  return ids.map((id, i) => ({ id, name: batch.karigar_names?.[i] || `Karigar ${id}`, pieces: share }));
}

/**
 * Sorts an array of size objects { size, ... } so that standard sizes
 * appear first in canonical order (XS→XL), then any custom sizes alphabetically.
 */
export function orderSizes(arr) {
  return [...arr].sort((a, b) => {
    const ai = STANDARD_SIZES.indexOf(a.size);
    const bi = STANDARD_SIZES.indexOf(b.size);
    if (ai === -1 && bi === -1) return a.size.localeCompare(b.size);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}
