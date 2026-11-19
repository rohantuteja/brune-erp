import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { localToday } from '../lib/constants';
import { accountingStart, fetchGstMonth } from '../lib/gstData';
import { buildGstReport, stateTable, monthsBetween, monthLabel, CHANNEL_LABEL, MYNTRA_ECO_GSTIN } from '../lib/gstReport';
import { buildGstSheets, gstFileName } from '../lib/gstWorkbook';
import { downloadXlsx } from '../lib/xlsxWrite';
import { Collapsible, Pagination, Pills, StatCard, useUrlParams } from '../components/AnalyticsKit';
import { Download, Info, CheckCircle2, AlertCircle, AlertTriangle, RotateCcw } from 'lucide-react';

// Analytics → GST. One month of sales for GSTR-1, worked out from the stored order ledger (never from payments):
// a sale counts in the month the ORDER was placed, a return in the month its credit note is dated. State-wise and rate-wise,
// Shopify and Myntra apart, with an Excel file of everything on the page. Rules and reasoning: docs/gst-view.md.

const URL_DEFAULTS = { gmonth: '', gchan: 'all' };
const inr = (n, digits = 0) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const amt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace('-', '−');
const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(`${d}T00:00:00`);
  return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
};
const tax = (b) => Math.round((b.igst + b.cgst + b.sgst) * 100) / 100;

const CHANNEL_PILLS = [{ id: 'all', label: 'Both channels (Table 7)' }, { id: 'myntra', label: 'Myntra (Table 14)' }, { id: 'shopify', label: 'Shopify only' }];
const CHECK_STYLE = {
  ok:    { icon: CheckCircle2,  cls: 'text-emerald-700' },
  info:  { icon: Info,          cls: 'text-sky-700' },
  warn:  { icon: AlertTriangle, cls: 'text-amber-700' },
  error: { icon: AlertCircle,   cls: 'text-red-700' },
};

/** The last month that has ended (the one being filed), or the current month if the books only started this month. */
export function defaultMonth(start, today) {
  const startMonth = start.slice(0, 7), thisMonth = today.slice(0, 7);
  const [y, m] = thisMonth.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return prev >= startMonth ? prev : thisMonth;
}

// ── A list of documents, paged ─────────────────────────────────────────────────────────────────────────────────────
// A proper component (it holds its own page state), not inlined in a .map().
export function DocTable({ rows, columns, noun }) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  useEffect(() => { setPage(1); }, [rows]);
  const slice = rows.slice((page - 1) * size, page * size);
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-stone-500 border-b border-stone-200">
            {columns.map(c => <th key={c.label} className={`py-1.5 px-2 font-medium whitespace-nowrap ${c.right ? 'text-right' : ''}`}>{c.label}</th>)}
          </tr></thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={r.key ?? `${r.order}-${i}`} className="border-b border-stone-100">
                {columns.map(c => <td key={c.label} className={`py-1.5 px-2 whitespace-nowrap ${c.right ? 'text-right tabular-nums' : ''} ${c.muted ? 'text-stone-500' : ''}`}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pt-2"><Pagination page={page} pageSize={size} total={rows.length} onPage={setPage} onPageSize={(s) => { setSize(s); setPage(1); }} noun={noun} /></div>
    </div>
  );
}

const docColumns = (extra = []) => [
  { label: 'Date', cell: r => fmtDate(r.date) },
  { label: 'Number', cell: r => r.number || <span className="text-amber-700">not numbered yet</span> },
  { label: 'Order', cell: r => r.order },
  ...extra,
  { label: 'State', cell: r => r.state || <span className="text-amber-700">none</span> },
  { label: 'Rate', right: true, cell: r => `${r.ratePct}%` },
  { label: 'Taxable', right: true, cell: r => amt(r.taxable) },
  { label: 'IGST', right: true, cell: r => amt(r.igst) },
  { label: 'CGST', right: true, cell: r => amt(r.cgst) },
  { label: 'SGST', right: true, cell: r => amt(r.sgst) },
  { label: 'Value', right: true, cell: r => amt(r.total) },
];

