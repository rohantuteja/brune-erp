import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { sortRows, inRange, clampPage, pageSizeOf } from '../lib/analyticsKit';
import { DateRange, Pagination, Collapsible, SortTh, StatCard, FilterChips, Pills, EmptyState, downloadCsv, useUrlParams, wideScreen } from '../components/AnalyticsKit';
import { RefreshCw, AlertCircle, ChevronDown, ChevronRight, Search, X, ExternalLink, Download, Info, FileText, SlidersHorizontal } from 'lucide-react';

// Analytics → Ledger. Shows the stored order ledger (ledger_orders / ledger_entries,
// written by the accounting-ledger function): which orders net to zero, which are
// still travelling, which need a person, and the documents the ERP has to issue.
// Design and rules: docs/accounting-ledger.md.

const SHOP_ADMIN = 'https://admin.shopify.com/store/supply-rethought/orders';

const URL_DEFAULTS = { lstatus: 'all', lq: '', lfrom: '', lto: '', lsort: '', ldir: '', lpage: '1', lsize: '25' };

const STATUS_FILTERS = [
  { id: 'all',             label: 'All' },
  { id: 'attention',       label: 'Needs attention' },
  { id: 'in_transit',      label: 'COD in transit' },
  { id: 'rto_on_the_way',  label: 'RTO on the way' },
  { id: 'awaiting_return', label: 'Waiting for parcel' },
  { id: 'with_courier',    label: 'COD with Velocity' },
  { id: 'needs_docs',      label: 'ERP issues a document' },
  { id: 'complete',        label: 'Complete' },
  { id: 'not_a_sale',      label: 'Not a sale' },
];

const EXCEPTION_LABEL = {
  in_transit: 'COD in transit',
  rto_on_the_way: 'RTO on the way',
  awaiting_return: 'Waiting for returned parcel',
  refund_due: 'Refund due',
  remittance_overdue: 'Velocity payment overdue',
  remittance_differs: 'Velocity paid a different amount',
  store_credit_differs: 'Store credit differs',
  unexplained_residual: 'Unexplained',
  bad_facts: 'Bad data',
};

const DOC_LABEL = {
  credit_note_goods: 'Credit note · goods',
  credit_note_cod_fee: 'Credit note · COD charge',
  retained_cod_fee_invoice: 'Invoice · retained COD charge',
  return_fee_invoice: 'Invoice · return fee',
};

const STATUS_STYLE = {
  complete:   'bg-emerald-50 text-emerald-800 border-emerald-200',
  open:       'bg-sky-50 text-sky-800 border-sky-200',
  attention:  'bg-amber-50 text-amber-900 border-amber-300',
  not_a_sale: 'bg-stone-100 text-stone-600 border-stone-200',
};

