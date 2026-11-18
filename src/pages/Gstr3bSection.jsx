import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { localToday } from '../lib/constants';
import { accountingStart } from '../lib/gstData';
import { buildGstReport, monthsBetween, monthLabel } from '../lib/gstReport';
import { buildGstr3b, HEADS, HEAD_LABEL, MYNTRA_GSTIN } from '../lib/gstr3b';
import { fetchGstr3bMonth, saveOpening, saveTwoB, deleteTwoB, markFiled, unmarkFiled } from '../lib/gstr3bData';
import { resolveOpening, filedSnapshot, changedSinceFiled, nextMonth } from '../lib/gstr3bCredit';
import { parseGstr2bFile, availableTotals } from '../lib/gstr2b';
import { buildGstr3bSheets, buildUploadSheet, gstr3bFileName } from '../lib/gstr3bWorkbook';
import { downloadXlsx } from '../lib/xlsxWrite';
import { Collapsible, StatCard, useUrlParams } from '../components/AnalyticsKit';
import { DocTable, defaultMonth } from './GstSection';
import { Download, Info, CheckCircle2, AlertCircle, AlertTriangle, RotateCcw, Upload, Trash2, FileText } from 'lucide-react';

// Analytics → GSTR-3B. A working sheet for the month's return, from the order ledger (outward supplies), the accepted supplier bills and
// the gateway / Myntra GST lines (input credit), GSTR-2B (what may be claimed) and the credit carried in. It files nothing.
// Rules and reasoning: docs/gstr3b-view.md.

const URL_DEFAULTS = { g3month: '' };
const inr = (n, digits = 0) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const amt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace('-', '−');
const dash = (n) => (Math.abs(n || 0) < 0.005 ? '–' : amt(n));
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
};
const fmtStamp = (t) => { if (!t) return ''; const dt = new Date(t); return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); };
const sum = (x) => Math.round(((x?.igst || 0) + (x?.cgst || 0) + (x?.sgst || 0)) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[,\s₹]/g, '')); return Number.isFinite(n) ? n : NaN; };

const CHECK_STYLE = {
  ok:    { icon: CheckCircle2,  cls: 'text-emerald-700' },
  info:  { icon: Info,          cls: 'text-sky-700' },
  warn:  { icon: AlertTriangle, cls: 'text-amber-700' },
  error: { icon: AlertCircle,   cls: 'text-red-700' },
};
const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';
const btn = 'inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50';
const btnDark = 'inline-flex items-center gap-1 h-8 px-3 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40';

