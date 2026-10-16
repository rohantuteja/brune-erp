// bills-import v1
// Analytics → Bills: takes a vendor's invoice PDF, reads it (_shared/invoice-reader.ts), checks it, keeps the ORIGINAL in the
// private vendor-bills bucket and the figures in vendor_invoices. Admins only (an admin's login).
//
// Actions (POST with an admin user's JWT):
//   upload       { filename, data }                          data = the PDF, base64, up to 5 MB. One result per invoice found in it.
//   confirm      { id, vendor: { id } | { new: {...} }, edits?, accept_anyway?, reason? }
//                                                            a person accepts a bill held for review (see _shared/bills.ts for what may be edited)
//   vendor_save  { id?, name, tally_ledger_name, gstin?, pan?, state_code?, booking, expense_ledger?, auto_accept?, active?, note? }
//   void         { id, reason }                              a bill is voided, never deleted; the reason is kept
//   file_url     { id }                                      a link to the original that expires in five minutes
//
// Nothing here posts to Tally, Shopify, Unicommerce or any other system.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getDocumentProxy } from 'npm:unpdf@0.12.1';
import { CORS, json, requireAdmin, setting } from '../_shared/shopify-admin.ts';
import { gstinChecksumOk, panOf, readInvoicePdf, type TextItem } from '../_shared/invoice-reader.ts';
import { applyEdits, billRow, decide, matchVendor, newVendorFrom, recheck, storagePath, vendorProblems, BOOKINGS, type Edits, type LedgerBook, type Vendor } from '../_shared/bills.ts';

