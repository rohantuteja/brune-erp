// finance-import v5
// Takes an uploaded bank statement (ICICI .xlsx), credit card statement (Kotak .pdf) or GoKwik settlement report (.csv),
// checks that it adds up, stores the LINES (never the file), and works out what each line is. Admins only (an admin's
// login, or the project's internal x-cron-key for server-to-server calls).
// The reading and the matching rules are in _shared (statements.ts, gokwik-report.ts, bank-match.ts) and tested there.
//
// Actions (POST with an admin user's JWT):
//   statement  { account_id, filename, data }   data = the file, base64. Refused whole if its own totals do not add up.
//   gokwik     { filename, csv }                GoKwik's rawSettlementReport (or settlement_v2) as text
//   rematch    {}                               re-run the matching on every line no person has decided
//   delete_statement { statement_id, dry_run }  take back a statement and the lines it brought in (see migration 026)
//   delete_gokwik    { source_file, dry_run }   take back a GoKwik report's payments
//   A delete is a DRY RUN (counts only, nothing changes) unless dry_run is exactly false; a real delete re-runs the matching.
//
// Nothing here posts to Tally, Shopify, Unicommerce or any other system: it only reads, and writes the finance_* tables.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';
import { CORS, cronKeyValid, json, requireAdmin } from '../_shared/shopify-admin.ts';
import { fileKind, parseBankRows, parseCardText, xlsxRows, type ParsedStatement } from '../_shared/statements.ts';
import { classify, type Ctx, type Line, type Payout } from '../_shared/bank-match.ts';
import { parseGokwikReport, payoutsOf } from '../_shared/gokwik-report.ts';
import { matchTopUps, VELOCITY_RECHARGE_BUCKET } from '../_shared/velocity-ledger.ts';

const CHUNK = 200;

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
      case 'statement': return await uploadStatement(admin, user, body);
      case 'gokwik':    return await uploadGokwik(admin, body);
      case 'rematch':   return json(await rematch(admin));
      case 'delete_statement': return await removeUpload(admin, user, 'finance_delete_statement', { p_id: String(body.statement_id ?? '') }, body.dry_run);
      case 'delete_gokwik':    return await removeUpload(admin, user, 'gokwik_delete_report', { p_source_file: String(body.source_file ?? '') }, body.dry_run);
      default:          return json({ error: 'action must be statement, gokwik, rematch, delete_statement or delete_gokwik' }, 400);
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
  const { text } = await extractText(pdf, { mergePages: false });     // page by page: merged text loses the line breaks
  return (text as string[]).join('\n');
}

// ── A statement ──────────────────────────────────────────────────────────────────────────────
async function uploadStatement(admin: any, user: { id?: string; name: string }, body: any) {
  const { data: account } = await admin.from('finance_accounts').select('id, name, kind').eq('id', body.account_id).maybeSingle();
  if (!account) return json({ error: 'choose which account this statement is for' }, 400);
  if (!body.data) return json({ error: 'no file received' }, 400);
  const bytes = fromBase64(String(body.data));
  const kind = fileKind(bytes);
  if (account.kind === 'bank' && kind !== 'xlsx') return json({ error: `${account.name} is a bank account: upload its Excel statement (.xlsx)${kind === 'pdf' ? ', not a PDF' : ''}` }, 400);
  if (account.kind === 'card' && kind !== 'pdf') return json({ error: `${account.name} is a credit card: upload its statement PDF${kind === 'xlsx' ? ', not an Excel file' : ''}` }, 400);

  const hash = await sha256(bytes);
  const { data: same } = await admin.from('finance_statements').select('id, uploaded_at, line_count').eq('account_id', account.id).eq('file_hash', hash).maybeSingle();
  if (same) return json({ already_imported: true, statement_id: same.id, uploaded_at: same.uploaded_at, line_count: same.line_count, new_lines: 0 });

  let parsed: ParsedStatement;
  try {
    parsed = account.kind === 'bank' ? parseBankRows(await xlsxRows(bytes)) : parseCardText(await pdfText(bytes));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: /password|encrypt/i.test(msg) ? 'the PDF is password protected: remove the password and upload it again' : `could not read the file: ${msg}` }, 422);
  }
  if (parsed.checks.some(c => !c.ok)) return json({ error: 'the statement does not add up, so nothing was imported', checks: parsed.checks }, 422);
  if (!parsed.lines.length) return json({ error: 'no transactions found in the file', checks: parsed.checks }, 422);

  // Lines already stored (an overlapping earlier upload) are kept as they are.
  const keys = parsed.lines.map(l => l.key);
  const have = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const { data, error } = await admin.from('finance_lines').select('line_key').eq('account_id', account.id).in('line_key', keys.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) have.add(r.line_key);
  }
  const fresh = parsed.lines.filter(l => !have.has(l.key));

  const { data: stmt, error: se } = await admin.from('finance_statements').insert({
    account_id: account.id, filename: body.filename ?? null, file_hash: hash, period_from: parsed.period_from, period_to: parsed.period_to, opening: parsed.opening, closing: parsed.closing,
    line_count: parsed.lines.length, new_lines: fresh.length, duplicate_lines: parsed.lines.length - fresh.length, checks: parsed.checks, uploaded_by: user.id ?? null, uploaded_by_name: user.name,
  }).select('id').single();
  if (se) throw new Error(`saving the statement: ${se.message}`);

  for (let i = 0; i < fresh.length; i += CHUNK) {
    const { error } = await admin.from('finance_lines').insert(fresh.slice(i, i + CHUNK).map(l => ({
      account_id: account.id, statement_id: stmt.id, line_key: l.key, txn_date: l.txn_date, value_date: l.value_date, ref: l.ref, remarks: l.remarks,
      debit: l.debit, credit: l.credit, balance: l.balance, fx: l.fx, category: l.category, section: l.section,
    })));
    if (error) throw new Error(`saving lines: ${error.message}`);
  }
  const matched = await rematch(admin);
  return json({
    statement_id: stmt.id, account: account.name, period_from: parsed.period_from, period_to: parsed.period_to, opening: parsed.opening, closing: parsed.closing,
    line_count: parsed.lines.length, new_lines: fresh.length, duplicate_lines: parsed.lines.length - fresh.length, checks: parsed.checks, matching: matched,
  });
}

