import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { describeDeletion, deletedMessage, KIND_LABEL } from '../lib/uploadDelete';
import { RefreshCw, Trash2, AlertCircle } from 'lucide-react';

// Taking an upload back (admin pages: Bank & card, Velocity wallet). A row's Delete button asks the server for a DRY RUN: what
// would go, what would stay, which matches fall back. That is shown inline for confirmation; only "Delete" sends the real request.
// No browser dialogs: the app runs in a sandboxed frame where alert()/confirm() are blocked.

/** `call(body)` → { ok, json } for the function that owns the upload; `onDeleted()` reloads the screen. */
export function useDeleteFlow({ call, onDeleted, showToast }) {
  const [state, setState] = useState(null);       // { request, stage: 'checking' | 'confirm' | 'deleting' | 'error', plan?, error? }

  const start = useCallback(async (request) => {
    setState({ request, stage: 'checking' });
    try {
      const { ok, json } = await call({ ...request, dry_run: true });
      if (!ok) throw new Error(json.error || 'could not check this upload');
      setState({ request, stage: 'confirm', plan: json });
    } catch (err) { setState({ request, stage: 'error', error: err.message || String(err) }); }
  }, [call]);

  const cancel = useCallback(() => setState(null), []);

  const confirm = useCallback(async () => {
    if (state?.stage !== 'confirm') return;
    const { request, plan } = state;
    setState({ request, plan, stage: 'deleting' });
    try {
      const { ok, json } = await call({ ...request, dry_run: false });
      if (!ok) throw new Error(json.error || 'the delete failed');
      showToast?.(deletedMessage(json), json.matching_error ? 'error' : 'success');
      setState(null);
      await onDeleted?.(json);
    } catch (err) { setState({ request, plan, stage: 'error', error: err.message || String(err) }); }
  }, [state, call, onDeleted, showToast]);

  const busy = state?.stage === 'checking' || state?.stage === 'deleting';
  const panel = state ? <DeletePanel state={state} onConfirm={confirm} onCancel={cancel} /> : null;
  return { start, panel, busy, pending: state?.request ?? null };
}

function DeletePanel({ state, onConfirm, onCancel }) {
  const { stage, plan, error } = state;
  if (stage === 'checking') return <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" />Checking what deleting this would change…</div>;
  if (stage === 'error') {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span>
        <button type="button" onClick={onCancel} className="shrink-0 underline">Close</button>
      </div>
    );
  }
  const d = describeDeletion(plan);
  const deleting = stage === 'deleting';
  return (
    <div role="alertdialog" aria-label={d.title} className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-stone-800">
      <div className="font-medium text-red-900 flex items-center gap-1.5"><Trash2 className="w-3.5 h-3.5" />{d.title}</div>
      <ul className="mt-1.5 list-disc pl-5 space-y-0.5">{d.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {d.cautions.length > 0 && <ul className="mt-1.5 list-disc pl-5 space-y-0.5 text-red-900">{d.cautions.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} disabled={deleting} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-red-700 text-white hover:bg-red-800 disabled:opacity-60">
          {deleting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}{deleting ? 'Deleting…' : 'Delete this upload'}
        </button>
        <button type="button" onClick={onCancel} disabled={deleting} className="h-8 px-3 rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-60">Keep it</button>
      </div>
    </div>
  );
}

/** The small Delete button on an upload's row. */
export function DeleteButton({ onClick, disabled, label = 'Delete' }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={`${label} this upload`}
      className="inline-flex items-center gap-1 px-2 py-1.5 -my-1 text-[11px] text-red-700 hover:bg-red-50 rounded disabled:opacity-40">
      <Trash2 className="w-3 h-3" />{label}
    </button>
  );
}

const when = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

/** The last few uploads that were deleted, who did it and what went (read from upload_deletions; admins only). */
export function DeletionLog({ kinds, refreshKey }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let live = true;
    supabase.from('upload_deletions').select('id, deleted_at, deleted_by_name, kind, label, summary').in('kind', kinds).order('deleted_at', { ascending: false }).limit(8)
      .then(({ data, error }) => { if (live) setRows(error ? [] : data ?? []); });
    return () => { live = false; };
  }, [kinds.join(','), refreshKey]);     // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows.length) return null;
  return (
    <div className="text-[11px] text-stone-500">
      <div className="font-medium text-stone-600 mb-0.5">Recently deleted</div>
      <ul className="space-y-0.5">
        {rows.map(r => (
          <li key={r.id} className="truncate" title={r.label}>
            {when(r.deleted_at)} · {r.deleted_by_name || 'someone'} deleted {KIND_LABEL[r.kind] || 'an upload'} <span className="text-stone-700">{r.label}</span>
            {r.summary?.removed != null && r.kind !== 'velocity_invoice' ? ` (${r.summary.removed} removed)` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