const BUCKET = 'vendor-bills';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 30;
const VENDOR_COLUMNS = 'id, name, tally_ledger_name, gstin, pan, state_code, booking, expense_ledger, auto_accept, active, note, ledger_new';
const BILL_COLUMNS = 'id, vendor, vendor_id, invoice_no, invoice_date, subtotal, tax, total, status, kind, checks, file_path, file_name, supplier_gstin, edited';

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin: any = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const denied = await requireAdmin(admin, req);
    if (denied) return denied;
    const user = await whoAmI(admin, req);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'upload':      return await upload(admin, user, body);
      case 'confirm':     return await confirm(admin, user, body);
      case 'vendor_save': return await vendorSave(admin, user, body);
      case 'void':        return await voidBill(admin, user, body);
      case 'file_url':    return await fileUrl(admin, body);
      default:            return json({ error: 'action must be upload, confirm, vendor_save, void or file_url' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

type User = { id?: string; name: string };
async function whoAmI(admin: any, req: Request): Promise<User> {
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  const { data: p } = await admin.from('user_profiles').select('username, name').eq('id', user?.id).maybeSingle();
  return { id: user?.id as string | undefined, name: (p?.username || p?.name || 'user') as string };
}

const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

async function context(admin: any) {
  const { data: vendors, error } = await admin.from('vendors').select(VENDOR_COLUMNS).order('name');
  if (error) throw new Error(`vendors: ${error.message}`);
  // The ledgers that exist in his Tally (from the trial balance he exported): a vendor's own ledger and its expense ledger are checked against them.
  const { data: ledgers, error: le } = await admin.from('tally_ledgers').select('name, role');
  if (le) throw new Error(`tally ledgers: ${le.message}`);
  const book: LedgerBook = { expense: new Set<string>(), known: new Set<string>() };
  for (const l of ledgers ?? []) { book.known.add(l.name); if (l.role === 'expense') book.expense.add(l.name); }
  return {
    vendors: (vendors ?? []) as Vendor[],
    book,
    companyGstin: await setting(admin, 'company_gstin', '09AALCR1014K1ZB'),
    booksStart: await setting(admin, 'accounting_start_date', '2026-10-01'),
  };
}

// ── Upload ───────────────────────────────────────────────────────────────────────────────────
async function pdfItems(bytes: Uint8Array): Promise<TextItem[]> {
  // pdf.js takes over the buffer it is given (the file would be empty afterwards), and the original is stored from these same bytes
  const pdf = await getDocumentProxy(bytes.slice());
  if (pdf.numPages > MAX_PAGES) throw new Error(`the PDF has ${pdf.numPages} pages: an invoice is not that long`);
  const items: TextItem[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const tc = await (await pdf.getPage(n)).getTextContent();
    for (const it of tc.items as any[]) if (it.str && it.str.trim()) items.push({ page: n, x: it.transform[4], y: it.transform[5], w: it.width, s: it.str });
  }
  return items;
}

async function upload(admin: any, user: User, body: any) {
  if (typeof body.data !== 'string' || !body.data) return json({ error: 'no file received' }, 400);
  const bytes = fromBase64(body.data);
  if (bytes.length > MAX_BYTES) return json({ error: `files up to ${MAX_BYTES / 1024 / 1024} MB are accepted` }, 413);
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'that is not a PDF' }, 400);
  const file = String(body.filename ?? 'invoice.pdf').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const hash = await sha256(bytes);

  // the same file twice
  const { data: same } = await admin.from('vendor_invoices').select(BILL_COLUMNS).eq('file_hash', hash);
  if (same?.length && body.attach_id !== undefined && body.attach_id !== null) return json({ error: `this file is already attached to ${same.map((b: any) => `${b.vendor} ${b.invoice_no}`).join(', ')}: nothing was changed` }, 409);
  if (same?.length) return json({ file, results: same.map((b: any) => ({ outcome: 'already_uploaded', id: b.id, vendor: b.vendor, invoice_no: b.invoice_no, status: b.status })) });

  let items: TextItem[];
  try { items = await pdfItems(bytes); } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: /password|encrypt/i.test(msg) ? 'the PDF is password protected: remove the password and upload it again' : `could not read the file: ${msg}` }, 422);
  }
  const ctx = await context(admin);
  const read = readInvoicePdf(items, { companyGstin: ctx.companyGstin, today: istToday() });
  if (read.problem === 'no_text') return json({ error: 'this PDF has no text in it (it is a scan or a photo), so it cannot be read. Ask the vendor for the original PDF.' }, 422);
  if (read.problem === 'no_invoice') return json({ error: 'this does not look like a tax invoice: no supplier GSTIN or invoice number was found' }, 422);

  // "Attach PDF" on a bill that has none: the PDF must be that bill's own invoice, or nothing is stored or changed
  if (body.attach_id !== undefined && body.attach_id !== null) return await attachToBill(admin, body, { bytes, hash, file, read });

  // decide what to do with each invoice before anything is written
  type Plan = { kind: 'insert'; row: Record<string, unknown>; reasons: string[]; vendor: Vendor | null } | { kind: 'attach'; existing: any; inv: any; differs: string[] } | { kind: 'duplicate'; existing: any } | { kind: 'unreadable'; invoice_no: string | null; checks: unknown; reasons: string[] };
  const path = storagePath(istToday(), hash);
  const plans: Plan[] = [];
  for (const inv of read.invoices) {
    const m = matchVendor(ctx.vendors, inv);
    const dec = decide(inv, m.vendor, ctx.book);
    const vendorName = m.vendor?.name ?? inv.supplier.name ?? 'Unknown vendor';
    const row = billRow(inv, { vendor: m.vendor, vendorName, companyGstin: ctx.companyGstin, file: { path, hash, name: file }, status: dec.status, booksStart: ctx.booksStart });
    if (!row) { plans.push({ kind: 'unreadable', invoice_no: inv.invoice_no, checks: inv.checks, reasons: inv.checks.filter(c => !c.ok).map(c => c.detail) }); continue; }
    const { data: found } = await admin.from('vendor_invoices').select(BILL_COLUMNS + ', file_hash').eq('invoice_no', inv.invoice_no).or(`supplier_gstin.eq.${inv.supplier.gstin ?? 'none'},vendor.eq.${vendorName.replace(/[,()]/g, ' ')}`);
    const existing = (found ?? []).find((b: any) => b.status !== 'void');
    if (!existing) { plans.push({ kind: 'insert', row, reasons: dec.reasons, vendor: m.vendor }); continue; }
    if (existing.file_path) { plans.push({ kind: 'duplicate', existing }); continue; }
    // a bill already in the system without its PDF (the Meta and Velocity invoices were typed in before there was an upload): attach it,
    // and say where the figures read from the PDF differ from the ones stored
    const differs: string[] = [];
    for (const [label, stored, now] of [['taxable value', existing.subtotal, inv.taxable], ['GST', existing.tax, inv.tax], ['total', existing.total, inv.total]] as const) {
      if (now !== null && Math.abs(Number(stored) - now) > 0.011) differs.push(`${label}: stored ${stored}, the PDF says ${now}`);
    }
    plans.push({ kind: 'attach', existing, inv, differs });
  }

  const keep = plans.some(p => p.kind === 'insert' || p.kind === 'attach');
  if (keep) {
    const { error } = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    if (error && !/already exists|duplicate/i.test(error.message)) throw new Error(`keeping the original: ${error.message}`);
  }

  const results: unknown[] = [];
  for (const p of plans) {
    if (p.kind === 'unreadable') { results.push({ outcome: 'unreadable', invoice_no: p.invoice_no, reasons: p.reasons }); continue; }
    if (p.kind === 'duplicate') { results.push({ outcome: 'duplicate', id: p.existing.id, vendor: p.existing.vendor, invoice_no: p.existing.invoice_no, status: p.existing.status }); continue; }
    if (p.kind === 'attach') {
      const i = p.inv;
      const { error } = await admin.from('vendor_invoices').update(attachFields(i, path, hash, file)).eq('id', p.existing.id);
      if (error) throw new Error(`attaching the PDF: ${error.message}`);
      results.push({ outcome: 'attached', id: p.existing.id, vendor: p.existing.vendor, invoice_no: p.existing.invoice_no, status: p.existing.status, differs: p.differs });
      continue;
    }
    const { data, error } = await admin.from('vendor_invoices').insert(p.row).select('id').single();
    if (error) throw new Error(`saving the bill: ${error.message}`);
    results.push({ outcome: p.row.status, id: data.id, vendor: p.row.vendor, invoice_no: p.row.invoice_no, status: p.row.status, reasons: p.reasons, new_vendor: !p.vendor });
  }
  return json({ file, uploaded_by: user.name, copies: read.invoices.map(i => i.copies), results });
}