const inr = (n, digits = 0) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(`${d}T00:00:00`);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(dt.getFullYear() === new Date().getFullYear() ? {} : { year: '2-digit' }) });
};
const ago = (iso) => {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

// What the list says about one order, in one place (the table, the phone card, the CSV and the filters all use it).
const exceptionOf = (o) => (o.exceptions || [])[0];
const stateLabel = (o) => { const ex = exceptionOf(o); return ex ? EXCEPTION_LABEL[ex.type] || ex.type : o.status === 'complete' ? 'Complete' : o.status === 'not_a_sale' ? 'Not a sale' : o.status; };
const docsOf = (o) => (o.balancing || []).filter(b => b.type !== 'return_fee_invoice');
const detailOf = (o) => { const ex = exceptionOf(o); return ex ? ex.reason : o.status === 'not_a_sale' ? (o.notes || [])[0] || '' : ''; };

const IN_FILTER = {
  all: () => true,
  attention: o => o.status === 'attention',
  complete: o => o.status === 'complete',
  not_a_sale: o => o.status === 'not_a_sale',
  with_courier: o => Number(o.cod_open) > 0,
  needs_docs: o => docsOf(o).length > 0,
  in_transit: o => o.exception_type === 'in_transit',
  rto_on_the_way: o => o.exception_type === 'rto_on_the_way',
  awaiting_return: o => o.exception_type === 'awaiting_return',
};
const SORT_KEY = {
  order: o => (/^\d+$/.test(o.order_name) ? Number(o.order_name) : o.order_name),
  sold: o => o.sale_date,
  state: o => stateLabel(o),
  amount: o => Number(o.net),
};

function EntriesTable({ orderName }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    supabase.from('ledger_entries')
      .select('seq, entry_date, voucher, account, debit, credit, doc, issued_by, memo, exportable')
      .eq('order_name', orderName).order('seq')
      .then(({ data, error: err }) => {
        if (!live) return;
        if (err) setError('Could not load the entries'); else setRows(data || []);
      });
    return () => { live = false; };
  }, [orderName]);

  if (error) return <div className="text-xs text-red-700 px-3 py-2">{error}</div>;
  if (!rows) return <div className="text-xs text-stone-500 px-3 py-2">Loading entries…</div>;
  if (!rows.length) return <div className="text-xs text-stone-500 px-3 py-2">No entries.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="text-left text-stone-500 border-b border-stone-200">
            <th className="py-1.5 px-2 font-medium">Date</th>
            <th className="py-1.5 px-2 font-medium">Voucher</th>
            <th className="py-1.5 px-2 font-medium">Account</th>
            <th className="py-1.5 px-2 font-medium text-right">Debit</th>
            <th className="py-1.5 px-2 font-medium text-right">Credit</th>
            <th className="py-1.5 px-2 font-medium">From</th>
            <th className="py-1.5 px-2 font-medium">Memo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(e => (
            <tr key={e.seq} className={`border-b border-stone-100 ${e.exportable ? '' : 'text-stone-400'}`}>
              <td className="py-1 px-2 whitespace-nowrap">{fmtDate(e.entry_date)}</td>
              <td className="py-1 px-2 whitespace-nowrap">{e.voucher.replace(/_/g, ' ')}{e.doc ? <span className="font-mono text-stone-500"> {String(e.doc).split('/').pop()}</span> : null}</td>
              <td className="py-1 px-2">{e.account}</td>
              <td className="py-1 px-2 text-right tabular-nums">{Number(e.debit) ? inr(e.debit, 2) : ''}</td>
              <td className="py-1 px-2 text-right tabular-nums">{Number(e.credit) ? inr(e.credit, 2) : ''}</td>
              <td className="py-1 px-2 whitespace-nowrap">{e.issued_by.replace('_', ' ')}</td>
              <td className="py-1 px-2 text-stone-500">{e.memo}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-[11px] text-stone-400 px-2 pt-1.5">Grey lines are dated before the accounting start date: carried in, never exported.</div>
    </div>
  );
}

function StateBadge({ o }) {
  return <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[o.status]}`}>{stateLabel(o)}</span>;
}

function DetailText({ o }) {
  const ex = exceptionOf(o);
  const docs = docsOf(o);
  return (
    <>
      {detailOf(o)}
      {Number(o.cod_open) > 0 && !ex && <div className="text-stone-500 mt-0.5">With Velocity: {inr(o.cod_open, 2)} collected, not yet paid into the bank</div>}
      {docs.length > 0 && <div className="text-stone-500 mt-0.5">ERP issues: {docs.map(d => `${DOC_LABEL[d.type] || d.type} ${inr(d.amount, 2)}`).join(', ')}</div>}
    </>
  );
}

function OrderLink({ o }) {
  return (
    <a href={`${SHOP_ADMIN}/${o.order_id}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-stone-400 hover:text-stone-700" title="Open in Shopify" aria-label={`Open ${o.order_name} in Shopify`}>
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

