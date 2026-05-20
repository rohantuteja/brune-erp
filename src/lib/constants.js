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

/** Returns today's date as YYYY-MM-DD in LOCAL time (not UTC). */
export const localToday = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

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
