import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { refreshLedgerNow } from '../lib/ledgerRefreshNow';
import LedgerRefreshStatus from '../components/LedgerRefreshStatus';
import { clampPage, pageSizeOf } from '../lib/analyticsKit';
import { toBase64 } from '../lib/financeView';
import { KIND_LABEL, TOPUP_STATUS_TEXT, invoiceVerdict, monthLabel, splitKinds, topupCounts, topupStatus } from '../lib/velocityView';
import { Pagination, Collapsible, Pills, StatCard, EmptyState, useUrlParams, wideScreen } from '../components/AnalyticsKit';
import { useDeleteFlow, DeleteButton, DeletionLog } from '../components/UploadDelete';
import { RefreshCw, Upload, Search, X, Info, Wallet, FileText, ListChecks, CheckCircle2, AlertCircle, CircleDashed } from 'lucide-react';

// Analytics → Velocity wallet (admin only). Velocity charges are taken from a prepaid wallet as they happen and billed once a
// month, so a top-up is an advance and the monthly invoice is the expense. Upload the dashboard's Ledger Report (CSV) and the
// monthly tax invoice (PDF): the ledger is checked, top-ups are matched to the bank, and each invoice is compared with its
// month's charges. Rules and design: docs/velocity-wallet.md. Nothing here posts to Tally.

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const callVelocity = (body) => callFunction('velocity-import', body);
const URL_DEFAULTS = { vmonth: '', vkind: 'all', vq: '', vpage: '1', vsize: '25' };

const inr = (n, digits = 2) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const diffInr = (n) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${inr(Math.abs(n))}`;
const fmtDate = (d) => d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';
const ago = (iso) => {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`; };

