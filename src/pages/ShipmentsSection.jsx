import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { usePermissions } from '../contexts/PermissionsContext';
import { localToday, localDate } from '../lib/constants';
import { sortRows, inRange, clampPage, pageSizeOf } from '../lib/analyticsKit';
import { DateRange, Pagination, Collapsible, SortTh, StatCard, FilterChips, Pills, EmptyState, downloadCsv, useUrlParams, wideScreen } from '../components/AnalyticsKit';
import { RefreshCw, ExternalLink, Copy, Check, ChevronDown, ChevronRight, Download, Info, SlidersHorizontal, TicketCheck, CircleCheck, RotateCcw, Search, X, ShieldQuestion } from 'lucide-react';

// Analytics → Shipments. Every parcel the business is waiting on, from the `shipments` table
// (written by the shipment-watch function): forward parcels not delivered, parcels coming back to
// origin (RTO), and customer returns on their way to the warehouse.
//
// The status shown is VELOCITY'S OWN (its order-tracking API, checked every 30 minutes): Shopify and
// Return Prime only say which parcels may be pending, and they lag the courier. A parcel Velocity
// reports delivered / cancelled / back with us leaves the open lists on its own; anything Velocity
// cannot confirm is flagged, never hidden. A person can also mark a parcel resolved, or record a
// ticket raised with Velocity (so it stops showing as "escalate" until the follow-up date).
// Rules: supabase/functions/_shared/shipments.ts. Docs: docs/shipments.md.

const SHOP_ORDERS = 'https://admin.shopify.com/store/supply-rethought/orders';

const URL_DEFAULTS = {
  sview: 'escalate', stype: 'all', spay: 'all', sq: '', sfrom: '', sto: '', sage: '', scourier: '', sstat: '', stk: 'all',
  ssort: '', sdir: '', spage: '1', ssize: '25',
};

const VIEWS = [
  { id: 'escalate',  label: 'Escalate' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'claim',     label: 'Credit note due' },
  { id: 'ticket',    label: 'Ticket raised' },
  { id: 'resolved',  label: 'Resolved' },
  { id: 'all',       label: 'All pending' },
];

const KIND_LABEL = { forward: 'Forward', rto: 'RTO', return: 'Return' };
const KIND_STYLE = { forward: 'bg-sky-50 text-sky-800 border-sky-200', rto: 'bg-amber-50 text-amber-900 border-amber-300', return: 'bg-violet-50 text-violet-800 border-violet-200' };
const PAY_LABEL = { prepaid: 'Prepaid', cod: 'COD', partial: 'Part-paid' };
const PAY_STYLE = { prepaid: 'bg-emerald-50 text-emerald-800 border-emerald-200', cod: 'bg-stone-100 text-stone-700 border-stone-200', partial: 'bg-orange-50 text-orange-800 border-orange-200' };

const ATTENTION = {
  lost:          { label: 'Lost',            cls: 'bg-red-50 text-red-800 border-red-200', rank: 0 },
  ndr:           { label: 'Delivery failed', cls: 'bg-amber-50 text-amber-900 border-amber-300', rank: 1 },
  pickup_failed: { label: 'Pickup failed',   cls: 'bg-amber-50 text-amber-900 border-amber-300', rank: 2 },
  unverified:    { label: "Can't confirm",   cls: 'bg-stone-100 text-stone-700 border-stone-300', rank: 3 },
};

