import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { localToday } from '../lib/constants';
import { accountingStart } from '../lib/gstData';
import { fetchFollowup, addFollowup } from '../lib/gstr3bData';
import { buildFollowup, bySupplier, reminderText, monthName, STATUS_LABEL, WAITING } from '../lib/gstr2bFollowup';
import { Pills, StatCard, useUrlParams } from '../components/AnalyticsKit';
import { DocTable } from './GstSection';
import { RotateCcw, Copy, BellRing, StickyNote, Info, AlertTriangle } from 'lucide-react';

// Analytics → Supplier filing. The bills the ERP holds that the supplier has not filed (they are not in GSTR-2B), kept track of across
// months: each is checked against every GSTR-2B that has been loaded, so one that turns up in a later month shows as claimed there; the
// ones that should have been filed are grouped by supplier with a message to send and a record of who reminded whom, and when.
// Rules and reasoning: docs/gstr3b-view.md.

const URL_DEFAULTS = { sfview: 'waiting' };
const inr = (n, digits = 0) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const amt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
};
const fmtStamp = (t) => { if (!t) return ''; const dt = new Date(t); return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };
const btn = 'inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50';
const btnDark = 'inline-flex items-center gap-1 h-8 px-3 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40';
const BADGE = {
  missing: 'bg-red-100 text-red-900', load: 'bg-amber-100 text-amber-900', not_due: 'bg-stone-100 text-stone-700',
  not_available: 'bg-amber-100 text-amber-900', claimed: 'bg-emerald-100 text-emerald-900',
};

