import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { usePermissions } from '../contexts/PermissionsContext';
import { refreshLedger, progressText, doneText } from '../lib/ledgerRefresh';
import { sortRows, inRange, clampPage, pageSizeOf } from '../lib/analyticsKit';
import { DateRange, Pagination, Collapsible, SortTh, StatCard, FilterChips, Pills, EmptyState, downloadCsv, useUrlParams, wideScreen } from '../components/AnalyticsKit';
import { RefreshCw, AlertCircle, ChevronDown, ChevronRight, Search, X, ExternalLink, Download, Info, FileText, SlidersHorizontal, Clock, RotateCcw } from 'lucide-react';

// Analytics → Ledger. Shows the stored order ledger (ledger_orders / ledger_entries,
// written by the accounting-ledger function): which orders net to zero, which are
// still travelling, which need a person, and the documents the ERP has to issue.
// Shopify and Myntra orders share the list (Myntra orders come from Unicommerce, are named by their invoice number and
// are invoiced to the end customer; Myntra collects the payment and pays us later); the Channel filter separates them.
// Design and rules: docs/accounting-ledger.md.

const SHOP_ADMIN = 'https://admin.shopify.com/store/supply-rethought/orders';

const URL_DEFAULTS = { lstatus: 'all', lchan: 'all', lq: '', lfrom: '', lto: '', lsort: '', ldir: '', lpage: '1', lsize: '25' };

const CHANNELS = [
  { id: 'all',     label: 'All channels' },
  { id: 'shopify', label: 'Shopify' },
  { id: 'myntra',  label: 'Myntra' },
];
const channelOf = (o) => o.channel || 'shopify';
const SHOPIFY_ONLY = new Set(['in_transit', 'rto_on_the_way', 'with_courier', 'awaiting_payout']);       // COD, courier and gateway states a Myntra order never has

const STATUS_FILTERS = [
  { id: 'all',             label: 'All' },
  { id: 'attention',       label: 'Needs attention' },
  { id: 'waiting_invoice', label: 'Waiting for invoice' },
  { id: 'in_transit',      label: 'COD in transit' },
  { id: 'rto_on_the_way',  label: 'RTO on the way' },
  { id: 'awaiting_return', label: 'Waiting for parcel' },
  { id: 'awaiting_settlement', label: 'Awaiting Myntra payment' },
  { id: 'awaiting_payout', label: 'Awaiting GoKwik payout' },
  { id: 'with_courier',    label: 'COD with Velocity' },
  { id: 'needs_docs',      label: 'ERP issues a document' },
  { id: 'complete',        label: 'Complete' },
  { id: 'not_a_sale',      label: 'Not a sale' },
];

