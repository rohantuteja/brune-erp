import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { refreshLedgerNow } from '../lib/ledgerRefreshNow';
import LedgerRefreshStatus from '../components/LedgerRefreshStatus';
import { sortRows, clampPage, pageSizeOf } from '../lib/analyticsKit';
import { effectiveRange, statusCounts, payeeGroups, bucketTotals, signed, toBase64 } from '../lib/financeView';
import { DateRange, Pagination, Collapsible, SortTh, StatCard, FilterChips, Pills, EmptyState, downloadCsv, useUrlParams, wideScreen } from '../components/AnalyticsKit';
import { useDeleteFlow, DeleteButton, DeletionLog } from '../components/UploadDelete';
import { RefreshCw, Upload, FileSpreadsheet, Search, X, Download, Info, Landmark, Tags, ListChecks, CheckCircle2, AlertCircle, Undo2, Check } from 'lucide-react';

// Analytics → Bank & card (admin only). Upload the bank statement (Excel), the credit card statement (PDF) and GoKwik's
// settlement report (CSV); every line is matched to what it is, and the rest is filed by a person under a bucket.
// Rules and design: docs/bank-reconciliation.md. Nothing here posts to Tally.

const START_DATE = '2026-10-01';       // app_settings.accounting_start_date: the books before it are closed
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const RPC_CHUNK = 1000;                // the filing functions take at most 1000 lines per call

const URL_DEFAULTS = { bstatus: 'todo', bacct: '', bflow: 'all', bbucket: '', bq: '', bfrom: '', bto: '', ball: '', bsort: '', bdir: '', bpage: '1', bsize: '25' };

const STATUS_FILTERS = [
  { id: 'todo',         label: 'To do' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'suggested',    label: 'Suggested' },
  { id: 'matched',      label: 'Matched' },
  { id: 'ignored',      label: 'No entry needed' },
  { id: 'all',          label: 'All' },
];
const STATUS_LABEL = { needs_review: 'Needs review', suggested: 'Suggested', matched: 'Matched', ignored: 'No entry needed' };
const STATUS_STYLE = {
  needs_review: 'bg-amber-50 text-amber-900 border-amber-300',
  suggested:    'bg-sky-50 text-sky-800 border-sky-200',
  matched:      'bg-emerald-50 text-emerald-800 border-emerald-200',
  ignored:      'bg-stone-100 text-stone-600 border-stone-200',
};
const IN_STATUS = {
  all: () => true,
  todo: l => l.status === 'needs_review' || l.status === 'suggested',
  needs_review: l => l.status === 'needs_review',
  suggested: l => l.status === 'suggested',
  matched: l => l.status === 'matched',
  ignored: l => l.status === 'ignored',
};
const KIND_GROUP = { expense: 'Expenses', asset: 'Assets', liability: 'Liabilities', income: 'Income', transfer: 'Payouts and transfers', ignore: 'No entry needed', review: 'To confirm' };

const inr = (n, digits = 2) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
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

const signedInr = (l) => { const v = signed(l); return `${v < 0 ? '−' : '+'}${inr(Math.abs(v))}`; };

const SORT_KEY = {
  date: l => l.txn_date,
  what: l => l.remarks,
  bucket: l => l.bucket,
  status: l => STATUS_LABEL[l.status],
  amount: l => Math.abs(signed(l)),
};

const callImport = (body) => callFunction('finance-import', body);

/** Run a filing function over any number of lines, 1000 at a time. */
async function inChunks(rpc, ids, extra = {}) {
  let done = 0;
  for (let i = 0; i < ids.length; i += RPC_CHUNK) {
    const { data, error } = await supabase.rpc(rpc, { p_ids: ids.slice(i, i + RPC_CHUNK), ...extra });
    if (error) throw new Error(error.message);
    done += Number(data) || 0;
  }
  return done;
}

const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';