function CheckList({ checks }) {
  if (!checks?.length) return null;
  return (
    <ul className="mt-2 space-y-0.5">
      {checks.map(c => (
        <li key={c.id} className={`flex items-start gap-1.5 text-[11px] ${c.ok ? 'text-stone-600' : 'text-red-700'}`}>
          {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-px shrink-0 text-emerald-600" /> : <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />}
          <span>{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Upload ──────────────────────────────────────────────────────────────────────────────────────
function UploadPanel({ onDone }) {
  const [what, setWhat] = useState('');                 // 'ledger' | 'invoice'
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const input = useRef(null);
  const accept = what === 'ledger' ? '.csv' : what === 'invoice' ? '.pdf' : '.csv,.pdf';
  const hint = what === 'ledger' ? 'The Ledger Report from the Velocity dashboard (CSV). One month, or any range: lines already stored are kept, and a report that does not add up is refused.'
    : what === 'invoice' ? 'The monthly tax invoice from Velocity (PDF). It is read, checked to add up, and compared with the ledger for its period.'
    : 'Choose what you are uploading first.';

  const upload = async () => {
    if (!what || !file) return;
    if (file.size > MAX_UPLOAD_BYTES) { setResult({ ok: false, title: 'That file is too large', error: `Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB are accepted.` }); return; }
    setBusy(true); setResult(null);
    try {
      const body = what === 'ledger'
        ? { action: 'ledger', filename: file.name, csv: await file.text() }
        : { action: 'invoice', filename: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) };
      const { ok, json } = await callFunction('velocity-import', body);
      if (!ok) { setResult({ ok: false, title: 'Nothing was imported', error: json.error || 'The upload failed', checks: json.checks }); return; }
      if (json.already_imported) setResult({ ok: true, title: 'Already imported', lines: [`This exact file was uploaded ${ago(json.uploaded_at)}. Nothing changed.`] });
      else if (what === 'ledger') {
        const m = json.bank_matching;
        setResult({ ok: !json.checks.some(c => !c.ok), title: 'Velocity ledger imported', checks: json.checks, lines: [
          `${fmtDate(json.period_from)} to ${fmtDate(json.period_to)}: ${json.line_count} lines, ${json.new_lines} new${json.duplicate_lines ? `, ${json.duplicate_lines} already stored` : ''}. Wallet ${inr(json.opening)} → ${inr(json.closing)}.`,
          `${json.topups} top-up${json.topups === 1 ? '' : 's'} worth ${inr(json.topped_up)}.`,
          m ? `Bank matching re-run: ${m.matched} matched, ${m.suggested} suggested, ${m.needs_review} need review.` : null].filter(Boolean) });
      } else {
        const a = json.against_ledger;
        setResult({ ok: true, title: `Invoice ${json.invoice_no} imported`, checks: json.checks, lines: [
          `Dated ${fmtDate(json.invoice_date)}, period ${fmtDate(json.period_from)} to ${fmtDate(json.period_to)}: ${inr(json.total)} including GST ${inr(json.tax)}.`,
          a?.has_ledger ? invoiceVerdict(a).headline : 'No ledger lines cover this period yet: upload the ledger report for it to check the invoice.'] });
      }
      setFile(null); if (input.current) input.current.value = '';
      onDone();
      if (!json.already_imported) refreshLedgerNow('the Velocity upload');       // recalculate the order ledger now, without being asked
    } catch (err) {
      setResult({ ok: false, title: 'Nothing was imported', error: err.message || String(err) });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        <label className="block text-xs text-stone-600">
          <span className="block mb-1 font-medium">What are you uploading?</span>
          <select value={what} onChange={e => { setWhat(e.target.value); setFile(null); setResult(null); if (input.current) input.current.value = ''; }} className={`${field} w-full`}>
            <option value="">Choose…</option>
            <option value="ledger">Wallet ledger report (CSV)</option>
            <option value="invoice">Monthly tax invoice (PDF)</option>
          </select>
        </label>
        <label className="block text-xs text-stone-600 min-w-0">
          <span className="block mb-1 font-medium">File</span>
          <input ref={input} type="file" accept={accept} disabled={!what || busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
            className="block w-full text-xs text-stone-700 file:mr-2 file:h-8 file:px-3 file:rounded-md file:border file:border-stone-300 file:bg-white file:text-xs file:text-stone-700 hover:file:border-stone-500 disabled:opacity-50" />
        </label>
        <button type="button" onClick={upload} disabled={!what || !file || busy}
          className="inline-flex items-center justify-center gap-1.5 h-8 px-3 text-xs rounded-md bg-stone-900 text-white disabled:opacity-40">
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}{busy ? 'Reading…' : 'Upload'}
        </button>
      </div>
      <div className="text-[11px] text-stone-500">{hint}</div>
      {result && (
        <div role="status" className={`rounded-md border px-3 py-2 text-xs ${result.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-800'}`}>
          <div className="font-medium">{result.title}</div>
          {result.error && <div className="mt-0.5">{result.error}</div>}
          {(result.lines || []).map((t, i) => <div key={i} className="mt-0.5">{t}</div>)}
          <CheckList checks={result.checks} />
        </div>
      )}
    </div>
  );
}

// ── A month's tables ────────────────────────────────────────────────────────────────────────────
function KindTable({ title, rows, total }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full min-w-[420px] text-xs">
        <thead><tr className="text-left text-stone-500 border-b border-stone-200">
          <th className="py-1.5 px-2 font-medium">{title}</th><th className="py-1.5 px-2 font-medium text-right">Lines</th>
          <th className="py-1.5 px-2 font-medium text-right">Before GST</th><th className="py-1.5 px-2 font-medium text-right">With GST</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.kind} className="border-b border-stone-100">
              <td className="py-1.5 px-2 text-stone-800">{r.label}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{r.n}</td>
              <td className="py-1.5 px-2 text-right tabular-nums text-stone-600">{r.kind === 'recharge' || r.kind === 'financial_note' ? '—' : inr(r.ex_gst)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums">{inr(r.amount)}</td>
            </tr>
          ))}
          <tr className="font-medium"><td className="py-1.5 px-2">Total</td><td /><td /><td className="py-1.5 px-2 text-right tabular-nums">{inr(total)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function TopupTable({ topups }) {
  if (!topups.length) return <div className="text-xs text-stone-500">No top-ups in this month.</div>;
  const icon = { matched: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />, not_in_bank: <AlertCircle className="w-3.5 h-3.5 text-amber-600" />, no_statement: <CircleDashed className="w-3.5 h-3.5 text-stone-400" /> };
  return (
    <div className="divide-y divide-stone-100">
      {topups.map(t => {
        const st = topupStatus(t);
        return (
          <div key={t.key} className="flex items-start gap-2 py-1.5 text-xs">
            <span className="mt-0.5 shrink-0">{icon[st]}</span>
            <span className="w-16 shrink-0 text-stone-700">{fmtDate(t.date)}</span>
            <span className="w-24 shrink-0 tabular-nums text-stone-900">{inr(t.amount)}</span>
            <span className={st === 'not_in_bank' ? 'text-amber-800' : 'text-stone-500'}>{st === 'matched' ? `Bank payment on ${fmtDate(t.bank_date)}${t.by_hand ? ' (matched by you)' : ''}` : TOPUP_STATUS_TEXT[st]}</span>
          </div>
        );
      })}
    </div>
  );
}

const TONE = { ok: 'bg-emerald-50 border-emerald-200 text-emerald-900', close: 'bg-sky-50 border-sky-200 text-sky-900', warn: 'bg-amber-50 border-amber-300 text-amber-900', neutral: 'bg-stone-50 border-stone-200 text-stone-700' };

function InvoicePanel({ invoice }) {
  if (!invoice) return <div className="text-xs text-stone-600">No Velocity invoice uploaded for this month yet. It arrives after month end: upload it above and it is checked against these charges.</div>;
  const a = invoice.against, v = invoiceVerdict(a);
  return (
    <div className="space-y-3">
      <div className="text-xs text-stone-700">
        Invoice <span className="font-mono font-medium text-stone-900">{invoice.invoice_no}</span>, dated {fmtDate(invoice.invoice_date)}, for {fmtDate(invoice.period_from)} to {fmtDate(invoice.period_to)}:
        {' '}{inr(invoice.subtotal)} + GST {inr(invoice.tax)} = <span className="font-medium text-stone-900">{inr(invoice.total)}</span>.
      </div>
      <div className={`rounded-md border px-3 py-2 text-xs ${TONE[v.tone]}`}>
        <div className="font-medium">{v.headline}</div>
        {v.vas && <div className="mt-0.5">{v.vas.text}</div>}
        {v.freight && <div className="mt-0.5">{v.freight.text}</div>}
      </div>
      {a?.has_ledger && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full min-w-[480px] text-xs">
            <thead><tr className="text-left text-stone-500 border-b border-stone-200">
              <th className="py-1.5 px-2 font-medium">Before GST</th><th className="py-1.5 px-2 font-medium text-right">Invoice</th><th className="py-1.5 px-2 font-medium text-right">Ledger</th><th className="py-1.5 px-2 font-medium text-right">Difference</th>
            </tr></thead>
            <tbody>
              {a.vas && <tr className="border-b border-stone-100"><td className="py-1.5 px-2">Delivery-failure messages (VAS)</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(a.vas.invoice)}</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(a.vas.ledger)}</td><td className="py-1.5 px-2 text-right tabular-nums">{diffInr(a.vas.diff)}</td></tr>}
              {a.freight && <tr className="border-b border-stone-100"><td className="py-1.5 px-2">Freight (closest count)</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(a.freight.invoice)}</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(a.freight.closest.ledger)}</td><td className="py-1.5 px-2 text-right tabular-nums">{diffInr(a.freight.closest.diff)}</td></tr>}
              {a.closest_total_with_gst != null && <tr className="font-medium"><td className="py-1.5 px-2">Total with GST</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(a.invoice_total)}</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(a.closest_total_with_gst)}</td><td className="py-1.5 px-2 text-right tabular-nums">{diffInr(Math.round((a.closest_total_with_gst - a.invoice_total) * 100) / 100)}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {a?.freight && (
        <details className="text-xs text-stone-600">
          <summary className="cursor-pointer text-stone-700">How the freight line was counted from the ledger</summary>
          <p className="mt-1.5 mb-1">Velocity’s invoice is not simply everything debited: it gives some credits back and not others. Every way of counting is shown, closest first.</p>
          <table className="w-full text-[11px]"><tbody>
            {a.freight.variants.map((x, i) => (
              <tr key={x.label} className={`border-b border-stone-100 ${i === 0 ? 'font-medium text-stone-900' : ''}`}>
                <td className="py-1 pr-2">{x.label}</td><td className="py-1 px-2 text-right tabular-nums">{inr(x.ledger)}</td><td className="py-1 pl-2 text-right tabular-nums">{diffInr(x.diff)}</td>
              </tr>
            ))}
          </tbody></table>
        </details>
      )}
    </div>
  );
}

// ── What has been uploaded, with a way to take each upload back ─────────────────────────────────
function UploadedList({ imports, invoices, flow, onDeleteLedger, onDeleteInvoice, logKey }) {
  return (
    <div className="space-y-3">
      {flow.panel}
      {imports.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full min-w-[560px] text-xs">
            <thead><tr className="text-left text-stone-500 border-b border-stone-200">
              <th className="py-1.5 px-2 font-medium">Ledger report</th><th className="py-1.5 px-2 font-medium">Period</th>
              <th className="py-1.5 px-2 font-medium text-right">Lines</th><th className="py-1.5 px-2 font-medium text-right">Wallet balance</th>
            </tr></thead>
            <tbody>
              {imports.map(i => (
                <tr key={i.id} className="border-b border-stone-100 align-top">
                  <td className="py-1.5 px-2"><div className="text-stone-900 truncate max-w-[16rem]" title={i.filename}>{i.filename || 'ledger report'}</div><div className="text-[11px] text-stone-500">{i.uploaded_by_name || '—'} · {ago(i.uploaded_at)}</div><div className="mt-1 -ml-2"><DeleteButton onClick={() => onDeleteLedger(i)} disabled={flow.busy} /></div></td>
                  <td className="py-1.5 px-2 whitespace-nowrap text-stone-600">{fmtDate(i.period_from)} – {fmtDate(i.period_to)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{i.line_count}<div className="text-[11px] text-stone-500">{i.new_lines} new</div></td>
                  <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{inr(i.closing)}<div className="text-[11px] text-stone-500">from {inr(i.opening)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invoices.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full min-w-[560px] text-xs">
            <thead><tr className="text-left text-stone-500 border-b border-stone-200">
              <th className="py-1.5 px-2 font-medium">Invoice</th><th className="py-1.5 px-2 font-medium">Period</th>
              <th className="py-1.5 px-2 font-medium text-right">Total with GST</th>
            </tr></thead>
            <tbody>
              {invoices.map(v => (
                <tr key={v.invoice_no} className="border-b border-stone-100 align-top">
                  <td className="py-1.5 px-2"><div className="text-stone-900">{v.invoice_no}</div><div className="text-[11px] text-stone-500">dated {fmtDate(v.invoice_date)} · uploaded {ago(v.uploaded_at)}</div><div className="mt-1 -ml-2"><DeleteButton onClick={() => onDeleteInvoice(v)} disabled={flow.busy} /></div></td>
                  <td className="py-1.5 px-2 whitespace-nowrap text-stone-600">{v.period_from ? `${fmtDate(v.period_from)} – ${fmtDate(v.period_to)}` : '—'}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{inr(v.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeletionLog kinds={['velocity_ledger', 'velocity_invoice']} refreshKey={logKey} />
    </div>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────────────────────────
export default function VelocitySection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'vpage');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { ok, json } = await callFunction('velocity-import', { action: 'reconcile' });
      if (!ok) throw new Error(json.error || 'failed');
      setData(json);
    } catch (err) { setError('Could not load the Velocity wallet'); showToast?.('Could not load the Velocity wallet', 'error'); }
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  // Taking an upload back: a dry run is shown for confirmation first (see components/UploadDelete.jsx).
  const flow = useDeleteFlow({ call: callVelocity, showToast, onDeleted: async (json) => { await load(); if (String(json?.kind || '').startsWith('velocity_')) refreshLedgerNow('removing the Velocity upload'); } });
  const deleteLedger = (i) => flow.start({ action: 'delete_ledger', import_id: i.id });
  const deleteInvoice = (v) => flow.start({ action: 'delete_invoice', invoice_no: v.invoice_no });

  const months = useMemo(() => (data?.months ?? []).map(m => m.month), [data]);
  const month = months.includes(p.vmonth) ? p.vmonth : months[months.length - 1] ?? '';
  const m = useMemo(() => (data?.months ?? []).find(x => x.month === month), [data, month]);
  const kinds = useMemo(() => splitKinds(m?.kinds), [m]);
  const monthTopups = useMemo(() => (data?.topups ?? []).filter(t => String(t.date).slice(0, 7) === month), [data, month]);
  const tc = useMemo(() => topupCounts(data?.topups, month), [data, month]);
  const reversals = useMemo(() => (m?.credits ?? 0) - kinds.credits.filter(r => r.kind === 'recharge').reduce((s, r) => s + r.amount, 0), [m, kinds]);

  // The month's lines, straight from the table (admins can read it), a page at a time.
  const [lines, setLines] = useState({ rows: [], total: 0, loading: false });
  const [q, setQ] = useState(p.vq);
  useEffect(() => { const t = setTimeout(() => { if (q !== p.vq) setP({ vq: q }); }, 300); return () => clearTimeout(t); }, [q]);   // eslint-disable-line react-hooks/exhaustive-deps
  const size = pageSizeOf(p.vsize);
  const page = clampPage(p.vpage, lines.total, size);
  useEffect(() => {
    if (!month) return;
    let live = true;
    setLines(l => ({ ...l, loading: true }));
    let query = supabase.from('velocity_wallet_lines').select('id, txn_at, direction, amount, balance, awb, notes, kind', { count: 'exact' })
      .gte('txn_date', `${month}-01`).lte('txn_date', lastDay(month));
    if (p.vkind !== 'all') query = query.eq('kind', p.vkind);
    if (p.vq.trim()) query = query.ilike('awb', `%${p.vq.trim().replace(/[%_]/g, '')}%`);
    query.order('txn_at', { ascending: false }).order('id', { ascending: false }).range((page - 1) * size, page * size - 1)
      .then(({ data: rows, count, error: err }) => { if (live) setLines({ rows: err ? [] : rows ?? [], total: err ? 0 : count ?? 0, loading: false }); });
    return () => { live = false; };
  }, [month, p.vkind, p.vq, page, size, data]);

  const kindPills = useMemo(() => [{ id: 'all', label: 'All' }, ...[...kinds.debits, ...kinds.credits].map(r => ({ id: r.kind, label: r.label, count: r.n }))], [kinds]);

  if (loading && !data) return <div className="text-sm text-stone-500 px-1 py-6">Loading the Velocity wallet…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Velocity wallet</h2>
          <div className="text-[11px] text-stone-500">Top-ups are advances; the monthly invoice is the expense. Nothing here posts to Tally.</div>
        </div>
        <button type="button" onClick={load} disabled={loading} className="shrink-0 inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <LedgerRefreshStatus />

      <Collapsible id="velocity-help" title="How this page works" icon={<Info className="w-4 h-4 text-stone-400" />}>
        <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
          <li>Velocity takes each charge from your prepaid wallet as it happens, <b>GST included</b>, and sends one tax invoice after month end. So a top-up is an <b>advance</b> and the invoice is the <b>expense</b>.</li>
          <li>Upload the dashboard’s <b>Ledger Report</b> (CSV). It is refused if its balance column does not follow from its amounts, and re-uploading overlapping reports never doubles a line.</li>
          <li>Each top-up is matched to the bank payment that funded it. One with no bank payment was probably paid from another account (for example, personally): it is a company expense owed to whoever paid.</li>
          <li>A wrong upload can be taken back from <b>Uploaded files</b>: you see what would change before anything is deleted.</li>
          <li>Upload each month’s <b>tax invoice</b> (PDF) to check it against that month’s charges. The delivery-failure messages should match to the paisa. Velocity’s freight line counts some credits and not others, so every way of counting is shown.</li>
        </ul>
      </Collapsible>

      <Collapsible id="velocity-upload" title="Upload a report or invoice" icon={<FileText className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen() || !months.length}
        summary={data?.imports?.length ? `${data.imports.length} ledger report${data.imports.length === 1 ? '' : 's'} stored` : 'nothing uploaded yet'}>
        <UploadPanel onDone={load} />
      </Collapsible>

      {((data?.imports?.length ?? 0) + (data?.invoices?.length ?? 0) > 0 || flow.pending) && (
        <Collapsible id="velocity-uploads" title="Uploaded files" icon={<ListChecks className="w-4 h-4 text-stone-400" />} defaultOpen={Boolean(flow.pending)}
          count={(data?.imports?.length ?? 0) + (data?.invoices?.length ?? 0)} summary="delete an upload to take its lines back">
          <UploadedList imports={data?.imports ?? []} invoices={data?.invoices ?? []} flow={flow} onDeleteLedger={deleteLedger} onDeleteInvoice={deleteInvoice}
            logKey={(data?.imports?.length ?? 0) + (data?.invoices?.length ?? 0)} />
        </Collapsible>
      )}

      {data?.gaps?.length > 0 && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-300 rounded px-3 py-2">
          <div className="font-medium flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" />A ledger report is missing</div>
          {data.gaps.map(g => <div key={g.import_id} className="mt-0.5">The report from {fmtDate(g.period_from)} opens at {inr(g.opening)}, but the lines stored before it leave the wallet at {inr(g.expected)}. Upload the report that covers the gap.</div>)}
        </div>
      )}

      {!months.length ? (
        <div className="bg-white rounded-lg border border-stone-200"><EmptyState title="No wallet ledger uploaded yet" hint="Download the Ledger Report from the Velocity dashboard (one month at a time is fine) and upload it above." /></div>
      ) : (
        <>
          <Collapsible id="velocity-month" title="Month" icon={<ListChecks className="w-4 h-4 text-stone-400" />} defaultOpen summary={monthLabel(month)}>
            <Pills value={month} onChange={id => setP({ vmonth: id, vkind: 'all', vq: '' })} options={months.map(x => ({ id: x, label: monthLabel(x) }))} />
          </Collapsible>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Opening balance" value={inr(m.opening)} sub="wallet at the start" />
            <StatCard label="Top-ups" value={inr(tc.amount)} sub={`${tc.total} payment${tc.total === 1 ? '' : 's'}${tc.not_in_bank ? ` · ${tc.not_in_bank} not in the bank` : ''}`} tone={tc.not_in_bank ? 'text-amber-800' : 'text-stone-900'} />
            <StatCard label="Charges" value={inr(m.debits)} sub="taken from the wallet, with GST" />
            <StatCard label="Credits back" value={inr(reversals)} sub="reversals and lost-shipment credits" tone="text-emerald-800" />
            <StatCard label="Closing balance" value={inr(m.closing)} sub="wallet at the end" tone={m.closing < 0 ? 'text-red-700' : 'text-stone-900'} />
          </div>

          <Collapsible id="velocity-invoice" title="Invoice check" icon={<FileText className="w-4 h-4 text-stone-400" />} defaultOpen
            tone={m.invoice ? (invoiceVerdict(m.invoice.against).tone === 'warn' ? 'amber' : 'neutral') : 'neutral'}
            summary={m.invoice ? `${m.invoice.invoice_no}` : 'no invoice yet'}>
            <InvoicePanel invoice={m.invoice} />
          </Collapsible>

          <Collapsible id="velocity-topups" title="Top-ups against the bank" icon={<Wallet className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen()} count={tc.total}
            tone={tc.not_in_bank ? 'amber' : 'neutral'} summary={tc.total ? `${tc.matched} in the bank${tc.not_in_bank ? `, ${tc.not_in_bank} not` : ''}${tc.no_statement ? `, ${tc.no_statement} unchecked` : ''}` : null}>
            <TopupTable topups={monthTopups} />
          </Collapsible>

          <Collapsible id="velocity-kinds" title="Charges and credits by type" icon={<ListChecks className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen()}>
            <div className="space-y-4">
              <KindTable title="Charges" rows={kinds.debits} total={m.debits} />
              <KindTable title="Credits" rows={kinds.credits} total={m.credits} />
            </div>
          </Collapsible>

          <div className="bg-white rounded-lg border border-stone-200">
            <div className="p-3 sm:p-4 space-y-3 border-b border-stone-100">
              <div className="text-sm font-medium text-stone-900">Ledger lines, {monthLabel(month)}</div>
              <Pills value={p.vkind} onChange={id => setP({ vkind: id })} options={kindPills} size="sm" />
              <div className="relative w-56 max-w-full">
                <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Tracking number" aria-label="Search by tracking number" className={`${field} pl-7 pr-6 w-full`} />
                {q && <button onClick={() => { setQ(''); setP({ vq: '' }); }} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>}
              </div>
            </div>
            <div className="p-3 sm:p-4">
              {lines.rows.length === 0 ? (
                <EmptyState title={lines.loading ? 'Loading…' : 'No lines match'} hint={lines.loading ? '' : 'Nothing fits these filters.'} />
              ) : (
                <>
                  <div className="overflow-x-auto -mx-1">
                    <table className="w-full min-w-[560px] text-xs">
                      <thead><tr className="text-left text-stone-500 border-b border-stone-200">
                        <th className="py-1.5 px-2 font-medium">When</th><th className="py-1.5 px-2 font-medium">What</th><th className="py-1.5 px-2 font-medium">Tracking number</th>
                        <th className="py-1.5 px-2 font-medium text-right">Amount</th><th className="py-1.5 px-2 font-medium text-right">Balance</th>
                      </tr></thead>
                      <tbody>
                        {lines.rows.map(l => (
                          <tr key={l.id} className="border-b border-stone-100">
                            <td className="py-1.5 px-2 whitespace-nowrap text-stone-600">{fmtDate(l.txn_at)} {String(l.txn_at).slice(11, 16)}</td>
                            <td className="py-1.5 px-2 text-stone-800">{KIND_LABEL[l.kind] ?? l.kind}</td>
                            <td className="py-1.5 px-2 font-mono text-stone-600">{l.awb || '—'}</td>
                            <td className={`py-1.5 px-2 text-right tabular-nums whitespace-nowrap ${l.direction === 'credit' ? 'text-emerald-800' : 'text-stone-900'}`}>{l.direction === 'credit' ? '+' : '−'}{inr(l.amount)}</td>
                            <td className="py-1.5 px-2 text-right tabular-nums text-stone-500">{inr(l.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pagination page={page} pageSize={size} total={lines.total} noun="lines" onPage={n => setP({ vpage: n })} onPageSize={n => setP({ vsize: n })} />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