// ── A person accepts a bill held for review ──────────────────────────────────────────────────
/** What a bill takes from the PDF that is attached to it: the file, and what the reader found in it. */
const attachFields = (i: any, path: string, hash: string, file: string) => ({
  file_path: path, file_hash: hash, file_name: file, kind: i.kind, checks: i.checks, place_of_supply: i.place_of_supply, irn: i.irn, tax_rate: i.tax_rate, round_off: i.round_off, reader: 'attached to a stored bill',
});

/** The "Attach PDF" button on a bill with no PDF. It is attached only when the PDF holds that very invoice (same number, and the same supplier when both say); otherwise nothing is stored and nothing changes. */
async function attachToBill(admin: any, body: any, f: { bytes: Uint8Array; hash: string; file: string; read: { invoices: any[] } }) {
  const { data: bill } = await admin.from('vendor_invoices').select(BILL_COLUMNS).eq('id', Number(body.attach_id)).maybeSingle();
  if (!bill) return json({ error: 'that bill was not found' }, 404);
  if (bill.status === 'void') return json({ error: 'that bill has been voided' }, 409);
  if (bill.file_path) return json({ error: 'this bill already has its PDF' }, 409);
  const wanted = String(bill.invoice_no).trim();
  const inv = f.read.invoices.find(i => String(i.invoice_no ?? '').trim() === wanted);
  if (!inv) {
    const found = f.read.invoices.map(i => i.invoice_no ?? 'an invoice with no number').join(', ');
    return json({ error: `this PDF is invoice ${found}, not ${wanted}: nothing was changed` }, 409);
  }
  if (bill.supplier_gstin && inv.supplier.gstin && bill.supplier_gstin !== inv.supplier.gstin) {
    return json({ error: `invoice ${wanted} in this PDF is from another supplier (${inv.supplier.gstin}), not ${bill.vendor}: nothing was changed` }, 409);
  }
  const differs: string[] = [];
  for (const [label, stored, now] of [['taxable value', bill.subtotal, inv.taxable], ['GST', bill.tax, inv.tax], ['total', bill.total, inv.total]] as const) {
    if (now !== null && Math.abs(Number(stored) - now) > 0.011) differs.push(`${label}: stored ${stored}, the PDF says ${now}`);
  }
  const path = storagePath(istToday(), f.hash);
  const { error: se } = await admin.storage.from(BUCKET).upload(path, f.bytes, { contentType: 'application/pdf', upsert: false });
  if (se && !/already exists|duplicate/i.test(se.message)) throw new Error(`keeping the original: ${se.message}`);
  const { error } = await admin.from('vendor_invoices').update(attachFields(inv, path, f.hash, f.file)).eq('id', bill.id);
  if (error) throw new Error(`attaching the PDF: ${error.message}`);
  return json({ file: f.file, results: [{ outcome: 'attached', id: bill.id, vendor: bill.vendor, invoice_no: bill.invoice_no, status: bill.status, differs }] });
}

