import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { localToday } from '../lib/constants';
import { accountingStart } from '../lib/gstData';
import { monthsBetween, monthLabel } from '../lib/gstReport';
import { fetchAccounting, markLedgers, linkVendor } from '../lib/accountingData';
import { bookChecks } from '../lib/tallyBooks';
import { buildLedgersFile, ledgersFileName, withLedgers } from '../lib/tallyLedgers';
import { buildChecklist } from '../lib/accountingChecklist';
import { groupOrderVouchers, voucherPlan, TYPE_LABEL } from '../lib/tallyVouchers';
import { buildTallyFile, tallyFileName } from '../lib/tallyJson';
import { useUrlParams } from '../components/AnalyticsKit';
import { CheckCircle2, Circle, Info, RotateCcw, ArrowRight, Lock, ChevronDown, ChevronRight, Download, AlertTriangle } from 'lucide-react';

// Accounting: pick a month, see every step still to do before its Tally file can be generated (from what the ERP already holds), and
// generate the file once nothing blocks it. Rules and reasoning: docs/accounting-page.md.

const URL_DEFAULTS = { acmonth: '' };
const SLUG = { bank: 'bank-and-card', bills: 'bills', velocity: 'velocity-wallet', gstr3b: 'gstr-3b', ledger: 'ledger', gst: 'gst', myntra: 'myntra', supfile: 'supplier-filing' };
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const field = 'h-8 border border-stone-300 rounded-md px-2 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-stone-900 focus:border-transparent';
const btn = 'inline-flex items-center gap-1 h-8 px-2.5 text-xs rounded-md border border-stone-300 bg-white hover:border-stone-500 disabled:opacity-50';
const btnDark = 'inline-flex items-center gap-1 h-9 px-4 text-sm rounded-md bg-stone-900 text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed';

function defaultMonth(start, today) {
  const startMonth = start.slice(0, 7), thisMonth = today.slice(0, 7);
  const [y, m] = thisMonth.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return prev >= startMonth ? prev : thisMonth;
}

// One step. A proper component: it holds whether its list is open.
function StepRow({ step, onGo }) {
  const [open, setOpen] = useState(false);
  const todo = step.status === 'todo', info = step.status === 'info';
  const Icon = step.status === 'done' ? CheckCircle2 : info ? Info : Circle;
  const tone = step.status === 'done' ? 'text-emerald-600' : info ? 'text-sky-600' : step.blocker ? 'text-red-600' : 'text-amber-600';
  return (
    <li className="px-3 sm:px-4 py-2.5 flex items-start gap-3">
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`text-sm ${todo ? 'font-medium text-stone-900' : 'text-stone-800'}`}>{step.title}</span>
          {todo && step.blocker && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-900">blocks the file</span>}
          {todo && !step.blocker && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900">to do</span>}
        </div>
        <div className="text-xs text-stone-500 mt-0.5 leading-relaxed">{step.detail}</div>
        {step.items.length > 0 && (
          <div className="mt-1">
            <button type="button" onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-1 text-[11px] text-stone-600 hover:text-stone-900">
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}{step.items.length} item{step.items.length === 1 ? '' : 's'}
            </button>
            {open && <ul className="mt-1 space-y-0.5 text-[11px] text-stone-600 list-disc pl-5">{step.items.map(x => <li key={x}>{x}</li>)}</ul>}
          </div>
        )}
      </div>
      {step.link && <button type="button" className={`${btn} shrink-0`} onClick={() => onGo(step.link.tab)}>{step.link.label}<ArrowRight className="w-3 h-3" /></button>}
    </li>
  );
}

// One bank payment the ERP could not place: say which supplier it went to. A proper component: it holds its own choice.
function SupplierLinkRow({ line, vendors, onLink }) {
  const [vendorId, setVendorId] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); await onLink([line.id], Number(vendorId), remember && !!line.payee); setBusy(false); };
  return (
    <li className="px-3 sm:px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-xs tabular-nums text-stone-700 w-20 shrink-0">{String(line.txn_date).slice(0, 10)}</span>
      <span className="text-xs tabular-nums font-medium text-stone-900 w-24 shrink-0">{inr(line.debit)}</span>
      <span className="text-[11px] text-stone-500 min-w-0 flex-1 truncate" title={line.remarks}>{line.payee || line.remarks}</span>
      <select value={vendorId} onChange={e => setVendorId(e.target.value)} className={`${field} w-56`} aria-label={`Supplier for the payment of ${inr(line.debit)}`}>
        <option value="">Which supplier?</option>
        {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      {line.payee && <label className="inline-flex items-center gap-1 text-[11px] text-stone-600"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Remember this payee</label>}
      <button type="button" className={btn} disabled={!vendorId || busy} onClick={save}>Save</button>
    </li>
  );
}

