// velocity-import v2
// Takes Velocity's wallet Ledger Report (.csv, from the Velocity dashboard) or a monthly tax invoice (.pdf), checks that it
// adds up, stores the LINES (never the file), and reconciles the wallet: top-ups against the bank, each month's charges against
// its invoice, balances month to month. Admins only (an admin's login, or the project's internal x-cron-key, which the
// scheduled report inbox will use later).
// The reading and the rules are in _shared/velocity-ledger.ts and tested there. Design: docs/velocity-wallet.md.
//
// Actions (POST with an admin user's JWT):
//   ledger     { filename, csv }            the Ledger Report as text. Refused whole if its balance column does not follow from its amounts.
//   invoice    { filename, data }           a Velocity tax invoice PDF, base64
//   reconcile  {}                           the month-by-month reconciliation as JSON
//
// Nothing here posts to Tally, Shopify, Unicommerce or Velocity: it only reads, and writes the velocity_* tables and vendor_invoices.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';
import { CORS, cronKeyValid, json, requireAdmin } from '../_shared/shopify-admin.ts';
import { GST_FACTOR, invoiceCheck, matchTopUps, parseVelocityInvoice, parseWalletLedger, VELOCITY_HANDLE } from '../_shared/velocity-ledger.ts';

const CHUNK = 500;
const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin: any = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const cronKey = req.headers.get('x-cron-key');
    let user: { id?: string; name: string };
    if (cronKey) {
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
      user = { name: 'system' };
    } else {
      const denied = await requireAdmin(admin, req);
      if (denied) return denied;
      user = await whoAmI(admin, req);
    }
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'ledger':    return await uploadLedger(admin, user, body);
      case 'invoice':   return await uploadInvoice(admin, body);
      case 'reconcile': return json(await reconcile(admin));
      default:          return json({ error: 'action must be ledger, invoice or reconcile' }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function whoAmI(admin: any, req: Request) {
  const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  const { data: p } = await admin.from('user_profiles').select('username, name').eq('id', user?.id).maybeSingle();
  return { id: user?.id as string | undefined, name: (p?.username || p?.name || 'user') as string };
}

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).join('\n');
}

