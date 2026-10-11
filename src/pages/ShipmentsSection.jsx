import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { RefreshCw, AlertCircle, Search, X, ExternalLink, Copy, Check } from 'lucide-react';

// Analytics → Shipments. Every parcel the business is waiting on, from the `shipments` table
// (written by the shipment-watch function): forward parcels not delivered, parcels coming back
// to origin (RTO), and customer returns on their way to the warehouse.
//   Escalate     a forward parcel past the delivery date Velocity promised. Prepaid first: the
//                customer has paid and will complain. COD and part-paid get the same view.
//   Credit note  any parcel still not delivered 45 days after dispatch: only then can a credit
//                note be requested from the courier.
// Rules: supabase/functions/_shared/shipments.ts.

const PAGE_SIZE = 100;
const DEFAULT_SETTINGS = { claimDays: 45, prepaidLate: 1, codLate: 2 };

const VIEWS = [
  { id: 'escalate', label: 'Escalate' },
  { id: 'claim',    label: 'Credit note (45+ days)' },
  { id: 'rto',      label: 'RTO on the way' },
  { id: 'return',   label: 'Returns on the way' },
  { id: 'all',      label: 'All pending' },
];

const KIND_LABEL = { forward: 'Forward', rto: 'RTO', return: 'Return' };
const KIND_STYLE = {
  forward: 'bg-sky-50 text-sky-800 border-sky-200',
  rto:     'bg-amber-50 text-amber-900 border-amber-300',
  return:  'bg-violet-50 text-violet-800 border-violet-200',
};
const PAY_LABEL = { prepaid: 'Prepaid', cod: 'COD', partial: 'Part-paid' };
const PAY_STYLE = {
  prepaid: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  cod:     'bg-stone-100 text-stone-700 border-stone-200',
  partial: 'bg-orange-50 text-orange-800 border-orange-200',
};
const STATUS_LABEL = {
  in_transit: 'In transit', out_for_delivery: 'Out for delivery', attempted: 'Delivery attempted', picked_up: 'Picked up',
  label_created: 'Not picked up yet', ready_for_pickup: 'Ready for pickup', delayed: 'Delayed', failed: 'Delivery failed',
  rto_initiated: 'RTO initiated', rto_in_transit: 'RTO in transit',
  return_requested: 'Pickup requested', return_on_the_way: 'On the way to warehouse',
};

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmtDate = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';
const ago = (iso) => {
  if (!iso) return 'no update';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// Most urgent first.
const byView = {
  escalate: (a, b) => (a.escalation === 'now' ? 0 : 1) - (b.escalation === 'now' ? 0 : 1) || b.late_days - a.late_days,
  claim: (a, b) => b.pending_days - a.pending_days,
  rto: (a, b) => b.pending_days - a.pending_days,
  return: (a, b) => b.pending_days - a.pending_days,
  all: (a, b) => b.pending_days - a.pending_days,
};

const inView = {
  escalate: (s) => s.kind === 'forward' && !!s.escalation,
  claim: (s) => s.claim_eligible,
  rto: (s) => s.kind === 'rto',
  return: (s) => s.kind === 'return',
  all: () => true,
};

// What a person pastes into a ticket to the courier.
function ticketText(rows) {
  const head = 'AWB\tOrder\tCourier\tDispatched\tPromised\tDays since dispatch\tStatus\tPayment';
  const lines = rows.map(s => [
    s.awb, s.order_name, s.courier || '', s.dispatched_on, s.edd || '', s.pending_days,
    STATUS_LABEL[s.status] || s.status, s.payment_type ? PAY_LABEL[s.payment_type] : 'Customer return',
  ].join('\t'));
  return [head, ...lines].join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(t);
    return ok;
  } catch { return false; }
}