async function confirm(admin: any, user: User, body: any) {
  const { data: bill } = await admin.from('vendor_invoices').select(BILL_COLUMNS).eq('id', Number(body.id)).maybeSingle();
  if (!bill) return json({ error: 'that bill was not found' }, 404);
  if (bill.status === 'void') return json({ error: 'that bill has been voided' }, 409);
  const ctx = await context(admin);

  // the vendor: an existing one, or a new one set up now
  let vendor: Vendor | undefined;
  if (body.vendor?.id) vendor = ctx.vendors.find(v => v.id === Number(body.vendor.id));
  else if (body.vendor?.new) {
    const nv = { ...body.vendor.new, booking: body.vendor.new.booking, expense_ledger: body.vendor.new.expense_ledger || null } as Vendor;
    nv.ledger_new = body.vendor.new.ledger_new === true && !ctx.book.known.has(String(nv.tally_ledger_name ?? ''));   // only a ledger Tally lacks can be "new"
    nv.tally_ledger_name = String(nv.tally_ledger_name ?? '').trim();
    const problems = vendorProblems(nv, ctx.book);
    if (problems.length) return json({ error: `the new vendor is not complete: ${problems.join('; ')}` }, 400);
    const { data, error } = await admin.from('vendors').insert({ name: nv.name.trim(), tally_ledger_name: nv.tally_ledger_name.trim(), gstin: nv.gstin || null, pan: nv.gstin ? panOf(nv.gstin) : nv.pan || null, state_code: nv.gstin ? nv.gstin.slice(0, 2) : nv.state_code || null, booking: nv.booking, expense_ledger: nv.expense_ledger, ledger_new: nv.ledger_new, created_by_name: user.name }).select(VENDOR_COLUMNS).single();
    if (error) return json({ error: `creating the vendor: ${/duplicate/i.test(error.message) ? 'a vendor with that name or GSTIN already exists: choose it from the list' : error.message}` }, 409);
    vendor = data as Vendor;
  }
  if (!vendor) return json({ error: 'choose the vendor this bill belongs to' }, 400);
  const problems = vendorProblems(vendor, ctx.book);
  if (problems.length) return json({ error: `${vendor.name} is not completely set up: ${problems.join('; ')}` }, 400);

  const done = applyEdits({ invoice_no: bill.invoice_no, invoice_date: bill.invoice_date, subtotal: Number(bill.subtotal), tax: Number(bill.tax), total: Number(bill.total) }, (body.edits ?? {}) as Edits);
  if (!done.ok) return json({ error: done.error }, 400);
  const checks = recheck((bill.checks ?? []) as Array<{ id: string; ok: boolean; detail: string }>, done.fixed, user.name);
  const failed = checks.filter(c => !c.ok);
  const reason = String(body.reason ?? '').trim();
  if (failed.length && !(body.accept_anyway === true && reason.length >= 5)) {
    return json({ error: 'some checks did not pass: correct what is wrong, or accept the bill anyway and say why', failed: failed.map(c => c.detail) }, 409);
  }

  const update: Record<string, unknown> = {
    vendor: vendor.name, vendor_id: vendor.id, status: 'accepted', checks,
    invoice_no: done.values.invoice_no, invoice_date: done.values.invoice_date, subtotal: done.values.subtotal, tax: done.values.tax, total: done.values.total,
    opening: !!done.values.invoice_date && done.values.invoice_date < ctx.booksStart,
    confirmed_by: user.id ?? null, confirmed_by_name: user.name, confirmed_at: new Date().toISOString(),
    edited: Object.keys(done.edited).length ? { ...(bill.edited ?? {}), ...done.edited } : bill.edited ?? null,
    accepted_anyway: failed.length ? reason : null,
  };
  const { error } = await admin.from('vendor_invoices').update(update).eq('id', bill.id);
  if (error) return json({ error: `saving the bill: ${/duplicate/i.test(error.message) ? 'another bill of this vendor already has that invoice number' : error.message}` }, 409);

  // the first clean bill of a vendor makes the next ones automatic; a vendor without a GSTIN learns it from this invoice
  const learn: Record<string, unknown> = {};
  if (!vendor.auto_accept && !failed.length) learn.auto_accept = true;
  if (!vendor.gstin && bill.supplier_gstin && gstinChecksumOk(bill.supplier_gstin)) Object.assign(learn, { gstin: bill.supplier_gstin, pan: panOf(bill.supplier_gstin), state_code: bill.supplier_gstin.slice(0, 2) });
  if (Object.keys(learn).length) await admin.from('vendors').update({ ...learn, updated_at: new Date().toISOString() }).eq('id', vendor.id);
  return json({ id: bill.id, status: 'accepted', vendor: vendor.name, auto_accept: !!(learn.auto_accept ?? vendor.auto_accept), learned: Object.keys(learn) });
}

