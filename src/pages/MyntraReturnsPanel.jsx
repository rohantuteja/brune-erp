import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { useUrlParams } from '../components/AnalyticsKit';
import {
  OPEN_FILTERS, ageDays, ageLabel, ageTone, defaultView, filterOpen, ledgerByOrder, openCounts, parseFilter, pieceCount, sortOpen,
  splitAttention, trackingText,
} from '../lib/myntraReturnsView';
import { RefreshCw, Play, AlertCircle, X, PackageCheck, Info } from 'lucide-react';

// Analytics → Myntra → Returns (admin only). When Myntra's tracking says a returned parcel (an RTO or a customer return) has been
// delivered back to us, the myntra-returns function receives it in Unicommerce as good stock, so the piece is back in sellable
// stock and Unicommerce issues its return invoice (credit note), which the accounting ledger reads. This panel shows what it did,
// which returns are still on their way, and is where the odd case (a wrong or damaged piece) is found and fixed by hand.
// The four boxes are views: Received by the job, Needs a person, Failed, and Pieces with a return open (the list of returns still
// on their way, kept by the function in myntra_open_returns). Rules and design: docs/myntra-returns.md.

const callReturns = (body) => callFunction('myntra-returns', body);

// URL params: which view is open and, for the open list, which filter. '' means "not chosen", so the default view applies.
const URL_DEFAULTS = { rview: '', rfilter: 'all' };

const KIND = { rto: 'RTO', customer: 'Customer return' };
const STATUS_TEXT = {
  working: 'Receiving…', received: 'Received', failed: 'Failed, will retry', unverified: 'Check in Unicommerce',
  attention: 'Needs a person', resolved: 'Handled by a person',
};
const STATUS_STYLE = {
  working: 'bg-stone-100 text-stone-700 border-stone-200',
  received: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  failed: 'bg-amber-50 text-amber-900 border-amber-300',
  unverified: 'bg-red-50 text-red-800 border-red-300',
  attention: 'bg-red-50 text-red-800 border-red-300',
  resolved: 'bg-stone-100 text-stone-600 border-stone-200',
};
// What Myntra's tracking says about a return that is not back yet (the dry check's summary line).
const TRACKING_TEXT = {
  CIR_COURIER_ASSIGNED: 'Customer return: pickup arranged',
  RTO_INITIATED: 'RTO: on its way back',
  STATUS_NOT_DEFINED: 'No tracking status yet',
};
const AGE_STYLE = { red: 'text-red-700 font-semibold', amber: 'text-amber-800 font-medium', normal: 'text-stone-900', unknown: 'text-stone-400' };

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const fmtDay = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

// A box that is also a button: it switches the list below to what it counts.
function StatTile({ label, value, valueClass, active, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`text-left rounded-lg border px-3 py-2 transition-colors ${active ? 'border-stone-900 ring-1 ring-stone-900 bg-stone-50' : 'border-stone-200 bg-white hover:border-stone-400'}`}>
      <div className="text-stone-500">{label}</div>
      <div className={`text-lg font-semibold ${valueClass}`}>{value}</div>
      <div className="text-[11px] text-stone-400">{active ? 'Showing below' : 'Click to see them'}</div>
    </button>
  );
}