function Checks({ checks }) {
  return (
    <ul className="space-y-1">
      {checks.map(c => {
        const s = CHECK_STYLE[c.level] || CHECK_STYLE.info; const Icon = s.icon;
        return <li key={`${c.id}-${c.text.slice(0, 20)}`} className="flex items-start gap-2 text-xs text-stone-700"><Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${s.cls}`} /><span>{c.text}</span></li>;
      })}
    </ul>
  );
}

function Section({ n, title, caption, children, right }) {
  return (
    <section className="bg-white rounded-lg border border-stone-200">
      <div className="px-3 sm:px-4 py-2.5 border-b border-stone-100 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-stone-900"><span className="text-stone-400 mr-1.5">{n}</span>{title}</h3>
          {caption && <div className="text-[11px] text-stone-500 mt-0.5 max-w-3xl">{caption}</div>}
        </div>
        {right}
      </div>
      <div className="px-3 sm:px-4 py-3 space-y-3">{children}</div>
    </section>
  );
}

// A table of amounts by tax head. `rows`: [{ key, label, heads, tone, strong, sign, note }]
function HeadTable({ rows, first = '' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-stone-500 border-b border-stone-200">
          <th className="py-1.5 pr-2 text-left font-medium">{first}</th>
          {HEADS.map(k => <th key={k} className="py-1.5 px-2 text-right font-medium">{HEAD_LABEL[k]}</th>)}
          <th className="py-1.5 pl-2 text-right font-medium">Total</th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className={`border-b border-stone-100 ${r.strong ? 'font-semibold bg-stone-50 border-t border-stone-300' : ''} ${r.tone || ''}`}>
              <td className="py-1.5 pr-2 min-w-[10rem]">{r.label}{r.note && <div className="text-[11px] font-normal text-stone-500">{r.note}</div>}</td>
              {HEADS.map(k => <td key={k} className="py-1.5 px-2 text-right tabular-nums">{r.sign ? (Math.abs(r.heads[k]) < 0.005 ? '–' : `${r.sign}${amt(Math.abs(r.heads[k]))}`) : dash(r.heads[k])}</td>)}
              <td className="py-1.5 pl-2 text-right tabular-nums">{r.sign ? (Math.abs(sum(r.heads)) < 0.005 ? '–' : `${r.sign}${amt(Math.abs(sum(r.heads)))}`) : dash(sum(r.heads))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── GSTR-2B: load, check, keep ─────────────────────────────────────────────────────────────────────────────────────
// A proper component: it holds the picked file and the parse result.
function TwoBPanel({ month, stored, storeMissing, sessionOnly, onSaved, onRemoved, onSession, showToast }) {
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  useEffect(() => { setParsed(null); setErr(''); }, [month]);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr(''); setParsed(null); setBusy(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('This file is larger than 20 MB: it is not a GSTR-2B.');
      setParsed(await parseGstr2bFile(file.name, new Uint8Array(await file.arrayBuffer())));
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };

  const problems = parsed ? [
    ...(parsed.period && parsed.period !== month ? [`This file is for ${monthLabel(parsed.period)}, not ${monthLabel(month)}. Pick ${monthLabel(parsed.period)} at the top, or load the right file.`] : []),
    ...(!parsed.docs.length ? ['The file has no invoices or credit notes in it.'] : []),
  ] : [];
  const totals = parsed ? availableTotals(parsed.docs) : null;

  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (storeMissing) onSession(parsed);
      else { await saveTwoB(supabase, month, parsed); await onSaved(); showToast?.(`GSTR-2B for ${monthLabel(month)} kept`, 'success'); }
      setParsed(null);
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true); setErr('');
    try { if (storeMissing) onSession(null); else { await deleteTwoB(supabase, month); await onRemoved(); } }
    catch (ex) { setErr(ex.message); }
    setBusy(false);
  };

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-stone-900 flex items-center gap-1.5"><FileText className="w-3.5 h-3.5 text-stone-500" />GSTR-2B for {monthLabel(month)}</div>
        <div className="flex items-center gap-2">
          <input ref={input} type="file" accept=".json,.xlsx,application/json" className="hidden" onChange={pick} aria-label="GSTR-2B file" />
          <button type="button" className={btn} disabled={busy} onClick={() => input.current?.click()}><Upload className="w-3.5 h-3.5" />{stored ? 'Load another file' : 'Load the file'}</button>
          {stored && <button type="button" className={`${btn} text-red-700`} disabled={busy} onClick={remove}><Trash2 className="w-3.5 h-3.5" />Remove</button>}
        </div>
      </div>

      {stored && !parsed && (
        <div className="text-xs text-stone-700">
          Loaded: <b>{stored.fileName || 'a file'}</b>, {stored.docs.length} line{stored.docs.length === 1 ? '' : 's'}
          {stored.generatedOn && <> · generated {fmtDate(stored.generatedOn)}</>}
          {stored.uploadedAt && <> · {sessionOnly ? 'loaded for this visit only' : `kept by ${stored.uploadedBy || 'someone'} on ${fmtStamp(stored.uploadedAt)}`}</>}
        </div>
      )}
      {!stored && !parsed && (
        <div className="text-xs text-stone-600 leading-relaxed">
          Only credit that is in GSTR-2B can be claimed. On the GST portal: Returns Dashboard → choose {monthLabel(month)} → GSTR-2B → <b>Download</b> (the JSON or the Excel file). The file is read here in your browser; only its invoice and credit note lines are kept, not the file.
        </div>
      )}
      {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">{err}</div>}

      {parsed && (
        <div className="space-y-2 bg-white border border-stone-200 rounded-md px-3 py-2.5">
          <div className="text-xs text-stone-800"><b>{parsed.fileName}</b> was read. Nothing is kept until you press Save.</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-[11px] text-stone-600">
            <div>GSTIN <span className="text-stone-900">{parsed.gstin || 'not in the file'}</span></div>
            <div>For month <span className="text-stone-900">{parsed.period ? monthLabel(parsed.period) : 'not in the file'}</span></div>
            <div>Lines <span className="text-stone-900">{parsed.docs.length}</span></div>
            <div>Credit available <span className="text-stone-900">{inr(sum(totals), 2)}</span></div>
          </div>
          <ul className="space-y-1">
            {parsed.checks.map(c => <li key={c.id} className="flex items-start gap-2 text-xs text-stone-700">{c.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-700" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-700" />}<span>{c.detail}</span></li>)}
            {parsed.warnings.map(w => <li key={w} className="flex items-start gap-2 text-xs text-stone-700"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sky-700" /><span>{w}</span></li>)}
            {!parsed.period && <li className="flex items-start gap-2 text-xs text-stone-700"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sky-700" /><span>The file does not say which month it is for. Check that it is the GSTR-2B for {monthLabel(month)} before saving.</span></li>}
            {problems.map(p => <li key={p} className="flex items-start gap-2 text-xs text-red-700"><AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{p}</span></li>)}
          </ul>
          <div className="flex items-center gap-2 pt-1">
            <button type="button" className={btnDark} disabled={busy || problems.length > 0} onClick={save}>{storeMissing ? `Use for ${monthLabel(month)} (this visit only)` : stored ? `Replace the file for ${monthLabel(month)}` : `Save for ${monthLabel(month)}`}</button>
            <button type="button" className={btn} disabled={busy} onClick={() => { setParsed(null); setErr(''); }}>Cancel</button>
          </div>
        </div>
      )}
      {storeMissing && <div className="text-[11px] text-amber-800">Keeping the file between visits needs the database update for this screen (migration 044), which has not been applied yet. Until then the file is used for this visit only.</div>}
    </div>
  );
}

// ── The credit carried into the month ──────────────────────────────────────────────────────────────────────────────
function OpeningForm({ month, opening, storeMissing, onSave }) {
  const [v, setV] = useState({ igst: '', cgst: '', sgst: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setV({ igst: opening ? String(opening.igst) : '', cgst: opening ? String(opening.cgst) : '', sgst: opening ? String(opening.sgst) : '', note: opening?.note || '' });
    setErr('');
  }, [month, opening]);
  const parsed = { igst: v.igst === '' ? 0 : num(v.igst), cgst: v.cgst === '' ? 0 : num(v.cgst), sgst: v.sgst === '' ? 0 : num(v.sgst) };
  const bad = HEADS.some(k => !Number.isFinite(parsed[k]) || parsed[k] < 0);
  const same = opening && HEADS.every(k => Math.abs(opening[k] - parsed[k]) < 0.005) && (opening.note || '') === v.note;
  const submit = async () => {
    setBusy(true); setErr('');
    try { await onSave({ ...parsed, note: v.note }); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-3 space-y-2">
      <div className="text-xs font-medium text-stone-900">Correct the credit carried into {monthLabel(month)}</div>
      <div className="text-[11px] text-stone-600">Only if the portal's electronic credit ledger (Services → Ledgers) shows a different balance than the one above, for example by tax head. Normally nothing needs typing: the ERP carries each filed return's closing credit forward by itself.</div>
      <div className="flex flex-wrap items-end gap-2">
        {HEADS.map(k => (
          <label key={k} className="text-[11px] text-stone-600">{HEAD_LABEL[k]}
            <input value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} inputMode="decimal" placeholder="0" className={`${field} block w-32 mt-0.5 text-right tabular-nums`} aria-label={`${HEAD_LABEL[k]} credit carried in`} />
          </label>
        ))}
        <label className="text-[11px] text-stone-600 flex-1 min-w-[10rem]">Note (optional)
          <input value={v.note} onChange={e => setV({ ...v, note: e.target.value })} placeholder="e.g. from the portal on 20 Nov" className={`${field} block w-full mt-0.5`} />
        </label>
        <button type="button" className={btnDark} disabled={busy || bad || same} onClick={submit}>{storeMissing ? 'Use for this visit' : 'Save'}</button>
      </div>
      {bad && <div className="text-xs text-red-700">Each balance must be a number, zero or more.</div>}
      {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">{err}</div>}
      {storeMissing && <div className="text-[11px] text-amber-800">Remembering this needs the database update for this screen (migration 044), which has not been applied yet.</div>}
    </div>
  );
}

// ── The credit ledger the ERP keeps: opening, claimed, used, closing, and recording the return as filed ─────────────
// A proper component: it holds the confirm step and the correction form.
export function CreditLedgerPanel({ r, month, resolved, canWrite, storeMissing, onMarkFiled, onUnmarkFiled, onCorrect }) {
  const P = r.payment;
  const [confirm, setConfirm] = useState(false);
  const [fix, setFix] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setConfirm(false); setFix(false); setErr(''); }, [month]);
  const filed = resolved.filed;
  const next = nextMonth(month);
  const spent = Object.fromEntries(HEADS.map(c => [c, HEADS.reduce((t, k) => t + P.used[k][c], 0)]));
  const changed = useMemo(() => changedSinceFiled(filed?.figures, r), [filed, r]);
  const can = canWrite && r.itc.hasTwoB && r.openingSet;

  const run = async (fn) => { setBusy(true); setErr(''); try { await fn(); setConfirm(false); } catch (e) { setErr(e.message); } setBusy(false); };

  return (
    <div className="space-y-2">
      <HeadTable first={`Credit ledger, ${monthLabel(month)}`} rows={[
        { key: 'open', label: 'Opening', note: r.openingSet ? resolved.text : `${resolved.text}: counted as nil`, heads: P.opening },
        { key: 'claim', label: '+ Claimed this month', note: r.itc.hasTwoB ? 'all of GSTR-2B' : 'in your books, not checked against GSTR-2B', heads: P.claim },
        { key: 'spent', label: '− Used to pay tax on sales', heads: { igst: -spent.igst, cgst: -spent.cgst, sgst: -spent.sgst } },
        { key: 'close', label: `Closing: carries into ${monthLabel(next)}`, heads: P.closing, strong: true },
      ]} />

      {filed ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><CheckCircle2 className="inline w-3.5 h-3.5 mr-1" />Recorded as filed on <b>{fmtStamp(filed.at)}</b>{filed.by ? ` by ${filed.by}` : ''}: <b>{inr(sum(filed.closing), 2)}</b> of credit carries into {monthLabel(next)} by itself.</span>
            {canWrite && <button type="button" className={btn} disabled={busy} onClick={() => run(onUnmarkFiled)}>Undo</button>}
          </div>
          {changed.length > 0 && <div className="text-amber-900"><AlertTriangle className="inline w-3.5 h-3.5 mr-1" />Changed since you filed: {changed.map(c => `${c.what} (${HEAD_LABEL[c.head]}) was ${amt(c.was)}, now ${amt(c.now)}`).join('; ')}. The credit carried forward is the filed one.</div>}
        </div>
      ) : (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 space-y-2">
          {!confirm ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-stone-700">After you file {monthLabel(month)}'s GSTR-3B on the portal, record it here: its closing credit then becomes {monthLabel(next)}'s opening, with nothing to type.</span>
              <button type="button" className={btnDark} disabled={!can || busy} onClick={() => setConfirm(true)} title={!r.itc.hasTwoB ? 'Load the GSTR-2B first' : !r.openingSet ? 'There is no opening credit to carry' : ''}>I filed {monthLabel(month)}'s return with these figures</button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs text-stone-800">
              <span>This records the figures above as filed ({inr(P.cashTotal, 2)} paid in cash) and carries <b>{inr(sum(P.closing), 2)}</b> of credit into {monthLabel(next)}.</span>
              <button type="button" className={btnDark} disabled={busy} onClick={() => run(onMarkFiled)}>Yes, record it</button>
              <button type="button" className={btn} disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          )}
          {!r.itc.hasTwoB && <div className="text-[11px] text-stone-500">Load the GSTR-2B first (section 2): the figures are only final once the credit comes from it.</div>}
          <button type="button" className="text-[11px] text-stone-500 underline hover:text-stone-800" onClick={() => setFix(f => !f)}>The portal shows a different balance? Correct the opening</button>
        </div>
      )}
      {err && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">{err}</div>}
      {fix && !filed && <OpeningForm month={month} opening={resolved.opening} storeMissing={storeMissing} onSave={async (v) => { await onCorrect(v); setFix(false); }} />}
      {storeMissing && <div className="text-[11px] text-amber-800">Keeping the credit ledger needs the database update for this screen, which has not been applied yet.</div>}
    </div>
  );
}

// ── The report for one month (no data loading here: the container passes a built report) ──────────────────────────
export function Gstr3bView({ r, months, month, onMonth, onExport, loading, error, onReload, panel, creditPanel, onExportUploads }) {
  const T = r?.itc.twoB;
  const L = r?.itc.lists;
  const itcRows = useMemo(() => {
    if (!r) return [];
    const C = r.itc.claim;
    if (T) {
      return [
        { key: 'claim', label: 'Claimable this month: all of what GSTR-2B shows', note: 'GSTR-2B is the source of truth, so every line it lists as available is claimed (Table 4(A)(5))', heads: C, strong: true },
        { key: 'withBill', label: 'of which: invoices that have a bill in the ERP', heads: T.withBill, tone: 'text-stone-500' },
        { key: 'suppliers', label: 'of which: gateway and Myntra', note: 'booked at each payout and settlement', heads: T.suppliers, tone: 'text-stone-500' },
        ...(sum(T.notes) ? [{ key: 'notes', label: 'of which: credit / debit notes from suppliers', heads: T.notes, tone: 'text-stone-500' }] : []),
        { key: 'noBill', label: 'of which: invoices with no bill in the ERP yet', note: 'upload them: the list is below', heads: T.noBill, tone: sum(T.noBill) ? 'text-amber-800' : 'text-stone-500' },
        { key: 'books', label: 'For comparison: your books this month', note: 'accepted bills dated in the month + gateway and Myntra lines', heads: r.itc.books.total, tone: 'text-stone-500' },
      ];
    }
    return [
      { key: 'bills', label: `Accepted bills dated this month (${r.itc.books.billCount})`, heads: r.itc.books.bills },
      ...r.itc.books.groups.filter(g => g.lines).map(g => ({ key: g.id, label: g.name, note: `${g.lines} ledger line${g.lines === 1 ? '' : 's'}`, heads: g.heads })),
      { key: 'claim', label: 'In your books (not checked against GSTR-2B)', heads: C, strong: true },
    ];
  }, [r, T]);

  const P = r?.payment;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">GSTR-3B</h2>
          <div className="text-[11px] text-stone-500">A working sheet for the month's return: tax to pay, credit to claim, and what to check first.</div>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => onMonth(e.target.value)} className={field} aria-label="Month">
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button type="button" onClick={onReload} disabled={loading} title="Read everything again" className={btn}><RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Reload</button>
          <button type="button" onClick={onExport} disabled={!r || loading} title="Everything for the month as an Excel file" className={btnDark}><Download className="w-3.5 h-3.5" /> Download Excel</button>
        </div>
      </div>

      <div className="text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 leading-relaxed">
        This does not file anything. Since July 2025 the portal fills <b>Tables 3.1 and 3.2</b> from your GSTR-1 and they cannot be edited, so section 1 is a cross-check of what it will show. <b>Table 4</b> (input credit) is claimed as GSTR-2B shows it, which is the source of truth even where a supplier's bill has not reached you: load it in section 2. Section 4 shows what is left to pay.
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {loading && !r && <div className="text-sm text-stone-500 px-1 py-6">Loading {monthLabel(month)}…</div>}

      {r && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            <StatCard label="Tax on sales" value={inr(r.outward.tax, 2)} sub={`IGST ${inr(r.outward.igst, 2)} · CGST ${inr(r.outward.cgst, 2)} · SGST ${inr(r.outward.sgst, 2)}`} />
            <StatCard label={T ? 'Credit to claim (GSTR-2B)' : 'Credit in your books'} value={inr(sum(r.itc.claim), 2)} tone={T ? 'text-emerald-800' : 'text-amber-800'} sub={T ? (L.toUpload.length ? `${L.toUpload.length} bill${L.toUpload.length === 1 ? '' : 's'} still to upload` : 'every invoice has its bill') : 'not checked against GSTR-2B yet'} />
            <StatCard label="Cash to pay" value={inr(P.cashTotal, 2)} tone={P.cashTotal > 0 ? 'text-red-700' : 'text-emerald-800'} sub={`after ${inr(P.itcUsedTotal, 2)} paid with credit`} />
            <StatCard label="Credit left after this return" value={inr(P.closingTotal, 2)} sub={r.openingSet ? 'carried to next month' : 'credit carried in is not entered'} />
          </div>

          <Checks checks={r.checks} />

          <Section n="1" title="Outward supplies" caption="Tables 3.1 and 3.2. The portal fills these from GSTR-1; this is what it should show. Net of credit notes, on the order date (see the GST tab).">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-stone-500 border-b border-stone-200">
                  <th className="py-1.5 pr-2 text-left font-medium">Table 3.1</th>
                  <th className="py-1.5 px-2 text-right font-medium">Taxable value</th>
                  {HEADS.map(k => <th key={k} className="py-1.5 px-2 text-right font-medium">{HEAD_LABEL[k]}</th>)}
                </tr></thead>
                <tbody>
                  <tr className="border-b border-stone-100 font-medium">
                    <td className="py-1.5 pr-2 min-w-[14rem]">(a) Outward taxable supplies (other than zero rated, nil rated and exempted)</td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{amt(r.outward.taxable)}</td>
                    {HEADS.map(k => <td key={k} className="py-1.5 px-2 text-right tabular-nums">{dash(r.outward[k])}</td>)}
                  </tr>
                  <tr><td colSpan={5} className="py-1.5 pr-2 text-stone-500">(b) zero rated, (c) nil rated or exempt, (d) reverse charge, (e) non-GST: nothing from the ERP. If you have any of these, tell your accountant.</td></tr>
                </tbody>
              </table>
            </div>
            <Collapsible id="g3-32" title="Table 3.2: by state" count={r.interstate.rows.length} summary={`${inr(r.interstate.taxable)} taxable · IGST ${inr(r.interstate.igst, 2)}`}>
              {r.interstate.rows.length === 0 ? <div className="text-xs text-stone-500">No inter-state sales in {monthLabel(month)}.</div> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-stone-500 border-b border-stone-200"><th className="py-1.5 pr-2 text-left font-medium">Place of supply</th><th className="py-1.5 px-2 text-right font-medium">Taxable value</th><th className="py-1.5 px-2 text-right font-medium">Integrated tax</th></tr></thead>
                    <tbody>
                      {r.interstate.rows.map(x => <tr key={x.stateCode} className="border-b border-stone-100"><td className="py-1.5 pr-2">{x.state}<span className="text-stone-400 ml-1">{x.stateCode}</span></td><td className="py-1.5 px-2 text-right tabular-nums">{amt(x.taxable)}</td><td className="py-1.5 px-2 text-right tabular-nums">{amt(x.igst)}</td></tr>)}
                    </tbody>
                    <tfoot><tr className="font-semibold border-t-2 border-stone-300 bg-stone-50"><td className="py-2 pr-2">Total</td><td className="py-2 px-2 text-right tabular-nums">{amt(r.interstate.taxable)}</td><td className="py-2 px-2 text-right tabular-nums">{amt(r.interstate.igst)}</td></tr></tfoot>
                  </table>
                </div>
              )}
              <div className="text-[11px] text-stone-500 mt-2">Home-state sales ({inr(r.intra.taxable)} taxable, CGST + SGST) are not in this table.</div>
            </Collapsible>
          </Section>

          <Section n="2" title="Input tax credit" caption="Table 4. GSTR-2B is the source of truth: the credit claimed is what suppliers have filed, even if their bill has not reached the ERP yet. Bills are matched to it by supplier GSTIN and invoice number; the payment gateway and Myntra by supplier.">
            {panel}
            <HeadTable first="Table 4(A)(5): all other ITC" rows={itcRows} />
            {T && (
              <>
                <Collapsible id="g3-upload" title="Bills to upload" count={L.toUpload.length} tone={L.toUpload.length ? 'amber' : 'neutral'} defaultOpen={L.toUpload.length > 0}
                  summary={L.toUpload.length ? 'in GSTR-2B, no bill in the ERP: upload each on the Bills page' : 'every invoice in GSTR-2B has its bill'}>
                  {L.toUpload.length === 0 ? <div className="text-xs text-stone-500">Every invoice in GSTR-2B has a bill in the ERP.</div> : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-stone-600">{L.toUpload.length} invoice{L.toUpload.length === 1 ? '' : 's'} from {new Set(L.toUpload.map(x => x.gstin)).size} supplier{new Set(L.toUpload.map(x => x.gstin)).size === 1 ? '' : 's'}, {inr(sum(L.toUpload.reduce((a, x) => ({ igst: a.igst + x.twoB.igst, cgst: a.cgst + x.twoB.cgst, sgst: a.sgst + x.twoB.sgst }), { igst: 0, cgst: 0, sgst: 0 })), 2)} of tax. Their credit is already claimed.</div>
                        <button type="button" className={btn} onClick={onExportUploads}><Download className="w-3.5 h-3.5" /> Download this list</button>
                      </div>
                      <DocTable rows={[...L.toUpload].sort((a, b) => String(a.vendor).localeCompare(String(b.vendor)) || String(a.date).localeCompare(String(b.date)))} noun="invoices" columns={[
                        { label: 'Supplier', cell: x => <>{x.vendor}{!x.knownVendor && <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-sky-100 text-sky-900">new vendor</span>}</> },
                        { label: 'GSTIN', muted: true, cell: x => x.gstin }, { label: 'Invoice', cell: x => x.no }, { label: 'Date', cell: x => fmtDate(x.date) },
                        { label: 'Taxable', right: true, cell: x => amt(x.taxable) }, { label: 'Tax', right: true, cell: x => amt(sum(x.twoB)) }, { label: 'Invoice value', right: true, cell: x => amt(x.value) },
                        { label: '', muted: true, cell: x => x.why === 'gateway' ? 'for the gateway fee tie-out' : '' },
                      ]} />
                    </div>
                  )}
                </Collapsible>
                <Collapsible id="g3-matched" title="Bills matched to GSTR-2B" count={L.matched.length + L.differs.length} tone={L.differs.length ? 'amber' : 'neutral'} summary={L.differs.length ? `${L.differs.length} differ` : 'all agree'}>
                  <DocTable rows={[...L.differs, ...L.matched]} noun="bills" columns={[
                    { label: 'Supplier', cell: x => x.vendor }, { label: 'Invoice', cell: x => x.no }, { label: 'Date', cell: x => fmtDate(x.date) },
                    { label: 'Tax on the bill', right: true, cell: x => amt(x.tax) }, { label: 'Tax in 2B', right: true, cell: x => amt(sum(x.twoB)) },
                    { label: '', muted: true, cell: x => L.differs.includes(x) ? 'differs: the 2B figure is claimed' : '' },
                  ]} />
                </Collapsible>
                <Collapsible id="g3-no2b" title="Bills not in GSTR-2B" count={L.notIn2b.length} tone={L.notIn2b.length ? 'amber' : 'neutral'} summary="the supplier has not filed them yet: not claimed this month (followed up on the Supplier filing tab)">
                  <DocTable rows={L.notIn2b} noun="bills" columns={[
                    { label: 'Supplier', cell: x => x.vendor }, { label: 'Invoice', cell: x => x.no }, { label: 'Date', cell: x => fmtDate(x.date) }, { label: 'Tax', right: true, cell: x => amt(x.tax) },
                  ]} />
                </Collapsible>
                {L.notes.length > 0 && (
                  <Collapsible id="g3-notes" title="Credit and debit notes from suppliers" count={L.notes.length} summary="they reduce (or add to) the credit">
                    <DocTable rows={L.notes} noun="notes" columns={[
                      { label: 'Supplier', cell: x => x.vendor || x.gstin }, { label: 'Number', cell: x => x.no }, { label: 'Date', cell: x => fmtDate(x.date) },
                      { label: 'What', muted: true, cell: x => x.kind === 'credit_note' ? 'Credit note' : 'Debit note' }, { label: 'Tax', right: true, cell: x => amt(sum(x.twoB)) },
                    ]} />
                  </Collapsible>
                )}
              </>
            )}
            <Collapsible id="g3-held" title="Bills waiting for your review" count={L.held.length} tone={L.held.length ? 'amber' : 'neutral'} summary={T ? 'claimed from GSTR-2B: accept them on the Bills page' : 'not claimed until accepted on the Bills page'}>
              <DocTable rows={L.held} noun="bills" columns={[
                { label: 'Supplier', cell: x => x.vendor }, { label: 'Invoice', cell: x => x.no }, { label: 'Date', cell: x => fmtDate(x.date) }, { label: 'Tax', right: true, cell: x => amt(x.tax) },
                { label: '', muted: true, cell: x => x.in2b ? 'in GSTR-2B' : '' },
              ]} />
            </Collapsible>
            {T && (L.unavailable.length + L.rcm.length > 0) && (
              <Collapsible id="g3-left" title="Left out by GSTR-2B" count={L.unavailable.length + L.rcm.length} summary="ITC not available, or reverse charge">
                <DocTable rows={[...L.unavailable.map(x => ({ ...x, what: 'ITC not available' })), ...L.rcm.map(x => ({ ...x, what: 'Reverse charge' }))]} noun="lines" columns={[
                  { label: 'Supplier', cell: x => x.vendor || x.gstin }, { label: 'Number', cell: x => x.no }, { label: 'Date', cell: x => fmtDate(x.date) },
                  { label: 'What', muted: true, cell: x => x.what }, { label: 'Reason', muted: true, cell: x => x.reason || '' }, { label: 'Tax', right: true, cell: x => amt(sum(x.twoB)) },
                ]} />
              </Collapsible>
            )}
            <Collapsible id="g3-suppliers" title="Gateway and Myntra, by supplier" count={r.itc.books.groups.filter(g => g.lines).length} summary={`Myntra GSTIN ${MYNTRA_GSTIN}`}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-stone-500 border-b border-stone-200"><th className="py-1.5 pr-2 text-left font-medium">Supplier</th>{T && <th className="py-1.5 px-2 text-right font-medium">In GSTR-2B</th>}<th className="py-1.5 px-2 text-right font-medium">Booked by the ledger this month</th>{T && <th className="py-1.5 pl-2 text-right font-medium">Difference</th>}</tr></thead>
                  <tbody>
                    {(T ? L.suppliers : r.itc.books.groups.map(g => ({ id: g.id, name: g.name, books: g.heads }))).map(s => (
                      <tr key={s.id} className="border-b border-stone-100"><td className="py-1.5 pr-2">{s.name}{T && <span className="text-stone-400 ml-1">{s.docs} invoice{s.docs === 1 ? '' : 's'}</span>}</td>{T && <td className="py-1.5 px-2 text-right tabular-nums">{amt(sum(s.twoB))}</td>}<td className="py-1.5 px-2 text-right tabular-nums">{amt(sum(s.books))}</td>{T && <td className="py-1.5 pl-2 text-right tabular-nums">{amt(sum(s.diff))}</td>}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[11px] text-stone-500 mt-2">Their invoices and the ledger lines fall in different months, so a difference is normal.</div>
            </Collapsible>
          </Section>

          <Section n="3" title="TCS and TDS deducted by Myntra" caption="From the settlements the ERP has booked this month.">
            <div className="grid grid-cols-2 gap-3 max-w-xl">
              <StatCard label="TCS (section 52, GST)" value={inr(r.tcs.tcs, 2)} sub={`${r.tcs.tcsLines} settlement line${r.tcs.tcsLines === 1 ? '' : 's'}`} />
              <StatCard label="TDS (section 194-O, income tax)" value={inr(r.tcs.tds, 2)} sub="not a GST item" />
            </div>
            <div className="text-xs text-stone-600 leading-relaxed">Myntra pays the TCS it collected to the government and reports it, so it should appear as a credit in your electronic <b>cash</b> ledger on the portal. Compare the two. How it reaches your return is for your accountant: this screen does not count it as a payment of tax.</div>
          </Section>

          <Section n="4" title="Payment and credit ledger" caption="Table 6.1. The ERP keeps the electronic credit ledger itself: October opens with your Tally balance and every filed return carries its closing credit forward. Tax on sales less credit, in the portal's order: credit of one tax pays that tax first; integrated tax credit then pays central and state tax; central and state credit pay integrated tax only once integrated tax credit is used up, and never each other.">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-stone-500 border-b border-stone-200">
                  <th className="py-1.5 pr-2 text-left font-medium">Tax</th><th className="py-1.5 px-2 text-right font-medium">Payable</th>
                  <th className="py-1.5 px-2 text-right font-medium">Paid with integrated credit</th><th className="py-1.5 px-2 text-right font-medium">with central credit</th><th className="py-1.5 px-2 text-right font-medium">with state credit</th>
                  <th className="py-1.5 pl-2 text-right font-medium text-stone-900">Paid in cash</th>
                </tr></thead>
                <tbody>
                  {HEADS.map(k => (
                    <tr key={k} className="border-b border-stone-100">
                      <td className="py-1.5 pr-2 min-w-[8rem]">{HEAD_LABEL[k]}</td><td className="py-1.5 px-2 text-right tabular-nums">{dash(P.liability[k])}</td>
                      {HEADS.map(c => <td key={c} className="py-1.5 px-2 text-right tabular-nums">{dash(P.used[k][c])}</td>)}
                      <td className="py-1.5 pl-2 text-right tabular-nums font-medium">{dash(P.cash[k])}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="font-semibold border-t-2 border-stone-300 bg-stone-50">
                  <td className="py-2 pr-2">Total</td><td className="py-2 px-2 text-right tabular-nums">{amt(sum(P.liability))}</td>
                  {HEADS.map(c => <td key={c} className="py-2 px-2 text-right tabular-nums">{amt(HEADS.reduce((s, k) => s + P.used[k][c], 0))}</td>)}
                  <td className="py-2 pl-2 text-right tabular-nums">{amt(P.cashTotal)}</td>
                </tr></tfoot>
              </table>
            </div>
            {creditPanel}
          </Section>
        </>
      )}
    </div>
  );
}

// ── The tab: loads the month, builds the sheet, keeps the 2B and the opening credit, exports ─────────────────────
export default function Gstr3bSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS);
  const [start, setStart] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [session, setSession] = useState({ month: '', twoB: undefined, opening: undefined });      // used only while migration 044 is not applied

  useEffect(() => { accountingStart(supabase).then(setStart); }, []);
  const today = localToday();
  const months = useMemo(() => start ? monthsBetween(start.slice(0, 7), today.slice(0, 7)) : [], [start, today]);
  const month = p.g3month && months.includes(p.g3month) ? p.g3month : start ? defaultMonth(start, today) : '';

  const load = useCallback(async () => {
    if (!month) return;
    setLoading(true); setError('');
    try { setData({ month, ...(await fetchGstr3bMonth(supabase, month)) }); }
    catch (err) { setError(`Could not load ${monthLabel(month)}: ${err.message}`); showToast?.('Could not load the GSTR-3B figures', 'error'); }
    setLoading(false);
  }, [month, showToast]);
  useEffect(() => { load(); }, [load]);

  const fresh = data && data.month === month ? data : null;
  const sess = session.month === month ? session : { month, twoB: undefined, opening: undefined };
  const twoB = fresh ? (sess.twoB !== undefined ? sess.twoB : fresh.twoB) : null;
  const resolved = useMemo(() => {
    if (!fresh) return { opening: null, source: null, text: '', filed: null };
    if (sess.opening) return { opening: sess.opening, source: 'manual', text: 'Entered for this visit', filed: null };
    return resolveOpening({ month, row: fresh.monthRow, prev: fresh.prevRow });
  }, [fresh, month, sess.opening]);
  const opening = resolved.opening;

  const r = useMemo(() => fresh ? buildGstr3b({
    month, gst: buildGstReport({ month, ...fresh.gst }), ownGstin: fresh.ownGstin, bills: fresh.bills, vendors: fresh.vendors,
    ledgerInput: fresh.ledgerInput, trueups: fresh.trueups, tcsRows: fresh.tcsRows, twoB, opening, openingLabel: resolved.text,
  }) : null, [fresh, month, twoB, opening, resolved.text]);

  const exportXlsx = () => { try { downloadXlsx(gstr3bFileName(r), buildGstr3bSheets(r)); } catch (err) { showToast?.(`Could not make the Excel file: ${err.message}`, 'error'); } };
  const exportUploads = () => { try { downloadXlsx(`Bills-to-upload-${month}.xlsx`, [buildUploadSheet(r)]); } catch (err) { showToast?.(`Could not make the Excel file: ${err.message}`, 'error'); } };
  const storeMissing = !!fresh?.storeMissing;

  const panel = fresh && (
    <TwoBPanel month={month} stored={twoB} storeMissing={storeMissing} sessionOnly={storeMissing && !!twoB}
      onSaved={load} onRemoved={load} onSession={(parsed) => setSession({ ...sess, month, twoB: parsed ? { ...parsed, uploadedAt: new Date().toISOString() } : null })} showToast={showToast} />
  );
  const creditPanel = fresh && r && (
    <CreditLedgerPanel r={r} month={month} resolved={resolved} canWrite={!storeMissing} storeMissing={storeMissing}
      onCorrect={async (v) => {
        if (storeMissing) setSession({ ...sess, month, opening: { ...v, at: null } });
        else { await saveOpening(supabase, month, v); await load(); showToast?.(`Credit carried into ${monthLabel(month)} corrected`, 'success'); }
      }}
      onMarkFiled={async () => {
        const snap = filedSnapshot(r, { opening: resolved.opening, source: resolved.source, twoBFile: twoB });
        await markFiled(supabase, month, { opening: snap.payload.opening, source: snap.payload.source, closing: snap.payload.closing, filed: snap.payload.filed });
        await load(); showToast?.(`${monthLabel(month)} recorded as filed: its closing credit carries forward`, 'success');
      }}
      onUnmarkFiled={async () => { await unmarkFiled(supabase, month); await load(); showToast?.(`${monthLabel(month)} is no longer recorded as filed`, 'success'); }} />
  );

  if (!month) return <div className="text-sm text-stone-500 px-1 py-6">Loading…</div>;
  return (
    <Gstr3bView r={r} months={months} month={month} onMonth={(m) => setP({ g3month: m })} onExport={exportXlsx} loading={loading} error={error} onReload={load}
      panel={panel} creditPanel={creditPanel} onExportUploads={exportUploads} />
  );
}
