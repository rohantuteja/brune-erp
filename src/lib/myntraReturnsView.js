// What the Myntra returns panel shows (Analytics → Myntra → Myntra returns): the four boxes are views, and "Pieces with a return open" is the
// list of returns still on their way (myntra_open_returns, kept by the myntra-returns function). Pure functions so they can be tested.

const DAY_MS = 86_400_000;

export const VIEWS = ['received', 'person', 'failed', 'open'];

/** A view from the URL, or null for anything else. */
export const parseView = (v) => (VIEWS.includes(v) ? v : null);

/**
 * Which view opens first: what a person must look at, else what failed, else what was received. A view chosen on purpose
 * (it is in the URL) always wins, so someone looking at the open list is not thrown elsewhere.
 */
export function defaultView(chosen, { person = 0, failed = 0 } = {}) {
  return parseView(chosen) ?? (person > 0 ? 'person' : failed > 0 ? 'failed' : 'received');
}

/** The returns the job could not finish by itself, split the way the two boxes count them. */
export function splitAttention(rows) {
  const list = rows ?? [];
  return {
    person: list.filter(r => r.status === 'attention' || r.status === 'unverified'),
    failed: list.filter(r => r.status === 'failed'),
  };
}

// What Myntra's tracking says. Anything not listed is shown as Myntra wrote it, made readable.
const TRACKING_TEXT = {
  CIR_COURIER_ASSIGNED: 'Pickup arranged',
  RTO_INITIATED: 'On its way back',
  STATUS_NOT_DEFINED: 'No status from Myntra yet',
  CIR_DELIVERED_TO_SELLER: 'Back with us, being received',
  RTO_DELIVERED_TO_SELLER: 'Back with us, being received',
};

export function trackingText(code) {
  if (!code) return 'No status from Myntra yet';
  return TRACKING_TEXT[code] ?? String(code).replace(/_/g, ' ').toLowerCase();
}

/** Whole days since an ISO time, or null when it is not known. */
export function ageDays(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

/** How worried to look about a return that has been out this long: 14 days is a reason to ask Myntra, 30 is overdue. */
export function ageTone(days) {
  if (days == null) return 'unknown';
  if (days >= 30) return 'red';
  if (days >= 14) return 'amber';
  return 'normal';
}

export const ageLabel = (days) => (days == null ? '—' : days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`);

export const OPEN_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'customer', label: 'Customer pickups' },
  { id: 'rto', label: 'RTOs' },
  { id: 'late', label: '14+ days' },
];
export const parseFilter = (v) => (OPEN_FILTERS.some(f => f.id === v) ? v : 'all');

const isLate = (r, nowMs) => (ageDays(r.opened_at, nowMs) ?? -1) >= 14;

export function openCounts(rows, nowMs) {
  const list = rows ?? [];
  return {
    all: list.length,
    customer: list.filter(r => r.kind === 'customer').length,
    rto: list.filter(r => r.kind === 'rto').length,
    late: list.filter(r => isLate(r, nowMs)).length,
  };
}

export function filterOpen(rows, filter, nowMs) {
  const list = rows ?? [];
  switch (filter) {
    case 'customer': return list.filter(r => r.kind === 'customer');
    case 'rto': return list.filter(r => r.kind === 'rto');
    case 'late': return list.filter(r => isLate(r, nowMs));
    default: return list;
  }
}

/** Oldest first: the ones to chase come first. A return whose date is not known yet goes last, then by code so the order is stable. */
export function sortOpen(rows) {
  return [...(rows ?? [])].sort((a, b) => {
    const ta = a.opened_at ? Date.parse(a.opened_at) : Infinity;
    const tb = b.opened_at ? Date.parse(b.opened_at) : Infinity;
    return ta - tb || String(a.return_code).localeCompare(String(b.return_code));
  });
}

/** Pieces on a set of returns (a return with no SKU on record still counts as one). */
export const pieceCount = (rows) => (rows ?? []).reduce((n, r) => n + Math.max(1, (r.skus ?? []).length), 0);

/**
 * The ledger's view of each order, by Unicommerce order code: its invoice number (what Myntra and the ledger call the order)
 * and what the ledger still shows as owed on it.
 */
export function ledgerByOrder(ledgerRows) {
  return new Map((ledgerRows ?? []).map(l => [String(l.channel_ref), { name: l.order_name, open: Number(l.net) || 0 }]));
}