const EXCEPTION_LABEL = {
  in_transit: 'COD in transit',
  rto_on_the_way: 'RTO on the way',
  awaiting_return: 'Waiting for returned parcel',
  awaiting_settlement: 'Awaiting Myntra payment',
  awaiting_payout: 'Awaiting GoKwik payout',
  payout_missing: 'Not in GoKwik report',
  payout_differs: 'GoKwik paid a different amount',
  refund_due: 'Refund due',
  remittance_overdue: 'Velocity payment overdue',
  remittance_differs: 'Velocity paid a different amount',
  store_credit_differs: 'Store credit differs',
  unexplained_residual: 'Unexplained',
  bad_facts: 'Bad data',
  no_state: 'No state on the order',
  cancelled_after_payment: 'Cancelled but paid',
  refund_not_booked: 'Refund not in the ledger',
  invoice_overdue: 'Invoice overdue',
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
  waiting_invoice: 'bg-white text-stone-600 border-stone-300 border-dashed',
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
const stateLabel = (o) => { const ex = exceptionOf(o); return ex ? EXCEPTION_LABEL[ex.type] || ex.type : o.status === 'complete' ? 'Complete' : o.status === 'not_a_sale' ? 'Not a sale' : o.status === 'waiting_invoice' ? 'Waiting for invoice' : o.status; };
const MODE_LABEL = { prepaid: 'paid in full', 'part paid': 'part paid', cod: 'cash on delivery', marketplace: 'Myntra collects' };
const daysSince = (d) => (d ? Math.max(0, Math.round((Date.now() - Date.parse(`${d}T00:00:00`)) / 864e5)) : 0);
// A Myntra order waiting for its invoice has no invoice number yet and is named by its long Unicommerce code: show the end of it.
const nameOf = (o) => (channelOf(o) === 'myntra' && o.status === 'waiting_invoice' && o.order_name.length > 20 ? `…${o.order_name.slice(-8)}` : o.order_name);
const waitingText = (o) => {
  const w = o.waiting || {};
  const days = daysSince(o.sale_date);
  return `${inr(w.amount)} ordered${w.mode ? `, ${MODE_LABEL[w.mode] || w.mode}` : ''} · ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`} · no invoice yet, nothing is booked`;
};
const docsOf = (o) => (o.balancing || []).filter(b => b.type !== 'return_fee_invoice');
const detailOf = (o) => { const ex = exceptionOf(o); return ex ? ex.reason : o.status === 'not_a_sale' ? (o.notes || [])[0] || '' : o.status === 'waiting_invoice' ? waitingText(o) : ''; };

const IN_FILTER = {
  all: () => true,
  attention: o => o.status === 'attention',
  complete: o => o.status === 'complete',
  not_a_sale: o => o.status === 'not_a_sale',
  waiting_invoice: o => o.status === 'waiting_invoice',
  with_courier: o => Number(o.cod_open) > 0,
  needs_docs: o => docsOf(o).length > 0,
  in_transit: o => o.exception_type === 'in_transit',
  rto_on_the_way: o => o.exception_type === 'rto_on_the_way',
  awaiting_return: o => o.exception_type === 'awaiting_return',
  awaiting_settlement: o => o.exception_type === 'awaiting_settlement',
  awaiting_payout: o => (o.exceptions || []).some(e => e.type === 'awaiting_payout'),
};
const SORT_KEY = {
  order: o => (/^\d+$/.test(o.order_name) ? Number(o.order_name) : o.order_name),
  sold: o => o.sale_date,
  state: o => stateLabel(o),
  ships: o => o.state || '',
  amount: o => Number(o.net),
};

function EntriesTable({ orderName, waiting = false }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (waiting) return undefined;
    let live = true;
    supabase.from('ledger_entries')
      .select('seq, entry_date, voucher, account, debit, credit, doc, issued_by, memo, exportable, part, qty')
      .eq('order_name', orderName).order('seq')
      .then(({ data, error: err }) => {
        if (!live) return;
        if (err) setError('Could not load the entries'); else setRows(data || []);
      });
    return () => { live = false; };
  }, [orderName, waiting]);

  if (waiting) return <div className="text-xs text-stone-600 px-3 py-2">Waiting for Unicommerce to issue the invoice. Nothing is booked and nothing is exported until it does; the sale is then booked on the order date.</div>;
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
              <td className="py-1 px-2 text-stone-500">{e.memo}{e.part ? ` · ${e.part.replace('_', ' ')}` : ''}{e.qty != null ? ` · ${Number(e.qty)} pc` : ''}</td>
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

function ChannelTag({ o }) {
  return channelOf(o) === 'myntra' ? <span className="text-[10px] px-1 py-px rounded border border-stone-300 bg-stone-100 text-stone-700">Myntra</span> : null;
}

function OrderLink({ o }) {
  if (channelOf(o) !== 'shopify' || o.order_id == null) return null;      // a Myntra order has no Shopify page
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
            <span className="font-mono font-medium text-stone-900" title={o.order_name}>{nameOf(o)}</span>
            <ChannelTag o={o} />
            <OrderLink o={o} />
          </span>
        </td>
        <td className="py-2 px-2 whitespace-nowrap text-stone-600">{fmtDate(o.sale_date)}</td>
        <td className="py-2 px-2 whitespace-nowrap"><StateBadge o={o} /></td>
        <td className="py-2 px-2 whitespace-nowrap text-xs text-stone-600">{o.state || <span className="text-red-700">none</span>}</td>
        <td className="py-2 px-2 text-stone-600 text-xs min-w-[240px]"><DetailText o={o} /></td>
        <td className={`py-2 px-2 text-right tabular-nums whitespace-nowrap ${Number(o.net) < 0 ? 'text-red-700' : 'text-stone-900'}`}>{Number(o.net) ? inr(o.net, 2) : '—'}</td>
      </tr>
      {open && (
        <tr className="bg-stone-50">
          <td colSpan={6} className="px-2 pb-3 pt-1">
            <EntriesTable orderName={o.order_name} waiting={o.status === 'waiting_invoice'} />
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
          <span className="font-mono font-medium text-stone-900" title={o.order_name}>{nameOf(o)}</span>
          <ChannelTag o={o} />
          <OrderLink o={o} />
          <span className="text-[11px] text-stone-500">{fmtDate(o.sale_date)}</span>
          <span className={`ml-auto text-sm tabular-nums ${Number(o.net) < 0 ? 'text-red-700' : 'text-stone-900'}`}>{Number(o.net) ? inr(o.net, 2) : ''}</span>
        </div>
        <div className="mt-1 pl-5 flex items-center gap-2"><StateBadge o={o} /><span className="text-[11px] text-stone-500">{o.state ? `ships to ${o.state}` : <span className="text-red-700">no state</span>}</span></div>
        <div className="mt-1 pl-5 text-xs text-stone-600"><DetailText o={o} /></div>
      </button>
      {open && <div className="mt-2"><EntriesTable orderName={o.order_name} waiting={o.status === 'waiting_invoice'} />{(o.notes || []).length > 0 && <div className="text-[11px] text-stone-500 px-2 pt-2">{o.notes.join(' · ')}</div>}</div>}
    </div>
  );
}

export default function LedgerSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'lpage');

  const [orders, setOrders] = useState([]);
  const [run, setRun] = useState(null);
  const [held, setHeld] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openOrder, setOpenOrder] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: err } = await supabase.from('ledger_orders')
        .select('order_name, order_id, channel, status, net, opening, cod_open, gateway_open, sale_date, state, state_code, exception_type, exceptions, balancing, notes, computed_at, waiting:facts->waiting')
        .order('sale_date', { ascending: false, nullsFirst: false }).order('order_name', { ascending: false }).range(from, from + 999);
      if (err) { setError('Could not load the ledger'); showToast?.('Could not load the ledger', 'error'); setLoading(false); return; }
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: runs } = await supabase.from('ledger_runs')
      .select('id, kind, status, pos, total, error, started_at, finished_at, updated_at, summary')
      .order('started_at', { ascending: false }).limit(5);
    // Orders the last finished run could not read all their inputs for (an outage): they keep their last figures.
    const finished = (runs || []).find(r => r.status === 'done');
    setOrders(all); setRun(runs?.[0] ?? null); setHeld(Array.isArray(finished?.summary?.held) ? finished.summary.held : []); setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  // "Refresh now" (admins): recalculate the ledger straight away instead of waiting for the hourly run. "Reload" only re-reads what is stored.
  const { isAdmin } = usePermissions();
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [refreshMsg, setRefreshMsg] = useState(null);       // { ok, text } about the last refresh
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const readLatestRun = useCallback(async () => {
    const { data } = await supabase.from('ledger_runs').select('id, status, pos, total, updated_at').order('started_at', { ascending: false }).limit(1);
    return data?.[0] ?? null;
  }, []);
  const refreshNow = async () => {
    setRefreshing(true); setRefreshMsg(null); setProgress(null);
    try {
      const r = await refreshLedger({ call: (body) => callFunction('accounting-ledger', body), readLatestRun, onProgress: (pr) => { if (alive.current) setProgress(pr); }, shouldStop: () => !alive.current });
      if (!alive.current) return;
      await load();
      setRefreshMsg({ ok: r.ok, text: doneText(r) });
      if (r.ok) showToast?.('Ledger refreshed');
    } catch (e) {
      if (alive.current) setRefreshMsg({ ok: false, text: e?.message || 'The refresh failed. Try again in a minute.' });
    } finally {
      if (alive.current) { setRefreshing(false); setProgress(null); }
    }
  };

  // The dates filter says WHICH orders the page is about: the cards, counts and lists all follow it.
  const dated = useMemo(() => orders.filter(o => o.status === 'not_a_sale' && !p.lfrom && !p.lto ? true : inRange(o.sale_date, p.lfrom, p.lto)), [orders, p.lfrom, p.lto]);
  const hasMyntra = useMemo(() => orders.some(o => channelOf(o) === 'myntra'), [orders]);
  const channelCounts = useMemo(() => ({ all: dated.length, shopify: dated.filter(o => channelOf(o) === 'shopify').length, myntra: dated.filter(o => channelOf(o) === 'myntra').length }), [dated]);
  const channel = hasMyntra && CHANNELS.some(c => c.id === p.lchan) ? p.lchan : 'all';
  const scoped = useMemo(() => channel === 'all' ? dated : dated.filter(o => channelOf(o) === channel), [dated, channel]);

  const stats = useMemo(() => {
    const s = { waiting: 0, waitingAmount: 0, waitingOverdue: 0, complete: 0, not_a_sale: 0, in_transit: 0, rto: 0, awaiting_return: 0, settlement: 0, payout: 0, attention: 0, transitAmount: 0, rtoAmount: 0, awaitingAmount: 0, settlementAmount: 0, payoutAmount: 0, attentionAmount: 0, courier: 0, courierAmount: 0, courierOverdue: 0 };
    for (const o of scoped) {
      if (Number(o.cod_open) > 0) { s.courier++; s.courierAmount += Number(o.cod_open); }
      if (o.exception_type === 'remittance_overdue') s.courierOverdue++;
      if (o.status === 'complete') s.complete++;
      else if (o.status === 'not_a_sale') s.not_a_sale++;
      else if (o.status === 'waiting_invoice') { s.waiting++; s.waitingAmount += Number(o.waiting?.amount || 0); if (o.exception_type === 'invoice_overdue') s.waitingOverdue++; }
      else if (o.status === 'attention') { s.attention++; s.attentionAmount += Number(o.net); }
      else if (o.exception_type === 'awaiting_return') { s.awaiting_return++; s.awaitingAmount += Number(o.net); }
      else if (o.exception_type === 'awaiting_settlement') { s.settlement++; s.settlementAmount += Number(o.net); }
      else if (o.exception_type === 'awaiting_payout') { s.payout++; s.payoutAmount += Number(o.gateway_open); }
      else if (o.exception_type === 'rto_on_the_way') { s.rto++; s.rtoAmount += Number(o.net); }
      else if (o.exception_type === 'in_transit') { s.in_transit++; s.transitAmount += Number(o.net); }
    }
    return s;
  }, [scoped]);

  const lastComputed = useMemo(() => orders.reduce((m, o) => (!m || o.computed_at > m ? o.computed_at : m), null), [orders]);
  const attention = useMemo(() => scoped.filter(IN_FILTER.attention), [scoped]);
  const attentionOutside = orders.filter(IN_FILTER.attention).length - dated.filter(IN_FILTER.attention).length;
  // Orders not invoiced yet, the overdue ones first, then the longest waiting.
  const waitingList = useMemo(() => scoped.filter(IN_FILTER.waiting_invoice)
    .sort((a, b) => (b.exception_type === 'invoice_overdue') - (a.exception_type === 'invoice_overdue') || String(a.sale_date).localeCompare(String(b.sale_date))), [scoped]);

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
    const list = scoped.filter(IN_FILTER[p.lstatus] ?? IN_FILTER.all).filter(o => !q || o.order_name.toLowerCase().includes(q.toLowerCase()) || (o.state || '').toLowerCase().includes(q.toLowerCase()));
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
    ['Order', 'Channel', 'Sold', 'State', 'Ships to (state)', 'Detail', 'Open amount', 'COD with Velocity', 'Documents the ERP issues'],
    shown.map(o => [o.order_name, channelOf(o), o.sale_date, stateLabel(o), o.state || '', detailOf(o), o.net, o.cod_open, docsOf(o).map(d => `${DOC_LABEL[d.type] || d.type} ${d.amount}`).join('; ')]));

  const chips = [
    p.lfrom || p.lto ? { key: 'date', label: `Sold ${p.lfrom ? fmtDate(p.lfrom) : 'start'} to ${p.lto ? fmtDate(p.lto) : 'today'}`, onRemove: () => setP({ lfrom: '', lto: '' }) } : null,
    channel !== 'all' ? { key: 'chan', label: CHANNELS.find(c => c.id === channel)?.label || channel, onRemove: () => setP({ lchan: 'all' }) } : null,
    p.lstatus !== 'all' ? { key: 'status', label: STATUS_FILTERS.find(f => f.id === p.lstatus)?.label || p.lstatus, onRemove: () => setP({ lstatus: 'all' }) } : null,
    p.lq ? { key: 'q', label: `Order ${p.lq}`, onRemove: () => setP({ lq: '' }) } : null,
  ].filter(Boolean);
  const clearAll = () => setP({ lfrom: '', lto: '', lstatus: 'all', lchan: 'all', lq: '' });

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
        <div className="shrink-0 flex items-center gap-2">
          <button onClick={load} disabled={loading || refreshing} title="Read the stored ledger again (does not recalculate it)" className="inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">
            <RotateCcw className={`w-3.5 h-3.5 ${loading && !refreshing ? 'animate-spin' : ''}`} /> Reload
          </button>
          {isAdmin && (
            <button onClick={refreshNow} disabled={refreshing} title="Recalculate the ledger now, from Shopify, Unicommerce, Return Prime and Velocity" className="inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-900 bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-60">
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Refreshing…' : 'Refresh now'}
            </button>
          )}
        </div>
      </div>

      {refreshing && <div role="status" className="text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded px-3 py-2">{progressText(progress)} <span className="text-stone-500">Safe to leave this page open; it can take a minute or two.</span></div>}
      {!refreshing && refreshMsg && (
        <div role="status" className={`text-xs rounded px-3 py-2 border flex items-start justify-between gap-3 ${refreshMsg.ok ? 'text-emerald-900 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
          <span>{refreshMsg.text}</span>
          <button type="button" onClick={() => setRefreshMsg(null)} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {held.length > 0 && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          <b>{held.length} {held.length === 1 ? 'order is' : 'orders are'} held back</b> because {[...new Set(held.map(h => String(h.why).split(' could not')[0]))].join(' and ')} could not be reached. They keep their last figures and are tried again every 10 minutes.
          <span className="text-amber-800"> {held.slice(0, 8).map(h => h.order).join(', ')}{held.length > 8 ? ` and ${held.length - 8} more` : ''}.</span>
        </div>
      )}

      {orders.length === 0 && !error && <div className="bg-white rounded-lg border border-stone-200 p-4 text-sm text-stone-600">Nothing stored yet. The first sync fills this in.</div>}

      {orders.length > 0 && (
        <>
          <Collapsible id="ledger-help" title="How this page works" icon={<Info className="w-4 h-4 text-stone-400" />}>
            <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
              <li>Every order since the accounting start date, built from Shopify, Unicommerce, Return Prime and Velocity. A finished order nets to zero.</li>
              <li><b>An order is a sale only once Unicommerce has issued its invoice.</b> Until then it is listed as <i>Waiting for invoice</i> (Shopify and Myntra alike): nothing is booked and nothing can be exported. When the invoice exists the sale is booked on the order date. An order waiting 3 days or more, or dispatched without an invoice, is flagged <i>Invoice overdue</i>; one cancelled first simply drops out.</li>
              <li><b>Myntra</b> orders come from Unicommerce and are named by their invoice number. They are invoiced to the customer, but Myntra collects the payment and pays us later, so they stay <i>Awaiting Myntra payment</i> until its settlement is matched. Use the Channel filter to look at one channel.</li>
              <li><b>Prepaid orders</b> stay <i>Awaiting GoKwik payout</i> until GoKwik's settlement report (uploaded on the Bank &amp; card page) shows the payout. The payout entry books the bank receipt, GoKwik's fee and the GST on the fee.</li>
              <li><b>Open amount</b> is what is still owed on the order (money to collect, or a sale still to be reversed). <b>COD with Velocity</b> is cash the courier collected and has not yet paid into the bank.</li>
              <li>Where Unicommerce's documents fall short, the ERP issues the credit note or invoice itself (<i>ERP issues a document</i>), so Tally always receives balanced orders.</li>
              <li><b>Refresh now</b> (admins) recalculates the ledger straight away and shows how far it has got; the ledger also refreshes itself about every hour. <b>Reload</b> only reads the stored ledger again, so it shows a change only after a refresh has happened.</li>
              <li>The date filter is the date of sale. Open an order to see its double-entry lines; grey lines are dated before the accounting start date and are never exported.</li>
            </ul>
          </Collapsible>

          <Collapsible id="ledger-scope" title="Dates" icon={<SlidersHorizontal className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen()}
            summary={p.lfrom || p.lto ? `Sold ${p.lfrom ? fmtDate(p.lfrom) : 'start'} to ${p.lto ? fmtDate(p.lto) : 'today'}` : 'All dates'}>
            <DateRange label="Sold" from={p.lfrom} to={p.lto} onChange={(f, t) => setP({ lfrom: f, lto: t })} />
          </Collapsible>

          {(() => {
            const cardsShown = [
              <StatCard key="invoice" label="Waiting for invoice" value={stats.waiting} sub={stats.waiting ? `${inr(stats.waitingAmount)} ordered, not booked${stats.waitingOverdue ? ` · ${stats.waitingOverdue} overdue` : ''}` : 'nothing waiting'} tone={stats.waitingOverdue ? 'text-amber-800' : 'text-stone-600'} active={p.lstatus === 'waiting_invoice'} onClick={() => goTo('waiting_invoice')} />,
              <StatCard key="complete" label="Complete" value={stats.complete} sub="net to zero" tone="text-emerald-800" active={p.lstatus === 'complete'} onClick={() => goTo('complete')} />,
              channel !== 'myntra' && <StatCard key="transit" label="COD in transit" value={stats.in_transit} sub={`${inr(stats.transitAmount)} due on delivery`} tone="text-sky-800" active={p.lstatus === 'in_transit'} onClick={() => goTo('in_transit')} />,
              channel !== 'myntra' && <StatCard key="rto" label="RTO on the way" value={stats.rto} sub={`${inr(stats.rtoAmount)} to reverse when back`} tone="text-sky-800" active={p.lstatus === 'rto_on_the_way'} onClick={() => goTo('rto_on_the_way')} />,
              <StatCard key="waiting" label="Waiting for parcel" value={stats.awaiting_return} sub={channel === 'myntra' ? `${inr(stats.awaitingAmount)} sold, parcel not back` : `${inr(stats.awaitingAmount)} refunded, goods not back`} tone="text-sky-800" active={p.lstatus === 'awaiting_return'} onClick={() => goTo('awaiting_return')} />,
              hasMyntra && channel !== 'shopify' && <StatCard key="settle" label="Awaiting Myntra payment" value={stats.settlement} sub={`${inr(stats.settlementAmount)} owed by Myntra`} tone="text-sky-800" active={p.lstatus === 'awaiting_settlement'} onClick={() => goTo('awaiting_settlement')} />,
              channel !== 'myntra' && <StatCard key="payout" label="Awaiting GoKwik payout" value={stats.payout} sub={stats.payout ? `${inr(stats.payoutAmount)} held by GoKwik` : 'nothing waiting'} tone="text-sky-800" active={p.lstatus === 'awaiting_payout'} onClick={() => goTo('awaiting_payout')} />,
              channel !== 'myntra' && <StatCard key="courier" label="COD with Velocity" value={stats.courier} sub={stats.courier ? `${inr(stats.courierAmount)} collected, not yet paid in${stats.courierOverdue ? ` · ${stats.courierOverdue} overdue` : ''}` : 'nothing waiting'} tone={stats.courierOverdue ? 'text-amber-800' : 'text-sky-800'} active={p.lstatus === 'with_courier'} onClick={() => goTo('with_courier')} />,
              <StatCard key="attention" label="Needs attention" value={stats.attention} sub={stats.attention ? `${inr(Math.abs(stats.attentionAmount))} net` : 'nothing to do'} tone={stats.attention ? 'text-amber-800' : 'text-stone-500'} active={p.lstatus === 'attention'} onClick={() => goTo('attention')} />,
            ].filter(Boolean);
            const cols = { 4: 'xl:grid-cols-4', 5: 'xl:grid-cols-5', 6: 'xl:grid-cols-6', 7: 'xl:grid-cols-7', 8: 'xl:grid-cols-8', 9: 'xl:grid-cols-5', 10: 'xl:grid-cols-5' }[cardsShown.length];
            return <div className={`grid grid-cols-2 lg:grid-cols-3 ${cols} gap-3`}>{cardsShown}</div>;
          })()}

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

          {waitingList.length > 0 && (
            <Collapsible id="ledger-waiting" title="Waiting for invoice" defaultOpen={stats.waitingOverdue > 0} count={waitingList.length}
              icon={<Clock className="w-4 h-4 text-stone-400" />} summary={`${inr(stats.waitingAmount)} not booked yet${stats.waitingOverdue ? ` · ${stats.waitingOverdue} overdue` : ''}`}>
              <div className="space-y-1">
                {waitingList.slice(0, 12).map(o => {
                  const ex = exceptionOf(o);
                  return (
                    <button key={o.order_name} type="button" onClick={() => findOrder(o.order_name)} className={`block w-full text-left text-xs rounded px-1.5 py-1 ${ex ? 'text-amber-900 hover:bg-amber-100/60' : 'text-stone-700 hover:bg-stone-100'}`}>
                      <span className="font-mono font-medium">{nameOf(o)}</span>{channelOf(o) === 'myntra' ? ' · Myntra' : ''}{' · '}{fmtDate(o.sale_date)}{o.state ? ` · ${o.state}` : ''}{' · '}{inr(o.waiting?.amount)}{o.waiting?.mode ? ` · ${MODE_LABEL[o.waiting.mode] || o.waiting.mode}` : ''}
                      {ex && <div className="text-amber-800/80 mt-0.5">{ex.reason}</div>}
                    </button>
                  );
                })}
                {waitingList.length > 12 && <div className="text-xs text-stone-600 px-1.5 pt-1">and {waitingList.length - 12} more. <button type="button" className="underline" onClick={() => goTo('waiting_invoice')}>Show them all</button></div>}
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
              {hasMyntra && <Pills value={channel} onChange={id => { setP({ lchan: id, lstatus: 'all' }); setOpenOrder(null); }} options={CHANNELS.map(c => ({ ...c, count: channelCounts[c.id] }))} />}
              <Pills value={p.lstatus} onChange={goTo} options={STATUS_FILTERS.filter(f => (f.id !== 'awaiting_settlement' || (hasMyntra && channel !== 'shopify')) && !(channel === 'myntra' && SHOPIFY_ONLY.has(f.id))).map(f => ({ ...f, count: counts[f.id] }))} />
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
                  <input value={p.lq} onChange={e => setP({ lq: e.target.value })} placeholder="Order, invoice or state" aria-label="Search orders" className={`${field} pl-7 pr-6 w-48`} />
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
                          <SortTh label="Ships to" id="ships" sort={p.lsort} dir={p.ldir} onSort={onSort} />
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
