// Reads what the Accounting page needs for one month: the checklist's inputs and the ledger entries the Tally vouchers are built from.
// Read-only. The rules are in accountingChecklist.js and tallyVouchers.js.
import { pages, accountingStart } from './gstData.js';
import { monthBounds } from './gstReport.js';
import { buildGstr3b } from './gstr3b.js';
import { missingLedgers } from './accountingChecklist.js';
import { buildBooks } from './tallyBooks.js';

const missingTable = (error) => !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache|Could not find the table/i.test(error.message || ''));
const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };

export async function fetchAccounting(supabase, month, today) {
  const { from, next } = monthBounds(month);
  const start = (await accountingStart(supabase)) || from;
  const first = async (table, col) => (must(await supabase.from(table).select(col).order(col, { ascending: false }).limit(1)))?.[0]?.[col] ?? null;

  const [accounts, statements, gokwikSettledTo, velocityTo, myntraSettledTo] = await Promise.all([
    supabase.from('finance_accounts').select('id, kind, name').then(must),
    supabase.from('finance_statements').select('account_id, period_to').order('period_to', { ascending: false }).then(must),
    first('gokwik_payments', 'settlement_date'), first('velocity_ledger_imports', 'period_to'), first('myntra_settlement_lines', 'settled_on'),
  ]);
  const accountRows = accounts.map(a => ({ kind: a.kind, name: a.name, periodTo: statements.find(s => s.account_id === a.id)?.period_to ?? null }));

  // Every Easebuzz credit in the bank in the month should be proven by a GoKwik payout line: that, not the date of the last transaction, says whether the report is complete
  // (payments made in the last days of the month are paid out, and appear in the report, in the next month).
  const easebuzz = await pages((a, b) => supabase.from('finance_lines').select('kind').gte('txn_date', from).lt('txn_date', next).gt('credit', 0).ilike('remarks', '%easebuzz%').order('id').range(a, b));
  const gokwikPayouts = easebuzz.filter(l => l.kind === 'gokwik_payout').length, gokwikUnproven = easebuzz.length - gokwikPayouts;
  const bankUnresolved = (await supabase.from('finance_lines').select('id', { count: 'exact', head: true }).gte('txn_date', from).lt('txn_date', next).not('status', 'in', '(matched,ignored)')).count ?? 0;

  const bills = await pages((a, b) => supabase.from('vendor_invoices').select('id, vendor, vendor_id, invoice_no, invoice_date, subtotal, tax, total, tax_type, tax_rate, supplier_gstin, status, opening, kind, file_path, source, lines').neq('status', 'void').order('id').range(a, b));
  const vendors = await pages((a, b) => supabase.from('vendors').select('id, name, gstin, pan, state_code, booking, tally_ledger_name, expense_ledger, tds_rate, tds_ledger, tds_to_confirm').order('id').range(a, b));
  const billsReview = bills.filter(b => b.status === 'review' && !b.opening).length;

  let twoB = null;
  const f = await supabase.from('gstr2b_files').select('docs').eq('month', month).maybeSingle();
  if (f.error && !missingTable(f.error)) throw new Error(f.error.message);
  if (f.data) twoB = { docs: f.data.docs || [], warnings: [], checks: [], period: month, gstin: null };
  let toUpload = [], noCopy = [];
  // Invoices the owner said the accountant books (wholesale, or a supplier that never sent the bill): no voucher or stock entry is made from them here.
  const hd = await supabase.from('gstr2b_handled').select('gstin, invoice_key, invoice_no');
  if (hd.error && !missingTable(hd.error)) throw new Error(hd.error.message);
  const handled = hd.data || [];
  if (twoB) {
    const stub = { states: [], totals: { all: { net: { taxable: 0, igst: 0, cgst: 0, sgst: 0 } } } };
    const lists = buildGstr3b({ month, gst: stub, ownGstin: '', bills, vendors, twoB, handled }).itc.lists;
    toUpload = lists.toUpload.filter(x => !x.handled).map(x => ({ vendor: x.vendor || x.gstin, no: x.no, date: x.date, tax: x.twoB.igst + x.twoB.cgst + x.twoB.sgst }));
    noCopy = lists.noCopy.map(b => ({ vendor: b.vendor, no: b.no, date: b.date }));
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
  // The bills and the bank payments from the books' start to the end of the month: a payment of an earlier month still settles (or advances) this month's bills.
  const buckets = await pages((a, b) => supabase.from('finance_buckets').select('name, kind, needs_bill').order('name').range(a, b));
  const bankIds = accounts.filter(a => a.kind === 'bank').map(a => a.id);
  const bankLines = bankIds.length ? await pages((a, b) => supabase.from('finance_lines').select('id, txn_date, debit, credit, status, bucket, remarks, payee, vendor_id, note').gte('txn_date', start).lt('txn_date', next).in('account_id', bankIds).order('id').range(a, b)) : [];
  const pl = await supabase.from('finance_payee_vendors').select('payee, vendor_id');
  if (pl.error && !missingTable(pl.error)) throw new Error(pl.error.message);
  const books = buildBooks({ from, next, start, bills, vendors, handled, bankLines, buckets, payeeLinks: pl.data || [] });
  const used = [
    ...entries.map(e => e.account),
    ...books.vouchers.flatMap(v => [...v.lines, ...(v.itemLines || [])].map(l => l.account)),
  ];

  const checklistInput = {
    month, today, accounts: accountRows, gokwikSettledTo, gokwikPayouts, gokwikUnproven, velocityTo, myntraSettledTo, billsReview, bills, toUpload, noCopy, twoBLoaded: !!twoB, bankUnresolved,
    orders: { total: orderRows.length, waitingInvoice: orderRows.filter(o => o.status === 'waiting_invoice').length, open }, attentionAll,
    ledgerRun: run ? { finishedAt: run.finished_at, held: (run.summary?.held || []).length } : null,
    missing: missingLedgers({ used, tally }), exportedAt: null,
    books: { unlinked: books.unlinked, problems: books.problems, notes: books.notes, advances: books.advances, unpaid: books.unpaid, tdsPending: books.tdsPending, purchases: books.summary.purchases.count, payments: books.summary.payments.count },
  };
  return { checklistInput, entries, orders, tally, books, vendors };
}

/** The accountant created or renamed these ledgers in Tally: they stop blocking the file. Returns how many moved. */
export async function markLedgers(supabase, names) {
  const { data, error } = await supabase.rpc('tally_ledgers_mark', { p_names: names });
  if (error) throw new Error(error.message);
  return data;
}

/** A person says which supplier a bank payment went to (and, by default, that the same payee is that supplier from now on). */
export async function linkVendor(supabase, lineIds, vendorId, remember = true) {
  const { data, error } = await supabase.rpc('finance_line_link_vendor', { p_ids: lineIds, p_vendor_id: vendorId, p_remember: remember });
  if (error) throw new Error(error.message);
  return data;
}