function BucketSelect({ buckets, value, onChange, label = 'Bucket', placeholder = 'Choose a bucket…', className = '' }) {
  const groups = useMemo(() => {
    const by = new Map();
    for (const b of buckets) (by.get(b.kind) ?? by.set(b.kind, []).get(b.kind)).push(b);
    return [...by.entries()].map(([kind, list]) => ({ kind, list }));
  }, [buckets]);
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className={`${field} ${className}`}>
      <option value="">{placeholder}</option>
      {groups.map(g => (
        <optgroup key={g.kind} label={KIND_GROUP[g.kind] || g.kind}>
          {g.list.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function StatusBadge({ status }) {
  return <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap ${STATUS_STYLE[status] || STATUS_STYLE.ignored}`}>{STATUS_LABEL[status] || status}</span>;
}

// ── Upload ──────────────────────────────────────────────────────────────────────────────────────
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

function UploadPanel({ accounts, onDone }) {
  const [target, setTarget] = useState('');           // an account id, or 'gokwik'
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);         // { ok, title, lines[], checks, error }
  const input = useRef(null);

  const account = accounts.find(a => a.id === target);
  const accept = target === 'gokwik' ? '.csv' : account?.kind === 'card' ? '.pdf' : account?.kind === 'bank' ? '.xlsx' : '.xlsx,.pdf,.csv';
  const hint = target === 'gokwik' ? 'GoKwik’s rawSettlementReport (CSV). It proves each prepaid payout in the bank.'
    : account?.kind === 'card' ? 'The card statement PDF, as the bank sends it.'
    : account?.kind === 'bank' ? 'The bank’s detailed statement in Excel (.xlsx). Overlapping uploads are fine: lines already stored are kept.'
    : 'Choose what you are uploading first.';

  const upload = async () => {
    if (!target || !file) return;
    if (file.size > MAX_UPLOAD_BYTES) { setResult({ ok: false, title: 'That file is too large', error: `Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB are accepted.` }); return; }
    setBusy(true); setResult(null);
    try {
      const body = target === 'gokwik'
        ? { action: 'gokwik', filename: file.name, csv: await file.text() }
        : { action: 'statement', account_id: target, filename: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) };
      const { ok, json } = await callImport(body);
      if (!ok) { setResult({ ok: false, title: 'Nothing was imported', error: json.error || 'The upload failed', checks: json.checks }); return; }
      if (json.already_imported) {
        setResult({ ok: true, title: 'Already imported', lines: [`This exact file was uploaded ${ago(json.uploaded_at)}. Nothing changed.`] });
      } else if (target === 'gokwik') {
        setResult({ ok: true, title: 'GoKwik report imported', checks: json.checks, lines: [
          `${json.payments} payments (${json.new_payments} new), in ${json.payouts} bank transfers worth ${inr(json.to_bank)}.`,
          json.settled_from ? `Settled ${fmtDate(json.settled_from)} to ${fmtDate(json.settled_to)}.` : null,
          matchingLine(json.matching)].filter(Boolean) });
      } else {
        setResult({ ok: true, title: `${json.account} imported`, checks: json.checks, lines: [
          `${fmtDate(json.period_from)} to ${fmtDate(json.period_to)}: ${json.line_count} lines, ${json.new_lines} new${json.duplicate_lines ? `, ${json.duplicate_lines} already stored` : ''}.`,
          matchingLine(json.matching)].filter(Boolean) });
      }
      setFile(null); if (input.current) input.current.value = '';
      onDone();
      // A GoKwik report decides which orders are paid out: recalculate the ledger now, without being asked (a bank statement does not change it).
      if (target === 'gokwik' && !json.already_imported) refreshLedgerNow('the GoKwik upload');
    } catch (err) {
      setResult({ ok: false, title: 'Nothing was imported', error: err.message || String(err) });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        <label className="block text-xs text-stone-600">
          <span className="block mb-1 font-medium">What are you uploading?</span>
          <select value={target} onChange={e => { setTarget(e.target.value); setFile(null); setResult(null); if (input.current) input.current.value = ''; }} className={`${field} w-full`}>
            <option value="">Choose…</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name} statement</option>)}
            <option value="gokwik">GoKwik settlement report</option>
          </select>
        </label>
        <label className="block text-xs text-stone-600 min-w-0">
          <span className="block mb-1 font-medium">File</span>
          <input ref={input} type="file" accept={accept} disabled={!target || busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
            className="block w-full text-xs text-stone-700 file:mr-2 file:h-8 file:px-3 file:rounded-md file:border file:border-stone-300 file:bg-white file:text-xs file:text-stone-700 hover:file:border-stone-500 disabled:opacity-50" />
        </label>
        <button type="button" onClick={upload} disabled={!target || !file || busy}
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

const matchingLine = (m) => m ? `Matching now: ${m.matched} matched, ${m.suggested} suggested, ${m.needs_review} need review, ${m.ignored} need no entry.` : null;

// ── Statements already uploaded ─────────────────────────────────────────────────────────────────
function StatementsList({ statements, accountName, gokwik, gokwikReports, flow, onDeleteStatement, onDeleteGokwik, logKey }) {
  return (
    <div className="space-y-3">
      {flow.panel}
      {statements.length === 0 ? <div className="text-xs text-stone-500">No statement uploaded yet.</div> : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full min-w-[640px] text-xs">
            <thead><tr className="text-left text-stone-500 border-b border-stone-200">
              <th className="py-1.5 px-2 font-medium">Account</th><th className="py-1.5 px-2 font-medium">Period</th>
              <th className="py-1.5 px-2 font-medium text-right">Lines</th><th className="py-1.5 px-2 font-medium text-right">Balance</th>
              <th className="py-1.5 px-2 font-medium">Checks</th><th className="py-1.5 px-2 font-medium">Uploaded</th>
            </tr></thead>
            <tbody>
              {statements.map(s => {
                const bad = (s.checks || []).filter(c => !c.ok).length;
                return (
                  <tr key={s.id} className="border-b border-stone-100 align-top">
                    <td className="py-1.5 px-2"><div className="text-stone-900">{accountName(s.account_id)}</div><div className="text-[11px] text-stone-500 truncate max-w-[14rem]" title={s.filename}>{s.filename}</div><div className="mt-1 -ml-2"><DeleteButton onClick={() => onDeleteStatement(s)} disabled={flow.busy} /></div></td>
                    <td className="py-1.5 px-2 whitespace-nowrap text-stone-600">{fmtDate(s.period_from)} – {fmtDate(s.period_to)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{s.line_count}<div className="text-[11px] text-stone-500">{s.new_lines} new</div></td>
                    <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{s.closing != null ? inr(s.closing) : '—'}<div className="text-[11px] text-stone-500">{s.opening != null ? `from ${inr(s.opening)}` : 'amount due'}</div></td>
                    <td className="py-1.5 px-2 whitespace-nowrap">{bad ? <span className="text-red-700">{bad} failed</span> : <span className="text-emerald-700">{(s.checks || []).length} passed</span>}</td>
                    <td className="py-1.5 px-2 whitespace-nowrap text-stone-600">{s.uploaded_by_name || '—'}<div className="text-[11px] text-stone-500">{ago(s.uploaded_at)}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {gokwikReports.length > 0 ? (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full min-w-[560px] text-xs">
            <thead><tr className="text-left text-stone-500 border-b border-stone-200">
              <th className="py-1.5 px-2 font-medium">GoKwik report</th><th className="py-1.5 px-2 font-medium text-right">Payments</th>
              <th className="py-1.5 px-2 font-medium">Settled</th><th className="py-1.5 px-2 font-medium text-right">To the bank</th>
            </tr></thead>
            <tbody>
              {gokwikReports.map(g => (
                <tr key={g.source_file} className="border-b border-stone-100 align-top">
                  <td className="py-1.5 px-2"><div className="text-[11px] text-stone-700 truncate max-w-[18rem]" title={g.source_file}>{g.source_file}</div><div className="text-[11px] text-stone-500">uploaded {ago(g.imported_at)}</div><div className="mt-1 -ml-2"><DeleteButton onClick={() => onDeleteGokwik(g)} disabled={flow.busy} /></div></td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{g.payments}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap text-stone-600">{fmtDate(g.settled_from)} – {fmtDate(g.settled_to)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{inr(g.to_bank)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-[11px] text-stone-500">
          GoKwik report: {gokwik.count ? `${gokwik.count} payments loaded${gokwik.latest ? `, settled up to ${fmtDate(gokwik.latest)}` : ''}.` : 'not uploaded yet, so prepaid payouts cannot be proved.'}
        </div>
      )}
      <DeletionLog kinds={['statement', 'gokwik_report']} refreshKey={logKey} />
    </div>
  );
}

// ── Label by payee ──────────────────────────────────────────────────────────────────────────────
function PayeeGroupRow({ group, buckets, busy, onFile }) {
  const [bucket, setBucket] = useState(group.hint || '');
  return (
    <div className="py-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-medium text-stone-900 break-words">{group.payee}</span>
          <span className="text-stone-500">{group.count} line{group.count === 1 ? '' : 's'}</span>
          <span className="tabular-nums text-stone-700">{group.out ? `${inr(group.out)} out` : ''}{group.out && group.in ? ' · ' : ''}{group.in ? `${inr(group.in)} in` : ''}</span>
        </div>
        <div className="text-[11px] text-stone-500 truncate" title={group.sample}>{group.sample}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <BucketSelect buckets={buckets} value={bucket} onChange={setBucket} label={`Bucket for ${group.payee}`} className="w-52 max-w-full" />
        <button type="button" disabled={!bucket || busy} onClick={() => onFile(group.ids, bucket)}
          className="h-8 px-2.5 text-xs rounded-md bg-stone-900 text-white disabled:opacity-40 whitespace-nowrap">File all {group.count}</button>
      </div>
    </div>
  );
}

function PayeePanel({ groups, buckets, busy, onFile }) {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, 10);
  return (
    <div>
      <p className="text-xs text-stone-600 mb-1">Pick where each payee belongs once. Every line to that payee is filed, and future uploads follow without asking.</p>
      <div className="divide-y divide-stone-100">
        {shown.map(g => <PayeeGroupRow key={g.payee} group={g} buckets={buckets} busy={busy} onFile={onFile} />)}
      </div>
      {groups.length > 10 && <button type="button" onClick={() => setAll(a => !a)} className="mt-2 text-xs text-stone-600 underline hover:text-stone-900">{all ? 'Show fewer' : `Show all ${groups.length} payees`}</button>}
    </div>
  );
}

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────
function Amounts({ l }) {
  const out = Number(l.debit), inn = Number(l.credit);
  return out ? <span className="text-stone-900">−{inr(out)}</span> : <span className="text-emerald-800">+{inr(inn)}</span>;
}

function LineRow({ l, accountName, selected, onSelect }) {
  return (
    <tr className={`border-b border-stone-100 align-top ${selected ? 'bg-sky-50/60' : 'hover:bg-stone-50'}`}>
      <td className="py-2 pl-2 pr-1"><input type="checkbox" checked={selected} onChange={() => onSelect(l.id)} aria-label={`Select line of ${fmtDate(l.txn_date)}, ${signedInr(l)}`} className="mt-0.5" /></td>
      <td className="py-2 px-2 whitespace-nowrap text-stone-600">{fmtDate(l.txn_date)}</td>
      <td className="py-2 px-2 text-xs text-stone-600 min-w-[260px] max-w-[26rem]">
        <div className="text-stone-800 break-words">{l.remarks}</div>
        {l.reason && <div className="text-[11px] text-stone-500 mt-0.5">{l.reason}</div>}
        <div className="text-[11px] text-stone-400 mt-0.5">{accountName(l.account_id)}{l.needs_bill ? ' · needs the vendor’s bill for GST credit' : ''}</div>
      </td>
      <td className="py-2 px-2 text-xs"><StatusBadge status={l.status} /><div className="text-stone-700 mt-1">{l.bucket || <span className="text-stone-400">no bucket yet</span>}</div></td>
      <td className="py-2 px-2 text-right tabular-nums whitespace-nowrap"><Amounts l={l} /></td>
    </tr>
  );
}

function LineCard({ l, accountName, selected, onSelect }) {
  return (
    <div className={`border-b border-stone-100 p-3 ${selected ? 'bg-sky-50/60' : ''}`}>
      <div className="flex items-start gap-2">
        <input type="checkbox" checked={selected} onChange={() => onSelect(l.id)} aria-label={`Select line of ${fmtDate(l.txn_date)}, ${signedInr(l)}`} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-stone-600">{fmtDate(l.txn_date)} · {accountName(l.account_id)}</span>
            <span className="tabular-nums font-medium"><Amounts l={l} /></span>
          </div>
          <div className="text-xs text-stone-800 mt-1 break-words">{l.remarks}</div>
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            <StatusBadge status={l.status} />
            <span className="text-[11px] text-stone-700">{l.bucket || <span className="text-stone-400">no bucket yet</span>}</span>
          </div>
          {l.reason && <div className="text-[11px] text-stone-500 mt-1">{l.reason}</div>}
        </div>
      </div>
    </div>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────────────────────────
export default function BankSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'bpage');
  const [accounts, setAccounts] = useState([]);
  const [buckets, setBuckets] = useState([]);
  const [statements, setStatements] = useState([]);
  const [lines, setLines] = useState([]);
  const [gokwik, setGokwik] = useState({ count: 0, latest: null });
  const [gokwikReports, setGokwikReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [working, setWorking] = useState(false);
  const [bulkBucket, setBulkBucket] = useState('');
  const [remember, setRemember] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [acc, bk, st, gc, gl, gr] = await Promise.all([
        supabase.from('finance_accounts').select('id, name, kind, holder').order('name'),
        supabase.from('finance_buckets').select('name, kind, needs_bill, note, sort').order('sort'),
        supabase.from('finance_statements').select('id, account_id, filename, period_from, period_to, opening, closing, line_count, new_lines, duplicate_lines, checks, uploaded_by_name, uploaded_at').order('uploaded_at', { ascending: false }),
        supabase.from('gokwik_payments').select('payment_id', { count: 'exact', head: true }),
        supabase.from('gokwik_payments').select('settlement_date').not('settlement_date', 'is', null).order('settlement_date', { ascending: false }).limit(1),
        supabase.rpc('gokwik_reports'),
      ]);
      for (const r of [acc, bk, st]) if (r.error) throw new Error(r.error.message);
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error: err } = await supabase.from('finance_lines')
          .select('id, account_id, txn_date, remarks, debit, credit, status, kind, bucket, match_ref, reason, needs_bill, payee, decided_at, decided_by_name')
          .order('txn_date', { ascending: false }).order('id', { ascending: false }).range(from, from + 999);
        if (err) throw new Error(err.message);
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      setAccounts(acc.data || []); setBuckets(bk.data || []); setStatements(st.data || []); setLines(all);
      setGokwik({ count: gc.count || 0, latest: gl.data?.[0]?.settlement_date ?? null });
      setGokwikReports(gr.error ? [] : gr.data || []);
    } catch (err) {
      setError('Could not load the bank lines'); showToast?.('Could not load the bank lines', 'error');
    }
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  // Taking an upload back: a dry run is shown for confirmation first (see components/UploadDelete.jsx).
  const flow = useDeleteFlow({ call: callImport, showToast, onDeleted: async (json) => { setSelected(new Set()); await load(); if (json?.kind === 'gokwik_report') refreshLedgerNow('removing the GoKwik report'); } });
  const deleteStatement = (st) => flow.start({ action: 'delete_statement', statement_id: st.id });
  const deleteGokwik = (g) => flow.start({ action: 'delete_gokwik', source_file: g.source_file });

  const accountName = useCallback((id) => accounts.find(a => a.id === id)?.name ?? '—', [accounts]);

  // What the page is about: the dates (the books start on the accounting start date unless told otherwise) and the account.
  const [from, to] = effectiveRange({ from: p.bfrom, to: p.bto, all: !!p.ball }, START_DATE);
  const scoped = useMemo(() => lines.filter(l =>
    (!from || l.txn_date >= from) && (!to || l.txn_date <= to) && (!p.bacct || l.account_id === p.bacct)), [lines, from, to, p.bacct]);
  const beforeStart = useMemo(() => lines.filter(l => l.txn_date < START_DATE).length, [lines]);

  const counts = useMemo(() => statusCounts(scoped), [scoped]);
  const todoCount = counts.needs_review[0] + counts.suggested[0];
  const moneyIn = useMemo(() => scoped.reduce((s, l) => s + Number(l.credit), 0), [scoped]);
  const moneyOut = useMemo(() => scoped.reduce((s, l) => s + Number(l.debit), 0), [scoped]);
  const groups = useMemo(() => payeeGroups(scoped), [scoped]);
  const byBucket = useMemo(() => bucketTotals(scoped.filter(l => l.status !== 'needs_review' || l.bucket)), [scoped]);

  const q = p.bq.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = scoped.filter(IN_STATUS[p.bstatus] ?? IN_STATUS.all)
      .filter(l => p.bflow === 'in' ? Number(l.credit) > 0 : p.bflow === 'out' ? Number(l.debit) > 0 : true)
      .filter(l => !p.bbucket || (p.bbucket === '__none' ? !l.bucket : l.bucket === p.bbucket))
      .filter(l => !q || [l.remarks, l.payee, l.bucket, l.match_ref, String(Number(l.debit) || Number(l.credit))].some(v => v && String(v).toLowerCase().includes(q)));
    return p.bsort && SORT_KEY[p.bsort] ? sortRows(list, SORT_KEY[p.bsort], p.bdir === 'desc' ? 'desc' : 'asc') : list;      // the load order is newest first
  }, [scoped, p.bstatus, p.bflow, p.bbucket, q, p.bsort, p.bdir]);

  const statusPills = useMemo(() => STATUS_FILTERS.map(f => ({ ...f, count: scoped.filter(IN_STATUS[f.id]).length })), [scoped]);

  const size = pageSizeOf(p.bsize);
  const page = clampPage(p.bpage, shown.length, size);
  const pageRows = shown.slice((page - 1) * size, page * size);

  // Selection only counts lines that are still on the list.
  const shownIds = useMemo(() => new Set(shown.map(l => l.id)), [shown]);
  const picked = useMemo(() => [...selected].filter(id => shownIds.has(id)), [selected, shownIds]);
  const pickedLines = useMemo(() => { const set = new Set(picked); return shown.filter(l => set.has(l.id)); }, [shown, picked]);
  const pickedMoney = pickedLines.reduce((s, l) => s + signed(l), 0);
  const pageAllOn = pageRows.length > 0 && pageRows.every(l => selected.has(l.id));
  const toggle = (id) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePage = () => setSelected(prev => { const n = new Set(prev); for (const l of pageRows) { if (pageAllOn) n.delete(l.id); else n.add(l.id); } return n; });
  const selectAllShown = () => setSelected(new Set(shown.map(l => l.id)));

  const act = async (fn, okMessage) => {
    setWorking(true);
    try { const n = await fn(); showToast?.(okMessage(n), 'success'); setSelected(new Set()); await load(); }
    catch (err) { showToast?.(`Could not save: ${err.message || err}`, 'error'); setError(`Could not save: ${err.message || err}`); }
    setWorking(false);
  };
  // Remembering a payee only stores the rule; re-matching applies it to that payee's other open lines straight away.
  const fileLines = (ids, bucket, rememberPayee) => act(async () => {
    const n = await inChunks('finance_line_assign', ids, { p_bucket: bucket, p_remember: rememberPayee });
    if (rememberPayee) {
      const { ok, json } = await callImport({ action: 'rematch' });
      if (!ok) throw new Error(`the lines are filed, but re-matching failed: ${json.error || 'unknown error'}`);
    }
    return n;
  }, n => `Filed ${n} line${n === 1 ? '' : 's'} under ${bucket}${rememberPayee ? ' and remembered the payee' : ''}`);
  const confirmPicked = () => act(() => inChunks('finance_line_confirm', picked), n => `Confirmed ${n} line${n === 1 ? '' : 's'}`);
  const reopen = () => act(() => inChunks('finance_line_reset', picked), n => `Reopened ${n} line${n === 1 ? '' : 's'}`);
  const rematch = async () => {
    setWorking(true);
    try {
      const { ok, json } = await callImport({ action: 'rematch' });
      if (!ok) throw new Error(json.error || 'failed');
      showToast?.(matchingLine(json), 'success'); await load();
    } catch (err) { showToast?.(`Could not re-run matching: ${err.message || err}`, 'error'); }
    setWorking(false);
  };

  const onSort = (id) => setP(p.bsort === id ? { bsort: id, bdir: p.bdir === 'desc' ? 'asc' : 'desc' } : { bsort: id, bdir: id === 'date' || id === 'amount' ? 'desc' : 'asc' });
  const goTo = (status) => { setP({ bstatus: status }); setSelected(new Set()); };
  const rangeLabel = from || to ? `${from ? fmtDate(from) : 'start'} to ${to ? fmtDate(to) : 'today'}` : 'All dates';

  const csv = () => downloadCsv(`bank-lines-${p.bstatus}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Date', 'Account', 'Description', 'Money out', 'Money in', 'Status', 'Bucket', 'Why'],
    shown.map(l => [l.txn_date, accountName(l.account_id), l.remarks, l.debit, l.credit, STATUS_LABEL[l.status], l.bucket, l.reason]));

  const chips = [
    p.ball ? { key: 'all', label: 'All dates', onRemove: () => setP({ ball: '' }) } : (p.bfrom || p.bto) ? { key: 'date', label: `Dated ${rangeLabel}`, onRemove: () => setP({ bfrom: '', bto: '' }) } : null,
    p.bstatus !== 'todo' ? { key: 'status', label: STATUS_FILTERS.find(f => f.id === p.bstatus)?.label || p.bstatus, onRemove: () => setP({ bstatus: 'todo' }) } : null,
    p.bacct ? { key: 'acct', label: accountName(p.bacct), onRemove: () => setP({ bacct: '' }) } : null,
    p.bflow !== 'all' ? { key: 'flow', label: p.bflow === 'in' ? 'Money in' : 'Money out', onRemove: () => setP({ bflow: 'all' }) } : null,
    p.bbucket ? { key: 'bucket', label: p.bbucket === '__none' ? 'No bucket yet' : p.bbucket, onRemove: () => setP({ bbucket: '' }) } : null,
    p.bq ? { key: 'q', label: `Search “${p.bq}”`, onRemove: () => setP({ bq: '' }) } : null,
  ].filter(Boolean);
  const clearAll = () => { setP({ bfrom: '', bto: '', ball: '', bstatus: 'todo', bacct: '', bflow: 'all', bbucket: '', bq: '' }); setSelected(new Set()); };

  if (loading && !lines.length && !statements.length) return <div className="text-sm text-stone-500 px-1 py-6">Loading the bank lines…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Bank & card</h2>
          <div className="text-[11px] text-stone-500">Statements are read line by line and matched to payouts, invoices and your rules. Nothing here posts to Tally yet.</div>
        </div>
        <div className="shrink-0 flex gap-1.5">
          <button type="button" onClick={rematch} disabled={working || loading} className="h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50" title="Run the matching again with the latest payouts, invoices and rules">Re-match</button>
          <button type="button" onClick={load} disabled={loading} className="inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <LedgerRefreshStatus />

      <Collapsible id="bank-help" title="How this page works" icon={<Info className="w-4 h-4 text-stone-400" />}>
        <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
          <li>Upload the ICICI statement (Excel), the Kotak card statement (PDF) and GoKwik’s settlement report (CSV). A file that does not add up is refused, and uploading the same lines twice never doubles them.</li>
          <li>After a GoKwik report is uploaded (or taken back) the order ledger is recalculated automatically, so its payouts show on Analytics → Ledger within a couple of minutes; the progress is shown at the top of this page.</li>
          <li><b>Matched</b> lines are proved: a GoKwik or Velocity payout, a Meta invoice payment, or a payee you filed before. <b>Suggested</b> lines are the system’s guess; confirm or refile them. <b>Needs review</b> lines have no guess.</li>
          <li>When you file a line it is yours: re-matching never changes it. Tick <i>Remember this payee</i> to file every future line to the same payee automatically.</li>
          <li>The founder’s card: its purchases are company expenses the company owes him. Paying the card bill from the founder’s own money needs no company entry.</li>
          <li>A wrong upload can be taken back from <i>Statements uploaded</i>: you see what would change before anything is deleted, and the matching is re-run afterwards.</li>
          <li>Dates start at {fmtDate(START_DATE)}, the accounting start date. {beforeStart ? `${beforeStart} earlier line${beforeStart === 1 ? ' is' : 's are'} stored; choose “All dates” to see them.` : ''}</li>
        </ul>
      </Collapsible>

      <Collapsible id="bank-upload" title="Upload a statement" icon={<FileSpreadsheet className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen() || lines.length === 0}
        summary={statements.length ? `${statements.length} uploaded` : 'nothing uploaded yet'}>
        <UploadPanel accounts={accounts} onDone={load} />
      </Collapsible>

      <Collapsible id="bank-statements" title="Statements uploaded" icon={<Landmark className="w-4 h-4 text-stone-400" />} count={statements.length}>
        <StatementsList statements={statements} accountName={accountName} gokwik={gokwik} gokwikReports={gokwikReports} flow={flow}
          onDeleteStatement={deleteStatement} onDeleteGokwik={deleteGokwik} logKey={statements.length + gokwikReports.length} />
      </Collapsible>

      <Collapsible id="bank-scope" title="Dates and account" icon={<ListChecks className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen()}
        summary={`${rangeLabel}${p.bacct ? ` · ${accountName(p.bacct)}` : ''}`}>
        <div className="space-y-3">
          <DateRange label="Dated" from={from} to={to} onChange={(f, t) => (!f && !t) ? setP({ ball: '1', bfrom: '', bto: '' }) : setP({ ball: '', bfrom: f, bto: t })} />
          <Pills size="sm" value={p.bacct} onChange={id => setP({ bacct: id })} options={[{ id: '', label: 'All accounts' }, ...accounts.map(a => ({ id: a.id, label: a.name }))]} />
        </div>
      </Collapsible>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Needs review" value={counts.needs_review[0]} sub={`${inr(counts.needs_review[1], 0)} with no guess`} tone={counts.needs_review[0] ? 'text-amber-800' : 'text-stone-500'} active={p.bstatus === 'needs_review'} onClick={() => goTo('needs_review')} />
        <StatCard label="Suggested" value={counts.suggested[0]} sub={`${inr(counts.suggested[1], 0)} to confirm`} tone="text-sky-800" active={p.bstatus === 'suggested'} onClick={() => goTo('suggested')} />
        <StatCard label="Matched" value={counts.matched[0]} sub={`${inr(counts.matched[1], 0)} proved or filed`} tone="text-emerald-800" active={p.bstatus === 'matched'} onClick={() => goTo('matched')} />
        <StatCard label="No entry needed" value={counts.ignored[0]} sub={`${inr(counts.ignored[1], 0)} returned or personal`} active={p.bstatus === 'ignored'} onClick={() => goTo('ignored')} />
      </div>
      <div className="text-[11px] text-stone-500 px-0.5">{rangeLabel}: {scoped.length} lines · money in {inr(moneyIn)} · money out {inr(moneyOut)}</div>

      {groups.length > 0 && (
        <Collapsible id="bank-payees" title="Label by payee" tone="amber" defaultOpen={wideScreen()} count={groups.length} icon={<Tags className="w-4 h-4 text-amber-700" />}
          summary={`${groups.reduce((n, g) => n + g.count, 0)} lines wait on a decision`}>
          <PayeePanel groups={groups} buckets={buckets} busy={working} onFile={(ids, bucket) => fileLines(ids, bucket, true)} />
        </Collapsible>
      )}

      {byBucket.length > 0 && (
        <Collapsible id="bank-buckets" title="By bucket" icon={<Tags className="w-4 h-4 text-stone-400" />} count={byBucket.length} summary="where the money went and came from">
          <div className="divide-y divide-stone-100">
            {byBucket.map(b => (
              <button key={b.bucket ?? '__none'} type="button" onClick={() => { setP({ bbucket: b.bucket ?? '__none', bstatus: 'all' }); }}
                className="w-full flex items-center justify-between gap-3 py-1.5 text-xs text-left hover:bg-stone-50 rounded px-1">
                <span className="text-stone-800 min-w-0 truncate">{b.bucket ?? 'No bucket yet'} <span className="text-stone-400">· {b.count}</span></span>
                <span className="tabular-nums text-stone-700 shrink-0">{b.out ? `−${inr(b.out)}` : ''}{b.out && b.in ? '  ' : ''}{b.in ? <span className="text-emerald-800">+{inr(b.in)}</span> : ''}</span>
              </button>
            ))}
          </div>
        </Collapsible>
      )}

      <div className="bg-white rounded-lg border border-stone-200">
        <div className="p-3 sm:p-4 space-y-3 border-b border-stone-100">
          <Pills value={p.bstatus} onChange={goTo} options={statusPills} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input value={p.bq} onChange={e => setP({ bq: e.target.value })} placeholder="Payee, narration or amount" aria-label="Search lines" className={`${field} pl-7 pr-6 w-56 max-w-full`} />
              {p.bq && <button onClick={() => setP({ bq: '' })} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>}
            </div>
            <Pills size="sm" value={p.bflow} onChange={id => setP({ bflow: id })} options={[{ id: 'all', label: 'In and out' }, { id: 'in', label: 'Money in' }, { id: 'out', label: 'Money out' }]} />
            <span className="flex-1" />
            {shown.length > 0 && <button type="button" onClick={csv} className="inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500"><Download className="w-3.5 h-3.5" />CSV ({shown.length})</button>}
          </div>
          <FilterChips chips={chips} onClearAll={clearAll} />
        </div>

        {picked.length > 0 && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 bg-stone-900 text-white text-xs">
            <span className="font-medium">{picked.length} selected</span>
            <span className="text-stone-300 tabular-nums">{pickedMoney < 0 ? `−${inr(-pickedMoney)}` : inr(pickedMoney)}</span>
            {picked.length < shown.length && <button type="button" onClick={selectAllShown} className="underline text-stone-200 hover:text-white">Select all {shown.length}</button>}
            <span className="flex-1" />
            <BucketSelect buckets={buckets} value={bulkBucket} onChange={setBulkBucket} label="File selected lines under" placeholder="File under…" className="w-48 max-w-full text-stone-900" />
            <label className="inline-flex items-center gap-1 text-stone-200"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Remember payee</label>
            <button type="button" disabled={!bulkBucket || working} onClick={() => fileLines(picked, bulkBucket, remember)} className="h-8 px-2.5 rounded-md bg-white text-stone-900 disabled:opacity-40">File</button>
            <button type="button" disabled={working} onClick={confirmPicked} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-500 hover:border-white disabled:opacity-40"><Check className="w-3.5 h-3.5" />Confirm suggestions</button>
            <button type="button" disabled={working} onClick={reopen} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-500 hover:border-white disabled:opacity-40"><Undo2 className="w-3.5 h-3.5" />Reopen</button>
            <button type="button" onClick={() => setSelected(new Set())} aria-label="Clear selection" className="p-1 text-stone-300 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        )}

        <div className="p-3 sm:p-4">
          {shown.length === 0 ? (
            lines.length === 0
              ? <EmptyState title="No statement uploaded yet" hint="Upload the bank statement above and its lines appear here, already matched where the system can prove them." />
              : <EmptyState title={p.bstatus === 'todo' && !chips.length ? 'Nothing left to decide' : 'No lines match'} hint={chips.length ? 'Nothing fits these filters.' : 'Every line in these dates is matched.'} action={chips.length ? { label: 'Clear filters', onClick: clearAll } : null} />
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto -mx-1">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="text-xs border-b border-stone-200">
                      <th scope="col" className="py-1.5 pl-2 pr-1 w-8"><input type="checkbox" checked={pageAllOn} onChange={togglePage} aria-label="Select all lines on this page" /></th>
                      <SortTh label="Date" id="date" sort={p.bsort} dir={p.bdir} onSort={onSort} />
                      <SortTh label="Narration" id="what" sort={p.bsort} dir={p.bdir} onSort={onSort} />
                      <SortTh label="Status and bucket" id="bucket" sort={p.bsort} dir={p.bdir} onSort={onSort} />
                      <SortTh label="Amount" id="amount" sort={p.bsort} dir={p.bdir} onSort={onSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(l => <LineRow key={l.id} l={l} accountName={accountName} selected={selected.has(l.id)} onSelect={toggle} />)}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden -mx-3 sm:-mx-4 border-t border-stone-100">
                <div className="flex items-center justify-between px-3 py-2 text-xs">
                  <label className="inline-flex items-center gap-1.5 text-stone-600"><input type="checkbox" checked={pageAllOn} onChange={togglePage} />Select page</label>
                  <label className="inline-flex items-center gap-1.5 text-stone-600">Sort
                    <select value={p.bsort} onChange={e => setP({ bsort: e.target.value, bdir: e.target.value === 'date' || e.target.value === 'amount' ? 'desc' : 'asc' })} className={field}>
                      <option value="">Newest first</option><option value="date">Date</option><option value="amount">Amount</option><option value="bucket">Bucket</option><option value="status">Status</option>
                    </select></label>
                </div>
                {pageRows.map(l => <LineCard key={l.id} l={l} accountName={accountName} selected={selected.has(l.id)} onSelect={toggle} />)}
              </div>
              <Pagination page={page} pageSize={size} total={shown.length} noun="lines" onPage={n => setP({ bpage: n })} onPageSize={n => setP({ bsize: n })} />
            </>
          )}
        </div>
      </div>
      {todoCount === 0 && lines.length > 0 && scoped.length > 0 && <div className="text-[11px] text-emerald-800 px-0.5">Every line in {rangeLabel.toLowerCase()} is matched or needs no entry.</div>}
    </div>
  );
}