function SupplierLinks({ lines, vendors, onLink }) {
  return (
    <section className="bg-white rounded-lg border border-amber-300">
      <div className="px-3 sm:px-4 py-2 border-b border-amber-200 bg-amber-50 rounded-t-lg text-sm font-medium text-amber-900">Which supplier did these payments go to?</div>
      <div className="px-3 sm:px-4 py-2 text-xs text-stone-600">The ERP places most payments by itself (the bill's exact amount, a payee it has seen, a name like Airtel). These it could not. Each is posted to the supplier you pick, against its bill or as an advance. Tick "Remember this payee" only when the payee is that supplier every time (not a person's own name). If it was not a supplier payment, file it on Bank & card under a bucket that needs no bill instead.</div>
      <ul className="divide-y divide-stone-100">{lines.map(l => <SupplierLinkRow key={l.id} line={l} vendors={vendors} onLink={onLink} />)}</ul>
    </section>
  );
}

export function AccountingView({ month, months, onMonth, checklist, plan, loading, error, onReload, onGo, onGenerate, built, ledgers, onLedgersFile, onMark, books, vendors, onLink }) {
  const c = checklist;
  const total = c ? c.steps.filter(s => s.status !== 'info').length : 0;
  const done = c ? c.steps.filter(s => s.status === 'done').length : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-stone-900">Accounting</h2>
          <div className="text-[11px] text-stone-500">Month-end checklist and the Tally file, from what the ERP already holds.</div>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => onMonth(e.target.value)} className={field} aria-label="Month">{months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}</select>
          <button type="button" onClick={onReload} disabled={loading} title="Read everything again" className={btn}><RotateCcw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Reload</button>
        </div>
      </div>

      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}
      {loading && !c && <div className="text-sm text-stone-500 px-1 py-6">Checking {monthLabel(month)}…</div>}

      {c && (
        <>
          <div className={`rounded-lg border px-4 py-3 ${c.ready ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className={`text-sm font-medium ${c.ready ? 'text-emerald-900' : 'text-amber-900'}`}>
              {c.ready ? `${monthLabel(month)} is ready for the Tally file.` : `${c.blockers.length} step${c.blockers.length === 1 ? '' : 's'} to finish before the ${monthLabel(month)} Tally file can be generated.`}
            </div>
            <div className="text-xs text-stone-600 mt-0.5">{done} of {total} steps done{c.todo.length - c.blockers.length > 0 ? ` · ${c.todo.length - c.blockers.length} more to do that do not block the file` : ''}.</div>
          </div>

          {c.sections.map(sec => (
            <section key={sec.id} className="bg-white rounded-lg border border-stone-200">
              <div className="px-3 sm:px-4 py-2 border-b border-stone-100 text-sm font-medium text-stone-900">{sec.title}</div>
              <ul className="divide-y divide-stone-100">{sec.steps.map(s => <StepRow key={s.id} step={s} onGo={onGo} />)}</ul>
            </section>
          ))}

          {books && books.unlinked.length > 0 && <SupplierLinks lines={books.unlinked} vendors={(vendors || []).filter(v => v.booking !== 'tie_out')} onLink={onLink} />}

          <section className="bg-white rounded-lg border border-stone-200">
            <div className="px-3 sm:px-4 py-2 border-b border-stone-100 text-sm font-medium text-stone-900">Tally file for {monthLabel(month)}</div>
            <div className="px-3 sm:px-4 py-3 space-y-3">
              <div className="text-xs text-stone-600 leading-relaxed">A JSON file of vouchers for TallyPrime to import: sales and credit notes by invoice, bank receipts by UTR and the clearing of each customer's bill order by order (all from the order ledger), the supplier bills as purchase vouchers, and the bank payments as payment vouchers settled against those bills. Nothing is sent to Tally: the accountant imports the file.</div>
              {plan && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-stone-500 border-b border-stone-200"><th className="py-1.5 pr-2 text-left font-medium">Voucher type</th><th className="py-1.5 px-2 text-right font-medium">Vouchers</th><th className="py-1.5 px-2 text-right font-medium">Amount</th><th className="py-1.5 pl-2 text-left font-medium">From</th></tr></thead>
                    <tbody>
                      {['sales', 'credit_note', 'purchase', 'payment', 'receipt', 'journal'].filter(t => plan[t]).map(t => (
                        <tr key={t} className="border-b border-stone-100">
                          <td className="py-1.5 pr-2">{TYPE_LABEL[t]}</td><td className="py-1.5 px-2 text-right tabular-nums">{plan[t].count}</td><td className="py-1.5 px-2 text-right tabular-nums">{inr(plan[t].amount)}</td>
                          <td className="py-1.5 pl-2 text-stone-500">{Object.entries(plan[t].sources).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(' · ')}{plan[t].unbalanced ? <span className="text-red-700"> · {plan[t].unbalanced} unbalanced</span> : null}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {ledgers && (ledgers.create.length > 0 || ledgers.rename.length > 0) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 space-y-2">
                  <div className="text-xs font-medium text-amber-900">Ledgers Tally does not have yet</div>
                  {ledgers.create.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs text-stone-700">The Tally file <b>begins with</b> {ledgers.create.length} ledger{ledgers.create.length === 1 ? '' : 's'} to create, so one import creates them and then posts into them: {ledgers.create.map(l => `${l.name} (${l.under})`).join(', ')}.</div>
                      <button type="button" className="text-[11px] text-stone-500 underline hover:text-stone-800" onClick={onLedgersFile}>If Tally refuses the combined file, download the ledgers on their own and import that first</button>
                    </div>
                  )}
                  {ledgers.rename.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs text-stone-700">To rename by hand in Tally (Alter Ledger; a file cannot be trusted to rename without making a second ledger): {ledgers.rename.map(l => `${l.renamed_from} → ${l.name}`).join('; ')}.</div>
                      <button type="button" className={btn} onClick={() => onMark(ledgers.rename.map(l => l.name))}>I renamed them in Tally</button>
                    </div>
                  )}
                  <div className="text-[11px] text-stone-600">Do the renames before importing: the vouchers use the new names.</div>
                </div>
              )}
              {books && (books.summary.skipped.ignored || books.summary.skipped['order ledger receipt']) ? <div className="text-[11px] text-stone-500">Left out on purpose: {books.summary.skipped.ignored || 0} bank lines that make no entry (wholesale, returned payments, your own card payments) and {books.summary['skipped']?.['order ledger receipt'] || 0} payouts the order ledger already has a receipt for.</div> : null}
              <div className="text-[11px] text-stone-500">Not in the file yet: the card journal, the stock journals and the month-end stock correction, and the Meta and Velocity provisions. Sales and credit notes still carry no stock items.</div>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={btnDark} disabled={!c.ready} onClick={() => onGenerate(false)} title={c.ready ? '' : 'Finish the steps that block the file first'}>
                  {c.ready ? <Download className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}Generate Tally file
                </button>
                <button type="button" className={btn} onClick={() => onGenerate(true)} title="A few vouchers of each type, to try the import on a copy company first"><Download className="w-3.5 h-3.5" />Download a small test file</button>
                <span className="text-xs text-stone-500">{c.ready ? 'Nothing blocks the file.' : `Finish the ${c.blockers.length} step${c.blockers.length === 1 ? '' : 's'} marked "blocks the file" above first.`}</span>
              </div>
              <div className="text-[11px] text-stone-500">Import the test file into a copy company first: it shows how your Tally takes the vouchers before a whole month goes in.</div>
              {built && (
                <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 space-y-1">
                  <div className="text-xs font-medium text-stone-900">{built.test ? 'Test file' : 'File'} downloaded: {Object.entries(built.counts).map(([t, n]) => `${n} ${(TYPE_LABEL[t] ?? 'ledger').toLowerCase()}${t === 'ledger' && n !== 1 ? 's' : ''}`).join(', ')}.</div>
                  <ul className="space-y-0.5">{built.checks.map(k => <li key={k.id} className="flex items-start gap-1.5 text-xs text-stone-700">{k.ok ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-600" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />}<span>{k.detail}</span></li>)}</ul>
                  {!built.test && ledgers && ledgers.create.length > 0 && <div className="pt-1 flex flex-wrap items-center gap-2"><button type="button" className={btn} onClick={() => onMark(ledgers.create.map(l => l.name))}>The accountant imported this file into Tally</button><span className="text-[11px] text-stone-500">Press it once they have: the new ledgers then stop being created again.</span></div>}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default function AccountingPage({ showToast }) {
  const navigate = useNavigate();
  const [p, setP] = useUrlParams(URL_DEFAULTS);
  const [start, setStart] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { accountingStart(supabase).then(setStart); }, []);
  const today = localToday();
  const months = useMemo(() => start ? monthsBetween(start.slice(0, 7), today.slice(0, 7)) : [], [start, today]);
  const month = p.acmonth && months.includes(p.acmonth) ? p.acmonth : start ? defaultMonth(start, today) : '';

  const load = useCallback(async () => {
    if (!month) return;
    setLoading(true); setError('');
    try { setData({ month, ...(await fetchAccounting(supabase, month, today)) }); }
    catch (err) { setError(`Could not check ${monthLabel(month)}: ${err.message}`); showToast?.('Could not load the accounting checklist', 'error'); }
    setLoading(false);
  }, [month, today, showToast]);
  useEffect(() => { load(); }, [load]);

  const fresh = data && data.month === month ? data : null;
  const checklist = useMemo(() => fresh ? buildChecklist(fresh.checklistInput) : null, [fresh]);
  const vouchers = useMemo(() => fresh ? groupOrderVouchers(fresh.entries) : [], [fresh]);
  const books = fresh?.books ?? null;
  const plan = useMemo(() => fresh ? voucherPlan([...vouchers, ...(books?.vouchers ?? [])]) : null, [fresh, vouchers, books]);
  const ledgers = useMemo(() => fresh ? buildLedgersFile(fresh.tally, fresh.vendors) : null, [fresh]);
  const downloadJson = (obj, name) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onMark = async (names) => {
    try { const n = await markLedgers(supabase, names); showToast?.(`${n} ledger${n === 1 ? '' : 's'} marked as ready in Tally`, 'success'); await load(); }
    catch (err) { showToast?.(`Could not save: ${err.message}`, 'error'); }
  };
  const onLink = async (ids, vendorId, remember) => {
    try { await linkVendor(supabase, ids, vendorId, remember); showToast?.('Supplier saved', 'success'); await load(); }
    catch (err) { showToast?.(`Could not save: ${err.message}`, 'error'); }
  };
  const [built, setBuilt] = useState(null);
  useEffect(() => { setBuilt(null); }, [month]);
  const onGenerate = (test) => {
    try {
      const orders = new Map((fresh?.orders || []).map(o => [o.order_name, { state: o.state, saleDoc: o.saleDoc, channel: o.channel }]));
      const r = buildTallyFile({ vouchers, orders, books: books?.vouchers ?? [], limit: test ? 3 : null });
      const withL = withLedgers(r.file, fresh?.tally || [], fresh?.vendors || []);
      downloadJson(withL, tallyFileName(month, test));
      setBuilt({ test, counts: { ...(ledgers && ledgers.create.length ? { ledger: ledgers.create.length } : {}), ...r.counts }, checks: [...r.checks, ...(books && !test ? bookChecks(books) : [])] });
    } catch (err) { showToast?.(`Could not make the file: ${err.message}`, 'error'); }
  };

  if (!month) return <div className="text-sm text-stone-500 px-1 py-6">Loading…</div>;
  return <AccountingView month={month} months={months} onMonth={(m) => setP({ acmonth: m })} checklist={checklist} plan={plan} loading={loading} error={error} onReload={load} onGenerate={onGenerate} built={built} ledgers={ledgers} onMark={onMark} books={books} vendors={fresh?.vendors} onLink={onLink} onLedgersFile={() => downloadJson(ledgers.file, ledgersFileName())}
    onGo={(tab) => navigate(`/analytics/${SLUG[tab] ?? tab}`)} />;
}