// ── The wallet ledger ────────────────────────────────────────────────────────────────────────
async function uploadLedger(admin: any, user: { id?: string; name: string }, body: any) {
  const text = String(body.csv ?? '');
  let parsed;
  try { parsed = parseWalletLedger(text); } catch (err) { return json({ error: err instanceof Error ? err.message : String(err) }, 422); }
  // An unknown note is a warning (the line is still stored as "other"); everything else must hold.
  if (parsed.checks.some(c => !c.ok && c.id !== 'known_notes')) return json({ error: 'the ledger does not add up, so nothing was imported', checks: parsed.checks }, 422);

  const hash = await sha256(new TextEncoder().encode(text));
  const { data: same } = await admin.from('velocity_ledger_imports').select('id, uploaded_at, line_count').eq('file_hash', hash).maybeSingle();
  if (same) return json({ already_imported: true, import_id: same.id, uploaded_at: same.uploaded_at, line_count: same.line_count, new_lines: 0 });

  // Does this report pick up where the stored ones leave off? (Warnings, not refusals: the files may be uploaded in any order.)
  const checks = [...parsed.checks];
  const { data: before } = await admin.from('velocity_ledger_imports').select('closing, period_to').lt('period_to', parsed.period_from).order('period_to', { ascending: false }).limit(1);
  const { data: after } = await admin.from('velocity_ledger_imports').select('opening, period_from').gt('period_from', parsed.period_to).order('period_from', { ascending: true }).limit(1);
  if (before?.[0]) {
    const gap = r2(Number(parsed.opening) - Number(before[0].closing));
    checks.push({ id: 'continues_earlier', ok: Math.abs(gap) <= 0.011, detail: Math.abs(gap) <= 0.011 ? `opens at ${before[0].closing}, where the report to ${before[0].period_to} closed` : `opens at ${parsed.opening} but the report to ${before[0].period_to} closed at ${before[0].closing}: ${Math.abs(gap).toFixed(2)} of movement is missing between them` });
  }
  if (after?.[0]) {
    const gap = r2(Number(after[0].opening) - Number(parsed.closing));
    checks.push({ id: 'followed_by_later', ok: Math.abs(gap) <= 0.011, detail: Math.abs(gap) <= 0.011 ? `closes at ${parsed.closing}, where the report from ${after[0].period_from} opens` : `closes at ${parsed.closing} but the report from ${after[0].period_from} opens at ${after[0].opening}: ${Math.abs(gap).toFixed(2)} of movement is missing between them` });
  }
  if (!before?.[0] && !after?.[0]) checks.push({ id: 'continues_earlier', ok: true, detail: 'no other ledger stored yet to compare with' });

  // Lines already stored (an earlier, overlapping report) are kept as they are. Asked for by date range, a page at a time:
  // asking by key put hundreds of long keys in the web address, which the database refuses ("Bad Request") on a real month.
  const have = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('velocity_wallet_lines').select('line_key')
      .gte('txn_date', parsed.period_from).lte('txn_date', parsed.period_to).order('id').range(from, from + 999);
    if (error) throw new Error(`checking the lines already stored: ${error.message}`);
    for (const r of data ?? []) have.add(r.line_key);
    if (!data || data.length < 1000) break;
  }
  const fresh = parsed.lines.filter(l => !have.has(l.key));

  const { data: imp, error: ie } = await admin.from('velocity_ledger_imports').insert({
    filename: body.filename ?? null, file_hash: hash, period_from: parsed.period_from, period_to: parsed.period_to, opening: parsed.opening, closing: parsed.closing,
    line_count: parsed.lines.length, new_lines: fresh.length, duplicate_lines: parsed.lines.length - fresh.length, checks, uploaded_by: user.id ?? null, uploaded_by_name: user.name,
  }).select('id').single();
  if (ie) throw new Error(`saving the import: ${ie.message}`);

  for (let i = 0; i < fresh.length; i += CHUNK) {
    const { error } = await admin.from('velocity_wallet_lines').insert(fresh.slice(i, i + CHUNK).map(l => ({
      import_id: imp.id, line_key: l.key, txn_at: l.txn_at, txn_date: l.txn_date, direction: l.direction, amount: l.amount, balance: l.balance, awb: l.awb, notes: l.notes, kind: l.kind, ex_gst: l.ex_gst,
    })));
    if (error) throw new Error(`saving lines: ${error.message}`);
  }

  const bank = await rematchBank(admin);       // new top-ups can prove bank payments
  const topups = parsed.lines.filter(l => l.kind === 'recharge');
  return json({
    import_id: imp.id, period_from: parsed.period_from, period_to: parsed.period_to, opening: parsed.opening, closing: parsed.closing,
    line_count: parsed.lines.length, new_lines: fresh.length, duplicate_lines: parsed.lines.length - fresh.length, topups: topups.length, topped_up: r2(topups.reduce((s, l) => s + l.amount, 0)),
    checks, bank_matching: bank,
  });
}