function OrderRow({ o, open, onToggle }) {
  return (
    <>
      <tr className={`border-b border-stone-100 cursor-pointer ${open ? 'bg-stone-50' : 'hover:bg-stone-50'}`} onClick={onToggle}>
        <td className="py-2 px-2 whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown className="w-3.5 h-3.5 text-stone-400" /> : <ChevronRight className="w-3.5 h-3.5 text-stone-400" />}
            <span className="font-mono font-medium text-stone-900">{o.order_name}</span>
            <OrderLink o={o} />
          </span>
        </td>
        <td className="py-2 px-2 whitespace-nowrap text-stone-600">{fmtDate(o.sale_date)}</td>
        <td className="py-2 px-2 whitespace-nowrap"><StateBadge o={o} /></td>
        <td className="py-2 px-2 text-stone-600 text-xs min-w-[240px]"><DetailText o={o} /></td>
        <td className={`py-2 px-2 text-right tabular-nums whitespace-nowrap ${Number(o.net) < 0 ? 'text-red-700' : 'text-stone-900'}`}>{Number(o.net) ? inr(o.net, 2) : '—'}</td>
      </tr>
      {open && (
        <tr className="bg-stone-50">
          <td colSpan={5} className="px-2 pb-3 pt-1">
            <EntriesTable orderName={o.order_name} />
            {(o.notes || []).length > 0 && <div className="text-[11px] text-stone-500 px-2 pt-2">{o.notes.join(' · ')}</div>}
          </td>
        </tr>
      )}
    </>
  );
}

