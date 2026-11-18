// Reads one month of the stored order ledger for Analytics → GST. Read-only: ledger_entries and ledger_orders already exist
// and are written only by the accounting-ledger function. The arithmetic is in gstReport.js.
import { GST_ACCOUNTS, GST_VOUCHERS, monthBounds } from './gstReport.js';

const PAGE = 1000;
const CHUNK = 100;
export const FALLBACK_START = '2026-10-01';      // app_settings.accounting_start_date: the books before it are closed

export async function pages(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** The first day the books count from (the ledger never holds exportable figures before it). */
export async function accountingStart(supabase) {
  try {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'accounting_start_date').maybeSingle();
    const v = typeof data?.value === 'string' ? data.value.replace(/"/g, '') : null;
    return /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : FALLBACK_START;
  } catch { return FALLBACK_START; }
}

/** { entries, orders, waiting } for `month` ('YYYY-MM'). Throws with a readable message when a read fails. */
export async function fetchGstMonth(supabase, month) {
  const { from, next } = monthBounds(month);
  const entries = await pages((a, b) => supabase.from('ledger_entries')
    .select('order_name, entry_date, voucher, account, debit, credit, doc, issued_by, memo, part, qty')
    .gte('entry_date', from).lt('entry_date', next).in('voucher', GST_VOUCHERS).in('account', GST_ACCOUNTS)
    .order('id').range(a, b));
  const names = [...new Set(entries.map(e => e.order_name))];
  const orders = [];
  for (let i = 0; i < names.length; i += CHUNK) {
    const { data, error } = await supabase.from('ledger_orders')
      .select('order_name, channel, status, sale_date, state, state_code, rate:facts->>rate, invoice_date:facts->>invoiceDate, notes')
      .in('order_name', names.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    orders.push(...(data || []));
  }
  const waiting = await pages((a, b) => supabase.from('ledger_orders')
    .select('order_name, channel, sale_date, state, exceptions')
    .eq('status', 'waiting_invoice').gte('sale_date', from).lt('sale_date', next).order('order_name').range(a, b));
  return { entries, orders, waiting };
}
