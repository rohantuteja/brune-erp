// Reads one month for Analytics → GSTR-3B and saves the two things the page remembers. Everything is read-only except the three
// functions at the bottom (migration 044). The arithmetic is in gstr3b.js.
//
// Tables that migration 044 creates (the saved GSTR-2B and the opening credit) are read tolerantly: if they are not there yet the page
// still works, it just cannot remember anything (`storeMissing`).
import { fetchGstMonth, pages } from './gstData.js';
import { monthBounds } from './gstReport.js';

const missing = (error) => !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache|Could not find the table/i.test(error.message || ''));

/** Everything GSTR-3B needs for `month` ('YYYY-MM'). Throws with a readable message when a required read fails. */
export async function fetchGstr3bMonth(supabase, month) {
  const { from, next } = monthBounds(month);
  const gst = await fetchGstMonth(supabase, month);

  const bills = await pages((a, b) => supabase.from('vendor_invoices')
    .select('id, vendor, vendor_id, invoice_no, invoice_date, subtotal, tax, total, tax_type, supplier_gstin, status, opening, kind, file_name')
    .neq('status', 'void').order('id').range(a, b));
  const vendors = await pages((a, b) => supabase.from('vendors').select('id, name, gstin, booking').order('id').range(a, b));
  const ledgerInput = await pages((a, b) => supabase.from('ledger_entries')
    .select('account, voucher, debit, credit, entry_date, order_name')
    .or('account.ilike.IGST Input%,account.ilike.CGST Input%,account.ilike.SGST Input%')
    .gte('entry_date', from).lt('entry_date', next).order('id').range(a, b));
  const tcsRows = await pages((a, b) => supabase.from('ledger_entries')
    .select('account, voucher, debit, credit, entry_date')
    .or('account.ilike.Tax Collected at source%,account.ilike.Tax Deducted at source%')
    .gte('entry_date', from).lt('entry_date', next).order('id').range(a, b));

  let trueups = [];
  const tu = await supabase.from('gateway_trueups').select('voucher_date, gst_diff').is('voided_at', null).gte('voucher_date', from).lt('voucher_date', next);
  if (tu.error && !missing(tu.error)) throw new Error(tu.error.message);
  trueups = tu.data || [];

  const company = await supabase.from('app_settings').select('value').eq('key', 'company_gstin').maybeSingle();
  const ownGstin = typeof company.data?.value === 'string' ? company.data.value.replace(/"/g, '') : null;

  let storeMissing = false;
  const file = await supabase.from('gstr2b_files').select('month, gstin, period, generated_on, file_name, source, docs, warnings, doc_count, uploaded_by_name, uploaded_at').eq('month', month).maybeSingle();
  if (file.error) { if (missing(file.error)) storeMissing = true; else throw new Error(file.error.message); }
  const open = await supabase.from('gstr3b_months').select('month, opening_igst, opening_cgst, opening_sgst, note, updated_by_name, updated_at').eq('month', month).maybeSingle();
  if (open.error) { if (missing(open.error)) storeMissing = true; else throw new Error(open.error.message); }

  const f = file.data;
  const twoB = f ? { source: f.source, fileName: f.file_name, gstin: f.gstin, period: f.period, generatedOn: f.generated_on, docs: f.docs || [], warnings: f.warnings || [], checks: [], uploadedBy: f.uploaded_by_name, uploadedAt: f.uploaded_at } : null;
  const o = open.data;
  const opening = o ? { igst: Number(o.opening_igst), cgst: Number(o.opening_cgst), sgst: Number(o.opening_sgst), note: o.note || '', by: o.updated_by_name, at: o.updated_at } : null;
  return { gst, bills, vendors, ledgerInput, tcsRows, trueups, ownGstin, twoB, opening, storeMissing };
}

const fail = (error) => { if (error) throw new Error(error.message); };

/** The credit carried into the month, from the portal's electronic credit ledger. */
export async function saveOpening(supabase, month, { igst, cgst, sgst, note }) {
  const { error } = await supabase.rpc('gstr3b_save_opening', { p_month: month, p_igst: igst, p_cgst: cgst, p_sgst: sgst, p_note: note || null });
  fail(error);
}

/** Keeps the lines of a parsed GSTR-2B for the month (replacing an earlier file). Returns the number of lines kept. */
export async function saveTwoB(supabase, month, parsed) {
  const { data, error } = await supabase.rpc('gstr2b_save', {
    p_month: month, p_file_name: parsed.fileName || null, p_source: parsed.source, p_gstin: parsed.gstin || null, p_period: parsed.period || null,
    p_generated_on: parsed.generatedOn || null, p_docs: parsed.docs, p_warnings: parsed.warnings || [],
  });
  fail(error);
  return data;
}

export async function deleteTwoB(supabase, month) {
  const { error } = await supabase.rpc('gstr2b_delete', { p_month: month });
  fail(error);
}
