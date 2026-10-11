import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { RefreshCw, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Search, X, ExternalLink } from 'lucide-react';

// Analytics → Ledger. Shows the stored order ledger (ledger_orders / ledger_entries,
// written by the accounting-ledger function): which orders net to zero, which are
// still travelling, which need a person, and the documents the ERP has to issue.
// Design and rules: docs/accounting-ledger.md.

const SHOP_ADMIN = 'https://admin.shopify.com/store/supply-rethought/orders';
const PAGE_SIZE = 100;

const STATUS_FILTERS = [
  { id: 'all',        label: 'All' },
  { id: 'attention',  label: 'Needs attention' },
  { id: 'in_transit', label: 'COD in transit' },
  { id: 'awaiting_return', label: 'Waiting for parcel' },
  { id: 'with_courier', label: 'COD with Velocity' },
  { id: 'complete',   label: 'Complete' },
  { id: 'not_a_sale', label: 'Not a sale' },
];

const EXCEPTION_LABEL = {
  in_transit: 'COD in transit',
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
const fmtDate = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';
const ago = (iso) => {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
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

function OrderRow({ o, open, onToggle }) {
  const ex = (o.exceptions || [])[0];
  const docs = (o.balancing || []).filter(b => b.type !== 'return_fee_invoice');
  return (
    <>
      <tr className="border-b border-stone-100 hover:bg-stone-50 cursor-pointer" onClick={onToggle}>
        <td className="py-2 px-2 whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            {open ? <ChevronDown className="w-3.5 h-3.5 text-stone-400" /> : <ChevronRight className="w-3.5 h-3.5 text-stone-400" />}
            <span className="font-mono font-medium text-stone-900">{o.order_name}</span>
            <a href={`${SHOP_ADMIN}/${o.order_id}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
               className="text-stone-400 hover:text-stone-700" title="Open in Shopify">
              <ExternalLink className="w-3 h-3" />
            </a>
          </span>
        </td>
        <td className="py-2 px-2 whitespace-nowrap text-stone-600">{fmtDate(o.sale_date)}</td>
        <td className="py-2 px-2 whitespace-nowrap">
          <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded border ${STATUS_STYLE[o.status]}`}>
            {ex ? EXCEPTION_LABEL[ex.type] || ex.type : o.status === 'complete' ? 'Complete' : o.status === 'not_a_sale' ? 'Not a sale' : o.status}
          </span>
        </td>
        <td className="py-2 px-2 text-stone-600 text-xs min-w-[240px]">
          {ex ? ex.reason : o.status === 'not_a_sale' ? (o.notes || [])[0] : ''}
          {Number(o.cod_open) > 0 && !ex && <div className="text-stone-500 mt-0.5">With Velocity: {inr(o.cod_open, 2)} collected, not yet paid into the bank</div>}
          {docs.length > 0 && <div className="text-stone-500 mt-0.5">ERP issues: {docs.map(d => `${DOC_LABEL[d.type] || d.type} ${inr(d.amount, 2)}`).join(', ')}</div>}
        </td>
        <td className={`py-2 px-2 text-right tabular-nums whitespace-nowrap ${Number(o.net) < 0 ? 'text-red-700' : 'text-stone-900'}`}>
          {Number(o.net) ? inr(o.net, 2) : '—'}
        </td>
      </tr>
      {open && (
        <tr className="bg-stone-50/60">
          <td colSpan={5} className="px-2 pb-3 pt-1">
            <EntriesTable orderName={o.order_name} />
            {(o.notes || []).length > 0 && (
              <div className="text-[11px] text-stone-500 px-2 pt-2">{o.notes.join(' · ')}</div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function LedgerSection({ showToast }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get('lstatus') ?? 'all';
  const search = searchParams.get('lq') ?? '';
  const setParam = (key, v, dflt) => setSearchParams(p => { const n = new URLSearchParams(p); v && v !== dflt ? n.set(key, v) : n.delete(key); return n; }, { replace: true });

  const [orders, setOrders] = useState([]);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openOrder, setOpenOrder] = useState(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [docsOpen, setDocsOpen] = useState(false);

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

  const stats = useMemo(() => {
    const s = { complete: 0, not_a_sale: 0, in_transit: 0, awaiting_return: 0, attention: 0, transitAmount: 0, awaitingAmount: 0, attentionAmount: 0, courier: 0, courierAmount: 0, courierOverdue: 0, lastComputed: null };
    for (const o of orders) {
      if (Number(o.cod_open) > 0) { s.courier++; s.courierAmount += Number(o.cod_open); }
      if (o.exception_type === 'remittance_overdue') s.courierOverdue++;
      if (o.status === 'complete') s.complete++;
      else if (o.status === 'not_a_sale') s.not_a_sale++;
      else if (o.status === 'attention') { s.attention++; s.attentionAmount += Number(o.net); }
      else if (o.exception_type === 'awaiting_return') { s.awaiting_return++; s.awaitingAmount += Number(o.net); }
      else { s.in_transit++; s.transitAmount += Number(o.net); }
      if (!s.lastComputed || o.computed_at > s.lastComputed) s.lastComputed = o.computed_at;
    }
    return s;
  }, [orders]);

  const docs = useMemo(() => {
    const by = {};
    for (const o of orders) for (const b of o.balancing || []) {
      const d = (by[b.type] ??= { type: b.type, orders: [], amount: 0 });
      d.orders.push(o.order_name); d.amount += Number(b.amount);
    }
    return Object.values(by).sort((a, b) => b.amount - a.amount);
  }, [orders]);

  const attention = useMemo(() => orders.filter(o => o.status === 'attention'), [orders]);

  const shown = useMemo(() => {
    const q = search.trim().replace(/^#/, '');
    return orders.filter(o => {
      if (q && !o.order_name.includes(q)) return false;
      if (filter === 'all') return true;
      if (filter === 'attention' || filter === 'complete' || filter === 'not_a_sale') return o.status === filter;
      if (filter === 'with_courier') return Number(o.cod_open) > 0;
      return o.exception_type === filter;
    });
  }, [orders, filter, search]);

  const counts = { all: orders.length, attention: stats.attention, in_transit: stats.in_transit, awaiting_return: stats.awaiting_return, with_courier: stats.courier, complete: stats.complete, not_a_sale: stats.not_a_sale };
  const running = run?.status === 'running';

  if (loading && !orders.length) return <div className="text-sm text-stone-500 px-1 py-6">Loading the ledger…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-stone-500 px-0.5">
          Every order since the accounting start date, built from Shopify, Unicommerce, Return Prime and Velocity. A finished order nets to zero; the ERP issues the documents the other systems leave out.
        </div>
        <button onClick={load} disabled={loading}
          className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {orders.length === 0 && !error && (
        <div className="bg-white rounded-lg border border-stone-200 p-4 text-sm text-stone-600">
          Nothing stored yet. The first sync fills this in.
        </div>
      )}

      {orders.length > 0 && (
        <>
          <div className="text-[11px] text-stone-500 px-0.5">
            Updated {ago(stats.lastComputed)}
            {run && <> · last run {run.status === 'running' ? `in progress (${run.pos}/${run.total})` : run.status === 'failed' ? <span className="text-red-700">failed: {run.error}</span> : `finished ${ago(run.finished_at)}`}</>}
            {running && <RefreshCw className="inline w-3 h-3 ml-1 animate-spin" />}
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              { label: 'Complete', value: stats.complete, sub: 'net to zero', tone: 'text-emerald-800' },
              { label: 'COD in transit', value: stats.in_transit, sub: `${inr(stats.transitAmount)} due on delivery`, tone: 'text-sky-800' },
              { label: 'Waiting for parcel', value: stats.awaiting_return, sub: `${inr(stats.awaitingAmount)} refunded, goods not back`, tone: 'text-sky-800' },
              { label: 'COD with Velocity', value: stats.courier, sub: stats.courier ? `${inr(stats.courierAmount)} collected, not yet paid in${stats.courierOverdue ? ` · ${stats.courierOverdue} overdue` : ''}` : 'nothing waiting', tone: stats.courierOverdue ? 'text-amber-800' : 'text-sky-800' },
              { label: 'Needs attention', value: stats.attention, sub: stats.attention ? `${inr(Math.abs(stats.attentionAmount))} net` : 'nothing to do', tone: stats.attention ? 'text-amber-800' : 'text-stone-500' },
            ].map(c => (
              <div key={c.label} className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
                <div className={`text-xl font-bold ${c.tone}`}>{c.value}</div>
                <div className="text-xs font-medium text-stone-900 mt-0.5">{c.label}</div>
                <div className="text-[11px] text-stone-500 mt-0.5">{c.sub}</div>
              </div>
            ))}
          </div>

          {attention.length > 0 && (
            <div className="bg-amber-50 rounded-lg border border-amber-200 p-3 sm:p-4 space-y-2">
              <div className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
                <AlertCircle className="w-4 h-4" /> Needs attention
              </div>
              {attention.map(o => {
                const ex = (o.exceptions || [])[0];
                return (
                  <div key={o.order_name} className="text-xs text-amber-900">
                    <span className="font-mono font-medium">{o.order_name}</span>
                    {' · '}{ex ? EXCEPTION_LABEL[ex.type] || ex.type : 'check'}{ex ? ` · ${inr(Math.abs(ex.amount), 2)}` : ''}
                    {ex && <div className="text-amber-800/80 mt-0.5">{ex.reason}</div>}
                  </div>
                );
              })}
            </div>
          )}

          {docs.length > 0 && (
            <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4">
              <button className="w-full flex items-center justify-between text-left" onClick={() => setDocsOpen(v => !v)}>
                <span className="text-sm font-medium text-stone-900">Documents the ERP issues</span>
                {docsOpen ? <ChevronDown className="w-4 h-4 text-stone-400" /> : <ChevronRight className="w-4 h-4 text-stone-400" />}
              </button>
              <div className="text-xs text-stone-500 mt-0.5">Credit notes and invoices the other systems did not produce, needed so every order nets to zero.</div>
              <div className="mt-2 divide-y divide-stone-100">
                {docs.map(d => (
                  <div key={d.type} className="py-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-stone-800">{DOC_LABEL[d.type] || d.type}</span>
                      <span className="tabular-nums text-stone-900">{d.orders.length} orders · {inr(d.amount, 2)}</span>
                    </div>
                    {docsOpen && <div className="font-mono text-[11px] text-stone-500 mt-1 break-words">{d.orders.join(', ')}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 overflow-x-auto max-w-full">
                {STATUS_FILTERS.map(f => (
                  <button key={f.id} onClick={() => { setParam('lstatus', f.id, 'all'); setLimit(PAGE_SIZE); }}
                    className={`text-xs px-2 py-1 rounded border whitespace-nowrap ${filter === f.id ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50'}`}>
                    {f.label} <span className="opacity-60">{counts[f.id]}</span>
                  </button>
                ))}
              </div>
              <div className="relative ml-auto">
                <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={e => { setParam('lq', e.target.value, ''); setLimit(PAGE_SIZE); }} placeholder="Order number"
                  className="text-xs border border-stone-300 rounded pl-7 pr-6 py-1 w-36 focus:outline-none focus:border-stone-500" />
                {search && <button onClick={() => setParam('lq', '', '')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>}
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="text-sm text-stone-500 py-4 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-stone-400" /> No orders match.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500 border-b border-stone-200">
                      <th className="py-1.5 px-2 font-medium">Order</th>
                      <th className="py-1.5 px-2 font-medium">Sold</th>
                      <th className="py-1.5 px-2 font-medium">State</th>
                      <th className="py-1.5 px-2 font-medium">Detail</th>
                      <th className="py-1.5 px-2 font-medium text-right">Open amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, limit).map(o => (
                      <OrderRow key={o.order_name} o={o} open={openOrder === o.order_name} onToggle={() => setOpenOrder(openOrder === o.order_name ? null : o.order_name)} />
                    ))}
                  </tbody>
                </table>
                {shown.length > limit && (
                  <button onClick={() => setLimit(l => l + PAGE_SIZE)} className="mt-2 text-xs text-stone-700 underline">
                    Show {Math.min(PAGE_SIZE, shown.length - limit)} more ({shown.length - limit} left)
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
