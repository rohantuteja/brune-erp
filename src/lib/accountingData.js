// Reads what the Accounting page needs for one month: the checklist's inputs and the ledger entries the Tally vouchers are built from.
// Read-only. The rules are in accountingChecklist.js and tallyVouchers.js.
import { pages } from './gstData.js';
import { monthBounds } from './gstReport.js';
import { buildGstr3b } from './gstr3b.js';
import { missingLedgers } from './accountingChecklist.js';

const missingTable = (error) => !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache|Could not find the table/i.test(error.message || ''));
const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };
// Bucket names that are not ledgers (a Tally group, or lines that make no company entry).
const NOT_LEDGERS = new Set(['Purchase Accounts', 'Returned or reversed (no entry)', 'Founder card payment (no company entry)']);

export async function fetchAccounting(supabase, month, today) {
  const { from, next } = monthBounds(month);
  const first = async (table, col) => (must(await supabase.from(table).select(col).order(col, { ascending: false }).limit(1)))?.[0]?.[col] ?? null;

  const [accounts, statements, gokwikTxnTo, velocityTo, myntraSettledTo] = await Promise.all([
    supabase.from('finance_accounts').select('id, kind, name').then(must),
    supabase.from('finance_statements').select('account_id, period_to').order('period_to', { ascending: false }).then(must),
    first('gokwik_payments', 'txn_date'), first('velocity_ledger_imports', 'period_to'), first('myntra_settlement_lines', 'settled_on'),
  ]);
  const accountRows = accounts.map(a => ({ kind: a.kind, name: a.name, periodTo: statements.find(s => s.account_id === a.id)?.period_to ?? null }));

  const bankUnresolved = (await supabase.from('finance_lines').select('id', { count: 'exact', head: true }).gte('txn_date', from).lt('txn_date', next).not('status', 'in', '(matched,ignored)')).count ?? 0;

  const bills = await pages((a, b) => supabase.from('vendor_invoices').select('id, vendor, vendor_id, invoice_no, invoice_date, subtotal, tax, total, tax_type, supplier_gstin, status, opening, kind').neq('status', 'void').order('id').range(a, b));
  const vendors = await pages((a, b) => supabase.from('vendors').select('id, name, gstin, booking, tally_ledger_name, expense_ledger').order('id').range(a, b));
  const billsReview = bills.filter(b => b.status === 'review' && !b.opening).length;

  let twoB = null;
  const f = await supabase.from('gstr2b_files').select('docs').eq('month', month).maybeSingle();
  if (f.error && !missingTable(f.error)) throw new Error(f.error.message);
  if (f.data) twoB = { docs: f.data.docs || [], warnings: [], checks: [], period: month, gstin: null };
  let toUpload = [];
  if (twoB) {
    const stub = { states: [], totals: { all: { net: { taxable: 0, igst: 0, cgst: 0, sgst: 0 } } } };
    toUpload = buildGstr3b({ month, gst: stub, ownGstin: '', bills, vendors, twoB }).itc.lists.toUpload.map(x => ({ vendor: x.vendor || x.gstin, no: x.no, date: x.date, tax: x.twoB.igst + x.twoB.cgst + x.twoB.sgst }));
  }

  const orderRows = await pages((a, b) => supabase.from('ledger_orders').select('order_name, status, exception_type').gte('sale_date', from).lt('sale_date', next).order('order_name').range(a, b));
  const open = {};
  for (const o of orderRows) if (o.status === 'open' && o.exception_type) open[o.exception_type] = (open[o.exception_type] ?? 0) + 1;
  const attentionAll = (await supabase.from('ledger_orders').select('order_name', { count: 'exact', head: true }).eq('status', 'attention')).count ?? 0;
  const run = (must(await supabase.from('ledger_runs').select('id, status, finished_at, summary').eq('status', 'done').order('id', { ascending: false }).limit(1)))?.[0] ?? null;

  const tally = await pages((a, b) => supabase.from('tally_ledgers').select('name, status, under, renamed_from').order('name').range(a, b));
  const entries = await pages((a, b) => supabase.from('ledger_entries').select('order_name, entry_date, voucher, account, debit, credit, doc, issued_by, memo, part, qty').gte('entry_date', from).lt('entry_date', next).order('id').range(a, b));
  const orderNames = [...new Set(entries.map(e => e.order_name))];
  const orders = [];
  for (let i = 0; i < orderNames.length; i += 100) {
    const { data, error } = await supabase.from('ledger_orders').select('order_name, state, channel, saleDoc:facts->>saleDoc').in('order_name', orderNames.slice(i, i + 100));
    if (error) throw new Error(error.message);
    orders.push(...(data || []));
  }
  const buckets = await pages((a, b) => supabase.from('finance_buckets').select('name, kind').order('name').range(a, b));
  const lines = await pages((a, b) => supabase.from('finance_lines').select('bucket').gte('txn_date', from).lt('txn_date', next).eq('status', 'matched').order('id').range(a, b));
  const ignore = new Set(buckets.filter(x => x.kind === 'ignore').map(x => x.name));
  const monthBills = bills.filter(b => b.invoice_date >= from && b.invoice_date < next && !b.opening && b.status === 'accepted');
  const vendorById = new Map(vendors.map(v => [v.id, v]));
  const used = [
    ...entries.map(e => e.account),
    ...lines.map(l => l.bucket).filter(x => x && !NOT_LEDGERS.has(x) && !ignore.has(x)),
    ...monthBills.flatMap(b => { const v = vendorById.get(b.vendor_id); return v && v.booking !== 'tie_out' ? [v.tally_ledger_name, v.expense_ledger].filter(Boolean) : []; }),
  ];

  let gstr3bFiled = false;
  const g3 = await supabase.from('gstr3b_months').select('filed_at').eq('month', month).maybeSingle();
  if (!g3.error && g3.data?.filed_at) gstr3bFiled = true;

  const checklistInput = {
    month, today, accounts: accountRows, gokwikTxnTo, velocityTo, myntraSettledTo, billsReview, bills, toUpload, twoBLoaded: !!twoB, bankUnresolved,
    orders: { total: orderRows.length, waitingInvoice: orderRows.filter(o => o.status === 'waiting_invoice').length, open }, attentionAll,
    ledgerRun: run ? { finishedAt: run.finished_at, held: (run.summary?.held || []).length } : null,
    missing: missingLedgers({ used, tally }), gstr3bFiled, exportedAt: null,
  };
  return { checklistInput, entries, orders, tally };
}

/** The accountant created or renamed these ledgers in Tally: they stop blocking the file. Returns how many moved. */
export async function markLedgers(supabase, names) {
  const { data, error } = await supabase.rpc('tally_ledgers_mark', { p_names: names });
  if (error) throw new Error(error.message);
  return data;
}
