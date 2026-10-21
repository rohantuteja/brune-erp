// Analytics → Myntra: which rows of public.myntra_fulfilments (written by the myntra-fulfil function) belong to which list.
// Pure, so the lists and their counts are tested (myntraView.test.js).

export const STATUS_TEXT = {
  held: 'Waiting for Myntra',
  invoiced: 'Invoiced, to dispatch',
  dispatched: 'Dispatched',
  failed: 'Failed, will retry',
  attention: 'Needs a person',
  working: 'In progress',
  cancelled: 'Cancelled',
};

// A label is "to print" once the package is invoiced or dispatched and nobody has marked it printed. It does not matter who
// invoiced it: a package a person invoiced on the dashboard is dispatched by the job within minutes, before it can be printed
// from the dashboard's Ready to Ship list, so its label is fetched from Unicommerce when the PDF is made.
export const needsPrint = (r) => !r.printed_at && (r.status === 'invoiced' || r.status === 'dispatched');

export const VIEW_TEST = {
  print: needsPrint,
  waiting: (r) => r.status === 'held',
  dispatch: (r) => r.status === 'invoiced',
  attention: (r) => r.status === 'failed' || r.status === 'attention',
  today: (r, today) => !!r.dispatched_at && localDay(r.dispatched_at) === today,
  all: () => true,
};

// The calendar day of an instant in the browser's time zone (IST for the team), as YYYY-MM-DD.
export function localDay(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function viewCounts(rows, today) {
  const out = {};
  for (const id of Object.keys(VIEW_TEST)) out[id] = rows.filter(r => VIEW_TEST[id](r, today)).length;
  return out;
}

export function filterRows(rows, view, query, today) {
  const q = String(query || '').trim().toLowerCase();
  const test = VIEW_TEST[view] ?? VIEW_TEST.all;
  return rows.filter(r => test(r, today) && (!q || [r.package_code, r.invoice_display, r.tracking_number, r.manifest_code, r.sale_order_code]
    .some(v => String(v ?? '').toLowerCase().includes(q))));
}

// Oldest label first: the order the PDF is printed in.
export const printQueue = (rows) => rows.filter(needsPrint).sort((a, b) => String(a.invoiced_at).localeCompare(String(b.invoiced_at)));
