import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { RefreshCw, Play, AlertCircle, X, PackageCheck, Info } from 'lucide-react';

// Analytics → Myntra → Returns (admin only). When Myntra's tracking says a returned parcel (an RTO or a customer return) has been
// delivered back to us, the myntra-returns function receives it in Unicommerce as good stock, so the piece is back in sellable
// stock and Unicommerce issues its return invoice (credit note), which the accounting ledger reads. This panel shows what it did,
// and is where the odd case (a wrong or damaged piece) is found and fixed by hand. Rules and design: docs/myntra-returns.md.

const callReturns = (body) => callFunction('myntra-returns', body);

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
// What Myntra's tracking says about a return that is not back yet.
const TRACKING_TEXT = {
  CIR_COURIER_ASSIGNED: 'Customer return: pickup arranged',
  RTO_INITIATED: 'RTO: on its way back',
  STATUS_NOT_DEFINED: 'No tracking status yet',
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

export default function MyntraReturnsPanel() {
  const [status, setStatus] = useState(null);
  const [rows, setRows] = useState([]);
  const [shown, setShown] = useState(25);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState(null);
  const [limit, setLimit] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);

  const load = useCallback(async () => {
    setError('');
    const [{ data, error: err }, st] = await Promise.all([
      supabase.from('myntra_returns').select('*').in('status', ['received', 'resolved']).order('updated_at', { ascending: false }).limit(200),
      callReturns({ action: 'status' }).catch(() => null),
    ]);
    if (err) setError(err.message); else setRows(data ?? []);
    if (st?.ok) setStatus(st.json);
    setLoading(false);
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
  const attention = status?.attention ?? [];

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
        <div className="rounded-lg border border-stone-200 px-3 py-2"><div className="text-stone-500">Received by the job</div><div className="text-lg font-semibold text-emerald-800">{counts.received ?? 0}</div></div>
        <div className="rounded-lg border border-stone-200 px-3 py-2"><div className="text-stone-500">Needs a person</div><div className={`text-lg font-semibold ${(counts.attention ?? 0) + (counts.unverified ?? 0) ? 'text-red-700' : 'text-stone-900'}`}>{(counts.attention ?? 0) + (counts.unverified ?? 0)}</div></div>
        <div className="rounded-lg border border-stone-200 px-3 py-2"><div className="text-stone-500">Failed, will retry</div><div className={`text-lg font-semibold ${counts.failed ? 'text-amber-800' : 'text-stone-900'}`}>{counts.failed ?? 0}</div></div>
        <div className="rounded-lg border border-stone-200 px-3 py-2"><div className="text-stone-500">Pieces with a return open</div><div className="text-lg font-semibold text-stone-900">{status?.open_pieces ?? '…'}</div></div>
      </div>

      {attention.length > 0 && (
        <div className="border border-red-200 bg-red-50 rounded-lg p-2.5 space-y-1.5 text-xs">
          <div className="font-medium text-red-800">Needs a person ({attention.length})</div>
          {attention.map(a => (
            <div key={a.return_code} className="bg-white border border-red-100 rounded px-2.5 py-1.5 flex flex-wrap items-start gap-x-3 gap-y-1">
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
                  <button type="button" disabled={!!busy} onClick={() => run(`retry-${a.return_code}`, { action: 'retry', return_code: a.return_code }, (j) => { setStatus(j); })}
                    className="h-7 px-2 rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">Retry</button>
                )}
                <button type="button" disabled={!!busy} onClick={() => run(`resolve-${a.return_code}`, { action: 'resolve', return_code: a.return_code }, (j) => { setStatus(j); load(); })}
                  className="h-7 px-2 rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">I handled it in Unicommerce</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        {!rows.length ? (
          <div className="text-xs text-stone-500 py-3">{loading ? 'Loading…' : 'Nothing has been received by the job yet.'}</div>
        ) : (
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
        )}
        {rows.length > shown && (
          <div className="pt-2"><button type="button" onClick={() => setShown(s => s + 50)} className="h-7 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500">Show more ({rows.length - shown} left)</button></div>
        )}
      </div>
      <div className="text-[11px] text-stone-500">
        A parcel that turns out to hold the wrong or a damaged piece: fix the stock in Unicommerce (remove the piece that should not be there, add the right one). The SKU and the parcel number above tell you which one it was.
      </div>
    </div>
  );
}
