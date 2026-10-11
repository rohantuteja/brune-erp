// Pure helpers shared by the Analytics list screens (Ledger, Shipments): paging, sorting,
// date ranges and CSV. No React, no network, so they can be tested with `node --test`.

export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;

/** Page size from a URL param: one of PAGE_SIZES, else the default. */
export function pageSizeOf(raw) {
  const n = Number(raw);
  return PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** Number of pages for `total` rows (always at least 1, so an empty list is "page 1 of 1"). */
export const pageCount = (total, size) => Math.max(1, Math.ceil(total / size));

/** Page from a URL param, clamped into 1..pages (a filter can shrink the list under the saved page). */
export function clampPage(raw, total, size) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, pageCount(total, size));
}

/** 1-based [first, last] row numbers on a page, [0, 0] for an empty list. */
export function pageSpan(page, size, total) {
  if (!total) return [0, 0];
  return [(page - 1) * size + 1, Math.min(page * size, total)];
}

/**
 * The page buttons to draw: always the first and last page and the pages around the current one,
 * with null where pages are skipped. pageWindow(5, 9) -> [1, null, 4, 5, 6, null, 9].
 */
export function pageWindow(page, pages, around = 1) {
  const keep = new Set([1, pages]);
  for (let p = page - around; p <= page + around; p++) if (p >= 1 && p <= pages) keep.add(p);
  const out = [];
  let prev = 0;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - prev === 2) out.push(prev + 1);          // a single skipped page is shown, not hidden behind a gap
    else if (p - prev > 2) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

/** True when a YYYY-MM-DD date lies in the inclusive range. Empty bounds are open; with a range set, no date means out. */
export function inRange(date, from, to) {
  if (!from && !to) return true;
  if (!date) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** A from/to pair as typed: if the user puts the end before the start, the other bound follows. */
export function normalizeRange(from, to, changed) {
  if (from && to && from > to) return changed === 'from' ? { from, to: from } : { from: to, to };
  return { from: from || '', to: to || '' };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Stable sort by a key function. Missing values (null, undefined, '') always go last,
 * whichever direction is asked for. Numbers compare as numbers, anything else as text
 * with numeric awareness ("37800" before "37801", "A2" before "A10").
 */
export function sortRows(rows, key, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return rows.map((row, i) => ({ row, i, k: key(row) })).sort((a, b) => {
    const am = a.k == null || a.k === '', bm = b.k == null || b.k === '';
    if (am || bm) return am && bm ? a.i - b.i : am ? 1 : -1;
    const c = typeof a.k === 'number' && typeof b.k === 'number' ? a.k - b.k : collator.compare(String(a.k), String(b.k));
    return c * sign || a.i - b.i;
  }).map(x => x.row);
}

/** One CSV cell: quoted when it holds a comma, quote or line break; spreadsheet formulas are defused. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  return [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