const Badge = ({ status }) => <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${BADGE[status]}`}>{STATUS_LABEL[status]}</span>;

/** One line saying what is known about the bill. */
function detail(r) {
  const mon = r.checkedMonths.map(monthName).join(', ');
  switch (r.status) {
    case 'missing':
      return `Not in the GSTR-2B for ${mon}. ${r.supplierFiled > 0 ? `The supplier filed ${r.supplierFiled} other invoice${r.supplierFiled === 1 ? '' : 's'} of theirs, so this one was left out.` : r.supplierFiled === 0 ? 'The supplier has nothing at all in your GSTR-2B for those months.' : ''}`.trim();
    case 'load': return `The ${monthName(r.billMonth)} GSTR-2B should exist by now: load it on the GSTR-3B tab to check.`;
    case 'not_due': return `The ${monthName(r.billMonth)} GSTR-2B is made on the 14th of the next month; the supplier has until the 11th to file.`;
    case 'not_available': return `In the ${monthName(r.foundMonth)} GSTR-2B, but ${r.itcNote}.`;
    default: return `In the ${monthName(r.foundMonth)} GSTR-2B${r.foundMonth > r.billMonth ? ", later than the bill's own month" : ''}.`;
  }
}

// ── One supplier: its bills, a message to copy, a way to record a reminder ─────────────────────────────────────────
// A proper component (it holds the selection and the note), not inlined in a .map().
function SupplierCard({ group, ownGstin, canWrite, onAction, showToast }) {
  const ids = group.rows.map(r => r.id);
  const [picked, setPicked] = useState(() => new Set(group.rows.filter(r => r.status === 'missing').map(r => r.id)));
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPicked(prev => new Set([...prev].filter(id => ids.includes(id)))); }, [ids.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = group.rows.filter(r => picked.has(r.id));
  const toggle = (id) => setPicked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const copy = async () => {
    const text = reminderText({ ...group, rows: chosen.length ? chosen : group.rows }, ownGstin);
    try { await navigator.clipboard.writeText(text); showToast?.('Message copied: paste it into WhatsApp or an email', 'success'); }
    catch { showToast?.('Could not copy: select the invoices and try again', 'error'); }
  };
  const act = async (action) => {
    setBusy(true);
    try { await onAction(chosen.map(r => r.id), action, note); if (action === 'note') setNote(''); setOpen(false); }
    finally { setBusy(false); }
  };

  return (
    <section className="bg-white rounded-lg border border-stone-200">
      <div className="px-3 sm:px-4 py-2.5 border-b border-stone-100 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-stone-900">{group.vendor}</div>
          <div className="text-[11px] text-stone-500">{group.gstin || 'no GSTIN on file'} · {group.rows.length} bill{group.rows.length === 1 ? '' : 's'} · {inr(group.tax, 2)} of tax waiting</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn} onClick={copy} disabled={!group.rows.length}><Copy className="w-3.5 h-3.5" />Copy message</button>
          <button type="button" className={btnDark} disabled={!canWrite || busy || !chosen.length} onClick={() => act('reminded')} title="Record that you reminded the supplier about the ticked bills"><BellRing className="w-3.5 h-3.5" />I reminded them</button>
          <button type="button" className={btn} disabled={!canWrite || !chosen.length} onClick={() => setOpen(o => !o)}><StickyNote className="w-3.5 h-3.5" />Note</button>
        </div>
      </div>
      {open && (
        <div className="px-3 sm:px-4 py-2 border-b border-stone-100 flex flex-wrap items-center gap-2 bg-stone-50">
          <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="e.g. said they will file in the next return" aria-label="Note" className="h-8 flex-1 min-w-[12rem] border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900" />
          <button type="button" className={btn} disabled={busy || !note.trim()} onClick={() => act('note')}>Save note</button>
          <button type="button" className={btn} disabled={busy || !note.trim()} onClick={() => act('reminded')}>Save as reminder with this note</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-stone-500 border-b border-stone-200">
            <th className="py-1.5 px-2 w-6" />
            <th className="py-1.5 px-2 font-medium">Invoice</th><th className="py-1.5 px-2 font-medium">Date</th>
            <th className="py-1.5 px-2 font-medium text-right">Tax</th><th className="py-1.5 px-2 font-medium text-right">Days</th>
            <th className="py-1.5 px-2 font-medium">Status</th><th className="py-1.5 px-2 font-medium">What we know</th><th className="py-1.5 px-2 font-medium">Reminders</th>
          </tr></thead>
          <tbody>
            {group.rows.map(r => (
              <tr key={r.id} className="border-b border-stone-100 align-top">
                <td className="py-1.5 px-2"><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select invoice ${r.no}`} /></td>
                <td className="py-1.5 px-2 whitespace-nowrap">{r.no}{r.billStatus === 'review' && <span className="ml-1 text-[10px] text-amber-800">(bill in review)</span>}</td>
                <td className="py-1.5 px-2 whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{amt(r.tax)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{r.age ?? ''}</td>
                <td className="py-1.5 px-2"><Badge status={r.status} /></td>
                <td className="py-1.5 px-2 text-stone-600 min-w-[16rem]">{detail(r)}<div className="text-[11px] text-stone-400">claimable until {fmtDate(r.claimBy)}</div></td>
                <td className="py-1.5 px-2 text-stone-600 min-w-[9rem]">
                  {r.reminderCount ? <>Reminded {fmtStamp(r.lastReminder.at)}{r.reminderCount > 1 ? ` (×${r.reminderCount})` : ''}{r.lastReminder.by_name ? ` by ${r.lastReminder.by_name}` : ''}</> : <span className="text-stone-400">not reminded</span>}
                  {r.lastNote && <div className="text-[11px] text-stone-500">"{r.lastNote.note}"</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── The page (no data loading here: the container passes the built follow-up) ───────────────────────────────────────
export function SupplierFilingView({ f, view, onView, loading, error, onReload, ownGstin, canWrite, onAction, showToast, storeMissing }) {
  const S = f?.summary;
  const rows = useMemo(() => {
    if (!f) return [];
    if (view === 'missing') return f.rows.filter(r => r.status === 'missing');
    if (view === 'claimed') return f.rows.filter(r => r.status === 'claimed' || r.status === 'not_available');
    if (view === 'all') return f.rows;
    return f.rows.filter(r => WAITING.includes(r.status));
  }, [f, view]);
  const groups = useMemo(() => (view === 'waiting' || view === 'missing') ? bySupplier(rows) : [], [rows, view]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Supplier filing</h2>
          <div className="text-[11px] text-stone-500">Bills you have that the supplier has not filed (not in GSTR-2B yet), and when they turn up.</div>
        </div>
        <button type="button" onClick={onReload} disabled={loading} title="Read everything again" className={btn}><RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Reload</button>
      </div>

      <div className="text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 leading-relaxed">
        Credit is claimed only when the supplier files the invoice and it shows in your <b>GSTR-2B</b>. That can be a later month than the bill's own, so every bill is checked against <b>every GSTR-2B you have loaded</b> (load each month's on the GSTR-3B tab): one that turns up later shows as in GSTR-2B for that month, and the ones that should have been filed are here to chase. Suppliers have until the 11th of the next month to file; the credit can be claimed until 30 November after the financial year ends (section 16(4): confirm with your accountant).
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {storeMissing && <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>The database update for this screen (migration 044) has not been applied, so loaded GSTR-2B files and reminders cannot be kept or read yet.</span></div>}
      {loading && !f && <div className="text-sm text-stone-500 px-1 py-6">Loading…</div>}

      {f && (
        <>
          <div className="flex items-start gap-2 text-xs text-stone-700">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-sky-700" />
            <span>{S.loadedMonths.length ? <>GSTR-2B loaded for <b>{S.loadedMonths.map(monthName).join(', ')}</b>.</> : <>No GSTR-2B has been loaded yet: load one on the GSTR-3B tab, and the bills that are not in it will be listed here.</>}</span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            <StatCard label="Waiting for suppliers" value={S.waiting.count} sub={`${inr(S.waiting.tax, 2)} of tax not claimable yet`} onClick={() => onView('waiting')} active={view === 'waiting'} />
            <StatCard label="Supplier should have filed" value={S.missing.count} tone={S.missing.count ? 'text-red-700' : 'text-stone-900'} sub={`${inr(S.missing.tax, 2)} · not in the 2B for their month · ${S.reminded} reminded`} onClick={() => onView('missing')} active={view === 'missing'} />
            <StatCard label="Load a GSTR-2B to check" value={S.load.count} tone={S.load.count ? 'text-amber-800' : 'text-stone-900'} sub={`${inr(S.load.tax, 2)} · ${S.notDue.count} not due yet`} />
            <StatCard label="In GSTR-2B" value={S.claimed.count + S.notAvailable.count} tone="text-emerald-800" sub={`${S.claimedLater} turned up in a later month${S.notAvailable.count ? ` · ${S.notAvailable.count} ITC not available` : ''}`} onClick={() => onView('claimed')} active={view === 'claimed'} />
          </div>

          <Pills value={view} onChange={onView} options={[
            { id: 'waiting', label: 'Waiting', count: S.waiting.count }, { id: 'missing', label: 'Should have filed', count: S.missing.count },
            { id: 'claimed', label: 'In GSTR-2B', count: S.claimed.count + S.notAvailable.count }, { id: 'all', label: 'All', count: f.rows.length },
          ]} />

          {rows.length === 0 && (
            <div className="bg-white rounded-lg border border-stone-200 px-4 py-8 text-center text-sm text-stone-600">
              {view === 'waiting' || view === 'missing' ? 'No bill is waiting on a supplier: every bill is in a GSTR-2B you have loaded, or is not due yet.' : 'Nothing here yet.'}
            </div>
          )}

          {groups.map(g => <SupplierCard key={g.key} group={g} ownGstin={ownGstin} canWrite={canWrite} onAction={onAction} showToast={showToast} />)}

          {(view === 'claimed' || view === 'all') && rows.length > 0 && (
            <section className="bg-white rounded-lg border border-stone-200 px-3 sm:px-4 py-3">
              <DocTable rows={rows} noun="bills" columns={[
                { label: 'Supplier', cell: r => r.vendor }, { label: 'Invoice', cell: r => r.no }, { label: 'Date', cell: r => fmtDate(r.date) },
                { label: 'Tax', right: true, cell: r => amt(r.tax) }, { label: 'Status', cell: r => <Badge status={r.status} /> }, { label: 'What we know', muted: true, cell: r => detail(r) },
              ]} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ── The tab: loads, builds the follow-up, records reminders ────────────────────────────────────────────────────────
export default function SupplierFilingSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS);
  const [start, setStart] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { accountingStart(supabase).then(setStart); }, []);
  const load = useCallback(async () => {
    if (!start) return;
    setLoading(true); setError('');
    try { setData(await fetchFollowup(supabase, start)); }
    catch (err) { setError(`Could not load: ${err.message}`); showToast?.('Could not load the supplier filing list', 'error'); }
    setLoading(false);
  }, [start, showToast]);
  useEffect(() => { load(); }, [load]);

  const f = useMemo(() => data ? buildFollowup({ bills: data.bills, vendors: data.vendors, files: data.files, followups: data.followups, today: localToday(), start }) : null, [data, start]);
  const onAction = async (ids, action, note) => {
    try {
      const n = await addFollowup(supabase, ids, action, note);
      showToast?.(action === 'reminded' ? `Recorded: you reminded the supplier about ${n} bill${n === 1 ? '' : 's'}` : 'Note saved', 'success');
      await load();
    } catch (err) { showToast?.(`Could not save: ${err.message}`, 'error'); }
  };

  const view = ['waiting', 'missing', 'claimed', 'all'].includes(p.sfview) ? p.sfview : 'waiting';
  return <SupplierFilingView f={f} view={view} onView={(v) => setP({ sfview: v })} loading={loading} error={error} onReload={load} ownGstin={data?.ownGstin}
    canWrite={!!data && !data.storeMissing} onAction={onAction} showToast={showToast} storeMissing={!!data?.storeMissing} />;
}