export default function ShipmentsSection({ showToast }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('sview') ?? 'escalate';
  const pay = searchParams.get('spay') ?? 'all';
  const search = searchParams.get('sq') ?? '';
  const setParam = (key, v, dflt) => setSearchParams(p => { const n = new URLSearchParams(p); v && v !== dflt ? n.set(key, v) : n.delete(key); return n; }, { replace: true });

  const [rows, setRows] = useState([]);
  const [scannedAt, setScannedAt] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [copied, setCopied] = useState('');
  const [manual, setManual] = useState('');       // shown when the browser blocks copying, so it can be selected by hand

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: err } = await supabase.from('shipments')
        .select('awb, kind, order_name, request_number, courier, tracking_url, payment_type, order_total, cod_due, city, pincode, dispatched_on, edd, rto_since, status, raw_status, last_event_at, attempts, late_days, pending_days, escalation, claim_eligible, stuck, note')
        .eq('state', 'pending').order('dispatched_on').range(from, from + 999);
      if (err) { setError('Could not load the shipments'); showToast?.('Could not load the shipments', 'error'); setLoading(false); return; }
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const { data: cfg } = await supabase.from('app_settings').select('key, value')
      .in('key', ['shipment_claim_days', 'shipment_escalate_prepaid_days', 'shipment_escalate_cod_days', 'shipment_watch_last_run']);
    const get = (k) => (cfg || []).find(r => r.key === k)?.value;
    setSettings({
      claimDays: Number(get('shipment_claim_days')) || DEFAULT_SETTINGS.claimDays,
      prepaidLate: Number(get('shipment_escalate_prepaid_days')) || DEFAULT_SETTINGS.prepaidLate,
      codLate: Number(get('shipment_escalate_cod_days')) || DEFAULT_SETTINGS.codLate,
    });
    setScannedAt(get('shipment_watch_last_run')?.scanned_at ?? null);
    setRows(all); setLoading(false);
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { now: 0, consider: 0, claim: 0, claimValue: 0, rto: 0, rtoOldest: 0, ret: 0, all: rows.length };
    for (const s of rows) {
      if (s.kind === 'forward' && s.escalation === 'now') c.now++;
      if (s.kind === 'forward' && s.escalation === 'consider') c.consider++;
      if (s.claim_eligible) { c.claim++; c.claimValue += Number(s.order_total || 0); }
      if (s.kind === 'rto') { c.rto++; c.rtoOldest = Math.max(c.rtoOldest, s.pending_days); }
      if (s.kind === 'return') c.ret++;
    }
    return c;
  }, [rows]);

  const viewCount = { escalate: counts.now + counts.consider, claim: counts.claim, rto: counts.rto, return: counts.ret, all: counts.all };

  const shown = useMemo(() => {
    const q = search.trim().replace(/^#/, '').toLowerCase();
    return rows
      .filter(inView[view] ?? inView.all)
      .filter(s => pay === 'all' || s.payment_type === pay)
      .filter(s => !q || s.order_name.toLowerCase().includes(q) || s.awb.toLowerCase().includes(q) || (s.request_number || '').toLowerCase().includes(q))
      .sort(byView[view] ?? byView.all);
  }, [rows, view, pay, search]);

  const copy = async (what) => {
    const list = what === 'awbs' ? shown.map(s => s.awb).join('\n') : ticketText(shown);
    const ok = await copyText(list);
    setManual(ok ? '' : list);
    setCopied(ok ? `Copied ${shown.length} ${what === 'awbs' ? 'tracking numbers' : 'rows'}` : 'Copying is blocked here: select the text below');
    setTimeout(() => setCopied(''), 4000);
  };

  if (loading && !rows.length) return <div className="text-sm text-stone-500 px-1 py-6">Loading shipments…</div>;

  const showPay = view === 'escalate' || view === 'claim' || view === 'all';

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-stone-500 px-0.5">
          Parcels still on their way: to the customer, back to us after a failed delivery (RTO), and customer returns. A parcel is late once it passes the delivery date Velocity promised; a credit note can be requested for anything not delivered {settings.claimDays} days after dispatch.
        </div>
        <button onClick={load} disabled={loading}
          className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      {rows.length === 0 && !error && (
        <div className="bg-white rounded-lg border border-stone-200 p-4 text-sm text-stone-600">Nothing stored yet. The first scan fills this in.</div>
      )}

      {rows.length > 0 && (
        <>
          <div className="text-[11px] text-stone-500 px-0.5">Updated {ago(scannedAt)} · refreshed every 30 minutes</div>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {[
              { label: 'Escalate now', value: counts.now, sub: `prepaid, ${days(settings.prepaidLate)}+ past the promised date`, tone: counts.now ? 'text-red-700' : 'text-stone-500', go: 'escalate', payFilter: 'prepaid' },
              { label: 'Consider escalating', value: counts.consider, sub: `COD / part-paid, ${days(settings.codLate)}+ late`, tone: counts.consider ? 'text-amber-800' : 'text-stone-500', go: 'escalate', payFilter: 'cod_partial' },
              { label: 'Credit note due', value: counts.claim, sub: counts.claim ? `${inr(counts.claimValue)} of orders, ${settings.claimDays}+ days` : `nothing past ${settings.claimDays} days`, tone: counts.claim ? 'text-amber-800' : 'text-stone-500', go: 'claim' },
              { label: 'RTO on the way', value: counts.rto, sub: counts.rto ? `oldest ${days(counts.rtoOldest)} since dispatch` : 'none', tone: 'text-sky-800', go: 'rto' },
              { label: 'Returns on the way', value: counts.ret, sub: 'customer returns not at the warehouse', tone: 'text-violet-800', go: 'return' },
            ].map(c => (
              <button key={c.label} onClick={() => { setParam('sview', c.go, 'escalate'); setParam('spay', c.payFilter === 'prepaid' ? 'prepaid' : 'all', 'all'); setLimit(PAGE_SIZE); }}
                className="text-left bg-white rounded-lg border border-stone-200 p-3 sm:p-4 hover:border-stone-400">
                <div className={`text-xl font-bold ${c.tone}`}>{c.value}</div>
                <div className="text-xs font-medium text-stone-900 mt-0.5">{c.label}</div>
                <div className="text-[11px] text-stone-500 mt-0.5">{c.sub}</div>
              </button>
            ))}
          </div>

          <div className="bg-white rounded-lg border border-stone-200 p-3 sm:p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 overflow-x-auto max-w-full">
                {VIEWS.map(v => (
                  <button key={v.id} onClick={() => { setParam('sview', v.id, 'escalate'); setLimit(PAGE_SIZE); }}
                    className={`text-xs px-2 py-1 rounded border whitespace-nowrap ${view === v.id ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50'}`}>
                    {v.label} <span className="opacity-60">{viewCount[v.id]}</span>
                  </button>
                ))}
              </div>
              <div className="relative ml-auto">
                <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input value={search} onChange={e => { setParam('sq', e.target.value, ''); setLimit(PAGE_SIZE); }} placeholder="Order, AWB or return"
                  className="text-xs border border-stone-300 rounded pl-7 pr-6 py-1 w-40 focus:outline-none focus:border-stone-500" />
                {search && <button onClick={() => setParam('sq', '', '')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {showPay && (
                <div className="flex gap-1">
                  {[['all', 'Any payment'], ['prepaid', 'Prepaid'], ['cod', 'COD'], ['partial', 'Part-paid']].map(([id, label]) => (
                    <button key={id} onClick={() => { setParam('spay', id, 'all'); setLimit(PAGE_SIZE); }}
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${pay === id ? 'bg-stone-700 text-white border-stone-700' : 'bg-white text-stone-600 border-stone-300 hover:bg-stone-50'}`}>{label}</button>
                  ))}
                </div>
              )}
              {shown.length > 0 && (
                <div className="ml-auto flex items-center gap-2">
                  {copied && <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1"><Check className="w-3 h-3" />{copied}</span>}
                  <button onClick={() => copy('awbs')} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50"><Copy className="w-3 h-3" /> Copy AWBs</button>
                  <button onClick={() => copy('ticket')} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-stone-300 bg-white hover:bg-stone-50"><Copy className="w-3 h-3" /> Copy for a ticket</button>
                </div>
              )}
            </div>

            {manual && (
              <textarea readOnly value={manual} rows={Math.min(8, manual.split('\n').length)} onFocus={e => e.target.select()} autoFocus
                className="w-full text-[11px] font-mono border border-stone-300 rounded p-2 bg-stone-50" />
            )}

            {view === 'claim' && (
              <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>Not delivered {settings.claimDays} days after dispatch (a customer return: after the pickup was requested). The days are counted from dispatch for forward parcels and RTOs, which are the same tracking number.</span>
              </div>
            )}

            {shown.length === 0 ? (
              <div className="text-sm text-stone-500 py-4">Nothing here.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500 border-b border-stone-200">
                      <th className="py-1.5 px-2 font-medium">Order</th>
                      <th className="py-1.5 px-2 font-medium">Parcel</th>
                      <th className="py-1.5 px-2 font-medium">Dispatched</th>
                      <th className="py-1.5 px-2 font-medium">Promised</th>
                      <th className="py-1.5 px-2 font-medium">Status</th>
                      <th className="py-1.5 px-2 font-medium">Last update</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.slice(0, limit).map(s => (
                      <tr key={s.awb} className="border-b border-stone-100 align-top">
                        <td className="py-2 px-2 whitespace-nowrap">
                          <div className="font-mono font-medium text-stone-900">{s.order_name}</div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${KIND_STYLE[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
                            {s.payment_type && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${PAY_STYLE[s.payment_type]}`}>{PAY_LABEL[s.payment_type]}</span>}
                          </div>
                          {s.request_number && <div className="text-[11px] text-stone-500 mt-0.5">{s.request_number}</div>}
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap">
                          <a href={s.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-stone-800 hover:underline">
                            {s.awb} <ExternalLink className="w-3 h-3 text-stone-400" />
                          </a>
                          <div className="text-[11px] text-stone-500">{[s.courier, s.city, s.pincode].filter(Boolean).join(' · ')}</div>
                          {s.cod_due > 0 && <div className="text-[11px] text-stone-500">{inr(s.cod_due)} to collect</div>}
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap text-stone-700">
                          {fmtDate(s.dispatched_on)}
                          <div className={`text-[11px] ${s.claim_eligible ? 'text-red-700 font-medium' : 'text-stone-500'}`}>{days(s.pending_days)}</div>
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap text-stone-700">
                          {s.kind === 'forward' ? (
                            <>
                              {s.edd ? fmtDate(s.edd) : <span className="text-stone-400">not given</span>}
                              {s.late_days > 0 && <div className="text-[11px] text-red-700 font-medium">{days(s.late_days)} late</div>}
                            </>
                          ) : <span className="text-stone-400">—</span>}
                        </td>
                        <td className="py-2 px-2 text-xs min-w-[180px]">
                          <div className="text-stone-900">{STATUS_LABEL[s.status] || s.status}</div>
                          {s.escalation && <div className={`text-[11px] font-medium ${s.escalation === 'now' ? 'text-red-700' : 'text-amber-800'}`}>{s.escalation === 'now' ? 'Escalate now' : 'Consider escalating'}</div>}
                          {s.note && <div className="text-[11px] text-stone-500">{s.note}</div>}
                        </td>
                        <td className={`py-2 px-2 whitespace-nowrap text-xs ${s.stuck ? 'text-amber-800' : 'text-stone-500'}`}>{ago(s.last_event_at)}</td>
                      </tr>
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
