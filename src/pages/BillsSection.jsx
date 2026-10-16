import { useState, useEffect, useMemo, useCallback, useRef, useId } from 'react';
import { supabase } from '../lib/supabase';
import { callFunction } from '../lib/edgeCall';
import { clampPage, pageSizeOf } from '../lib/analyticsKit';
import { toBase64 } from '../lib/financeView';
import { STATUS_LABEL, BOOKING_LABEL, BOOKING_SHORT, billSummary, filterBills, failedChecks, outcomeText, newVendorDraft, changedEdits, ledgerNote, ledgerOk, expenseGroups } from '../lib/billsView';
import { Pagination, Collapsible, StatCard, Pills, EmptyState, useUrlParams, wideScreen } from '../components/AnalyticsKit';
import { RefreshCw, Upload, FileText, X, CheckCircle2, AlertCircle, Building2, Search, ExternalLink, Ban } from 'lucide-react';

// Analytics → Bills (admin only). Upload a vendor's invoice PDF: it is read, checked and kept with its original. The first bill of each
// vendor is confirmed once (and the vendor is told how it is booked); after that a bill that passes every check is accepted by itself.
// Rules: docs/supplier-invoices.md. Nothing here posts to Tally.

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const URL_DEFAULTS = { lstatus: 'review', lvendor: '', lq: '', lpage: '1', lsize: '25' };
const STATUS_FILTERS = [{ id: 'review', label: 'Needs review' }, { id: 'accepted', label: 'Accepted' }, { id: 'open', label: 'All bills' }, { id: 'void', label: 'Void' }];
const STATUS_STYLE = { review: 'bg-amber-50 text-amber-900 border-amber-300', accepted: 'bg-emerald-50 text-emerald-800 border-emerald-200', void: 'bg-stone-100 text-stone-500 border-stone-200' };
const TONE = { ok: 'bg-emerald-50 border-emerald-200 text-emerald-900', warn: 'bg-amber-50 border-amber-300 text-amber-950', info: 'bg-stone-50 border-stone-200 text-stone-700', bad: 'bg-red-50 border-red-200 text-red-800' };

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(`${d}T00:00:00`);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(dt.getFullYear() === new Date().getFullYear() ? {} : { year: '2-digit' }) });
};
const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';
const callBills = (body) => callFunction('bills-import', body);

function StatusBadge({ status }) {
  return <span className={`inline-block text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap ${STATUS_STYLE[status] || STATUS_STYLE.void}`}>{STATUS_LABEL[status] || status}</span>;
}

// ── Upload ──────────────────────────────────────────────────────────────────────────────────────
function UploadPanel({ onDone }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);       // [{ name, error?, items: [{ tone, text }] }]
  const [over, setOver] = useState(false);
  const input = useRef(null);

  const pick = (list) => { setFiles([...list].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')); setResults([]); };
  const upload = async () => {
    if (!files.length) return;
    setBusy(true); setResults([]);
    const out = [];
    for (const file of files) {
      try {
        if (file.size > MAX_UPLOAD_BYTES) { out.push({ name: file.name, error: `Files up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB are accepted.` }); continue; }
        const { ok, json } = await callBills({ action: 'upload', filename: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) });
        out.push(ok ? { name: file.name, items: (json.results ?? []).map(outcomeText) } : { name: file.name, error: json.error || 'The upload failed' });
      } catch (err) { out.push({ name: file.name, error: err.message || String(err) }); }
      setResults([...out]);
    }
    setBusy(false); setFiles([]); if (input.current) input.current.value = '';
    onDone();
  };

  return (
    <div className="space-y-3">
      <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
        className={`rounded-md border border-dashed px-3 py-4 text-center text-xs ${over ? 'border-stone-900 bg-stone-50' : 'border-stone-300'}`}>
        <FileText className="w-5 h-5 mx-auto text-stone-400" />
        <div className="mt-1 text-stone-600">Drop invoice PDFs here, or</div>
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple disabled={busy} onChange={e => pick(e.target.files)} aria-label="Choose invoice PDFs"
          className="mt-2 text-xs text-stone-700 file:mr-2 file:h-8 file:px-3 file:rounded-md file:border file:border-stone-300 file:bg-white file:text-xs file:text-stone-700 hover:file:border-stone-500 disabled:opacity-50" />
        {files.length > 0 && <div className="mt-2 text-stone-700">{files.length} file{files.length === 1 ? '' : 's'} ready: {files.map(f => f.name).join(', ')}</div>}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={upload} disabled={!files.length || busy} className="inline-flex items-center gap-1.5 h-8 px-3 text-xs rounded-md bg-stone-900 text-white disabled:opacity-40">
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}{busy ? 'Reading…' : 'Upload'}
        </button>
        <span className="text-[11px] text-stone-500">PDFs only, up to 5 MB each. Text PDFs from the vendor’s billing software are read; a scan or a photo has no text to read.</span>
      </div>
      {results.map((r, i) => (
        <div key={i} role="status" className="space-y-1">
          <div className="text-[11px] font-medium text-stone-600">{r.name}</div>
          {r.error ? <div className={`rounded-md border px-3 py-2 text-xs ${TONE.bad}`}>{r.error}</div>
            : r.items.map((it, j) => <div key={j} className={`rounded-md border px-3 py-2 text-xs ${TONE[it.warn ? 'warn' : it.tone]}`}>{it.text}</div>)}
        </div>
      ))}
    </div>
  );
}