// ── Vendors ──────────────────────────────────────────────────────────────────────────────────
async function vendorSave(admin: any, user: User, body: any) {
  const ctx = await context(admin);
  const v = {
    name: String(body.name ?? '').trim(), tally_ledger_name: String(body.tally_ledger_name ?? '').trim(),
    gstin: body.gstin ? String(body.gstin).trim().toUpperCase() : null, pan: body.pan ? String(body.pan).trim().toUpperCase() : null, state_code: body.state_code ? String(body.state_code).trim() : null,
    booking: body.booking, expense_ledger: body.expense_ledger || null,
  } as Vendor;
  v.ledger_new = body.ledger_new === true && !ctx.book.known.has(v.tally_ledger_name);   // only a ledger Tally lacks can be "new"
  if (v.gstin && gstinChecksumOk(v.gstin)) { v.pan = panOf(v.gstin); v.state_code = v.gstin.slice(0, 2); }
  if (!BOOKINGS.includes(v.booking)) return json({ error: 'choose how the vendor is booked' }, 400);
  if (v.booking !== 'expense' && v.booking !== 'tie_out') v.expense_ledger = null;
  const problems = vendorProblems(v, ctx.book);
  if (problems.length) return json({ error: problems.join('; ') }, 400);
  const row = { ...v, auto_accept: body.auto_accept === true, active: body.active !== false, note: body.note ?? null, updated_at: new Date().toISOString() };
  const q = body.id ? admin.from('vendors').update(row).eq('id', Number(body.id)) : admin.from('vendors').insert({ ...row, created_by_name: user.name });
  const { data, error } = await q.select(VENDOR_COLUMNS).single();
  if (error) return json({ error: /duplicate/i.test(error.message) ? 'a vendor with that name or GSTIN already exists' : error.message }, 409);
  return json({ vendor: data });
}

// ── Void, and the original ───────────────────────────────────────────────────────────────────
async function voidBill(admin: any, user: User, body: any) {
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 5) return json({ error: 'say why the bill is voided' }, 400);
  const { data: bill } = await admin.from('vendor_invoices').select('id, vendor, status').eq('id', Number(body.id)).maybeSingle();
  if (!bill) return json({ error: 'that bill was not found' }, 404);
  if (bill.status === 'void') return json({ error: 'that bill is already voided' }, 409);
  if (bill.vendor === 'Velocity') return json({ error: "a Velocity invoice is also read by the Velocity wallet page: delete it there (it shows what would change first)" }, 409);
  const { error } = await admin.from('vendor_invoices').update({ status: 'void', void_reason: reason, voided_at: new Date().toISOString(), voided_by_name: user.name }).eq('id', bill.id);
  if (error) throw new Error(`voiding the bill: ${error.message}`);
  return json({ id: bill.id, status: 'void' });
}

async function fileUrl(admin: any, body: any) {
  const { data: bill } = await admin.from('vendor_invoices').select('file_path, file_name').eq('id', Number(body.id)).maybeSingle();
  if (!bill?.file_path) return json({ error: 'no PDF is attached to this bill yet: upload it to attach it' }, 404);
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(bill.file_path, 300);
  if (error) throw new Error(`opening the original: ${error.message}`);
  return json({ url: data.signedUrl, name: bill.file_name });
}
