import { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight, ChevronLeft, ArrowUp, ArrowDown, ChevronsUpDown, X, CalendarDays } from 'lucide-react';
import { presetRange } from '../lib/constants';
import { PAGE_SIZES, pageCount, pageSpan, pageWindow, normalizeRange, toCsv } from '../lib/analyticsKit';

// Building blocks shared by the Analytics list screens (Ledger, Shipments): URL-backed filters, a date
// range, paging, collapsible panels, sortable headers, summary cards and filter chips. Pure logic lives
// in lib/analyticsKit.js (tested); this file is only the markup.

// ── URL-backed filter state ─────────────────────────────────────────────────────────────────────
// `defaults` is a module-level object: its keys are the URL params, its values what "unset" means.
// Changing any filter drops the saved page (a filter shrinks the list under it) unless `pageKey` is in the patch.
export function useUrlParams(defaults, pageKey) {
  const [sp, setSp] = useSearchParams();
  const values = {};
  for (const k of Object.keys(defaults)) values[k] = sp.get(k) ?? defaults[k];
  const set = useCallback((patch) => setSp(prev => {
    const n = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || String(v) === String(defaults[k])) n.delete(k); else n.set(k, String(v));
    }
    if (pageKey && !(pageKey in patch)) n.delete(pageKey);
    return n;
  }, { replace: true }), [setSp, defaults, pageKey]);
  return [values, set];
}