// ── One bill, open ──────────────────────────────────────────────────────────────────────────────
function Checks({ checks }) {
  if (!checks?.length) return <div className="text-[11px] text-stone-500">No checks were stored for this bill.</div>;
  return (
    <ul className="space-y-0.5">
      {checks.map((c, i) => (
        <li key={`${c.id}-${i}`} className={`flex items-start gap-1.5 text-[11px] ${c.ok ? 'text-stone-600' : 'text-red-700'}`}>
          {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-px shrink-0 text-emerald-600" /> : <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />}<span>{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const NOTE_TONE = { ok: 'text-emerald-800', info: 'text-stone-600', warn: 'text-amber-900' };

/** What the page knows about a ledger name, in a line: it is in his Tally, an agreed rename, or not there (with a way out). */
function LedgerNote({ value, ledgers, onChange }) {
  const note = ledgerNote(value.tally_ledger_name, ledgers);
  if (!note) return null;
  const use = (name) => onChange({ ...value, tally_ledger_name: name, ledger_new: false });
  return (
    <div className="sm:col-span-2 space-y-1">
      <div className={`text-[11px] ${NOTE_TONE[note.tone]}`}>{note.text}</div>
      {note.kind === 'spelling' && <button type="button" onClick={() => use(note.suggest)} className="text-[11px] underline text-stone-700 hover:text-stone-900">Use “{note.suggest}”</button>}
      {note.kind === 'missing' && (
        <>
          {note.similar.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-stone-600">Did you mean:
              {note.similar.map(n => <button key={n} type="button" onClick={() => use(n)} className="underline text-stone-800 hover:text-stone-950">{n}</button>)}
            </div>
          )}
          <label className="inline-flex items-start gap-1.5 text-[11px] text-stone-700"><input type="checkbox" className="mt-0.5" checked={value.ledger_new === true} onChange={e => onChange({ ...value, ledger_new: e.target.checked })} />It is not in my Tally yet: the export creates it as a new ledger with exactly this name</label>
        </>
      )}
    </div>
  );
}

function VendorFields({ value, onChange, ledgers, lockName = false }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const listId = useId();
  const parties = useMemo(() => ledgers.filter(l => l.role === 'party').sort((a, b) => a.name.localeCompare(b.name)), [ledgers]);
  const groups = useMemo(() => expenseGroups(ledgers, value.expense_ledger ?? ''), [ledgers, value.expense_ledger]);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="block text-[11px] text-stone-600">Vendor name<input value={value.name} onChange={e => set('name', e.target.value)} disabled={lockName} className={`${field} w-full mt-0.5`} /></label>
      <label className="block text-[11px] text-stone-600">Its own ledger in Tally
        <input value={value.tally_ledger_name} onChange={e => onChange({ ...value, tally_ledger_name: e.target.value, ledger_new: false })} list={listId} placeholder="Type to search the ledgers in your Tally" autoComplete="off" className={`${field} w-full mt-0.5`} />
        <datalist id={listId}>{parties.map(l => <option key={l.name} value={l.name}>{l.under}</option>)}</datalist>
      </label>
      <LedgerNote value={value} ledgers={ledgers} onChange={onChange} />
      <label className="block text-[11px] text-stone-600">GSTIN<input value={value.gstin ?? ''} onChange={e => set('gstin', e.target.value.toUpperCase())} className={`${field} w-full mt-0.5`} placeholder="none (a foreign vendor)" /></label>
      <label className="block text-[11px] text-stone-600">How it is booked
        <select value={value.booking} onChange={e => set('booking', e.target.value)} className={`${field} w-full mt-0.5`}>
          {Object.entries(BOOKING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {value.booking === 'expense' && (
        <label className="block text-[11px] text-stone-600 sm:col-span-2">Expense ledger (the ledgers in your Tally)
          <select value={value.expense_ledger ?? ''} onChange={e => set('expense_ledger', e.target.value)} className={`${field} w-full mt-0.5`}>
            <option value="">Choose a ledger…</option>
            {groups.map(g => (
              <optgroup key={g.under} label={g.under}>
                {g.items.map(l => <option key={l.name} value={l.name}>{l.name}{l.status === 'will_create' ? ' (to be created in Tally)' : ''}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function BillDetail({ bill, vendors, ledgers, onClose, onChanged, showToast }) {
  const review = bill.status === 'review';
  const [fields, setFields] = useState({ invoice_no: bill.invoice_no, invoice_date: bill.invoice_date ?? '', taxable: bill.subtotal, tax: bill.tax, total: bill.total });
  const [vendorId, setVendorId] = useState(bill.vendor_id ? String(bill.vendor_id) : 'new');
  const [draft, setDraft] = useState(() => newVendorDraft(bill, ledgers));
  const [anyway, setAnyway] = useState(false);
  const [reason, setReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState({ state: bill.file_path ? 'loading' : 'none', url: null });
  const set = (k, v) => setFields(f => ({ ...f, [k]: v }));
  const chosen = vendors.find(v => String(v.id) === vendorId);
  const failed = failedChecks(bill);

  useEffect(() => {
    if (!bill.file_path) return undefined;
    let stale = false;
    callBills({ action: 'file_url', id: bill.id }).then(({ ok, json }) => { if (!stale) setFile(ok ? { state: 'ready', url: json.url } : { state: 'error', url: null }); }).catch(() => { if (!stale) setFile({ state: 'error', url: null }); });
    return () => { stale = true; };
  }, [bill.id, bill.file_path]);

  const confirm = async () => {
    setBusy(true); setError('');
    try {
      const { ok, json } = await callBills({
        action: 'confirm', id: bill.id, edits: changedEdits(bill, fields), accept_anyway: anyway, reason,
        vendor: vendorId === 'new' ? { new: { ...draft, gstin: draft.gstin || null, expense_ledger: draft.booking === 'expense' ? draft.expense_ledger : null, ledger_new: draft.ledger_new === true } } : { id: Number(vendorId) },
      });
      if (!ok) { setError([json.error, ...(json.failed ?? [])].filter(Boolean).join(' — ')); setBusy(false); return; }
      showToast?.(`Accepted ${bill.invoice_no}${json.learned?.includes('auto_accept') ? `; the next bills of ${json.vendor} are accepted when every check passes` : ''}`, 'success');
      onChanged(); onClose();
    } catch (err) { setError(err.message || String(err)); setBusy(false); }
  };
  const voidIt = async () => {
    setBusy(true); setError('');
    try {
      const { ok, json } = await callBills({ action: 'void', id: bill.id, reason: voidReason });
      if (!ok) { setError(json.error || 'Could not void the bill'); setBusy(false); return; }
      showToast?.(`Voided ${bill.invoice_no}`, 'success'); onChanged(); onClose();
    } catch (err) { setError(err.message || String(err)); setBusy(false); }
  };

  const ready = review && (vendorId !== 'new' || (draft.name.trim() && ledgerOk(draft, ledgers) && (draft.booking !== 'expense' || draft.expense_ledger))) && (!failed.length || (anyway && reason.trim().length >= 5));

  return (
    <div role="dialog" aria-modal="true" aria-label={`Bill ${bill.invoice_no}`} className="fixed inset-0 z-50 bg-stone-900/40 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-5xl max-h-full overflow-y-auto sm:rounded-lg border border-stone-200 shadow-xl">
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-stone-200">
          <div>
            <div className="text-sm font-semibold text-stone-900">{bill.vendor} · {bill.invoice_no}</div>
            <div className="text-[11px] text-stone-500 flex flex-wrap items-center gap-x-2">
              <StatusBadge status={bill.status} /><span>{bill.kind === 'goods' ? 'goods' : 'service'}</span>
              {bill.opening && <span>opening bill: dated before the books start, matched but never exported</span>}
              {bill.confirmed_by_name && <span>confirmed by {bill.confirmed_by_name}</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-stone-500 hover:text-stone-900"><X className="w-4 h-4" /></button>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="min-h-[18rem]">
            {file.state === 'ready' && (
              <>
                <iframe title={`Original of ${bill.invoice_no}`} src={file.url} className="w-full h-[28rem] border border-stone-200 rounded" />
                <a href={file.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 mt-1 text-[11px] text-stone-600 underline"><ExternalLink className="w-3 h-3" />Open the original in a new tab</a>
              </>
            )}
            {file.state === 'loading' && <div className="text-xs text-stone-500">Opening the original…</div>}
            {file.state === 'error' && <div className="text-xs text-red-700">The original could not be opened.</div>}
            {file.state === 'none' && <div className="rounded border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">No PDF is attached to this bill yet. Upload its PDF on this page and it is attached to this bill (its figures are compared with the PDF).</div>}
          </div>
          <div className="space-y-3 min-w-0">
            <div className="grid gap-2 grid-cols-2">
              <label className="block text-[11px] text-stone-600">Invoice number<input value={fields.invoice_no} onChange={e => set('invoice_no', e.target.value)} disabled={!review} className={`${field} w-full mt-0.5`} /></label>
              <label className="block text-[11px] text-stone-600">Invoice date<input type="date" value={fields.invoice_date} onChange={e => set('invoice_date', e.target.value)} disabled={!review} className={`${field} w-full mt-0.5`} /></label>
              <label className="block text-[11px] text-stone-600">Taxable value<input inputMode="decimal" value={fields.taxable} onChange={e => set('taxable', e.target.value)} disabled={!review} className={`${field} w-full mt-0.5 tabular-nums`} /></label>
              <label className="block text-[11px] text-stone-600">GST ({bill.tax_type}{bill.tax_rate ? ` ${bill.tax_rate}%` : ''})<input inputMode="decimal" value={fields.tax} onChange={e => set('tax', e.target.value)} disabled={!review} className={`${field} w-full mt-0.5 tabular-nums`} /></label>
              <label className="block text-[11px] text-stone-600 col-span-2">Invoice total<input inputMode="decimal" value={fields.total} onChange={e => set('total', e.target.value)} disabled={!review} className={`${field} w-full mt-0.5 tabular-nums`} /></label>
            </div>
            {review && <div className="text-[11px] text-stone-500">A correction must still add up: taxable value + GST = total, within ₹1 of rounding.</div>}
            <div>
              <div className="text-[11px] font-medium text-stone-700 mb-1">What was checked</div>
              <Checks checks={bill.checks} />
            </div>
            {bill.accepted_anyway && <div className="text-[11px] text-amber-900">Accepted with a failed check: {bill.accepted_anyway}</div>}
            {bill.void_reason && <div className="text-[11px] text-stone-600">Voided: {bill.void_reason}</div>}

            {review && (
              <div className="space-y-2 rounded-md border border-stone-200 p-3">
                <div className="text-[11px] font-medium text-stone-700">Whose bill is it, and how is it booked?</div>
                <select value={vendorId} onChange={e => setVendorId(e.target.value)} aria-label="Vendor" className={`${field} w-full`}>
                  {vendors.filter(v => v.active).map(v => <option key={v.id} value={String(v.id)}>{v.name} · {BOOKING_SHORT[v.booking]}{v.expense_ledger ? ` → ${v.expense_ledger}` : ''}</option>)}
                  <option value="new">A new vendor…</option>
                </select>
                {vendorId === 'new' && <VendorFields value={draft} onChange={setDraft} ledgers={ledgers} />}
                {chosen && !chosen.auto_accept && <div className="text-[11px] text-stone-500">This is the first bill of {chosen.name} you confirm: after it, bills of {chosen.name} that pass every check are accepted by themselves.</div>}
              </div>
            )}
            {review && failed.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2">
                <div className="text-[11px] text-amber-950">{failed.length} check{failed.length === 1 ? '' : 's'} did not pass. Correct what is wrong above, or accept the bill as it is and say why.</div>
                <label className="inline-flex items-center gap-1.5 text-xs text-amber-950"><input type="checkbox" checked={anyway} onChange={e => setAnyway(e.target.checked)} />Accept it anyway</label>
                {anyway && <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why (at least 5 characters)" aria-label="Why the bill is accepted anyway" className={`${field} w-full`} />}
              </div>
            )}
            {error && <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

            <div className="flex flex-wrap items-center gap-2">
              {review && <button type="button" onClick={confirm} disabled={!ready || busy} className="h-8 px-3 text-xs rounded-md bg-stone-900 text-white disabled:opacity-40">{busy ? 'Saving…' : 'Confirm and accept'}</button>}
              {bill.status !== 'void' && !voiding && <button type="button" onClick={() => setVoiding(true)} disabled={busy} className="inline-flex items-center gap-1 h-8 px-3 text-xs rounded-md border border-stone-300 text-stone-700 hover:border-stone-500"><Ban className="w-3.5 h-3.5" />Void</button>}
            </div>
            {voiding && (
              <div className="flex flex-wrap items-center gap-2">
                <input value={voidReason} onChange={e => setVoidReason(e.target.value)} placeholder="Why is it voided?" aria-label="Why the bill is voided" className={`${field} flex-1 min-w-[12rem]`} />
                <button type="button" onClick={voidIt} disabled={busy || voidReason.trim().length < 5} className="h-8 px-3 text-xs rounded-md bg-red-700 text-white disabled:opacity-40">Void this bill</button>
                <button type="button" onClick={() => setVoiding(false)} className="h-8 px-2 text-xs text-stone-600 underline">Keep it</button>
              </div>
            )}
            <div className="text-[11px] text-stone-400">A voided bill is kept, never deleted, and no longer proves a payment.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Vendors ─────────────────────────────────────────────────────────────────────────────────────
/** The vendors table's one-line verdict on its Tally ledger: in Tally, to be renamed there, to be created, or not there at all. */
function VendorLedgerLine({ v, ledgers }) {
  const note = ledgerNote(v.tally_ledger_name, ledgers);
  if (!note) return null;
  if (note.kind === 'tally') return <div className="text-[11px] text-emerald-800">in your Tally</div>;
  if (note.kind === 'rename') return <div className="text-[11px] text-stone-600">in Tally as “{note.ledger.renamed_from}” until it is renamed</div>;
  if (note.kind === 'create') return <div className="text-[11px] text-stone-600">to be created in Tally</div>;
  if (v.ledger_new) return <div className="text-[11px] text-stone-600">new: the export creates it</div>;
  return <div className="text-[11px] text-amber-900">not in your Tally: Edit to pick the right ledger</div>;
}

function VendorsPanel({ vendors, ledgers, onChanged, showToast }) {
  const [editing, setEditing] = useState(null);       // a vendor row, or {} for a new one
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = (v) => { setEditing(v); setForm({ name: v.name ?? '', tally_ledger_name: v.tally_ledger_name ?? '', gstin: v.gstin ?? '', booking: v.booking ?? 'expense', expense_ledger: v.expense_ledger ?? '', ledger_new: !!v.ledger_new, auto_accept: !!v.auto_accept, active: v.active ?? true }); setError(''); };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const { ok, json } = await callBills({ action: 'vendor_save', id: editing.id, ...form, gstin: form.gstin || null, expense_ledger: form.booking === 'expense' || form.booking === 'tie_out' ? form.expense_ledger || null : null });
      if (!ok) { setError(json.error || 'Could not save the vendor'); setBusy(false); return; }
      showToast?.(`Saved ${form.name}`, 'success'); setEditing(null); onChanged();
    } catch (err) { setError(err.message || String(err)); }
    setBusy(false);
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-600">Each vendor is booked one way, chosen once. <b>Expense</b> vendors become a GST EXPENSES voucher (the expense ledger and the input GST debited, the vendor credited); <b>goods purchase</b> a Purchase UP voucher; <b>tie-out only</b> is never posted, only compared with something else (Easebuzz: the order ledger already books its fee at each payout from the GoKwik settlement report, and this invoice has to agree with that total). A vendor turns automatic after you confirm its first bill.</p>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full min-w-[640px] text-xs">
          <thead><tr className="text-left text-stone-500 border-b border-stone-200"><th className="py-1.5 px-2 font-medium">Vendor</th><th className="py-1.5 px-2 font-medium">Booked as</th><th className="py-1.5 px-2 font-medium">Tally ledger</th><th className="py-1.5 px-2 font-medium">Automatic</th><th /></tr></thead>
          <tbody>
            {vendors.map(v => (
              <tr key={v.id} className={`border-b border-stone-100 align-top ${v.active ? '' : 'opacity-50'}`}>
                <td className="py-1.5 px-2"><div className="text-stone-900">{v.name}</div><div className="text-[11px] text-stone-500">{v.gstin ?? 'no GSTIN yet'}</div></td>
                <td className="py-1.5 px-2">{BOOKING_SHORT[v.booking]}{v.expense_ledger ? <div className="text-[11px] text-stone-500">{v.expense_ledger}</div> : null}</td>
                <td className="py-1.5 px-2 text-stone-700"><div>{v.tally_ledger_name}</div><VendorLedgerLine v={v} ledgers={ledgers} /></td>
                <td className="py-1.5 px-2">{v.auto_accept ? <span className="text-emerald-700">yes</span> : <span className="text-stone-500">after the first bill</span>}</td>
                <td className="py-1.5 px-2 text-right"><button type="button" onClick={() => open(v)} className="text-xs text-stone-600 underline hover:text-stone-900">Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!editing && <button type="button" onClick={() => open({})} className="h-8 px-3 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500">Add a vendor</button>}
      {editing && form && (
        <div className="rounded-md border border-stone-200 p-3 space-y-2">
          <div className="text-[11px] font-medium text-stone-700">{editing.id ? `Edit ${editing.name}` : 'A new vendor'}</div>
          <VendorFields value={form} onChange={setForm} ledgers={ledgers} />
          <div className="flex flex-wrap items-center gap-4 text-xs text-stone-700">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={form.auto_accept} onChange={e => setForm({ ...form, auto_accept: e.target.checked })} />Accept its bills automatically when every check passes</label>
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />In use</label>
          </div>
          {error && <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy || !form.name.trim() || !ledgerOk(form, ledgers)} className="h-8 px-3 text-xs rounded-md bg-stone-900 text-white disabled:opacity-40">{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={() => setEditing(null)} className="h-8 px-2 text-xs text-stone-600 underline">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── The list ────────────────────────────────────────────────────────────────────────────────────
function BillRow({ b, onOpen }) {
  return (
    <tr onClick={() => onOpen(b)} className="border-b border-stone-100 align-top hover:bg-stone-50 cursor-pointer">
      <td className="py-2 px-2 whitespace-nowrap text-stone-600">{fmtDate(b.invoice_date)}</td>
      <td className="py-2 px-2 min-w-[200px]"><div className="text-stone-900">{b.vendor}</div><div className="text-[11px] text-stone-500 break-all">{b.invoice_no}{b.opening ? ' · opening' : ''}</div></td>
      <td className="py-2 px-2 text-right tabular-nums whitespace-nowrap"><div className="text-stone-900">{inr(b.total)}</div><div className="text-[11px] text-stone-500">{inr(b.subtotal)} + {inr(b.tax)}</div></td>
      <td className="py-2 px-2"><StatusBadge status={b.status} />{failedChecks(b).length > 0 && b.status === 'review' && <div className="text-[11px] text-amber-800 mt-0.5">{failedChecks(b).length} check{failedChecks(b).length === 1 ? '' : 's'} failed</div>}</td>
      <td className="py-2 px-2 text-[11px] text-stone-500 whitespace-nowrap">{b.file_path ? 'PDF kept' : '—'}</td>
    </tr>
  );
}

function BillCard({ b, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(b)} className="w-full text-left border-b border-stone-100 p-3 hover:bg-stone-50">
      <div className="flex items-center justify-between gap-2 text-xs"><span className="text-stone-600">{fmtDate(b.invoice_date)}</span><span className="tabular-nums font-medium text-stone-900">{inr(b.total)}</span></div>
      <div className="text-xs text-stone-900 mt-1">{b.vendor}</div>
      <div className="text-[11px] text-stone-500 break-all">{b.invoice_no}</div>
      <div className="flex items-center gap-2 mt-1.5"><StatusBadge status={b.status} /><span className="text-[11px] text-stone-500">{b.file_path ? 'PDF kept' : '—'}</span></div>
    </button>
  );
}

export default function BillsSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'lpage');
  const [bills, setBills] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [ledgers, setLedgers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [b, v, l] = await Promise.all([
        supabase.from('vendor_invoices').select('id, vendor, vendor_id, invoice_no, invoice_date, period_from, period_to, subtotal, tax, total, tax_type, tax_rate, kind, status, opening, supplier_gstin, checks, file_path, file_name, confirmed_by_name, confirmed_at, edited, accepted_anyway, void_reason, imported_at, place_of_supply').order('invoice_date', { ascending: false }).order('id', { ascending: false }),
        supabase.from('vendors').select('id, name, tally_ledger_name, gstin, pan, state_code, booking, expense_ledger, auto_accept, active, note, ledger_new').order('name'),
        supabase.from('tally_ledgers').select('name, under, section, role, status, renamed_from').order('name'),
      ]);
      for (const r of [b, v, l]) if (r.error) throw new Error(r.error.message);
      setBills(b.data || []); setVendors(v.data || []); setLedgers(l.data || []);
    } catch (err) {
      setError('Could not load the bills'); showToast?.('Could not load the bills', 'error');
    }
    setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => billSummary(bills), [bills]);
  const shown = useMemo(() => filterBills(bills, { status: p.lstatus, vendor: p.lvendor, q: p.lq }), [bills, p.lstatus, p.lvendor, p.lq]);
  const size = pageSizeOf(p.lsize);
  const page = clampPage(p.lpage, shown.length, size);
  const pageRows = shown.slice((page - 1) * size, page * size);
  const open = bills.find(b => b.id === openId);
  const statusPills = useMemo(() => STATUS_FILTERS.map(f => ({ ...f, count: filterBills(bills, { status: f.id }).length })), [bills]);

  if (loading && !bills.length && !vendors.length) return <div className="text-sm text-stone-500 px-1 py-6">Loading the bills…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Bills</h2>
          <div className="text-[11px] text-stone-500">Every vendor invoice: read, checked, and kept with its original PDF. Nothing here posts to Tally yet.</div>
        </div>
        <button type="button" onClick={load} disabled={loading} className="shrink-0 inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <Collapsible id="bills-upload" title="Upload invoices" icon={<Upload className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen() || bills.length === 0}>
        <UploadPanel onDone={load} />
      </Collapsible>

      <Collapsible id="bills-help" title="How this page works" icon={<FileText className="w-4 h-4 text-stone-400" />}>
        <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
          <li>Drop the vendor’s invoice PDF. It is read in a few seconds: supplier GSTIN, invoice number and date, taxable value, GST and total, and the lines. The original is kept, and can be opened from the bill.</li>
          <li>Eight checks run on every invoice: the GSTIN’s check digit, billed to our GSTIN (or our PAN with state code 09, as Google prints it), the number and date, taxable + GST = total, IGST or CGST + SGST for the states, the lines adding up, and quantity × rate = amount.</li>
          <li><b>The first bill of a vendor is confirmed once</b>: you say how it is booked, and from then on its bills that pass every check are accepted by themselves. Anything that fails a check, or belongs to an unknown vendor, waits under <i>Needs review</i>.</li>
          <li>You can correct the invoice number, the date and the amounts (they must still add up). A bill that fails a check can be accepted anyway, with the reason kept.</li>
          <li>The same invoice uploaded twice is recognised.</li>
          <li>Bills dated before the books start (1 Oct 2026) are <i>opening bills</i>: kept and matched with payments, never exported. A bill can be voided, never deleted.</li>
          <li>A PDF that is a scan or a photo has no text to read: ask the vendor for the original PDF.</li>
        </ul>
      </Collapsible>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Needs review" value={summary.review} sub={`${inr(summary.reviewAmount)} waiting for you`} tone={summary.review ? 'text-amber-800' : 'text-stone-500'} active={p.lstatus === 'review'} onClick={() => setP({ lstatus: 'review' })} />
        <StatCard label="Accepted" value={summary.accepted} sub={`${summary.opening} opening bill${summary.opening === 1 ? '' : 's'}`} tone="text-emerald-800" active={p.lstatus === 'accepted'} onClick={() => setP({ lstatus: 'accepted' })} />
        <StatCard label="Voided" value={summary.void} sub="kept, never deleted" active={p.lstatus === 'void'} onClick={() => setP({ lstatus: 'void' })} />
      </div>

      <div className="bg-white rounded-lg border border-stone-200">
        <div className="p-3 sm:p-4 space-y-3 border-b border-stone-100">
          <Pills value={p.lstatus} onChange={id => setP({ lstatus: id })} options={statusPills} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input value={p.lq} onChange={e => setP({ lq: e.target.value })} placeholder="Vendor, invoice number or amount" aria-label="Search bills" className={`${field} pl-7 w-60 max-w-full`} />
            </div>
            <select value={p.lvendor} onChange={e => setP({ lvendor: e.target.value })} aria-label="Filter by vendor" className={`${field} w-48 max-w-full`}>
              <option value="">All vendors</option>
              {vendors.map(v => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
            </select>
          </div>
        </div>
        <div className="p-3 sm:p-4">
          {shown.length === 0 ? (
            bills.length === 0
              ? <EmptyState title="No bills yet" hint="Drop an invoice PDF above and it appears here." />
              : <EmptyState title={p.lstatus === 'review' && !p.lq && !p.lvendor ? 'Nothing waits for you' : 'No bills match'} hint="Every bill that was read has been accepted or voided." action={p.lq || p.lvendor || p.lstatus !== 'review' ? { label: 'Show what needs review', onClick: () => setP({ lstatus: 'review', lq: '', lvendor: '' }) } : null} />
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto -mx-1">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="text-xs text-left text-stone-500 border-b border-stone-200">
                    <th scope="col" className="py-1.5 px-2 font-medium">Date</th><th scope="col" className="py-1.5 px-2 font-medium">Vendor and invoice</th><th scope="col" className="py-1.5 px-2 font-medium text-right">Amount</th><th scope="col" className="py-1.5 px-2 font-medium">Status</th><th scope="col" className="py-1.5 px-2 font-medium">Original</th>
                  </tr></thead>
                  <tbody>{pageRows.map(b => <BillRow key={b.id} b={b} onOpen={x => setOpenId(x.id)} />)}</tbody>
                </table>
              </div>
              <div className="md:hidden -mx-3 sm:-mx-4 border-t border-stone-100">{pageRows.map(b => <BillCard key={b.id} b={b} onOpen={x => setOpenId(x.id)} />)}</div>
              <Pagination page={page} pageSize={size} total={shown.length} noun="bills" onPage={n => setP({ lpage: n })} onPageSize={n => setP({ lsize: n })} />
            </>
          )}
        </div>
      </div>

      <Collapsible id="bills-vendors" title="Vendors and how each is booked" icon={<Building2 className="w-4 h-4 text-stone-400" />} count={vendors.length} summary="the ledger each vendor’s bills go to">
        <VendorsPanel vendors={vendors} ledgers={ledgers} onChanged={load} showToast={showToast} />
      </Collapsible>

      {open && <BillDetail key={open.id} bill={open} vendors={vendors} ledgers={ledgers} onClose={() => setOpenId(null)} onChanged={load} showToast={showToast} />}
    </div>
  );
}
