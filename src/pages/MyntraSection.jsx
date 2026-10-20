import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { localToday } from '../lib/constants';
import { STATUS_TEXT, filterRows, printQueue, viewCounts } from '../lib/myntraView';
import { clampPage, pageSizeOf } from '../lib/analyticsKit';
import { Pagination, Pills, StatCard, EmptyState, useUrlParams } from '../components/AnalyticsKit';
import { RefreshCw, Printer, Search, X, Info, Play, AlertCircle, CheckCircle2, Download } from 'lucide-react';

// Analytics → Myntra (admin only). Myntra orders are invoiced, labelled and dispatched in Unicommerce by the
// myntra-fulfil function every 5 minutes, as soon as Myntra allows (it holds holiday orders as "upcoming" and refuses
// the invoice until their time). This page shows what the job did, and is where the labels are printed: one PDF of every
// label not yet printed, then "I printed them". Rules and design: docs/myntra-fulfilment.md.

const callMyntra = (body) => callFunction('myntra-fulfil', body);
const URL_DEFAULTS = { myview: 'print', myq: '', mypage: '1', mysize: '25' };

const VIEWS = [
  { id: 'print', label: 'Labels to print' },
  { id: 'waiting', label: 'Waiting for Myntra' },
  { id: 'dispatch', label: 'To dispatch' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'today', label: 'Dispatched today' },
  { id: 'all', label: 'All' },
];

const STATUS_STYLE = {
  held: 'bg-sky-50 text-sky-800 border-sky-200',
  invoiced: 'bg-amber-50 text-amber-900 border-amber-300',
  dispatched: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  failed: 'bg-red-50 text-red-800 border-red-200',
  attention: 'bg-red-50 text-red-800 border-red-300',
  working: 'bg-stone-100 text-stone-700 border-stone-200',
  cancelled: 'bg-stone-100 text-stone-500 border-stone-200',
};

const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

function base64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