// Returns the job could not finish by itself, with the two things a person can do about each.
function AttentionList({ title, rows, empty, busy, onRetry, onResolve }) {
  return (
    <div className="border border-stone-200 rounded-lg p-2.5 space-y-1.5 text-xs">
      <div className="font-medium text-stone-800">{title} ({rows.length})</div>
      {!rows.length && <div className="text-stone-500 py-1">{empty}</div>}
      {rows.map(a => (
        <div key={a.return_code} className="bg-red-50 border border-red-100 rounded px-2.5 py-1.5 flex flex-wrap items-start gap-x-3 gap-y-1">
          <div className="min-w-[8rem]">
            <div className="font-medium text-stone-900">{a.return_code}</div>
            <div className="text-[11px] text-stone-500">{KIND[a.kind] ?? a.kind}{a.awb ? ` · ${a.awb}` : ''}</div>
          </div>
          <div className="text-[11px] text-stone-600">{(a.skus ?? []).join(', ')}</div>
          <div className="flex-1 min-w-[12rem]">
            <span className={`inline-block px-1.5 py-0.5 rounded border text-[11px] ${STATUS_STYLE[a.status] ?? STATUS_STYLE.working}`}>{STATUS_TEXT[a.status] ?? a.status}</span>
            <div className="text-[11px] text-red-700 mt-0.5">{a.detail}</div>
          </div>
          <div className="flex gap-1.5">
            {(a.status === 'failed' || a.status === 'attention') && (
              <button type="button" disabled={!!busy} onClick={() => onRetry(a.return_code)}
                className="h-7 px-2 rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">Retry</button>
            )}
            <button type="button" disabled={!!busy} onClick={() => onResolve(a.return_code)}
              className="h-7 px-2 rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">I handled it in Unicommerce</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// What the job has received, newest first.
function ReceivedTable({ rows, loading, shown, onMore }) {
  if (!rows.length) return <div className="text-xs text-stone-500 py-3">{loading ? 'Loading…' : 'Nothing has been received by the job yet.'}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-stone-500 border-b border-stone-200">
            <th className="px-3 py-2 font-medium">Return</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Pieces</th>
            <th className="px-3 py-2 font-medium">Parcel</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Received</th>
            <th className="px-3 py-2 font-medium">Credit note</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map(r => (
            <tr key={r.return_code} className="border-b border-stone-100 last:border-0 align-top">
              <td className="px-3 py-2 font-medium text-stone-900">{r.return_code}</td>
              <td className="px-3 py-2">{KIND[r.kind] ?? r.kind}</td>
              <td className="px-3 py-2">{(r.skus ?? []).join(', ')}</td>
              <td className="px-3 py-2"><div>{r.courier ?? '—'}</div><div className="text-[11px] text-stone-500">{r.awb ?? ''}</div></td>
              <td className="px-3 py-2"><span className={`inline-block px-1.5 py-0.5 rounded border text-[11px] ${STATUS_STYLE[r.status] ?? STATUS_STYLE.working}`}>{STATUS_TEXT[r.status] ?? r.status}</span></td>
              <td className="px-3 py-2 whitespace-nowrap">{fmtWhen(r.received_at ?? r.updated_at)}</td>
              <td className="px-3 py-2">{r.return_invoice ?? <span className="text-stone-400">pending</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown && (
        <div className="pt-2"><button type="button" onClick={onMore} className="h-7 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500">Show more ({rows.length - shown} left)</button></div>
      )}
    </div>
  );
}

// The returns still on their way, oldest first: the ones to ask Myntra about come first.
function OpenReturnsList({ rows, ledger, error, loading, openPieces, filter, onFilter, shown, onMore }) {
  const nowMs = Date.now();
  const counts = openCounts(rows, nowMs);
  const list = sortOpen(filterOpen(rows, filter, nowMs));
  const newest = rows.reduce((m, r) => (r.seen_at && r.seen_at > m ? r.seen_at : m), '');
  const pieces = pieceCount(rows);

  if (error) return <div className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">The list of returns on their way could not be read ({error}). Try Reload; the returns run fills the list in every 30 minutes.</div>;
  if (!rows.length) {
    return <div className="text-xs text-stone-500 py-3">{loading ? 'Loading…' : openPieces ? `${openPieces} pieces have a return open. The list fills in at the next returns run (every 30 minutes); reload then.` : 'No Myntra return is on its way.'}</div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="text-stone-700">
          <b>{counts.all}</b> returns · <b>{pieces}</b> pieces · list updated {ago(newest)}
          {openPieces != null && openPieces !== pieces && <span className="text-stone-500"> (Unicommerce shows {openPieces} pieces; the list catches up at the next run)</span>}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {OPEN_FILTERS.map(f => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}
              className={`h-7 px-2.5 rounded-md border transition-colors ${filter === f.id ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-700 border-stone-300 hover:border-stone-500'}`}>
              {f.label} ({counts[f.id]})
            </button>
          ))}
        </div>
      </div>
      {!list.length ? (
        <div className="text-xs text-stone-500 py-3">No returns match this filter.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-stone-500 border-b border-stone-200">
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Pieces</th>
                <th className="px-3 py-2 font-medium">Where it is</th>
                <th className="px-3 py-2 font-medium" title="Days since Myntra opened the return">Out for</th>
                <th className="px-3 py-2 font-medium">Parcel</th>
                <th className="px-3 py-2 font-medium text-right" title="What the ledger still shows as owed on the order">Open amount</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, shown).map(r => {
                const l = ledger.get(String(r.order_code));
                const days = ageDays(r.opened_at, nowMs);
                return (
                  <tr key={r.return_code} className="border-b border-stone-100 last:border-0 align-top">
                    <td className="px-3 py-2"><div className="font-medium text-stone-900">{l?.name ?? '—'}</div><div className="text-[11px] text-stone-500">{r.return_code}</div></td>
                    <td className="px-3 py-2">
                      <div>{KIND[r.kind] ?? r.kind}</div>
                      {r.reason && <div className="text-[11px] text-stone-500 max-w-[16rem]">{r.reason}</div>}
                    </td>
                    <td className="px-3 py-2">{(r.skus ?? []).join(', ')}</td>
                    <td className="px-3 py-2">{trackingText(r.tracking_status)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className={AGE_STYLE[ageTone(days)]}>{ageLabel(days)}</div>
                      {r.opened_at && <div className="text-[11px] text-stone-500">since {fmtDay(r.opened_at)}</div>}
                    </td>
                    <td className="px-3 py-2"><div>{r.courier ?? '—'}</div><div className="text-[11px] text-stone-500">{r.awb ?? ''}</div></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{l ? inr(l.open) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.length > shown && (
            <div className="pt-2"><button type="button" onClick={onMore} className="h-7 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500">Show more ({list.length - shown} left)</button></div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MyntraReturnsPanel() {
  const [p, setP] = useUrlParams(URL_DEFAULTS);
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [openRows, setOpenRows] = useState([]);
  const [openError, setOpenError] = useState('');
  const [ledger, setLedger] = useState(() => new Map());
  const [shown, setShown] = useState(25);
  const [openShown, setOpenShown] = useState(50);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState(null);
  const [limit, setLimit] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);

  const load = useCallback(async () => {
    setError('');
    const [{ data, error: err }, st, open] = await Promise.all([
      supabase.from('myntra_returns').select('*').in('status', ['received', 'resolved']).order('updated_at', { ascending: false }).limit(200),
      callReturns({ action: 'status' }).catch(() => null),
      supabase.from('myntra_open_returns').select('*').limit(1000),
    ]);
    if (err) setError(err.message); else setRows(data ?? []);
    if (st?.ok) setStatus(st.json);
    if (open.error) { setOpenError(open.error.message); setOpenRows([]); } else { setOpenError(''); setOpenRows(open.data ?? []); }
    setLoading(false);

    // The ledger's name for each order (its invoice number) and what is still owed on it.
    const codes = [...new Set((open.data ?? []).map(r => r.order_code))];
    const found = [];
    for (let i = 0; i < codes.length; i += 50) {
      const { data: l } = await supabase.from('ledger_orders').select('order_name, channel_ref, net').eq('channel', 'myntra').in('channel_ref', codes.slice(i, i + 50));
      found.push(...(l ?? []));
    }
    setLedger(ledgerByOrder(found));
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (label, body, after) => {
    setBusy(label); setError('');
    try {
      const { ok, json } = await callReturns(body);
      if (!ok) throw new Error(json.error || 'The request failed');
      after?.(json);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const live = status?.mode === 'live';
  const counts = status?.counts ?? {};
  const attn = splitAttention(status?.attention ?? []);
  const personCount = (counts.attention ?? 0) + (counts.unverified ?? 0);
  const failedCount = counts.failed ?? 0;
  const view = defaultView(p.rview, { person: personCount, failed: failedCount });
  const pick = (v) => setP({ rview: v });
  const onRetry = (code) => run(`retry-${code}`, { action: 'retry', return_code: code }, (j) => { setStatus(j); });
  const onResolve = (code) => run(`resolve-${code}`, { action: 'resolve', return_code: code }, (j) => { setStatus(j); load(); });

  return (
    <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck className="w-4 h-4 text-stone-500" />
        <h3 className="text-sm font-semibold text-stone-900">Myntra returns</h3>
        <span className="text-[11px] text-stone-500 inline-flex items-center gap-1">
          <Info className="w-3 h-3" />Received in Unicommerce as good stock once Myntra says the parcel is back with us; Unicommerce then issues the credit note
        </span>
        <button type="button" onClick={() => { setLoading(true); load(); }} className="ml-auto h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 inline-flex items-center gap-1">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />Reload
        </button>
      </div>

      <div className={`rounded-lg border px-3 py-2.5 text-xs ${live ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-300 text-amber-900'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{live ? 'Live' : 'Dry run'}</span>
          <span>
            {live
              ? `Returns that are back are being received in Unicommerce, at most ${status?.limit ?? '…'} per run.`
              : 'The job only reads Unicommerce and reports what it would receive. Nothing is received.'}
          </span>
          <span className="text-[11px] opacity-80">Last run {ago(status?.last_run?.at)}</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" disabled={!!busy} onClick={() => run('dry', { action: 'sweep', dry: true }, setPlan)}
              className="h-7 px-2.5 rounded-md border border-stone-300 bg-white text-stone-800 hover:border-stone-500 disabled:opacity-50 inline-flex items-center gap-1">
              {busy === 'dry' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}Check now (dry)
            </button>
            {live ? (
              <>
                <button type="button" disabled={!!busy} onClick={() => run('mode', { action: 'set_mode', mode: 'dry' }, (j) => { setStatus(j); })}
                  className="h-7 px-2.5 rounded-md border border-stone-300 bg-white text-stone-800 hover:border-stone-500 disabled:opacity-50">Switch off (dry run)</button>
                <input value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, ''))} placeholder={String(status?.limit ?? 1)} inputMode="numeric" aria-label="Returns per run"
                  className="w-12 h-7 border border-stone-300 rounded px-1 text-xs bg-white" />
                <button type="button" disabled={!!busy || !limit} onClick={() => run('mode', { action: 'set_mode', mode: 'live', limit: Number(limit) }, (j) => { setLimit(''); setStatus(j); })}
                  className="h-7 px-2 rounded-md border border-stone-300 bg-white disabled:opacity-50">Set per-run limit</button>
              </>
            ) : confirmLive ? (
              <span className="inline-flex items-center gap-1.5 bg-white border border-amber-400 rounded-md px-2 py-1">
                <span>This really receives returns in Unicommerce. Returns per run:</span>
                <input value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, ''))} placeholder={String(status?.limit ?? 1)} inputMode="numeric" aria-label="Returns per run"
                  className="w-12 h-6 border border-stone-300 rounded px-1 text-xs" />
                <button type="button" disabled={!!busy} onClick={() => run('mode', { action: 'set_mode', mode: 'live', limit: Number(limit || status?.limit || 1) }, (j) => { setConfirmLive(false); setStatus(j); })}
                  className="h-6 px-2 rounded bg-stone-900 text-white disabled:opacity-50">Go live</button>
                <button type="button" onClick={() => setConfirmLive(false)} className="h-6 px-2 rounded border border-stone-300">Cancel</button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmLive(true)} className="h-7 px-2.5 rounded-md bg-stone-900 text-white hover:bg-stone-700">Switch to live</button>
            )}
          </div>
        </div>
        {error && <div className="mt-1.5 text-red-700 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" />{error}</div>}
        {plan && (
          <div className="mt-2 bg-white/70 rounded border border-stone-200 px-2.5 py-2 text-stone-800 space-y-0.5">
            <div className="flex items-center gap-1 font-medium">Dry check <button type="button" onClick={() => setPlan(null)} aria-label="Close" className="ml-auto p-0.5 hover:bg-stone-100 rounded"><X className="w-3 h-3" /></button></div>
            <div>{plan.open_orders} Myntra order{plan.open_orders === 1 ? '' : 's'} with a return open; {plan.looked_at} read from Unicommerce.</div>
            <div>
              Would receive now: <b>{plan.would_receive.length}</b>
              {plan.would_receive.length > 0 && <> ({plan.would_receive.filter(w => w.kind === 'rto').length} RTO, {plan.would_receive.filter(w => w.kind === 'customer').length} customer return)</>}
            </div>
            {Object.keys(plan.waiting).length > 0 && (
              <div className="text-stone-600">Not back yet: {Object.entries(plan.waiting).map(([k, v]) => `${v} ${TRACKING_TEXT[k] ?? k}`).join(' · ')}</div>
            )}
            {plan.already_logged > 0 && <div className="text-stone-500">{plan.already_logged} already handled by the job.</div>}
            {plan.attention.length > 0 && <div className="text-red-700">Would leave for a person: {plan.attention.join('; ')}</div>}
            {plan.unreadable.length > 0 && <div className="text-red-700">Could not read: {plan.unreadable.slice(0, 3).join('; ')}</div>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <StatTile label="Received by the job" value={counts.received ?? 0} valueClass="text-emerald-800" active={view === 'received'} onClick={() => pick('received')} />
        <StatTile label="Needs a person" value={personCount} valueClass={personCount ? 'text-red-700' : 'text-stone-900'} active={view === 'person'} onClick={() => pick('person')} />
        <StatTile label="Failed, will retry" value={failedCount} valueClass={failedCount ? 'text-amber-800' : 'text-stone-900'} active={view === 'failed'} onClick={() => pick('failed')} />
        <StatTile label="Pieces with a return open" value={status?.open_pieces ?? '…'} valueClass="text-stone-900" active={view === 'open'} onClick={() => pick('open')} />
      </div>

      {view === 'received' && <ReceivedTable rows={rows} loading={loading} shown={shown} onMore={() => setShown(s => s + 50)} />}
      {view === 'person' && <AttentionList title="Needs a person" rows={attn.person} empty="Nothing needs a person right now." busy={busy} onRetry={onRetry} onResolve={onResolve} />}
      {view === 'failed' && <AttentionList title="Failed, will retry" rows={attn.failed} empty="Nothing has failed. A refused receive is tried again by itself after 30 minutes, 2 hours, 6 hours and 24 hours." busy={busy} onRetry={onRetry} onResolve={onResolve} />}
      {view === 'open' && (
        <OpenReturnsList rows={openRows} ledger={ledger} error={openError} loading={loading} openPieces={status?.open_pieces ?? null}
          filter={parseFilter(p.rfilter)} onFilter={(f) => { setP({ rfilter: f }); setOpenShown(50); }} shown={openShown} onMore={() => setOpenShown(s => s + 50)} />
      )}

      <div className="text-[11px] text-stone-500">
        A parcel that turns out to hold the wrong or a damaged piece: fix the stock in Unicommerce (remove the piece that should not be there, add the right one). The SKU and the parcel number above tell you which one it was.
      </div>
    </div>
  );
}
