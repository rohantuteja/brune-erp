// Shared constants and pure utilities used by both the component and the data hook.

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