// ── Mode: dry run or live ───────────────────────────────────────────────────────────────────────
function ModeBar({ status, onChanged }) {
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const live = status?.mode === 'live';

  const run = async (label, body, after) => {
    setBusy(label); setError('');
    try {
      const { ok, json } = await callMyntra(body);
      if (!ok) throw new Error(json.error || 'The request failed');
      after?.(json);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-xs ${live ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-300 text-amber-900'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{live ? 'Live' : 'Dry run'}</span>
        <span>
          {live
            ? `Invoices, labels and dispatches are being made, at most ${status?.limit ?? '…'} package${status?.limit === 1 ? '' : 's'} per run.`
            : 'The job only reads Unicommerce and reports what it would do. Nothing is invoiced or dispatched.'}
        </span>
        <span className="text-[11px] opacity-80">Last run {ago(status?.last_run?.at)}{status?.last_run ? ` · ${status.last_run.orders} open order${status.last_run.orders === 1 ? '' : 's'}` : ''}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" disabled={!!busy} onClick={() => run('dry', { action: 'sweep', dry: true }, setPlan)}
            className="h-7 px-2.5 rounded-md border border-stone-300 bg-white text-stone-800 hover:border-stone-500 disabled:opacity-50 inline-flex items-center gap-1">
            {busy === 'dry' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}Check now (dry)
          </button>
          {live ? (
            <button type="button" disabled={!!busy} onClick={() => run('mode', { action: 'set_mode', mode: 'dry' }, onChanged)}
              className="h-7 px-2.5 rounded-md border border-stone-300 bg-white text-stone-800 hover:border-stone-500 disabled:opacity-50">Switch off (dry run)</button>
          ) : confirmLive ? (
            <span className="inline-flex items-center gap-1.5 bg-white border border-amber-400 rounded-md px-2 py-1">
              <span>This really invoices and dispatches. Packages per run:</span>
              <input value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, ''))} placeholder={String(status?.limit ?? 1)} inputMode="numeric" aria-label="Packages per run"
                className="w-12 h-6 border border-stone-300 rounded px-1 text-xs" />
              <button type="button" disabled={!!busy} onClick={() => run('mode', { action: 'set_mode', mode: 'live', limit: Number(limit || status?.limit || 1) }, (j) => { setConfirmLive(false); onChanged(j); })}
                className="h-6 px-2 rounded bg-stone-900 text-white disabled:opacity-50">Go live</button>
              <button type="button" onClick={() => setConfirmLive(false)} className="h-6 px-2 rounded border border-stone-300">Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmLive(true)} className="h-7 px-2.5 rounded-md bg-stone-900 text-white hover:bg-stone-700">Switch to live</button>
          )}
          {live && (
            <span className="inline-flex items-center gap-1">
              <input value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, ''))} placeholder={String(status?.limit ?? 1)} inputMode="numeric" aria-label="Packages per run"
                className="w-12 h-7 border border-stone-300 rounded px-1 text-xs bg-white" />
              <button type="button" disabled={!!busy || !limit} onClick={() => run('mode', { action: 'set_mode', mode: 'live', limit: Number(limit) }, (j) => { setLimit(''); onChanged(j); })}
                className="h-7 px-2 rounded-md border border-stone-300 bg-white disabled:opacity-50">Set per-run limit</button>
            </span>
          )}
        </div>
      </div>
      {error && <div className="mt-1.5 text-red-700 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" />{error}</div>}
      {plan && (
        <div className="mt-2 bg-white/70 rounded border border-stone-200 px-2.5 py-2 text-stone-800 space-y-0.5">
          <div className="flex items-center gap-1 font-medium">Dry check <button type="button" onClick={() => setPlan(null)} aria-label="Close" className="ml-auto p-0.5 hover:bg-stone-100 rounded"><X className="w-3 h-3" /></button></div>
          <div>{plan.orders} open Myntra order{plan.orders === 1 ? '' : 's'}; Unicommerce was asked about {plan.looked_at}.</div>
          <div>Would invoice and label: {plan.would_invoice.length ? plan.would_invoice.join(', ') : 'none'}</div>
          <div>Would dispatch (invoiced already): {plan.would_dispatch.length ? plan.would_dispatch.join(', ') : 'none'}</div>
          {plan.deferred > 0 && <div>{plan.deferred} more would wait for the next run (limit {plan.limit} per run).</div>}
          {Object.keys(plan.skipped).length > 0 && <div className="text-stone-500">Left alone: {Object.entries(plan.skipped).map(([k, v]) => `${v} ${k}`).join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}

// ── Print the labels not printed yet ────────────────────────────────────────────────────────────
function PrintPanel({ queue, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState(null);          // { url, codes, missing }
  const urlRef = useRef(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const build = async () => {
    setBusy(true); setError('');
    try {
      const { ok, json } = await callMyntra({ action: 'labels' });
      if (!ok) throw new Error(json.error || 'The request failed');
      if (!json.pdf) { setMade({ url: null, codes: [], missing: json.missing ?? [] }); return; }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = base64ToBlobUrl(json.pdf);
      setMade({ url: urlRef.current, codes: json.codes, missing: json.missing ?? [] });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const printed = async () => {
    setBusy(true); setError('');
    try {
      const { ok, json } = await callMyntra({ action: 'mark_printed', codes: made.codes });
      if (!ok) throw new Error(json.error || 'The request failed');
      setMade(null);
      await onDone();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Printer className="w-4 h-4 text-stone-500" />
        <div className="text-sm font-medium text-stone-900">{queue.length ? `${queue.length} label${queue.length === 1 ? '' : 's'} not printed yet` : 'Every label is printed'}</div>
        {!made && queue.length > 0 && (
          <button type="button" disabled={busy} onClick={build} className="ml-auto h-8 px-3 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-50 inline-flex items-center gap-1">
            {busy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Printer className="w-3 h-3" />}Get one PDF of the unprinted labels
          </button>
        )}
      </div>
      <div className="text-[11px] text-stone-500">Each label PDF is the invoice and the courier label together. A label stays on this list until you confirm you printed it.</div>
      {error && <div className="text-xs text-red-700 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" />{error}</div>}
      {made && (
        <div className="border border-stone-200 rounded-md p-2.5 bg-stone-50 space-y-2 text-xs">
          {made.url ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span><b>{made.codes.length}</b> label{made.codes.length === 1 ? '' : 's'} in one PDF.</span>
                <a href={made.url} target="_blank" rel="noreferrer" className="h-7 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500 inline-flex items-center gap-1">Open to print</a>
                <a href={made.url} download={`myntra-labels-${localToday()}.pdf`} className="h-7 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500 inline-flex items-center gap-1"><Download className="w-3 h-3" />Download</a>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-stone-600">Once they are printed:</span>
                <button type="button" disabled={busy} onClick={printed} className="h-7 px-2.5 rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-50">I printed these {made.codes.length}</button>
                <button type="button" onClick={() => setMade(null)} className="h-7 px-2.5 rounded-md border border-stone-300 bg-white">Not yet</button>
              </div>
            </>
          ) : (
            <div className="text-red-700">No label could be fetched.</div>
          )}
          {made.missing.length > 0 && (
            <div className="text-amber-900 bg-amber-50 border border-amber-300 rounded px-2 py-1.5">
              {made.missing.length} label{made.missing.length === 1 ? '' : 's'} could not be fetched and stay unprinted: {made.missing.map(m => `${m.package} (${m.reason})`).join(', ')}. Try again in a minute, or print it from Unicommerce.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────
export default function MyntraSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'myntra');
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState('');
  const today = localToday();

  const load = useCallback(async () => {
    setError('');
    const [{ data, error: err }, st] = await Promise.all([
      supabase.from('myntra_fulfilments').select('*').order('created_at', { ascending: false }).limit(1000),
      callMyntra({ action: 'status' }).catch(() => null),
    ]);
    if (err) setError(err.message); else setRows(data ?? []);
    if (st?.ok) setStatus(st.json);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => viewCounts(rows, today), [rows, today]);
  const queue = useMemo(() => printQueue(rows), [rows]);
  const shown = useMemo(() => filterRows(rows, p.myview, p.myq, today), [rows, p.myview, p.myq, today]);
  const size = pageSizeOf(p.mysize);
  const page = clampPage(Number(p.mypage) || 1, shown.length, size);
  const pageRows = shown.slice((page - 1) * size, page * size);

  const retry = async (code) => {
    setRetrying(code);
    try {
      const { ok, json } = await callMyntra({ action: 'retry', package_code: code });
      if (!ok) throw new Error(json.error || 'The request failed');
      showToast?.(`${code} will be tried again at the next run`);
      await load();
    } catch (e) { setError(e.message); } finally { setRetrying(''); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-stone-900">Myntra orders</h2>
        <span className="text-[11px] text-stone-500 inline-flex items-center gap-1"><Info className="w-3 h-3" />Invoiced, labelled and dispatched in Unicommerce every 5 minutes, as soon as Myntra allows</span>
        <button type="button" onClick={() => { setLoading(true); load(); }} className="ml-auto h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 inline-flex items-center gap-1">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />Reload
        </button>
      </div>

      <ModeBar status={status} onChanged={(s) => { setStatus(s); load(); }} />
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Labels to print" value={counts.print} sub="not marked printed" tone={counts.print ? 'text-amber-800' : 'text-stone-900'} onClick={() => setP({ myview: 'print', mypage: '1' })} active={p.myview === 'print'} />
        <StatCard label="Waiting for Myntra" value={counts.waiting} sub="holiday / upcoming orders" onClick={() => setP({ myview: 'waiting', mypage: '1' })} active={p.myview === 'waiting'} />
        <StatCard label="To dispatch" value={counts.dispatch} sub="invoiced, not dispatched" onClick={() => setP({ myview: 'dispatch', mypage: '1' })} active={p.myview === 'dispatch'} />
        <StatCard label="Needs attention" value={counts.attention} sub="failed or stuck" tone={counts.attention ? 'text-red-700' : 'text-stone-900'} onClick={() => setP({ myview: 'attention', mypage: '1' })} active={p.myview === 'attention'} />
        <StatCard label="Dispatched today" value={counts.today} sub="on a closed manifest" tone="text-emerald-800" onClick={() => setP({ myview: 'today', mypage: '1' })} active={p.myview === 'today'} />
      </div>

      <PrintPanel queue={queue} onDone={load} />

      <div className="flex flex-wrap items-center gap-2">
        <Pills options={VIEWS.map(v => ({ ...v, count: counts[v.id] }))} value={p.myview} onChange={id => setP({ myview: id, mypage: '1' })} />
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2 top-2.5 text-stone-400" />
          <input value={p.myq} onChange={e => setP({ myq: e.target.value, mypage: '1' })} placeholder="Package, invoice, tracking…" aria-label="Search"
            className="h-8 w-56 border border-stone-300 rounded-md pl-7 pr-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent" />
        </div>
      </div>

      <div className="bg-white rounded-lg border border-stone-200 overflow-x-auto">
        {!pageRows.length ? (
          <EmptyState title={loading ? 'Loading…' : rows.length ? 'Nothing in this list' : 'No Myntra order handled yet'}
            hint={rows.length ? 'Try another list above.' : 'Orders appear here once the job is live and finds an open Myntra order.'} />
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-stone-500 border-b border-stone-200">
                <th className="px-3 py-2 font-medium">Package</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Courier · tracking</th>
                <th className="px-3 py-2 font-medium">Invoice</th>
                <th className="px-3 py-2 font-medium">Manifest</th>
                <th className="px-3 py-2 font-medium">Invoiced</th>
                <th className="px-3 py-2 font-medium">Dispatched</th>
                <th className="px-3 py-2 font-medium">Label</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(r => (
                <tr key={r.package_code} className="border-b border-stone-100 last:border-0 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-stone-900">{r.package_code}</div>
                    <div className="text-[11px] text-stone-500">{r.payment === 'cod' ? 'COD' : 'Prepaid'}{r.source === 'dashboard' ? ' · invoiced on the dashboard' : ''}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-1.5 py-0.5 rounded border text-[11px] ${STATUS_STYLE[r.status] ?? STATUS_STYLE.working}`}>{STATUS_TEXT[r.status] ?? r.status}</span>
                    {r.status === 'held' && r.next_try_at && <div className="text-[11px] text-stone-500 mt-0.5">Myntra allows it from {fmtWhen(r.next_try_at)}</div>}
                    {(r.status === 'failed' || r.status === 'attention') && (
                      <div className="text-[11px] text-red-700 mt-0.5 max-w-xs">
                        {r.detail}
                        <button type="button" disabled={retrying === r.package_code} onClick={() => retry(r.package_code)} className="ml-1 underline disabled:opacity-50">Retry now</button>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2"><div>{r.provider ?? '—'}</div><div className="text-[11px] text-stone-500">{r.tracking_number ?? ''}</div></td>
                  <td className="px-3 py-2">{r.invoice_display ?? '—'}</td>
                  <td className="px-3 py-2">{r.manifest_code ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtWhen(r.invoiced_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtWhen(r.dispatched_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.printed_at ? <span className="text-stone-500">Printed {ago(r.printed_at)}</span>
                      : r.label_url && r.source === 'erp' ? <span className="text-amber-800">To print</span> : <span className="text-stone-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={page} pageSize={size} total={shown.length} onPage={n => setP({ mypage: String(n) })} onPageSize={n => setP({ mysize: String(n), mypage: '1' })} noun="packages" />
      </div>
    </div>
  );
}