// ── Date range ──────────────────────────────────────────────────────────────────────────────────
const PRESET_LABEL = { all: 'All dates', today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', mtd: 'This month', lastmonth: 'Last month', '3m': 'Last 3 months' };

export function DateRange({ label, from, to, onChange, presets = ['all', '7d', '30d', 'mtd', 'lastmonth'] }) {
  const active = (key) => { const r = presetRange(key); return from === r.from && to === r.to; };
  const input = 'h-8 border border-stone-300 rounded-md px-2 text-xs text-stone-800 bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
      <span className="inline-flex items-center gap-1 text-xs font-medium text-stone-600"><CalendarDays className="w-3.5 h-3.5" />{label}</span>
      <div className="flex flex-wrap gap-1">
        {presets.map(key => {
          const r = presetRange(key);
          return (
            <button key={key} type="button" onClick={() => onChange(r.from, r.to)} aria-pressed={active(key)}
              className={`h-8 px-2.5 text-xs rounded-md border transition-colors ${active(key) ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-700 border-stone-300 hover:border-stone-500'}`}>
              {PRESET_LABEL[key] || key}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-stone-500">
        <input type="date" aria-label={`${label}: from`} value={from} max={to || undefined} className={input}
          onChange={e => { const r = normalizeRange(e.target.value, to, 'from'); onChange(r.from, r.to); }} />
        <span>to</span>
        <input type="date" aria-label={`${label}: to`} value={to} min={from || undefined} className={input}
          onChange={e => { const r = normalizeRange(from, e.target.value, 'to'); onChange(r.from, r.to); }} />
      </div>
    </div>
  );
}

// ── Paging ──────────────────────────────────────────────────────────────────────────────────────
export function Pagination({ page, pageSize, total, onPage, onPageSize, noun = 'rows' }) {
  if (!total) return null;
  const pages = pageCount(total, pageSize);
  const [first, last] = pageSpan(page, pageSize, total);
  const btn = 'h-8 min-w-8 px-2 inline-flex items-center justify-center rounded-md border text-xs transition-colors';
  const off = 'border-stone-200 text-stone-300 cursor-not-allowed';
  const on = 'border-stone-300 text-stone-700 bg-white hover:border-stone-500';
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3 text-xs text-stone-600">
      <div>Showing <span className="font-medium text-stone-900">{first}–{last}</span> of <span className="font-medium text-stone-900">{total}</span> {noun}</div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1.5">
          <span className="text-stone-500">Rows per page</span>
          <select value={pageSize} onChange={e => onPageSize(Number(e.target.value))} className="h-8 border border-stone-300 rounded-md px-1.5 bg-white text-xs">
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {pages > 1 && (
          <nav className="flex items-center gap-1" aria-label="Pages">
            <button type="button" className={`${btn} ${page <= 1 ? off : on}`} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
            <span className="sm:hidden px-1">Page {page} of {pages}</span>
            <span className="hidden sm:flex items-center gap-1">
              {pageWindow(page, pages).map((p, i) => p == null
                ? <span key={`gap${i}`} className="px-1 text-stone-400">…</span>
                : <button key={p} type="button" onClick={() => onPage(p)} aria-current={p === page ? 'page' : undefined}
                    className={`${btn} ${p === page ? 'bg-stone-900 text-white border-stone-900' : on}`}>{p}</button>)}
            </span>
            <button type="button" className={`${btn} ${page >= pages ? off : on}`} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
          </nav>
        )}
      </div>
    </div>
  );
}

// ── Collapsible panel ───────────────────────────────────────────────────────────────────────────
// The open/closed choice is remembered in this browser only (a convenience, never needed to render).
const TONE = {
  neutral: { box: 'bg-white border-stone-200', head: 'text-stone-900', badge: 'bg-stone-100 text-stone-700' },
  amber:   { box: 'bg-amber-50 border-amber-200', head: 'text-amber-900', badge: 'bg-amber-100 text-amber-900' },
  red:     { box: 'bg-red-50 border-red-200', head: 'text-red-900', badge: 'bg-red-100 text-red-900' },
  sky:     { box: 'bg-sky-50 border-sky-200', head: 'text-sky-900', badge: 'bg-sky-100 text-sky-900' },
};
const readOpen = (key, dflt) => { try { const v = localStorage.getItem(`brune:open:${key}`); return v == null ? dflt : v === '1'; } catch { return dflt; } };
const writeOpen = (key, v) => { try { localStorage.setItem(`brune:open:${key}`, v ? '1' : '0'); } catch { /* private window or blocked storage */ } };

// Open on a wide screen, closed on a phone, unless the person chose otherwise before.
export const wideScreen = () => typeof window !== 'undefined' && window.innerWidth >= 768;

export function Collapsible({ id, title, icon, count, summary, tone = 'neutral', defaultOpen = false, children }) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const t = TONE[tone] || TONE.neutral;
  const toggle = () => setOpen(o => { writeOpen(id, !o); return !o; });
  return (
    <section className={`rounded-lg border ${t.box}`}>
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-2 px-3 sm:px-4 py-2.5 text-left">
        {open ? <ChevronDown className="w-4 h-4 shrink-0 text-stone-400" /> : <ChevronRight className="w-4 h-4 shrink-0 text-stone-400" />}
        {icon}
        <span className={`text-sm font-medium shrink-0 whitespace-nowrap ${t.head}`}>{title}</span>
        {count != null && <span className={`text-[11px] px-1.5 py-0.5 rounded-full shrink-0 ${t.badge}`}>{count}</span>}
        {summary && <span className="ml-auto min-w-0 text-xs text-stone-500 truncate">{summary}</span>}
      </button>
      {open && <div className="px-3 sm:px-4 pb-3 sm:pb-4 border-t border-black/5 pt-3">{children}</div>}
    </section>
  );
}

// ── Sortable column header ──────────────────────────────────────────────────────────────────────
export function SortTh({ label, id, sort, dir, onSort, align = 'left', className = '' }) {
  const here = sort === id;
  const Icon = !here ? ChevronsUpDown : dir === 'desc' ? ArrowDown : ArrowUp;
  return (
    <th scope="col" aria-sort={here ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'} className={`py-1.5 px-2 font-medium whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <button type="button" onClick={() => onSort(id)} className={`inline-flex items-center gap-1 ${here ? 'text-stone-900' : 'text-stone-500 hover:text-stone-800'}`}>
        {label}<Icon className={`w-3 h-3 ${here ? '' : 'opacity-50'}`} />
      </button>
    </th>
  );
}

// ── Summary card (a button when it filters the list) ────────────────────────────────────────────
export function StatCard({ label, value, sub, tone = 'text-stone-900', onClick, active }) {
  const body = (
    <>
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
      <div className="text-xs font-medium text-stone-900 mt-0.5">{label}</div>
      {sub && <div className="text-[11px] text-stone-500 mt-0.5 leading-snug">{sub}</div>}
    </>
  );
  const cls = `text-left bg-white rounded-lg border p-3 sm:p-4 ${active ? 'border-stone-900 ring-1 ring-stone-900' : 'border-stone-200'}`;
  return onClick
    ? <button type="button" onClick={onClick} aria-pressed={!!active} className={`${cls} hover:border-stone-500 transition-colors`}>{body}</button>
    : <div className={cls}>{body}</div>;
}

// ── Active filters, removable ───────────────────────────────────────────────────────────────────
export function FilterChips({ chips, onClearAll }) {
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-stone-500">Filtered by</span>
      {chips.map(c => (
        <span key={c.key} className="inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full bg-stone-100 text-stone-800 border border-stone-200">
          {c.label}
          <button type="button" onClick={c.onRemove} aria-label={`Remove filter ${c.label}`} className="p-0.5 rounded-full hover:bg-stone-200"><X className="w-3 h-3" /></button>
        </span>
      ))}
      <button type="button" onClick={onClearAll} className="text-[11px] text-stone-600 underline hover:text-stone-900">Clear all</button>
    </div>
  );
}

// ── Pills (a view switcher or a filter), with optional counts ───────────────────────────────────
export function Pills({ options, value, onChange, size = 'md' }) {
  const pad = size === 'sm' ? 'h-7 px-2 text-[11px]' : 'h-8 px-2.5 text-xs';
  return (
    <div className="flex flex-wrap gap-1" role="group">
      {options.map(o => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={value === o.id}
          className={`${pad} rounded-md border whitespace-nowrap transition-colors ${value === o.id ? 'bg-stone-900 text-white border-stone-900' : 'bg-white text-stone-700 border-stone-300 hover:border-stone-500'}`}>
          {o.label}{o.count != null && <span className={`ml-1 ${value === o.id ? 'opacity-70' : 'text-stone-400'}`}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, hint, action }) {
  return (
    <div className="py-8 text-center">
      <div className="text-sm font-medium text-stone-800">{title}</div>
      {hint && <div className="text-xs text-stone-500 mt-1 max-w-md mx-auto">{hint}</div>}
      {action && <button type="button" onClick={action.onClick} className="mt-3 h-8 px-3 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500">{action.label}</button>}
    </div>
  );
}

// ── CSV download (rows are what the list shows, all pages) ──────────────────────────────────────
export function downloadCsv(filename, headers, rows) {
  const blob = new Blob(['﻿', toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });   // BOM so Excel reads rupee signs and accents
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