// ── GoKwik's settlement report ───────────────────────────────────────────────────────────────
async function uploadGokwik(admin: any, body: any) {
  let report;
  try { report = parseGokwikReport(String(body.csv ?? '')); } catch (err) { return json({ error: err instanceof Error ? err.message : String(err) }, 422); }
  const broken = report.checks.filter(c => !c.ok && c.id !== 'all_settled');
  if (broken.length) return json({ error: 'the report does not add up, so nothing was imported', checks: report.checks }, 422);
  let fresh = 0;
  const ids = report.rows.map(r => r.payment_id);
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await admin.from('gokwik_payments').select('payment_id').in('payment_id', ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) have.add(r.payment_id);
  }
  fresh = report.rows.filter(r => !have.has(r.payment_id)).length;
  for (let i = 0; i < report.rows.length; i += CHUNK) {
    const { error } = await admin.from('gokwik_payments').upsert(report.rows.slice(i, i + CHUNK).map(r => ({ ...r, source_file: body.filename ?? null })), { onConflict: 'payment_id' });
    if (error) throw new Error(`saving payments: ${error.message}`);
  }
  const payouts = payoutsOf(report.rows);
  const matched = await rematch(admin);
  return json({
    payments: report.rows.length, new_payments: fresh, payouts: payouts.length, to_bank: Math.round(payouts.reduce((s, p) => s + p.amount, 0) * 100) / 100,
    settled_from: payouts.map(p => p.date).sort()[0] ?? null, settled_to: payouts.map(p => p.date).sort().pop() ?? null, checks: report.checks, matching: matched,
  });
}

// ── Taking an upload back ────────────────────────────────────────────────────────────────────
// The database function counts what would go (dry run) or deletes it and writes the log; the matching is then re-run so a payment
// that only the deleted upload proved goes back to "suggested". Anything but an explicit dry_run:false is a dry run.
async function removeUpload(admin: any, user: { id?: string; name: string }, fn: string, args: Record<string, string>, dryRun: unknown) {
  if (!Object.values(args).every(v => v)) return json({ error: 'say which upload to delete' }, 400);
  const dry = dryRun !== false;
  const { data, error } = await admin.rpc(fn, { ...args, p_dry_run: dry, p_by: user.id ?? null, p_by_name: user.name });
  if (error) throw new Error(`${dry ? 'checking' : 'deleting'} the upload: ${error.message}`);
  if (!data) return json({ error: 'that upload was not found: it may already have been deleted' }, 404);
  if (dry) return json(data);
  let matching = null, matching_error = null;
  try { matching = await rematch(admin); } catch (err) { matching_error = err instanceof Error ? err.message : String(err); }
  return json({ ...data, matching, matching_error });
}