/** Run the bank matching again so new wallet top-ups prove the bank payments that funded them. Never blocks an import. */
async function rematchBank(admin: any) {
  try {
    const { data } = await admin.from('private_secrets').select('value').eq('key', 'erp_stock_cron_key').maybeSingle();
    if (!data?.value) return null;
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/finance-import`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-key': data.value }, body: JSON.stringify({ action: 'rematch' }) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ── A monthly tax invoice ────────────────────────────────────────────────────────────────────
async function uploadInvoice(admin: any, body: any) {
  if (!body.data) return json({ error: 'no file received' }, 400);
  const bytes = fromBase64(String(body.data));
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'upload the invoice as a PDF' }, 400);
  let inv;
  try { inv = parseVelocityInvoice(await pdfText(bytes)); } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: /password|encrypt/i.test(msg) ? 'the PDF is password protected: remove the password and upload it again' : msg }, 422);
  }
  if (inv.checks.some(c => !c.ok)) return json({ error: 'the invoice does not add up, so nothing was imported', checks: inv.checks }, 422);

  const end = inv.period_to ?? inv.invoice_date;
  const row = {
    vendor: 'Velocity', invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, period: `${MONTHS[Number(end.slice(5, 7)) - 1]}-${end.slice(2, 4)}`,
    subtotal: inv.subtotal, tax: inv.tax, total: inv.total, tax_type: inv.taxes.map(t => t.name).join('+') || 'IGST',
    supplier_gstin: inv.supplier_gstin, bill_to_gstin: inv.bill_to_gstin, source: 'tax invoice PDF', period_from: inv.period_from, period_to: inv.period_to, lines: inv.lines,
  };
  const { error } = await admin.from('vendor_invoices').upsert(row, { onConflict: 'vendor,invoice_no' });
  if (error) throw new Error(`saving the invoice: ${error.message}`);
  const against = inv.period_from && inv.period_to ? await checkAgainstLedger(admin, inv) : null;
  return json({ invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, period_from: inv.period_from, period_to: inv.period_to, lines: inv.lines, tax: inv.tax, total: inv.total, checks: inv.checks, against_ledger: against });
}

// ── Reconciliation ───────────────────────────────────────────────────────────────────────────
async function summaryRows(admin: any, from: string | null, to: string | null) {
  const { data, error } = await admin.rpc('velocity_summary', { p_from: from, p_to: to });
  if (error) throw new Error(`summary: ${error.message}`);
  return (data ?? []) as Array<{ month: string; kind: string; direction: 'debit' | 'credit'; n: number; amount: number; ex_gst: number }>;
}

async function checkAgainstLedger(admin: any, inv: { period_from: string | null; period_to: string | null; lines: any[]; total: number }) {
  const rows = await summaryRows(admin, inv.period_from, inv.period_to);
  if (!rows.length) return { has_ledger: false };
  const c = invoiceCheck(rows.map(r => ({ kind: r.kind as any, direction: r.direction, amount: Number(r.amount), ex_gst: Number(r.ex_gst) })), { lines: inv.lines });
  const closest = c.freight ? r2((c.vas?.ledger ?? 0) + c.freight.closest.ledger) : null;
  return { has_ledger: true, ...c, closest_total_with_gst: closest == null ? null : r2(closest * GST_FACTOR), invoice_total: inv.total };
}

async function reconcile(admin: any) {
  const { data: imports, error: ie } = await admin.from('velocity_ledger_imports')
    .select('id, filename, period_from, period_to, opening, closing, line_count, new_lines, duplicate_lines, checks, uploaded_by_name, uploaded_at').order('period_from');
  if (ie) throw new Error(ie.message);
  const all = await summaryRows(admin, null, null);

  // Month by month: the balance carries from the first stored report; a month's opening is the balance before its first line.
  const byMonth = new Map<string, typeof all>();
  for (const r of all) byMonth.set(r.month, [...(byMonth.get(r.month) ?? []), r]);
  const months = [...byMonth.keys()].sort();
  const o0 = imports?.length ? Number(imports[0].opening) : 0;
  let running = o0;
  const outMonths = [];
  for (const m of months) {
    const rows = byMonth.get(m)!;
    const credits = rows.filter(r => r.direction === 'credit').reduce((s, r) => s + Number(r.amount), 0);
    const debits = rows.filter(r => r.direction === 'debit').reduce((s, r) => s + Number(r.amount), 0);
    const opening = r2(running); running = r2(running + credits - debits);
    const kinds: Record<string, { n: number; amount: number; ex_gst: number; direction: string }> = {};
    for (const r of rows) kinds[`${r.direction}:${r.kind}`] = { n: Number(r.n), amount: Number(r.amount), ex_gst: Number(r.ex_gst), direction: r.direction };
    outMonths.push({ month: m, opening, closing: running, debits: r2(debits), credits: r2(credits), kinds, invoice: null as any });
  }

  // Each import must open where the lines before it leave the balance (a gap means a report is missing).
  const gaps: Array<{ import_id: string; period_from: string; expected: number; opening: number }> = [];
  for (let i = 1; i < (imports ?? []).length; i++) {
    const imp = imports[i];
    const before = await summaryRows(admin, null, new Date(Date.parse(`${imp.period_from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
    const net = before.reduce((s, r) => s + (r.direction === 'credit' ? Number(r.amount) : -Number(r.amount)), 0);
    const expected = r2(o0 + net);
    if (Math.abs(expected - Number(imp.opening)) > 0.011) gaps.push({ import_id: imp.id, period_from: imp.period_from, expected, opening: Number(imp.opening) });
  }

  // Invoices against the ledger lines of their period.
  const { data: invoices } = await admin.from('vendor_invoices').select('invoice_no, invoice_date, period, period_from, period_to, subtotal, tax, total, lines').eq('vendor', 'Velocity').order('invoice_date');
  for (const inv of invoices ?? []) {
    const against = inv.period_from && inv.period_to ? await checkAgainstLedger(admin, inv) : null;
    const mo = outMonths.find(x => x.month === String(inv.period_from ?? inv.invoice_date).slice(0, 7));
    const entry = { invoice_no: inv.invoice_no, invoice_date: inv.invoice_date, period_from: inv.period_from, period_to: inv.period_to, lines: inv.lines, subtotal: Number(inv.subtotal), tax: Number(inv.tax), total: Number(inv.total), against };
    if (mo) mo.invoice = entry;
  }

  // Top-ups against the bank.
  const topLines = await fetchAll<any>((f, t) => admin.from('velocity_wallet_lines').select('id, line_key, txn_at, txn_date, amount').eq('kind', 'recharge').order('txn_at').range(f, t));
  const topups = topLines.map(l => ({ key: l.line_key, at: String(l.txn_at).replace('T', ' ').slice(0, 19), date: l.txn_date as string, amount: Number(l.amount) }));
  const { data: accts } = await admin.from('finance_accounts').select('id').eq('kind', 'bank');
  const bankIds = (accts ?? []).map((a: any) => a.id);
  const { data: stmts } = bankIds.length ? await admin.from('finance_statements').select('period_from, period_to').in('account_id', bankIds) : { data: [] };
  const { data: cand } = bankIds.length
    ? await admin.from('finance_lines').select('id, txn_date, debit, remarks').in('account_id', bankIds).gt('debit', 0).or('remarks.ilike.%shipfast%,remarks.ilike.%.cf@%,remarks.ilike.%velocity%')
    : { data: [] };
  const matched = matchTopUps(topups, (cand ?? []).filter((c: any) => VELOCITY_HANDLE.test(c.remarks)).map((c: any) => ({ id: c.id, date: c.txn_date, amount: Number(c.debit), remarks: c.remarks })));
  const dateOf = new Map((cand ?? []).map((c: any) => [c.id, c.txn_date]));
  const outTopups = topups.map(t => ({
    key: t.key, at: t.at, date: t.date, amount: t.amount,
    bank_line_id: matched.get(t.key) ?? null, bank_date: matched.has(t.key) ? dateOf.get(matched.get(t.key)!) ?? null : null,
    bank_statement_covers: (stmts ?? []).some((s: any) => s.period_from <= t.date && t.date <= s.period_to),
  }));

  return { imports: imports ?? [], months: outMonths, topups: outTopups, gaps };
}