// ── The report for one month (no data loading here: the container passes a built report) ──────────────────────────
export function GstReportView({ report, channel, onChannel, months, month, onMonth, onExport, loading, error, onReload }) {
  const inChannel = useCallback((x) => channel === 'all' || x.channel === channel, [channel]);
  const table = useMemo(() => report ? stateTable(report, channel) : null, [report, channel]);
  const docs = useMemo(() => report ? {
    sales: report.docs.sales.filter(inChannel), fees: report.docs.fees.filter(inChannel), returns: report.docs.returns.filter(inChannel), waiting: report.waiting.filter(inChannel),
  } : null, [report, inChannel]);
  const T = table?.total;
  const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">GST sales</h2>
          <div className="text-[11px] text-stone-500">The month's sales for GSTR-1, by state and rate, from the order ledger.</div>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => onMonth(e.target.value)} className={field} aria-label="Month">
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button type="button" onClick={onReload} disabled={loading} title="Read the stored ledger again" className="inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50">
            <RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Reload
          </button>
          <button type="button" onClick={onExport} disabled={!report || loading} title="Everything for the month, both channels, as an Excel file" className="inline-flex items-center gap-1 h-8 px-3 text-xs rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40">
            <Download className="w-3.5 h-3.5" /> Download Excel
          </button>
        </div>
      </div>

      <div className="text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 leading-relaxed">
        A sale counts in the month the <b>order was placed</b>, whether or not it has been paid. A return reduces the month its <b>credit note is dated</b>. Orders Unicommerce has not invoiced yet are not in the figures; they are listed at the bottom.
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {loading && !report && <div className="text-sm text-stone-500 px-1 py-6">Loading {monthLabel(month)}…</div>}

      {report && T && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Pills options={CHANNEL_PILLS} value={channel} onChange={onChannel} />
            <div className="text-[11px] text-stone-500 max-w-2xl sm:text-right">
              {channel === 'all' && <>Shopify and Myntra together, by state and rate: the figures for GSTR-1 <b>Table 7</b> (B2C). Myntra's sales belong here too.</>}
              {channel === 'myntra' && <>Myntra collects TCS under section 52, so GSTR-1 <b>Table 14(a)</b> also asks for a summary of these sales under its GSTIN {MYNTRA_ECO_GSTIN}. They are already in Table 7 (use "Both channels" for that); do not leave them out of it.</>}
              {channel === 'shopify' && <>Shopify's sales on their own. This is not a GSTR-1 table: Table 7 needs Myntra's sales as well.</>}
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            <StatCard label="Sales" value={inr(T.sales.taxable + T.fees.taxable)} sub={`${T.sales.docs} invoices${T.fees.docs ? ` + ${T.fees.docs} fee invoices` : ''} · GST ${inr(tax(T.sales) + tax(T.fees), 2)}`} />
            <StatCard label="Credit notes" value={inr(T.returns.taxable)} tone="text-amber-800" sub={`${T.returns.docs} documents · GST ${inr(tax(T.returns), 2)}`} />
            <StatCard label="Net taxable value" value={inr(T.net.taxable)} tone="text-emerald-800" sub="sales + fee invoices − credit notes" />
            <StatCard label="Net GST" value={inr(tax(T.net), 2)} sub={`IGST ${inr(T.net.igst, 2)} · CGST ${inr(T.net.cgst, 2)} · SGST ${inr(T.net.sgst, 2)}`} />
          </div>

          <ul className="space-y-1">
            {report.checks.map(c => {
              const s = CHECK_STYLE[c.level] || CHECK_STYLE.info; const Icon = s.icon;
              return <li key={c.id} className="flex items-start gap-2 text-xs text-stone-700"><Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${s.cls}`} /><span>{c.text}</span></li>;
            })}
          </ul>

          <section className="bg-white rounded-lg border border-stone-200">
            <div className="px-3 sm:px-4 py-2.5 border-b border-stone-100 flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-stone-900">By state and rate</h3>
              <span className="text-[11px] text-stone-500">{table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'}</span>
            </div>
            {table.rows.length === 0 ? <div className="text-sm text-stone-500 px-4 py-6">No sales or returns in {monthLabel(month)} for this channel.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-stone-500 border-b border-stone-200">
                    <th className="py-1.5 px-3 text-left font-medium">State</th>
                    <th className="py-1.5 px-2 text-right font-medium">Rate</th>
                    <th className="py-1.5 px-2 text-right font-medium">Sales</th>
                    <th className="py-1.5 px-2 text-right font-medium">Fee invoices</th>
                    <th className="py-1.5 px-2 text-right font-medium">Credit notes</th>
                    <th className="py-1.5 px-2 text-right font-medium text-stone-900">Net taxable</th>
                    <th className="py-1.5 px-2 text-right font-medium">IGST</th>
                    <th className="py-1.5 px-2 text-right font-medium">CGST</th>
                    <th className="py-1.5 px-2 text-right font-medium">SGST</th>
                    <th className="py-1.5 px-3 text-right font-medium">Net tax</th>
                  </tr></thead>
                  <tbody>
                    {table.rows.map(r => (
                      <tr key={`${r.channel}|${r.stateCode}|${r.ratePct}`} className="border-b border-stone-100">
                        <td className="py-1.5 px-3 whitespace-nowrap">{r.state}{r.stateCode && <span className="text-stone-400 ml-1">{r.stateCode}</span>}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{r.ratePct}%</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{amt(r.sales.taxable)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-stone-500">{r.fees.taxable ? amt(r.fees.taxable) : '–'}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-stone-500">{r.returns.taxable ? `−${amt(r.returns.taxable)}` : '–'}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-medium">{amt(r.net.taxable)}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{r.net.igst ? amt(r.net.igst) : '–'}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{r.net.cgst ? amt(r.net.cgst) : '–'}</td>
                        <td className="py-1.5 px-2 text-right tabular-nums">{r.net.sgst ? amt(r.net.sgst) : '–'}</td>
                        <td className="py-1.5 px-3 text-right tabular-nums">{amt(tax(r.net))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="font-semibold border-t-2 border-stone-300 bg-stone-50">
                    <td className="py-2 px-3">Total</td><td />
                    <td className="py-2 px-2 text-right tabular-nums">{amt(T.sales.taxable)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{amt(T.fees.taxable)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{T.returns.taxable ? `−${amt(T.returns.taxable)}` : amt(0)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{amt(T.net.taxable)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{amt(T.net.igst)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{amt(T.net.cgst)}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{amt(T.net.sgst)}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{amt(tax(T.net))}</td>
                  </tr></tfoot>
                </table>
              </div>
            )}
          </section>

          <Collapsible id="gst-sales" title="Sales invoices" count={docs.sales.length} summary="one line per Unicommerce invoice, on the order date">
            <DocTable rows={docs.sales} noun="invoices" columns={[
              { label: 'Order date', cell: r => fmtDate(r.date) }, { label: 'Invoice', cell: r => r.number || '—' }, { label: 'Order', cell: r => r.order },
              ...(channel === 'all' ? [{ label: 'Channel', cell: r => CHANNEL_LABEL[r.channel] }] : []),
              { label: 'State', cell: r => r.state || <span className="text-amber-700">none</span> }, { label: 'Rate', right: true, cell: r => `${r.ratePct}%` },
              { label: 'Taxable', right: true, cell: r => amt(r.taxable) }, { label: 'IGST', right: true, cell: r => amt(r.igst) }, { label: 'CGST', right: true, cell: r => amt(r.cgst) }, { label: 'SGST', right: true, cell: r => amt(r.sgst) },
              { label: 'Value', right: true, cell: r => amt(r.total) }, { label: 'Qty', right: true, muted: true, cell: r => r.qty || '' },
            ]} />
          </Collapsible>
          <Collapsible id="gst-returns" title="Credit notes" count={docs.returns.length} summary="dated by the credit note, with who issued it">
            <DocTable rows={docs.returns} noun="credit notes" columns={docColumns([{ label: 'Issued by', muted: true, cell: r => r.issuedBy === 'unicommerce' ? 'Unicommerce' : 'ERP' }, { label: 'What for', muted: true, cell: r => r.reason }])} />
          </Collapsible>
          <Collapsible id="gst-fees" title="Fee invoices issued by the ERP" count={docs.fees.length} summary="return fee and COD charge kept from customers">
            <DocTable rows={docs.fees} noun="invoices" columns={docColumns([{ label: 'What for', muted: true, cell: r => r.reason }])} />
          </Collapsible>
          <Collapsible id="gst-waiting" title="Placed this month, not invoiced yet" count={docs.waiting.length} tone={docs.waiting.length ? 'amber' : 'neutral'} summary="not in the figures above until Unicommerce invoices them">
            {docs.waiting.length === 0 ? <div className="text-xs text-stone-500">Every order placed in {monthLabel(month)} has been invoiced.</div> : (
              <DocTable rows={docs.waiting} noun="orders" columns={[
                { label: 'Order date', cell: r => fmtDate(r.date) }, { label: 'Order', cell: r => r.order }, { label: 'Channel', cell: r => CHANNEL_LABEL[r.channel] },
                { label: 'State', cell: r => r.state || '—' }, { label: 'Why', muted: true, cell: r => r.reason },
              ]} />
            )}
          </Collapsible>
        </>
      )}
    </div>
  );
}

// ── The tab: loads the month, builds the report, exports ──────────────────────────────────────────────────────────
export default function GstSection({ showToast }) {
  const [p, setP] = useUrlParams(URL_DEFAULTS);
  const [start, setStart] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { accountingStart(supabase).then(setStart); }, []);
  const today = localToday();
  const months = useMemo(() => start ? monthsBetween(start.slice(0, 7), today.slice(0, 7)) : [], [start, today]);
  const month = p.gmonth && months.includes(p.gmonth) ? p.gmonth : start ? defaultMonth(start, today) : '';

  const load = useCallback(async () => {
    if (!month) return;
    setLoading(true); setError('');
    try { setData({ month, ...(await fetchGstMonth(supabase, month)) }); }
    catch (err) { setError(`Could not load ${monthLabel(month)}: ${err.message}`); showToast?.('Could not load the GST figures', 'error'); }
    setLoading(false);
  }, [month, showToast]);
  useEffect(() => { load(); }, [load]);

  const report = useMemo(() => data && data.month === month ? buildGstReport(data) : null, [data, month]);
  const exportXlsx = () => { try { downloadXlsx(gstFileName(report), buildGstSheets(report)); } catch (err) { showToast?.(`Could not make the Excel file: ${err.message}`, 'error'); } };

  if (!month) return <div className="text-sm text-stone-500 px-1 py-6">Loading…</div>;
  return (
    <GstReportView report={report} channel={p.gchan} onChannel={(c) => setP({ gchan: c })} months={months} month={month}
      onMonth={(m) => setP({ gmonth: m })} onExport={exportXlsx} loading={loading} error={error} onReload={load} />
  );
}