// ── Matching ─────────────────────────────────────────────────────────────────────────────────
async function loadContext(admin: any): Promise<Ctx> {
  const gk = await fetchAll<{ utr: string; settlement_date: string; credit: number }>((f, t) => admin.from('gokwik_payments').select('utr, settlement_date, credit').not('utr', 'is', null).range(f, t));
  const payouts: Payout[] = payoutsOf(gk.map(r => ({ utr: r.utr, settlement_date: r.settlement_date, credit: Number(r.credit) }))).map(p => ({ source: 'gokwik' as const, ...p }));
  const { data: vel, error: ve } = await admin.rpc('finance_velocity_payouts');
  if (ve) throw new Error(`velocity payouts: ${ve.message}`);
  for (const v of vel ?? []) payouts.push({ source: 'velocity', utr: v.utr, date: v.paid_on, amount: Number(v.amount), payments: v.payments });
  const invoices = await fetchAll<any>((f, t) => admin.from('vendor_invoices').select('vendor, invoice_no, invoice_date, period, subtotal, tax, total').range(f, t));
  const rules = await fetchAll<any>((f, t) => admin.from('finance_rules').select('id, match_type, pattern, bucket').range(f, t));
  // Top-ups Velocity's wallet ledger shows: they prove the bank payments that funded the wallet.
  const wallet = await fetchAll<any>((f, t) => admin.from('velocity_wallet_lines').select('line_key, txn_at, txn_date, amount').eq('kind', 'recharge').order('id').range(f, t));
  return {
    payouts, rules,
    topups: wallet.map(w => ({ key: w.line_key, at: String(w.txn_at).replace('T', ' ').slice(0, 19), date: w.txn_date, amount: Number(w.amount) })),
    invoices: invoices.map(i => ({ vendor: i.vendor, invoice_no: i.invoice_no, invoice_date: i.invoice_date, period: i.period, subtotal: Number(i.subtotal), tax: Number(i.tax), total: Number(i.total) })),
  };
}

async function rematch(admin: any) {
  const accounts = new Map<string, 'bank' | 'card'>(((await admin.from('finance_accounts').select('id, kind')).data ?? []).map((a: any) => [a.id, a.kind]));
  const all = await fetchAll<any>((f, t) => admin.from('finance_lines').select('id, account_id, txn_date, remarks, debit, credit, category, section, kind, match_ref, decided_at, bucket').order('id').range(f, t));
  const open = all.filter(l => !l.decided_at);
  const ctx = await loadContext(admin);
  // A payout a person has already filed against a line cannot explain another credit.
  const taken = new Set(all.filter(l => l.decided_at && (l.kind === 'gokwik_payout' || l.kind === 'velocity_remittance') && l.match_ref).map(l => String(l.match_ref).replace(/^UTR /, '')));
  ctx.payouts = ctx.payouts.filter(p => !taken.has(p.utr));
  // Likewise a top-up a person has already tied to a payment.
  const takenTopups = new Set(all.filter(l => l.decided_at && l.kind === 'velocity_recharge' && l.match_ref).map(l => String(l.match_ref).replace(/^Wallet recharge /, '')));
  ctx.topups = (ctx.topups ?? []).filter(t => !takenTopups.has(t.at));
  // And a top-up whose payment a person filed by hand under the wallet recharge bucket.
  const filedByHand = all.filter(l => l.decided_at && l.kind !== 'velocity_recharge' && l.bucket === VELOCITY_RECHARGE_BUCKET && Number(l.debit) > 0)
    .map(l => ({ id: l.id, date: l.txn_date, amount: Number(l.debit), remarks: l.remarks, filed: true }));
  const reserved = matchTopUps(ctx.topups, filedByHand);
  ctx.topups = ctx.topups.filter(t => !reserved.has(t.key));
  const lines: Line[] = open.map(l => ({ key: String(l.id), account_kind: accounts.get(l.account_id) ?? 'bank', txn_date: l.txn_date, remarks: l.remarks, debit: Number(l.debit), credit: Number(l.credit), category: l.category, section: l.section }));
  const result = classify(lines, ctx);
  const rows = open.map(l => ({ id: l.id, ...result.get(String(l.id))! })).map(r => ({
    id: r.id, status: r.status, kind: r.kind, bucket: r.bucket, match_ref: r.match_ref, reason: r.reason, needs_bill: r.needs_bill, payee: r.payee, rule_id: r.rule_id,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.rpc('finance_apply_matches', { p_rows: rows.slice(i, i + 500) });
    if (error) throw new Error(`saving matches: ${error.message}`);
  }
  const count = (s: string) => rows.filter(r => r.status === s).length;
  return { lines: all.length, decided_by_you: all.length - open.length, matched: count('matched'), suggested: count('suggested'), needs_review: count('needs_review'), ignored: count('ignored') };
}