const STATUS_LABEL = {
  in_transit: 'In transit', out_for_delivery: 'Out for delivery', attempted: 'Delivery attempted', picked_up: 'Picked up', new: 'Booked', pickup_scheduled: 'Pickup scheduled',
  label_created: 'Not picked up yet', ready_for_pickup: 'Ready for pickup', delayed: 'Delayed', failed: 'Delivery failed', ndr_raised: 'Delivery failed (NDR)', reattempt_delivery: 'Re-attempt booked',
  rto_initiated: 'RTO initiated', rto_in_transit: 'RTO in transit', rto_delivered: 'RTO back with us',
  return_requested: 'Pickup requested', return_on_the_way: 'On the way to warehouse', return_in_transit: 'Return in transit', return_pickup_scheduled: 'Pickup scheduled',
  return_ndr_raised: 'Pickup failed (NDR)', return_not_picked: 'Pickup not done', return_delivered: 'Back with us', return_cancelled: 'Return cancelled', return_received: 'Received',
  lost: 'Lost', delivered: 'Delivered', cancelled: 'Cancelled',
};
const statusLabel = (st) => STATUS_LABEL[st] || String(st || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
const OUTCOME_LABEL = { delivered: 'Delivered', returned_to_us: 'Back with us', cancelled: 'Cancelled' };

const REASONS = [
  { id: 'delivered',   label: 'Delivered to the customer' },
  { id: 'back',        label: 'Parcel is back with us' },
  { id: 'credit_note', label: 'Velocity issued a credit note' },
  { id: 'cancelled',   label: 'Cancelled / no longer needed' },
  { id: 'other',       label: 'Other' },
];

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const inr2 = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(String(d).length === 10 ? `${d}T00:00:00` : d);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) });
};
const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—';
const ago = (iso) => {
  if (!iso) return 'no update';
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const shopLink = (s) => s.order_id ? `${SHOP_ORDERS}/${s.order_id}` : `${SHOP_ORDERS}?query=${encodeURIComponent(s.order_name)}`;

// ── Per-row facts the lists and filters share ───────────────────────────────────────────────────
function enrich(s, review, today) {
  const manual = review?.status === 'resolved';
  const ticket = review?.status === 'ticket';
  const due = ticket && !!review.follow_up_on && review.follow_up_on <= today;
  return { ...s, review, manual, ticket, due, waiting: ticket && !due, open: s.state === 'pending' && !manual };
}

const IN_VIEW = {
  escalate:  s => s.open && s.kind === 'forward' && !!s.escalation && !s.waiting,
  attention: s => s.open && !!s.attention && !s.waiting,
  claim:     s => s.open && s.claim_eligible && !(s.waiting && s.review.ticket_type === 'credit_note'),
  ticket:    s => s.open && s.ticket,
  resolved:  s => !s.open,
  all:       s => s.open,
};

// Most urgent first, per view; a column header overrides it.
const byDefault = {
  escalate:  (a, b) => (a.escalation === 'now' ? 0 : 1) - (b.escalation === 'now' ? 0 : 1) || b.late_days - a.late_days || b.pending_days - a.pending_days,
  attention: (a, b) => (ATTENTION[a.attention]?.rank ?? 9) - (ATTENTION[b.attention]?.rank ?? 9) || b.pending_days - a.pending_days,
  claim:     (a, b) => b.pending_days - a.pending_days,
  ticket:    (a, b) => (b.due ? 1 : 0) - (a.due ? 1 : 0) || String(a.review?.follow_up_on || '9999').localeCompare(String(b.review?.follow_up_on || '9999')),
  resolved:  (a, b) => String(b.closed_on || b.review?.reviewed_at || '').localeCompare(String(a.closed_on || a.review?.reviewed_at || '')),
  all:       (a, b) => b.pending_days - a.pending_days,
};
const SORT_KEY = {
  order: s => (/^\d+$/.test(s.order_name) ? Number(s.order_name) : s.order_name),
  dispatched: s => s.dispatched_on,
  promised: s => (s.kind === 'forward' ? s.edd || '' : ''),
  status: s => statusLabel(s.status),
  update: s => s.last_event_at || '',
};

function ticketText(rows) {
  const head = 'AWB\tOrder\tCourier\tDispatched\tPromised\tDays since dispatch\tStatus (Velocity)\tPayment\tLast activity';
  return [head, ...rows.map(s => [
    s.awb, s.order_name, s.courier || '', s.dispatched_on, s.edd || '', s.pending_days, statusLabel(s.status),
    s.payment_type ? PAY_LABEL[s.payment_type] : 'Customer return', s.velocity_last_activity || '',
  ].join('\t'))].join('\n');
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

// ── Mark resolved / ticket raised ───────────────────────────────────────────────────────────────
function ReviewForm({ mode, awbs, defaultType, onSaved, onCancel }) {
  const [type, setType] = useState(defaultType);
  const [ref, setRef] = useState('');
  const [wait, setWait] = useState('3');
  const [reason, setReason] = useState(defaultType === 'credit_note' ? 'credit_note' : 'delivered');
  const [cnRef, setCnRef] = useState('');
  const [cnAmt, setCnAmt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';

  const save = async () => {
    setBusy(true); setErr('');
    const now = new Date();
    const follow = mode === 'ticket' ? localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Number(wait))) : null;
    const reasonText = REASONS.find(r => r.id === reason)?.label;
    const amt = cnAmt.trim() === '' ? null : Number(cnAmt);
    if (mode === 'resolved' && reason === 'credit_note' && amt != null && !(amt >= 0)) { setErr('The credit note amount must be a number'); setBusy(false); return; }
    const { data, error } = await supabase.rpc('shipment_review_set', {
      p_awbs: awbs, p_status: mode, p_ticket_type: mode === 'ticket' ? type : null, p_ticket_ref: mode === 'ticket' ? ref : null, p_follow_up_on: follow,
      p_note: mode === 'resolved' ? [reasonText, note.trim()].filter(Boolean).join(': ') : note,
      p_credit_note_ref: mode === 'resolved' && reason === 'credit_note' ? cnRef : null, p_credit_note_amount: mode === 'resolved' && reason === 'credit_note' ? amt : null,
    });
    setBusy(false);
    if (error) { setErr(/not allowed/i.test(error.message) ? 'You do not have permission to mark shipments' : `Could not save: ${error.message}`); return; }
    onSaved(Number(data) || awbs.length, mode);
  };

  return (
    <div className="rounded-md border border-stone-300 bg-white p-3 space-y-2.5 text-xs">
      <div className="font-medium text-stone-900">
        {mode === 'ticket' ? 'Record a ticket raised with Velocity' : 'Mark as resolved'}
        <span className="font-normal text-stone-500"> · {awbs.length} parcel{awbs.length === 1 ? '' : 's'}</span>
      </div>
      {mode === 'ticket' ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><div className="text-stone-500">Ticket for</div>
            <select value={type} onChange={e => setType(e.target.value)} className={field}>
              <option value="delivery">Delivery escalation</option><option value="credit_note">Credit note request</option>
            </select></label>
          <label className="space-y-1"><div className="text-stone-500">Ticket number (optional)</div>
            <input value={ref} onChange={e => setRef(e.target.value)} placeholder="e.g. VEL-48213" className={`${field} w-40`} /></label>
          <label className="space-y-1"><div className="text-stone-500">Follow up in</div>
            <select value={wait} onChange={e => setWait(e.target.value)} className={field}>
              {[1, 2, 3, 5, 7, 14].map(n => <option key={n} value={n}>{days(n)}</option>)}
            </select></label>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1"><div className="text-stone-500">Why is it resolved?</div>
            <select value={reason} onChange={e => setReason(e.target.value)} className={field}>{REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
          {reason === 'credit_note' && <>
            <label className="space-y-1"><div className="text-stone-500">Credit note number</div><input value={cnRef} onChange={e => setCnRef(e.target.value)} className={`${field} w-36`} /></label>
            <label className="space-y-1"><div className="text-stone-500">Amount (₹)</div><input value={cnAmt} onChange={e => setCnAmt(e.target.value)} inputMode="decimal" className={`${field} w-24`} /></label>
          </>}
        </div>
      )}
      <label className="block space-y-1"><div className="text-stone-500">Note (optional)</div>
        <input value={note} onChange={e => setNote(e.target.value)} className={`${field} w-full`} /></label>
      {err && <div className="text-red-700">{err}</div>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={save} className="h-8 px-3 rounded-md bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50">{busy ? 'Saving…' : mode === 'ticket' ? 'Save ticket' : 'Mark resolved'}</button>
        <button type="button" disabled={busy} onClick={onCancel} className="h-8 px-3 rounded-md border border-stone-300 bg-white hover:border-stone-500">Cancel</button>
      </div>
    </div>
  );
}

function ReviewHistory({ awb }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    supabase.from('shipment_review_log').select('id, action, ticket_type, ticket_ref, follow_up_on, credit_note_ref, credit_note_amount, note, by_name, at')
      .eq('awb', awb).order('at', { ascending: false }).limit(6)
      .then(({ data }) => { if (live) setRows(data || []); });
    return () => { live = false; };
  }, [awb]);
  if (!rows?.length) return null;
  return (
    <div>
      <div className="text-[11px] font-medium text-stone-500 mb-1">History</div>
      <ul className="space-y-0.5 text-[11px] text-stone-600">
        {rows.map(r => (
          <li key={r.id}>
            {fmtWhen(r.at)} · {r.by_name || 'someone'} {r.action === 'ticket' ? `raised a ${r.ticket_type === 'credit_note' ? 'credit note' : 'delivery'} ticket${r.ticket_ref ? ` ${r.ticket_ref}` : ''}${r.follow_up_on ? `, follow up ${fmtDate(r.follow_up_on)}` : ''}` : r.action === 'resolved' ? `marked it resolved${r.credit_note_ref ? ` (credit note ${r.credit_note_ref}${r.credit_note_amount != null ? `, ${inr2(r.credit_note_amount)}` : ''})` : ''}` : 'reopened it'}
            {r.note ? <span className="text-stone-500"> — {r.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── What is shown for one parcel (the table row and the phone card use the same pieces) ─────────
function Badges({ s }) {
  const a = ATTENTION[s.attention];
  return (
    <div className="mt-0.5 flex flex-wrap gap-1">
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${KIND_STYLE[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
      {s.payment_type && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${PAY_STYLE[s.payment_type]}`}>{PAY_LABEL[s.payment_type]}</span>}
      {s.open && a && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${a.cls}`}>{a.label}</span>}
      {s.open && s.ticket && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${s.due ? 'bg-red-50 text-red-800 border-red-200' : 'bg-sky-50 text-sky-800 border-sky-200'}`}>{s.due ? 'Follow up due' : 'Ticket raised'}</span>}
      {!s.open && <span className="text-[10px] px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-800 border-emerald-200">Resolved</span>}
    </div>
  );
}

function StatusBlock({ s }) {
  if (!s.open) {
    return s.manual
      ? <div className="text-xs"><div className="text-stone-900">Resolved by {s.review.reviewed_by_name || 'someone'}</div><div className="text-[11px] text-stone-500">{fmtDate(s.review.reviewed_at)}{s.review.note ? ` · ${s.review.note}` : ''}</div></div>
      : <div className="text-xs"><div className="text-stone-900">{OUTCOME_LABEL[s.outcome] || statusLabel(s.status)}{s.closed_on ? ` · ${fmtDate(s.closed_on)}` : ''}</div><div className="text-[11px] text-stone-500">Confirmed by Velocity</div></div>;
  }
  return (
    <div className="text-xs">
      <div className="text-stone-900">{statusLabel(s.status)}</div>
      {s.escalation && !s.waiting && <div className={`text-[11px] font-medium ${s.escalation === 'now' ? 'text-red-700' : 'text-amber-800'}`}>{s.escalation === 'now' ? 'Escalate now' : 'Consider escalating'}</div>}
      {s.ticket && <div className="text-[11px] text-sky-800">{s.review.ticket_type === 'credit_note' ? 'Credit note requested' : 'Escalated'}{s.review.ticket_ref ? ` · ${s.review.ticket_ref}` : ''}{s.review.follow_up_on ? ` · follow up ${fmtDate(s.review.follow_up_on)}` : ''}</div>}
      {s.attention_reason && <div className={`text-[11px] ${s.attention === 'lost' ? 'text-red-700' : 'text-amber-800'}`}>{s.attention_reason}</div>}
      {Number(s.credit_received) > 0 && <div className="text-[11px] text-emerald-700">Velocity credited {inr2(s.credit_received)} to the wallet</div>}
    </div>
  );
}

function Detail({ s, canReview, onAct, form, children }) {
  const cell = (label, value) => value == null || value === '' ? null : <div><div className="text-[11px] text-stone-500">{label}</div><div className="text-xs text-stone-800">{value}</div></div>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2">
        {cell('Velocity status', s.velocity_status ? statusLabel(s.velocity_status) : null)}
        {cell('Last activity', s.velocity_last_activity ? `${s.velocity_last_activity} · ${fmtWhen(s.velocity_last_at)}` : null)}
        {cell('Checked with Velocity', s.velocity_checked_at ? `${ago(s.velocity_checked_at)}${s.verified ? '' : ' · not confirmed'}` : 'not checked yet')}
        {cell('Delivery attempts', s.attempts > 0 ? s.attempts : null)}
        {cell('Order total', s.order_total ? inr(s.order_total) : null)}
        {cell('Cash to collect', s.cod_due > 0 ? inr(s.cod_due) : null)}
        {cell('Deliver to', [s.city, s.pincode].filter(Boolean).join(' · '))}
        {cell('Return request', s.request_number)}
        {cell('Freight charged', s.freight_debit != null ? inr2(s.freight_debit) : null)}
        {cell('Credited by Velocity', Number(s.credit_received) > 0 ? inr2(s.credit_received) : s.freight_debit != null ? 'nothing yet' : null)}
        {cell('Courier', s.courier)}
        {cell('Shopify says', s.raw_status)}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {s.tracking_url && <a href={s.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500">Velocity tracking <ExternalLink className="w-3 h-3" /></a>}
        <a href={shopLink(s)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500">Order in Shopify <ExternalLink className="w-3 h-3" /></a>
        {canReview && s.open && <>
          <button type="button" onClick={() => onAct('ticket', [s.awb])} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500"><TicketCheck className="w-3.5 h-3.5" /> {s.ticket ? 'Update ticket' : 'Ticket raised'}</button>
          <button type="button" onClick={() => onAct('resolved', [s.awb])} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500"><CircleCheck className="w-3.5 h-3.5" /> Mark resolved</button>
        </>}
        {canReview && (s.manual || s.ticket) && <button type="button" onClick={() => onAct('reopen', [s.awb])} className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-stone-300 bg-white hover:border-stone-500"><RotateCcw className="w-3.5 h-3.5" /> {s.manual ? 'Reopen' : 'Remove ticket'}</button>}
      </div>
      {form}
      {children}
      <ReviewHistory awb={s.awb} />
    </div>
  );
}

function ShipmentRow({ s, expanded, onToggle, picked, onPick, canReview, onAct, form }) {
  return (
    <>
      <tr className={`border-b border-stone-100 align-top ${expanded ? 'bg-stone-50' : 'hover:bg-stone-50'}`}>
        <td className="py-2 pl-2 pr-1 w-8">{canReview && <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select ${s.order_name}`} className="mt-1 accent-stone-900" />}</td>
        <td className="py-2 px-2 whitespace-nowrap">
          <button type="button" onClick={onToggle} aria-expanded={expanded} className="inline-flex items-center gap-1 font-mono font-medium text-stone-900">
            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-stone-400" /> : <ChevronRight className="w-3.5 h-3.5 text-stone-400" />}{s.order_name}
          </button>
          <div className="pl-[18px]"><Badges s={s} /></div>
        </td>
        <td className="py-2 px-2 whitespace-nowrap">
          {s.tracking_url ? <a href={s.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-stone-800 hover:underline">{s.awb} <ExternalLink className="w-3 h-3 text-stone-400" /></a> : <span className="font-mono text-xs text-stone-500">no tracking number</span>}
          <div className="text-[11px] text-stone-500">{[s.courier, s.city].filter(Boolean).join(' · ')}</div>
        </td>
        <td className="py-2 px-2 whitespace-nowrap text-stone-700">
          {fmtDate(s.dispatched_on)}
          {s.open && <div className={`text-[11px] ${s.claim_eligible ? 'text-red-700 font-medium' : 'text-stone-500'}`}>{days(s.pending_days)}</div>}
        </td>
        <td className="py-2 px-2 whitespace-nowrap text-stone-700">
          {s.kind === 'forward' ? <>{s.edd ? fmtDate(s.edd) : <span className="text-stone-400">not given</span>}{s.open && s.late_days > 0 && <div className="text-[11px] text-red-700 font-medium">{days(s.late_days)} late</div>}</> : <span className="text-stone-400">—</span>}
        </td>
        <td className="py-2 px-2 min-w-[200px]"><StatusBlock s={s} /></td>
        <td className={`py-2 px-2 whitespace-nowrap text-xs ${s.open && s.stuck ? 'text-amber-800' : 'text-stone-500'}`}>{ago(s.last_event_at)}</td>
      </tr>
      {expanded && <tr className="bg-stone-50 border-b border-stone-100"><td colSpan={7} className="px-4 pb-4 pt-1"><Detail s={s} canReview={canReview} onAct={onAct} form={form} /></td></tr>}
    </>
  );
}

function ShipmentCard({ s, expanded, onToggle, picked, onPick, canReview, onAct, form }) {
  return (
    <div className={`border-b border-stone-100 p-3 ${expanded ? 'bg-stone-50' : ''}`}>
      <div className="flex items-start gap-2">
        {canReview && <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select ${s.order_name}`} className="mt-1 accent-stone-900" />}
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex-1 text-left">
          <div className="flex items-center gap-1 font-mono font-medium text-stone-900">{expanded ? <ChevronDown className="w-3.5 h-3.5 text-stone-400" /> : <ChevronRight className="w-3.5 h-3.5 text-stone-400" />}{s.order_name}<span className="font-sans font-normal text-[11px] text-stone-500 ml-1">{s.open ? days(s.pending_days) : ''}</span></div>
          <Badges s={s} />
          <div className="mt-1.5"><StatusBlock s={s} /></div>
          <div className="mt-1 text-[11px] text-stone-500">
            Dispatched {fmtDate(s.dispatched_on)}{s.kind === 'forward' ? ` · promised ${s.edd ? fmtDate(s.edd) : 'not given'}` : ''}{s.open && s.late_days > 0 ? <span className="text-red-700 font-medium"> · {days(s.late_days)} late</span> : ''}
          </div>
        </button>
      </div>
      {expanded && <div className="mt-3"><Detail s={s} canReview={canReview} onAct={onAct} form={form} /></div>}
    </div>
  );
}

// ── The screen ──────────────────────────────────────────────────────────────────────────────────
export default function ShipmentsSection({ showToast }) {
  const { can } = usePermissions();
  const canReview = can('can_view_analytics');
  const [p, setP] = useUrlParams(URL_DEFAULTS, 'spage');
  const today = localToday();

  const [rows, setRows] = useState([]);
  const [reviews, setReviews] = useState({});
  const [cfg, setCfg] = useState({ claimDays: 45, prepaidLate: 1, codLate: 2, scannedAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [form, setForm] = useState(null);                 // { mode: 'ticket' | 'resolved', awbs: [...] }
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState('');
  const [manual, setManual] = useState('');               // shown when the browser blocks copying, so it can be selected by hand

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error: err } = await supabase.from('shipments')
        .select('awb, kind, order_name, order_id, request_number, courier, tracking_url, payment_type, order_total, cod_due, city, pincode, dispatched_on, edd, status, raw_status, last_event_at, attempts, state, closed_on, late_days, pending_days, escalation, claim_eligible, stuck, note, velocity_status, velocity_checked_at, velocity_last_activity, velocity_last_at, verified, outcome, attention, attention_reason, freight_debit, credit_received')
        .order('dispatched_on', { ascending: false }).range(from, from + 999);
      if (err) { setError('Could not load the shipments'); showToast?.('Could not load the shipments', 'error'); setLoading(false); return; }
      all.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const [{ data: rv }, { data: conf }] = await Promise.all([
      supabase.from('shipment_reviews').select('awb, status, ticket_type, ticket_ref, follow_up_on, credit_note_ref, credit_note_amount, note, reviewed_by_name, reviewed_at'),
      supabase.from('app_settings').select('key, value').in('key', ['shipment_claim_days', 'shipment_escalate_prepaid_days', 'shipment_escalate_cod_days', 'shipment_watch_last_run']),
    ]);
    const get = (k) => (conf || []).find(r => r.key === k)?.value;
    setCfg({
      claimDays: Number(get('shipment_claim_days')) || 45, prepaidLate: Number(get('shipment_escalate_prepaid_days')) || 1,
      codLate: Number(get('shipment_escalate_cod_days')) || 2, scannedAt: get('shipment_watch_last_run')?.scanned_at ?? null,
    });
    setReviews(Object.fromEntries((rv || []).map(r => [r.awb, r])));
    setRows(all); setLoading(false);
  }, [showToast]);
  useEffect(() => { load(); }, [load]);

  const all = useMemo(() => rows.map(s => enrich(s, reviews[s.awb], today)), [rows, reviews, today]);

  // "Scope": the filters that say WHICH parcels the page is about. Counts and cards follow the scope; the table adds the rest.
  const scoped = useMemo(() => all.filter(s =>
    inRange(s.dispatched_on, p.sfrom, p.sto)
    && (p.stype === 'all' || s.kind === p.stype)
    && (!p.sage || s.pending_days >= Number(p.sage))), [all, p.sfrom, p.sto, p.stype, p.sage]);

  const counts = useMemo(() => {
    const c = { now: 0, consider: 0, attention: 0, claim: 0, claimValue: 0, ticket: 0, due: 0, resolved: 0, all: 0, byAttention: {} };
    for (const s of scoped) {
      if (IN_VIEW.escalate(s)) { if (s.escalation === 'now') c.now++; else c.consider++; }
      if (IN_VIEW.attention(s)) { c.attention++; c.byAttention[s.attention] = (c.byAttention[s.attention] ?? 0) + 1; }
      if (IN_VIEW.claim(s)) { c.claim++; c.claimValue += Number(s.order_total || 0); }
      if (IN_VIEW.ticket(s)) { c.ticket++; if (s.due) c.due++; }
      if (IN_VIEW.resolved(s)) c.resolved++;
      if (IN_VIEW.all(s)) c.all++;
    }
    return c;
  }, [scoped]);
  const viewCount = { escalate: counts.now + counts.consider, attention: counts.attention, claim: counts.claim, ticket: counts.ticket, resolved: counts.resolved, all: counts.all };

  const couriers = useMemo(() => [...new Set(scoped.map(s => (s.courier || '').toLowerCase()).filter(Boolean))].sort(), [scoped]);
  const statuses = useMemo(() => [...new Set(scoped.filter(IN_VIEW[p.sview] ?? IN_VIEW.all).map(s => s.status))].sort((a, b) => statusLabel(a).localeCompare(statusLabel(b))), [scoped, p.sview]);

  const shown = useMemo(() => {
    const q = p.sq.trim().replace(/^#/, '').toLowerCase();
    const list = scoped
      .filter(IN_VIEW[p.sview] ?? IN_VIEW.all)
      .filter(s => p.spay === 'all' || s.payment_type === p.spay)
      .filter(s => !p.scourier || (s.courier || '').toLowerCase() === p.scourier)
      .filter(s => !p.sstat || s.status === p.sstat)
      .filter(s => p.stk === 'all' || (p.stk === 'none' ? !s.ticket : p.stk === 'ticket' ? s.ticket : s.due))
      .filter(s => !q || s.order_name.toLowerCase().includes(q) || s.awb.toLowerCase().includes(q) || (s.request_number || '').toLowerCase().includes(q));
    return p.ssort && SORT_KEY[p.ssort] ? sortRows(list, SORT_KEY[p.ssort], p.sdir === 'desc' ? 'desc' : 'asc') : [...list].sort(byDefault[p.sview] ?? byDefault.all);
  }, [scoped, p.sview, p.spay, p.scourier, p.sstat, p.stk, p.sq, p.ssort, p.sdir]);

  const size = pageSizeOf(p.ssize);
  const page = clampPage(p.spage, shown.length, size);
  const pageRows = shown.slice((page - 1) * size, page * size);

  // What a button acts on: the ticked parcels that are still in the list, else everything the list holds.
  const ticked = shown.filter(s => picked.has(s.awb));
  const target = ticked.length ? ticked : shown;

  const onSort = (id) => setP(p.ssort === id ? { ssort: id, sdir: p.sdir === 'desc' ? 'asc' : 'desc' } : { ssort: id, sdir: id === 'order' || id === 'status' ? 'asc' : 'desc' });
  const tabTo = (id) => { setP({ sview: id, sstat: '', ssort: '', sdir: '' }); setExpanded(null); setForm(null); };
  const pick = (awb) => setPicked(prev => { const n = new Set(prev); n.has(awb) ? n.delete(awb) : n.add(awb); return n; });
  const pagePicked = pageRows.length > 0 && pageRows.every(s => picked.has(s.awb));
  const pickPage = () => setPicked(prev => { const n = new Set(prev); pageRows.forEach(s => pagePicked ? n.delete(s.awb) : n.add(s.awb)); return n; });

  const flash = (text) => { setMessage(text); setTimeout(() => setMessage(''), 5000); };
  const copy = async (what) => {
    const text = what === 'awbs' ? target.map(s => s.awb).join('\n') : ticketText(target);
    const ok = await copyText(text);
    setManual(ok ? '' : text);
    flash(ok ? `Copied ${target.length} ${what === 'awbs' ? 'tracking numbers' : 'rows'}` : 'Copying is blocked here: select the text below');
  };
  const csv = () => {
    downloadCsv(`shipments-${p.sview}-${today}.csv`,
      ['Order', 'AWB', 'Type', 'Payment', 'Courier', 'City', 'Dispatched', 'Promised', 'Days since dispatch', 'Days late', 'Status (Velocity)', 'Needs attention', 'Last activity', 'Last tracking update', 'Freight charged', 'Credited by Velocity', 'Ticket', 'Follow up', 'Resolved by', 'Note', 'Order total', 'Cash to collect'],
      target.map(s => [s.order_name, s.awb, KIND_LABEL[s.kind], s.payment_type ? PAY_LABEL[s.payment_type] : '', s.courier, s.city, s.dispatched_on, s.edd, s.pending_days, s.late_days, statusLabel(s.status),
        s.attention ? ATTENTION[s.attention]?.label : '', s.velocity_last_activity, s.last_event_at, s.freight_debit, s.credit_received,
        s.ticket ? `${s.review.ticket_type === 'credit_note' ? 'Credit note' : 'Delivery'} ${s.review.ticket_ref || ''}`.trim() : '', s.review?.follow_up_on, s.manual ? s.review.reviewed_by_name : '', s.review?.note || s.note, s.order_total, s.cod_due]));
    flash(`Downloaded ${target.length} rows`);
  };

  const act = async (mode, awbs) => {
    if (mode === 'reopen') {
      const { error: err } = await supabase.rpc('shipment_review_clear', { p_awbs: awbs });
      if (err) { flash(`Could not reopen: ${err.message}`); return; }
      setReviews(prev => { const n = { ...prev }; awbs.forEach(a => delete n[a]); return n; });
      flash(`Reopened ${awbs.length} parcel${awbs.length === 1 ? '' : 's'}`);
      return;
    }
    setForm({ mode, awbs });
  };
  const saved = async (count, mode) => {
    setForm(null); setPicked(new Set());
    const { data } = await supabase.from('shipment_reviews').select('awb, status, ticket_type, ticket_ref, follow_up_on, credit_note_ref, credit_note_amount, note, reviewed_by_name, reviewed_at');
    setReviews(Object.fromEntries((data || []).map(r => [r.awb, r])));
    flash(mode === 'ticket' ? `Ticket recorded on ${count} parcel${count === 1 ? '' : 's'}: they leave the escalate list until the follow-up date` : `Marked ${count} parcel${count === 1 ? '' : 's'} resolved`);
  };

  const chips = [
    p.sfrom || p.sto ? { key: 'date', label: `Dispatched ${p.sfrom ? fmtDate(p.sfrom) : 'start'} to ${p.sto ? fmtDate(p.sto) : 'today'}`, onRemove: () => setP({ sfrom: '', sto: '' }) } : null,
    p.stype !== 'all' ? { key: 'type', label: KIND_LABEL[p.stype], onRemove: () => setP({ stype: 'all' }) } : null,
    p.sage ? { key: 'age', label: `${p.sage}+ days pending`, onRemove: () => setP({ sage: '' }) } : null,
    p.spay !== 'all' ? { key: 'pay', label: PAY_LABEL[p.spay], onRemove: () => setP({ spay: 'all' }) } : null,
    p.scourier ? { key: 'courier', label: `Courier: ${p.scourier}`, onRemove: () => setP({ scourier: '' }) } : null,
    p.sstat ? { key: 'stat', label: statusLabel(p.sstat), onRemove: () => setP({ sstat: '' }) } : null,
    p.stk !== 'all' ? { key: 'tk', label: { none: 'No ticket', ticket: 'Ticket raised', due: 'Follow-up due' }[p.stk], onRemove: () => setP({ stk: 'all' }) } : null,
    p.sq ? { key: 'q', label: `Search: ${p.sq}`, onRemove: () => setP({ sq: '' }) } : null,
  ].filter(Boolean);
  const clearAll = () => setP({ sfrom: '', sto: '', stype: 'all', sage: '', spay: 'all', scourier: '', sstat: '', stk: 'all', sq: '' });

  if (loading && !rows.length) return <div className="text-sm text-stone-500 px-1 py-6">Loading shipments…</div>;

  const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';
  const btn = 'inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50';
  const formFor = (awbs) => form && form.awbs.length === awbs.length && form.awbs.every((a, i) => a === awbs[i])
    ? <ReviewForm mode={form.mode} awbs={form.awbs} defaultType={p.sview === 'claim' ? 'credit_note' : 'delivery'} onSaved={saved} onCancel={() => setForm(null)} /> : null;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Shipments</h2>
          <div className="text-[11px] text-stone-500">Checked against Velocity {ago(cfg.scannedAt)} · refreshed every 30 minutes</div>
        </div>
        <button onClick={load} disabled={loading} className={btn}><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

      <Collapsible id="ship-help" title="How this page works" icon={<Info className="w-4 h-4 text-stone-400" />}>
        <ul className="list-disc pl-5 space-y-1 text-xs text-stone-600">
          <li><b>The status is Velocity's own</b>, read from its tracking every 30 minutes. Shopify and Return Prime only tell us which parcels might be pending; they lag the courier.</li>
          <li><b>Resolved on their own:</b> a parcel Velocity shows as delivered, cancelled, or back with us (with a delivery scan or tracking log as proof) leaves the open lists and appears under <i>Resolved</i>. Anything Velocity cannot confirm stays, marked <i>Can't confirm</i>, so nothing is hidden by guesswork.</li>
          <li><b>Escalate:</b> a forward parcel past the date it was promised for: prepaid from {days(cfg.prepaidLate)} late, COD and part-paid from {days(cfg.codLate)}. <b>Credit note due:</b> still not delivered {cfg.claimDays} days after dispatch (a customer return counts from its request).</li>
          <li><b>Your marks are kept and logged.</b> <i>Ticket raised</i> takes a parcel off the escalate list until the follow-up date. <i>Mark resolved</i> closes it for good. <i>Reopen</i> undoes either.</li>
          <li><b>Credits:</b> the Velocity wallet shows what it charged and credited per parcel. The credit note <i>documents</i> are not visible to the ERP, so record the number when you resolve a parcel.</li>
        </ul>
      </Collapsible>

      <Collapsible id="ship-scope" title="Dates and type" icon={<SlidersHorizontal className="w-4 h-4 text-stone-400" />} defaultOpen={wideScreen()}
        summary={[p.sfrom || p.sto ? `Dispatched ${p.sfrom ? fmtDate(p.sfrom) : 'start'} to ${p.sto ? fmtDate(p.sto) : 'today'}` : 'All dates', p.stype === 'all' ? 'all types' : KIND_LABEL[p.stype], p.sage ? `${p.sage}+ days` : null].filter(Boolean).join(' · ')}>
        <div className="space-y-3">
          <DateRange label="Dispatched" from={p.sfrom} to={p.sto} onChange={(f, t) => setP({ sfrom: f, sto: t })} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2"><span className="text-xs font-medium text-stone-600">Type</span>
              <Pills size="sm" value={p.stype} onChange={v => setP({ stype: v })} options={[{ id: 'all', label: 'All' }, { id: 'forward', label: 'Forward' }, { id: 'rto', label: 'RTO' }, { id: 'return', label: 'Return' }]} /></div>
            <label className="flex items-center gap-2 text-xs"><span className="font-medium text-stone-600">Pending for</span>
              <select value={p.sage} onChange={e => setP({ sage: e.target.value })} className={field}>
                <option value="">Any time</option>{[7, 14, 30, 45].map(n => <option key={n} value={n}>{n}+ days</option>)}
              </select></label>
          </div>
        </div>
      </Collapsible>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Escalate now" value={counts.now} tone={counts.now ? 'text-red-700' : 'text-stone-500'} sub={`prepaid, ${days(cfg.prepaidLate)}+ past the promised date`} active={p.sview === 'escalate' && p.spay === 'prepaid'} onClick={() => { setP({ sview: 'escalate', spay: 'prepaid', sstat: '' }); setExpanded(null); }} />
        <StatCard label="Consider escalating" value={counts.consider} tone={counts.consider ? 'text-amber-800' : 'text-stone-500'} sub={`COD / part-paid, ${days(cfg.codLate)}+ late`} onClick={() => { setP({ sview: 'escalate', spay: 'all', sstat: '' }); setExpanded(null); }} />
        <StatCard label="Needs attention" value={counts.attention} tone={counts.attention ? 'text-amber-800' : 'text-stone-500'}
          sub={counts.attention ? Object.entries(ATTENTION).filter(([k]) => counts.byAttention[k]).map(([k, v]) => `${counts.byAttention[k]} ${v.label.toLowerCase()}`).join(' · ') : 'nothing to look at'} active={p.sview === 'attention'} onClick={() => tabTo('attention')} />
        <StatCard label="Credit note due" value={counts.claim} tone={counts.claim ? 'text-amber-800' : 'text-stone-500'} sub={counts.claim ? `${cfg.claimDays}+ days not delivered${counts.claimValue ? ` · ${inr(counts.claimValue)} of orders` : ''}` : `nothing past ${cfg.claimDays} days`} active={p.sview === 'claim'} onClick={() => tabTo('claim')} />
        <StatCard label="Ticket raised" value={counts.ticket} tone="text-sky-800" sub={counts.due ? `${counts.due} follow-up due` : 'waiting on Velocity'} active={p.sview === 'ticket'} onClick={() => tabTo('ticket')} />
        <StatCard label="Resolved" value={counts.resolved} tone="text-emerald-800" sub="by Velocity or by you" active={p.sview === 'resolved'} onClick={() => tabTo('resolved')} />
      </div>

      <div className="bg-white rounded-lg border border-stone-200">
        <div className="p-3 sm:p-4 space-y-3 border-b border-stone-100">
          <Pills value={p.sview} onChange={tabTo} options={VIEWS.map(v => ({ ...v, count: viewCount[v.id] }))} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2 top-1/2 -translate-y-1/2" />
              <input value={p.sq} onChange={e => setP({ sq: e.target.value })} placeholder="Order, AWB or return no." aria-label="Search shipments" className={`${field} pl-7 pr-6 w-48`} />
              {p.sq && <button onClick={() => setP({ sq: '' })} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-700"><X className="w-3.5 h-3.5" /></button>}
            </div>
            <select value={p.spay} onChange={e => setP({ spay: e.target.value })} aria-label="Payment" className={field}>
              <option value="all">Any payment</option><option value="prepaid">Prepaid</option><option value="cod">COD</option><option value="partial">Part-paid</option>
            </select>
            <select value={p.scourier} onChange={e => setP({ scourier: e.target.value })} aria-label="Courier" className={field}>
              <option value="">Any courier</option>{couriers.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={p.sstat} onChange={e => setP({ sstat: e.target.value })} aria-label="Status" className={field}>
              <option value="">Any status</option>{statuses.map(st => <option key={st} value={st}>{statusLabel(st)}</option>)}
            </select>
            <select value={p.stk} onChange={e => setP({ stk: e.target.value })} aria-label="Ticket" className={field}>
              <option value="all">Any ticket state</option><option value="none">No ticket</option><option value="ticket">Ticket raised</option><option value="due">Follow-up due</option>
            </select>
          </div>
          <FilterChips chips={chips} onClearAll={clearAll} />
        </div>

        <div className="px-3 sm:px-4 py-2.5 flex flex-wrap items-center gap-2 bg-stone-50 border-b border-stone-100 text-xs">
          <span className="text-stone-600">{ticked.length ? <><b>{ticked.length}</b> selected</> : <><b>{shown.length}</b> parcel{shown.length === 1 ? '' : 's'}</>}</span>
          {ticked.length > 0 && <button type="button" onClick={() => setPicked(new Set())} className="text-stone-500 underline">Clear selection</button>}
          <span className="flex-1" />
          {canReview && target.some(s => s.open) && <>
            <button type="button" className={btn} onClick={() => act('ticket', target.filter(s => s.open).map(s => s.awb))}><TicketCheck className="w-3.5 h-3.5" />Ticket raised{ticked.length ? '' : ` · all ${target.filter(s => s.open).length}`}</button>
            <button type="button" className={btn} onClick={() => act('resolved', target.filter(s => s.open).map(s => s.awb))}><CircleCheck className="w-3.5 h-3.5" />Mark resolved{ticked.length ? '' : ` · all ${target.filter(s => s.open).length}`}</button>
          </>}
          {canReview && target.some(s => s.manual || s.ticket) && <button type="button" className={btn} onClick={() => act('reopen', target.filter(s => s.manual || s.ticket).map(s => s.awb))}><RotateCcw className="w-3.5 h-3.5" />Reopen</button>}
          {shown.length > 0 && <>
            <button type="button" className={btn} onClick={() => copy('awbs')}><Copy className="w-3.5 h-3.5" />Copy AWBs</button>
            <button type="button" className={btn} onClick={() => copy('ticket')}><Copy className="w-3.5 h-3.5" />Copy for a ticket</button>
            <button type="button" className={btn} onClick={csv}><Download className="w-3.5 h-3.5" />CSV</button>
          </>}
        </div>

        {message && <div className="px-3 sm:px-4 py-2 text-xs text-emerald-800 bg-emerald-50 border-b border-emerald-100 flex items-center gap-1.5"><Check className="w-3.5 h-3.5" />{message}</div>}
        <div className="p-3 sm:p-4 space-y-3">
          {manual && <textarea readOnly value={manual} rows={Math.min(8, manual.split('\n').length)} onFocus={e => e.target.select()} autoFocus className="w-full text-[11px] font-mono border border-stone-300 rounded p-2 bg-stone-50" />}
          {form && !(form.awbs.length === 1 && expanded === form.awbs[0]) && <ReviewForm mode={form.mode} awbs={form.awbs} defaultType={p.sview === 'claim' ? 'credit_note' : 'delivery'} onSaved={saved} onCancel={() => setForm(null)} />}
          {p.sview === 'claim' && (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-start gap-1.5">
              <ShieldQuestion className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>Not delivered {cfg.claimDays} days after dispatch, by Velocity's own tracking. Days count from dispatch for forward parcels and RTOs (one tracking number), and from the pickup request for customer returns. Record the ticket number when you ask for the credit note.</span>
            </div>
          )}

          {shown.length === 0 ? (
            <EmptyState title={rows.length ? 'Nothing here' : 'Nothing stored yet'} hint={rows.length ? (chips.length ? 'No parcel matches these filters.' : p.sview === 'escalate' ? 'No parcel is past its promised date. Good.' : 'Nothing in this list.') : 'The first scan fills this in.'}
              action={chips.length ? { label: 'Clear filters', onClick: clearAll } : null} />
          ) : (
            <>
              <div className="hidden md:block overflow-x-auto -mx-1">
                <table className="w-full min-w-[920px] text-sm">
                  <thead>
                    <tr className="text-xs border-b border-stone-200">
                      <th className="py-1.5 pl-2 pr-1 w-8">{canReview && <input type="checkbox" checked={pagePicked} onChange={pickPage} aria-label="Select this page" className="accent-stone-900" />}</th>
                      <SortTh label="Order" id="order" sort={p.ssort} dir={p.sdir} onSort={onSort} />
                      <th scope="col" className="py-1.5 px-2 font-medium text-left text-stone-500">Parcel</th>
                      <SortTh label="Dispatched" id="dispatched" sort={p.ssort} dir={p.sdir} onSort={onSort} />
                      <SortTh label="Promised" id="promised" sort={p.ssort} dir={p.sdir} onSort={onSort} />
                      <SortTh label="Status" id="status" sort={p.ssort} dir={p.sdir} onSort={onSort} />
                      <SortTh label="Last update" id="update" sort={p.ssort} dir={p.sdir} onSort={onSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(s => (
                      <ShipmentRow key={s.awb} s={s} expanded={expanded === s.awb} onToggle={() => setExpanded(expanded === s.awb ? null : s.awb)}
                        picked={picked.has(s.awb)} onPick={() => pick(s.awb)} canReview={canReview} onAct={act} form={formFor([s.awb])} />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden -mx-3 sm:-mx-4 border-t border-stone-100">
                <div className="flex items-center justify-between px-3 py-2 text-xs">
                  {canReview ? <label className="inline-flex items-center gap-1.5 text-stone-600"><input type="checkbox" checked={pagePicked} onChange={pickPage} className="accent-stone-900" /> Select this page</label> : <span />}
                  <label className="inline-flex items-center gap-1.5 text-stone-600">Sort
                    <select value={p.ssort} onChange={e => setP({ ssort: e.target.value, sdir: e.target.value === 'order' || e.target.value === 'status' ? 'asc' : 'desc' })} className={field}>
                      <option value="">Most urgent</option><option value="order">Order</option><option value="dispatched">Dispatched</option><option value="promised">Promised</option><option value="status">Status</option><option value="update">Last update</option>
                    </select></label>
                </div>
                {pageRows.map(s => (
                  <ShipmentCard key={s.awb} s={s} expanded={expanded === s.awb} onToggle={() => setExpanded(expanded === s.awb ? null : s.awb)}
                    picked={picked.has(s.awb)} onPick={() => pick(s.awb)} canReview={canReview} onAct={act} form={formFor([s.awb])} />
                ))}
              </div>
              <Pagination page={page} pageSize={size} total={shown.length} noun="parcels" onPage={n => setP({ spage: n })} onPageSize={n => setP({ ssize: n })} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