function OrderCard({ o, open, onToggle }) {
  return (
    <div className={`border-b border-stone-100 p-3 ${open ? 'bg-stone-50' : ''}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="w-full text-left">
        <div className="flex items-center gap-1.5">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-stone-400" /> : <ChevronRight className="w-3.5 h-3.5 text-stone-400" />}
          <span className="font-mono font-medium text-stone-900">{o.order_name}</span>
          <OrderLink o={o} />
          <span className="text-[11px] text-stone-500">{fmtDate(o.sale_date)}</span>
          <span className={`ml-auto text-sm tabular-nums ${Number(o.net) < 0 ? 'text-red-700' : 'text-stone-900'}`}>{Number(o.net) ? inr(o.net, 2) : ''}</span>
        </div>
        <div className="mt-1 pl-5"><StateBadge o={o} /></div>
        <div className="mt-1 pl-5 text-xs text-stone-600"><DetailText o={o} /></div>
      </button>
      {open && <div className="mt-2"><EntriesTable orderName={o.order_name} />{(o.notes || []).length > 0 && <div className="text-[11px] text-stone-500 px-2 pt-2">{o.notes.join(' · ')}</div>}</div>}
    </div>
  );
}

export default function LedgerSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'lpage');

  const [orders, setOrders] = useState([]);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openOrder, setOpenOrder] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: err } = await supabase.from('ledger_orders')
        .select('order_name, order_id, status, net, opening, cod_open, sale_date, exception_type, exceptions, balancing, notes, computed_at')
        .order('order_name', { ascending: false }).range(from, from + 999);
      if (err) { setError('Could not load the ledger'); showToast?.('Could not load the ledger', 'error'); setLoading(false); return; }
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: runs } = await supabase.from('ledger_runs')
      .select('id, kind, status, pos, total, error, started_at, finished_at, updated_at')
      .order('started_at', { ascending: false }).limit(1);
    setOrders(all); setRun(runs?.[0] ?? null); setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  // The dates filter says WHICH orders the page is about: the cards, counts and lists all follow it.
  const scoped = useMemo(() => orders.filter(o => o.status === 'not_a_sale' && !p.lfrom && !p.lto ? true : inRange(o.sale_date, p.lfrom, p.lto)), [orders, p.lfrom, p.lto]);

  const stats = useMemo(() => {
    const s = { complete: 0, not_a_sale: 0, in_transit: 0, rto: 0, awaiting_return: 0, attention: 0, transitAmount: 0, rtoAmount: 0, awaitingAmount: 0, attentionAmount: 0, courier: 0, courierAmount: 0, courierOverdue: 0 };
    for (const o of scoped) {
      if (Number(o.cod_open) > 0) { s.courier++; s.courierAmount += Number(o.cod_open); }
      if (o.exception_type === 'remittance_overdue') s.courierOverdue++;
      if (o.status === 'complete') s.complete++;
      else if (o.status === 'not_a_sale') s.not_a_sale++;
      else if (o.status === 'attention') { s.attention++; s.attentionAmount += Number(o.net); }
      else if (o.exception_type === 'awaiting_return') { s.awaiting_return++; s.awaitingAmount += Number(o.net); }
      else if (o.exception_type === 'rto_on_the_way') { s.rto++; s.rtoAmount += Number(o.net); }
      else if (o.exception_type === 'in_transit') { s.in_transit++; s.transitAmount += Number(o.net); }
    }
    return s;
  }, [scoped]);

  const lastComputed = useMemo(() => orders.reduce((m, o) => (!m || o.computed_at > m ? o.computed_at : m), null), [orders]);
  const attention = useMemo(() => scoped.filter(IN_FILTER.attention), [scoped]);
  const attentionOutside = orders.filter(IN_FILTER.attention).length - attention.length;

  const docs = useMemo(() => {
    const by = {};
    for (const o of scoped) for (const b of o.balancing || []) {
      const d = (by[b.type] ??= { type: b.type, orders: [], amount: 0 });
      d.orders.push(o.order_name); d.amount += Number(b.amount);
    }
    return Object.values(by).sort((a, b) => b.amount - a.amount);
  }, [scoped]);

  const q = p.lq.trim().replace(/^#/, '');
  const shown = useMemo(() => {
    const list = scoped.filter(IN_FILTER[p.lstatus] ?? IN_FILTER.all).filter(o => !q || o.order_name.includes(q));
    return p.lsort && SORT_KEY[p.lsort] ? sortRows(list, SORT_KEY[p.lsort], p.ldir === 'asc' ? 'asc' : 'desc') : list;     // the load order is newest first
  }, [scoped, p.lstatus, q, p.lsort, p.ldir]);

  const counts = useMemo(() => Object.fromEntries(STATUS_FILTERS.map(f => [f.id, scoped.filter(IN_FILTER[f.id]).length])), [scoped]);

  const size = pageSizeOf(p.lsize);
  const page = clampPage(p.lpage, shown.length, size);
  const pageRows = shown.slice((page - 1) * size, page * size);

  const onSort = (id) => setP(p.lsort === id ? { lsort: id, ldir: p.ldir === 'asc' ? 'desc' : 'asc' } : { lsort: id, ldir: id === 'order' || id === 'sold' || id === 'amount' ? 'desc' : 'asc' });
  const goTo = (status) => { setP({ lstatus: status }); setOpenOrder(null); };
  const findOrder = (name) => { setP({ lq: name, lstatus: 'all' }); setOpenOrder(name); };

  const csv = () => downloadCsv(`ledger-${p.lstatus}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Order', 'Sold', 'State', 'Detail', 'Open amount', 'COD with Velocity', 'Documents the ERP issues'],
    shown.map(o => [o.order_name, o.sale_date, stateLabel(o), detailOf(o), o.net, o.cod_open, docsOf(o).map(d => `${DOC_LABEL[d.type] || d.type} ${d.amount}`).join('; ')]));

  const chips = [
    p.lfrom || p.lto ? { key: 'date', label: `Sold ${p.lfrom ? fmtDate(p.lfrom) : 'start'} to ${p.lto ? fmtDate(p.lto) : 'today'}`, onRemove: () => setP({ lfrom: '', lto: '' }) } : null,
    p.lstatus !== 'all' ? { key: 'status', label: STATUS_FILTERS.find(f => f.id === p.lstatus)?.label || p.lstatus, onRemove: () => setP({ lstatus: 'all' }) } : null,
    p.lq ? { key: 'q', label: `Order ${p.lq}`, onRemove: () => setP({ lq: '' }) } : null,
  ].filter(Boolean);
  const clearAll = () => setP({ lfrom: '', lto: '', lstatus: 'all', lq: '' });

  const running = run?.status === 'running';
  const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';

  if (loading && !orders.length) return <div className="text-sm text-stone-500 px-1 py-6">Loading the ledger…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Order ledger</h2>
          <div className="text-[11px] text-stone-500">
            Updated {ago(lastComputed)}
            {run && <> · last run {run.status === 'running' ? `in progress (${run.pos}/${run.total})` : run.status === 'failed' ? <span className="text-red-700">failed: {run.error}</span> : `finished ${ago(run.finished_at)}`}</>}
            {running && <RefreshCw className="inline w-3 h-3 ml-1 animate-spin" />}
          </div>
        </div>
        <button onClick={load} disabled={loading} className="shrink-0 inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {orders.length === 0 && !error && <div className="bg-white rounded-lg border border-stone-200 p-4 text-sm text-stone-600">Nothing stored yet. The first sync fills this in.</div>}

      {orders.length > 0 && (
        <>
          <Collapsible id="ledger-help" title="How this page works" icon={<Info className="w-4 h-4 text-stone-400" />}>
            <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
              <li>Every order since the accounting start date, built from Shopify, Unicommerce, Return Prime and Velocity. A finished order nets to zero.</li>
              <li><b>Open amount</b> is what is still owed on the order (money to collect, or a sale still to be reversed). <b>COD with Velocity</b> is cash the courier collected and has not yet paid into the bank.</li>
              <li>Where Unicommerce's documents fall short, the ERP issues the credit note or invoice itself (<i>ERP issues a document</i>), so Tally always receives balanced orders.</li>
              <li>The date filter is the date of sale. Open an order to see its double-entry lines; grey lines are dated before the accounting start date and are never exported.</li>
            </ul>
          </Collapsible>

          <Collapsible id="ledger-scope" title="Dates" icon={<SlidersHorizontal className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen()}
            summary={p.lfrom || p.lto ? `Sold ${p.lfrom ? fmtDate(p.lfrom) : 'start'} to ${p.lto ? fmtDate(p.lto) : 'today'}` : 'All dates'}>
            <DateRange label="Sold" from={p.lfrom} to={p.lto} onChange={(f, t) => setP({ lfrom: f, lto: t })} />
          </Collapsible>

          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="Complete" value={stats.complete} sub="net to zero" tone="text-emerald-800" active={p.lstatus === 'complete'} onClick={() => goTo('complete')} />
            <StatCard label="COD in transit" value={stats.in_transit} sub={`${inr(stats.transitAmount)} due on delivery`} tone="text-sky-800" active={p.lstatus === 'in_transit'} onClick={() => goTo('in_transit')} />
            <StatCard label="RTO on the way" value={stats.rto} sub={`${inr(stats.rtoAmount)} to reverse when back`} tone="text-sky-800" active={p.lstatus === 'rto_on_the_way'} onClick={() => goTo('rto_on_the_way')} />
            <StatCard label="Waiting for parcel" value={stats.awaiting_return} sub={`${inr(stats.awaitingAmount)} refunded, goods not back`} tone="text-sky-800" active={p.lstatus === 'awaiting_return'} onClick={() => goTo('awaiting_return')} />
            <StatCard label="COD with Velocity" value={stats.courier} sub={stats.courier ? `${inr(stats.courierAmount)} collected, not yet paid in${stats.courierOverdue ? ` · ${stats.courierOverdue} overdue` : ''}` : 'nothing waiting'} tone={stats.courierOverdue ? 'text-amber-800' : 'text-sky-800'} active={p.lstatus === 'with_courier'} onClick={() => goTo('with_courier')} />
            <StatCard label="Needs attention" value={stats.attention} sub={stats.attention ? `${inr(Math.abs(stats.attentionAmount))} net` : 'nothing to do'} tone={stats.attention ? 'text-amber-800' : 'text-stone-500'} active={p.lstatus === 'attention'} onClick={() => goTo('attention')} />
          </div>

          {(attention.length > 0 || attentionOutside > 0) && (
            <Collapsible id="ledger-attention" title="Needs attention" tone="amber" defaultOpen count={attention.length}
              icon={<AlertCircle className="w-4 h-4 text-amber-700" />} summary={attention.length ? `${inr(Math.abs(stats.attentionAmount))} net` : null}>
              <div className="space-y-2">
                {attention.map(o => {
                  const ex = exceptionOf(o);
                  return (
                    <button key={o.order_name} type="button" onClick={() => findOrder(o.order_name)} className="block w-full text-left text-xs text-amber-900 hover:bg-amber-100/60 rounded px-1.5 py-1">
                      <span className="font-mono font-medium">{o.order_name}</span>{' · '}{ex ? EXCEPTION_LABEL[ex.type] || ex.type : 'check'}{ex ? ` · ${inr(Math.abs(ex.amount), 2)}` : ''}
                      {ex && <div className="text-amber-800/80 mt-0.5">{ex.reason}</div>}
                    </button>
                  );
                })}
                {attentionOutside > 0 && (
                  <div className="text-xs text-amber-900">{attentionOutside} more order{attentionOutside === 1 ? ' needs' : 's need'} attention outside these dates. <button type="button" className="underline" onClick={() => setP({ lfrom: '', lto: '', lstatus: 'attention' })}>Show all dates</button></div>
                )}
              </div>
            </Collapsible>
          )}

          {docs.length > 0 && (
            <Collapsible id="ledger-docs" title="Documents the ERP issues" icon={<FileText className="w-4 h-4 text-stone-400" />} count={docs.reduce((n, d) => n + d.orders.length, 0)}
              summary="credit notes and invoices the other systems did not produce">
              <div className="divide-y divide-stone-100">
                {docs.map(d => (
                  <div key={d.type} className="py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-stone-800">{DOC_LABEL[d.type] || d.type}</span>
                      <span className="tabular-nums text-stone-900">{d.orders.length} orders · {inr(d.amount, 2)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.orders.map(n => <button key={n} type="button" onClick={() => findOrder(n)} className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-stone-200 bg-white text-stone-600 hover:border-stone-500">{n}</button>)}
                    </div>
                  </div>
                ))}
              </div>
            </Collapsible>
          )}

          <div className="bg-white rounded-lg border border-stone-200">
            <div className="p-3 sm:p-4 space-y-3 border-b border-stone-100">
              <Pills value={p.lstatus} onChange={goTo} options={STATUS_FILTERS.map(f => ({ ...f, count: counts[f.id] }))} />
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
                  <input value={p.lq} onChange={e => setP({ lq: e.target.value })} placeholder="Order number" aria-label="Search orders" className={`${field} pl-7 pr-6 w-40`} />
                  {p.lq && <button onClick={() => setP({ lq: '' })} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>}
                </div>
                <span className="flex-1" />
                {shown.length > 0 && <button type="button" onClick={csv} className="inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500"><Download className="w-3.5 h-3.5" />CSV ({shown.length})</button>}
              </div>
              <FilterChips chips={chips} onClearAll={clearAll} />
            </div>

            <div className="p-3 sm:p-4">
              {shown.length === 0 ? (
                <EmptyState title="No orders match" hint={chips.length ? 'Nothing fits these filters.' : 'Nothing in this list.'} action={chips.length ? { label: 'Clear filters', onClick: clearAll } : null} />
              ) : (
                <>
                  <div className="hidden md:block overflow-x-auto -mx-1">
                    <table className="w-full min-w-[720px] text-sm">
                      <thead>
                        <tr className="text-xs border-b border-stone-200">
                          <SortTh label="Order" id="order" sort={p.lsort} dir={p.ldir} onSort={onSort} />
                          <SortTh label="Sold" id="sold" sort={p.lsort} dir={p.ldir} onSort={onSort} />
                          <SortTh label="State" id="state" sort={p.lsort} dir={p.ldir} onSort={onSort} />
                          <th scope="col" className="py-1.5 px-2 font-medium text-left text-stone-500">Detail</th>
                          <SortTh label="Open amount" id="amount" sort={p.lsort} dir={p.ldir} onSort={onSort} align="right" />
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map(o => <OrderRow key={o.order_name} o={o} open={openOrder === o.order_name} onToggle={() => setOpenOrder(openOrder === o.order_name ? null : o.order_name)} />)}
                      </tbody>
                    </table>
                  </div>
                  <div className="md:hidden -mx-3 sm:-mx-4 border-t border-stone-100">
                    <div className="flex justify-end px-3 py-2 text-xs">
                      <label className="inline-flex items-center gap-1.5 text-stone-600">Sort
                        <select value={p.lsort} onChange={e => setP({ lsort: e.target.value, ldir: e.target.value === 'state' ? 'asc' : 'desc' })} className={field}>
                          <option value="">Newest first</option><option value="order">Order</option><option value="sold">Sold</option><option value="state">State</option><option value="amount">Open amount</option>
                        </select></label>
                    </div>
                    {pageRows.map(o => <OrderCard key={o.order_name} o={o} open={openOrder === o.order_name} onToggle={() => setOpenOrder(openOrder === o.order_name ? null : o.order_name)} />)}
                  </div>
                  <Pagination page={page} pageSize={size} total={shown.length} noun="orders" onPage={n => setP({ lpage: n })} onPageSize={n => setP({ lsize: n })} />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
