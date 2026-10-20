// myntra-fulfil v1
// Invoices, labels and dispatches Myntra orders (Unicommerce channel MYNTRAPPMP) as soon as Myntra allows,
// so the seller's dispatch time stays short. Docs: docs/myntra-fulfilment.md. Rules: _shared/myntra-fulfil.ts (tested).
//
// Each run:
//   1. finds Myntra orders still PROCESSING in Unicommerce (created on or after app_settings.myntra_fulfil_from)
//   2. a package with no invoice → "create invoice and allocate shipping provider" (the label comes back with it).
//      Myntra refuses this before the order's own eligibility time (its holiday "upcoming" orders); that refusal
//      names the time, the package is 'held' until then and tried again, it is not a failure
//   3. every READY_TO_SHIP package (made just now, or by a person on the dashboard) → "create and close
//      manifest", one manifest per courier = Quick Dispatch without its dispatch group (the public API has no
//      pack or dispatch group). The package becomes DISPATCHED
//   4. labels: the invoice+label PDFs of packages the job invoiced are listed on Analytics → Myntra until a
//      person marks them printed; the `labels` action merges the unprinted ones into one PDF
//
// Every Unicommerce call goes through public.uc_post (ucPost), never straight from here.
//
// Dry mode: until app_settings.myntra_fulfil_mode is "live" a run only READS Unicommerce and reports what it
// would do. app_settings.myntra_fulfil_limit caps the packages one live run touches (default 1: set it to 1 for the
// first live run, check that order, then raise it). Packages over the cap wait for the next run.
//
// Schedule: every 5 minutes (pg_cron, migration 037, header x-cron-key matching private_secrets.erp_stock_cron_key).
//
// Admin actions (POST { action } with an admin user's JWT; status/sweep/retry also with the x-cron-key header):
//   status          — mode, limit, start date, counts per status, unprinted labels, the last run, rows needing a person
//   sweep           — { dry?: false } run now; dry (default) only reports
//   retry           — { package_code } a failed / attention package is tried again at the next run
//   labels          — { codes? } one merged PDF (base64) of the unprinted labels, or of the given packages
//   mark_printed    — { codes } / mark_unprinted — { codes }
//   set_mode        — { mode: "dry"|"live", limit? } (admin JWT only)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { decode, encode } from 'https://deno.land/std@0.177.0/encoding/base64.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PDFDocument } from 'https://esm.sh/pdf-lib@1.17.1';
import { CORS, cronKeyValid, json, requireAdmin, setting } from '../_shared/shopify-admin.ts';
import { ucErrorText, ucPost } from '../_shared/unicommerce.ts';
import {
  CHANNEL, MAX_ATTEMPTS, CLAIM_STALE_MS, groupByProvider, invoiceOutcome, manifestBody, manifestOutcome, paymentOf, planPackage, retryAt,
  type Known, type Pkg,
} from '../_shared/myntra-fulfil.ts';

const LOOKBACK_DAYS = 14;        // an order Myntra held over a long holiday is still found
const MAX_LABELS = 100;          // labels in one merged PDF
const SEARCH_WINDOW_MS = 30 * 86_400_000;   // Unicommerce's order search takes at most 31 days

type Row = {
  package_code: string; sale_order_code: string; status: string; source: string; attempts: number;
  next_try_at: string | null; claimed_at: string | null; provider: string | null; label_url: string | null; invoiced_at: string | null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const raw = await req.text();
  try {
    const body = raw ? JSON.parse(raw) : {};
    const cronKey = req.headers.get('x-cron-key');
    if (cronKey) {
      // The scheduled job ({}), or a read-only / retry action sent with the same secret key.
      if (!(await cronKeyValid(admin, cronKey))) return json({ error: 'bad cron key' }, 401);
      if (!body.action) return json(await sweep(admin, { record: true }));
      if (!['status', 'sweep', 'retry'].includes(body.action)) return json({ error: 'that action needs an admin user' }, 403);
      return json(await dispatch(admin, body));
    }
    const denied = await requireAdmin(admin, req);
    if (denied) return denied;
    return json(await dispatch(admin, body));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

async function dispatch(admin: SupabaseClient, body: any) {
  switch (body.action) {
    case 'status':       return await status(admin);
    case 'sweep':        return await sweep(admin, { record: body.dry === false });
    case 'retry':        return await retry(admin, String(body.package_code ?? ''));
    case 'labels':       return await labels(admin, Array.isArray(body.codes) ? body.codes.map(String) : null);
    case 'mark_printed': return await markPrinted(admin, codesOf(body), true);
    case 'mark_unprinted': return await markPrinted(admin, codesOf(body), false);
    case 'set_mode':     return await setMode(admin, body);
    default: throw new Error('action must be status, sweep, retry, labels, mark_printed, mark_unprinted or set_mode');
  }
}

const codesOf = (body: any): string[] => (Array.isArray(body.codes) ? body.codes.map(String).filter(Boolean) : []);
const iso = (d = new Date()) => d.toISOString();

// ── Settings ──────────────────────────────────────────────────────────────────────────────────

async function config(admin: SupabaseClient) {
  return {
    mode: await setting(admin, 'myntra_fulfil_mode', 'dry'),
    limit: Math.max(0, Math.floor(Number(await setting(admin, 'myntra_fulfil_limit', '1')) || 0)),
    from: await setting(admin, 'myntra_fulfil_from', '2026-10-19'),
  };
}

async function setMode(admin: SupabaseClient, body: any) {
  const mode = String(body.mode ?? '');
  if (mode !== 'dry' && mode !== 'live') throw new Error('mode must be dry or live');
  const writes = [{ key: 'myntra_fulfil_mode', value: mode }];
  if (body.limit !== undefined) {
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be a whole number from 1 to 200');
    writes.push({ key: 'myntra_fulfil_limit', value: limit as any });
  }
  const { error } = await admin.from('app_settings').upsert(writes, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  return await status(admin);
}

// ── Status ────────────────────────────────────────────────────────────────────────────────────

async function status(admin: SupabaseClient) {
  const cfg = await config(admin);
  const { data: rows } = await admin.from('myntra_fulfilments').select('status, printed_at');
  const counts: Record<string, number> = {};
  let unprinted = 0;
  for (const r of rows ?? []) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (!r.printed_at && (r.status === 'invoiced' || r.status === 'dispatched')) unprinted++;
  }
  const { data: attention } = await admin.from('myntra_fulfilments')
    .select('package_code, sale_order_code, status, attempts, detail, updated_at').in('status', ['failed', 'attention'])
    .order('updated_at', { ascending: false }).limit(20);
  const { data: last } = await admin.from('app_settings').select('value').eq('key', 'myntra_fulfil_last_run').maybeSingle();
  return { ...cfg, counts, unprinted, last_run: last?.value ?? null, attention: attention ?? [] };
}

// ── The job ───────────────────────────────────────────────────────────────────────────────────

async function sweep(admin: SupabaseClient, opts: { record: boolean }) {
  const cfg = await config(admin);
  const live = opts.record && cfg.mode === 'live';
  const now = new Date();
  const out = {
    mode: cfg.mode, live, record: opts.record, limit: cfg.limit, from: cfg.from,
    orders: 0, looked_at: 0,
    would_invoice: [] as string[], would_dispatch: [] as string[],
    invoiced: [] as string[], held: [] as Array<{ package: string; until: string | null }>,
    dispatched: [] as Array<{ manifest: string; courier: string; packages: string[] }>,
    failed: [] as Array<{ package: string; reason: string }>,
    deferred: 0, skipped: {} as Record<string, number>,
  };
  const skip = (why: string) => { out.skipped[why] = (out.skipped[why] ?? 0) + 1; };

  // 1. Open Myntra orders.
  const fromMs = Math.max(Date.parse(`${cfg.from}T00:00:00+05:30`), now.getTime() - LOOKBACK_DAYS * 86_400_000);
  const orders = await openOrders(admin, fromMs, now.getTime());
  out.orders = orders.length;

  const { data: knownRows } = orders.length
    ? await admin.from('myntra_fulfilments').select('*').in('sale_order_code', orders.map(o => o.code))
    : { data: [] as Row[] };
  const byOrder = new Map<string, Row[]>();
  for (const r of (knownRows ?? []) as Row[]) byOrder.set(r.sale_order_code, [...(byOrder.get(r.sale_order_code) ?? []), r]);

  // A package we invoiced whose order is no longer open was dispatched (or cancelled) outside the ERP.
  if (live) await reconcile(admin, new Set(orders.map(o => o.code)));

  // 2. Each order's packages and what to do with them.
  type Work = { order: { code: string; created: number }; pkg: Pkg; step: 'invoice' | 'dispatch'; known: Row | undefined };
  const work: Work[] = [];
  for (const o of orders) {
    const rows = byOrder.get(o.code) ?? [];
    // Everything we know about this order is waiting for a later time or a person: no need to ask Unicommerce.
    // (A 'failed' invoice is always looked at again: the call may have timed out after Unicommerce did it.)
    if (rows.length && rows.every(r => r.status === 'attention' || (r.next_try_at && Date.parse(r.next_try_at) > now.getTime() && (r.status === 'held' || r.status === 'invoiced')))) { skip('waiting'); continue; }
    out.looked_at++;
    const so = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code: o.code });
    if (!so?.successful || !so.saleOrderDTO) { out.failed.push({ package: o.code, reason: `order lookup failed: ${ucErrorText(so)}` }); continue; }
    for (const p of so.saleOrderDTO.shippingPackages ?? []) {
      const pkg: Pkg = {
        code: String(p.code), status: String(p.status), shippingProvider: p.shippingProvider ?? null, shippingMethod: p.shippingMethod ?? null,
        trackingNumber: p.trackingNumber ?? null, invoiceCode: p.invoiceCode ?? null, invoiceDisplayCode: p.invoiceDisplayCode ?? null,
      };
      const known = rows.find(r => r.package_code === pkg.code);
      const plan = planPackage(pkg, known as Known, now);
      if (plan.step === 'skip') { skip(plan.why); continue; }
      work.push({ order: o, pkg, step: plan.step, known });
    }
  }
  work.sort((a, b) => a.order.created - b.order.created);   // oldest order first
  out.deferred = Math.max(0, work.length - cfg.limit);
  const todo = work.slice(0, cfg.limit);

  if (!live) {
    for (const w of todo) (w.step === 'invoice' ? out.would_invoice : out.would_dispatch).push(w.pkg.code);
    if (opts.record) await saveLastRun(admin, out, now);
    return out;
  }

  // 3. Invoice and label, then collect everything READY_TO_SHIP for dispatch.
  type Ready = { pkg: string; provider: string | null };
  const ready: Ready[] = [];
  for (const w of todo) {
    const source = w.known?.source ?? (w.pkg.status === 'CREATED' ? 'erp' : 'dashboard');
    const claimed = await claim(admin, w, source, now);
    if (!claimed) { skip('another run is working on it'); continue; }
    if (w.step === 'dispatch') {
      // A person invoiced it on the dashboard (or an earlier run did and the dispatch failed): keep what the package says.
      const byPerson = !w.known?.invoiced_at;
      await update(admin, w.pkg.code, {
        ...(byPerson ? { source: 'dashboard', invoiced_at: iso() } : {}),
        invoice_code: w.pkg.invoiceCode, invoice_display: w.pkg.invoiceDisplayCode,
        tracking_number: w.pkg.trackingNumber, provider: w.pkg.shippingProvider ?? w.known?.provider ?? null,
      });
      ready.push({ pkg: w.pkg.code, provider: w.pkg.shippingProvider ?? w.known?.provider ?? null });
      continue;
    }

    const attempts = (w.known?.attempts ?? 0) + 1;
    let res;
    try {
      res = invoiceOutcome(await ucPost(admin, '/services/rest/v1/oms/shippingPackage/createInvoiceAndAllocateShippingProvider', { shippingPackageCode: w.pkg.code }));
    } catch (err) {
      res = { ok: false as const, heldUntil: null, error: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok && !res.heldUntil) {
      // The database gives a call 7 seconds and an invoice can take longer (Myntra is told at the same time): the call "failed"
      // but Unicommerce may have done it. Look at the package before calling it a failure.
      const done = await invoicedNow(admin, w.order.code, w.pkg.code).catch(() => null);
      if (done) res = { ok: true, invoiceCode: done.invoiceCode ?? '', invoiceDisplayCode: done.invoiceDisplayCode, trackingNumber: done.trackingNumber, provider: done.shippingProvider, labelUrl: null };
    }
    if (res.ok) {
      out.invoiced.push(w.pkg.code);
      await update(admin, w.pkg.code, {
        status: 'invoiced', attempts: 0, next_try_at: null, claimed_at: null, detail: null,
        invoice_code: res.invoiceCode, invoice_display: res.invoiceDisplayCode, tracking_number: res.trackingNumber,
        provider: res.provider ?? w.pkg.shippingProvider, label_url: res.labelUrl, invoiced_at: iso(),
      });
      ready.push({ pkg: w.pkg.code, provider: res.provider ?? w.pkg.shippingProvider });
    } else if (res.heldUntil) {
      out.held.push({ package: w.pkg.code, until: res.heldUntil });
      await update(admin, w.pkg.code, { status: 'held', next_try_at: res.heldUntil, claimed_at: null, detail: res.error });
    } else {
      out.failed.push({ package: w.pkg.code, reason: res.error });
      await update(admin, w.pkg.code, failure(attempts, res.error, now));
    }
  }

  // 4. Dispatch: one manifest per courier.
  const noCourier = ready.filter(r => !r.provider);
  for (const r of noCourier) {
    out.failed.push({ package: r.pkg, reason: 'no courier on the package' });
    await update(admin, r.pkg, { status: 'attention', claimed_at: null, detail: 'no courier on the package: dispatch it by hand' });
  }
  for (const [provider, items] of groupByProvider(ready.filter(r => r.provider) as Array<{ pkg: string; provider: string }>)) {
    const codes = items.map(i => i.pkg);
    let res;
    try {
      res = manifestOutcome(await ucPost(admin, '/services/rest/v1/oms/shippingManifest/createclose', manifestBody(provider, codes)));
    } catch (err) {
      res = { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) {
      out.dispatched.push({ manifest: res.manifest, courier: provider, packages: codes });
      for (const c of codes) await update(admin, c, { status: 'dispatched', attempts: 0, next_try_at: null, claimed_at: null, detail: null, manifest_code: res.manifest, dispatched_at: iso() });
    } else {
      for (const c of codes) {
        out.failed.push({ package: c, reason: res.error });
        const { data: cur } = await admin.from('myntra_fulfilments').select('attempts').eq('package_code', c).maybeSingle();
        // The invoice step already worked, so the package stays 'invoiced' (its label still prints) and only the
        // dispatch is retried, with a back-off; after too many failures a person must look.
        const f = failure((cur?.attempts ?? 0) + 1, `dispatch: ${res.error}`, now);
        await update(admin, c, { ...f, status: f.status === 'attention' ? 'attention' : 'invoiced' });
      }
    }
  }

  await saveLastRun(admin, out, now);
  return out;
}

// The package as Unicommerce has it now, if it is READY_TO_SHIP (invoiced and labelled).
async function invoicedNow(admin: SupabaseClient, orderCode: string, packageCode: string): Promise<Pkg | null> {
  const so = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code: orderCode });
  const p = (so?.saleOrderDTO?.shippingPackages ?? []).find((x: any) => String(x.code) === packageCode);
  if (!p || p.status !== 'READY_TO_SHIP') return null;
  return {
    code: packageCode, status: 'READY_TO_SHIP', shippingProvider: p.shippingProvider ?? null, shippingMethod: p.shippingMethod ?? null,
    trackingNumber: p.trackingNumber ?? null, invoiceCode: p.invoiceCode ?? null, invoiceDisplayCode: p.invoiceDisplayCode ?? null,
  };
}

// Rows still open in the ledger whose order left PROCESSING: a person dispatched it on the dashboard, or it was cancelled.
async function reconcile(admin: SupabaseClient, open: Set<string>) {
  const { data } = await admin.from('myntra_fulfilments').select('package_code, sale_order_code').in('status', ['held', 'invoiced', 'failed']).limit(100);
  const gone = (data ?? []).filter(r => !open.has(r.sale_order_code as string)).slice(0, 20);
  for (const r of gone) {
    const so = await ucPost(admin, '/services/rest/v1/oms/saleorder/get', { code: r.sale_order_code });
    const st = so?.saleOrderDTO?.status;
    if (st === 'COMPLETE') await update(admin, r.package_code as string, { status: 'dispatched', next_try_at: null, claimed_at: null, detail: 'dispatched outside the ERP', dispatched_at: iso() });
    else if (st === 'CANCELLED') await update(admin, r.package_code as string, { status: 'cancelled', next_try_at: null, claimed_at: null, detail: 'order cancelled' });
  }
}

// What a failed step leaves on the row: a back-off, and after MAX_ATTEMPTS a person must look.
function failure(attempts: number, error: string, now: Date) {
  return {
    status: attempts >= MAX_ATTEMPTS ? 'attention' : 'failed', attempts, claimed_at: null, detail: error.slice(0, 400),
    next_try_at: attempts >= MAX_ATTEMPTS ? null : retryAt(attempts, now),
  };
}

async function update(admin: SupabaseClient, code: string, fields: Record<string, unknown>) {
  const { error } = await admin.from('myntra_fulfilments').update({ ...fields, updated_at: iso() }).eq('package_code', code);
  if (error) throw new Error(`could not record ${code}: ${error.message}`);
}

async function saveLastRun(admin: SupabaseClient, out: any, now: Date) {
  const summary = {
    at: now.toISOString(), mode: out.mode, live: out.live, orders: out.orders,
    invoiced: out.invoiced.length, would_invoice: out.would_invoice.length, would_dispatch: out.would_dispatch.length,
    held: out.held.length, dispatched: out.dispatched.reduce((n: number, d: any) => n + d.packages.length, 0),
    failed: out.failed.length, deferred: out.deferred,
  };
  await admin.from('app_settings').upsert({ key: 'myntra_fulfil_last_run', value: summary }, { onConflict: 'key' });
}

// A package belongs to one run at a time: the first run to insert (or take a stale claim) wins.
async function claim(admin: SupabaseClient, w: { order: { code: string; created: number }; pkg: Pkg; known: Row | undefined }, source: string, now: Date): Promise<boolean> {
  if (!w.known) {
    const { error } = await admin.from('myntra_fulfilments').insert({
      package_code: w.pkg.code, sale_order_code: w.order.code, order_created: iso(new Date(w.order.created)),
      payment: paymentOf(w.pkg.shippingMethod), provider: w.pkg.shippingProvider, tracking_number: w.pkg.trackingNumber,
      invoice_code: w.pkg.invoiceCode, invoice_display: w.pkg.invoiceDisplayCode,
      status: 'working', source, claimed_at: iso(now),
    });
    if (!error) return true;
    if (error.code !== '23505') throw new Error(`could not claim ${w.pkg.code}: ${error.message}`);
  }
  const stale = iso(new Date(now.getTime() - CLAIM_STALE_MS));
  const { data } = await admin.from('myntra_fulfilments').update({ status: 'working', claimed_at: iso(now), updated_at: iso() })
    .eq('package_code', w.pkg.code).or(`claimed_at.is.null,claimed_at.lt.${stale}`).select('package_code');
  return (data ?? []).length > 0;
}

// Myntra orders still PROCESSING in Unicommerce, created between the two instants.
async function openOrders(admin: SupabaseClient, fromMs: number, toMs: number): Promise<Array<{ code: string; created: number }>> {
  const found = new Map<string, number>();
  for (let start = fromMs; start < toMs; start += SEARCH_WINDOW_MS) {
    const to = Math.min(start + SEARCH_WINDOW_MS, toMs);
    for (let displayStart = 0; ; displayStart += 500) {
      const r = await ucPost(admin, '/services/rest/v1/oms/saleOrder/search', {
        channel: CHANNEL, dateType: 'CREATED', fromDate: new Date(start).toISOString(), toDate: new Date(to).toISOString(),
        searchOptions: { displayLength: 500, displayStart },
      });
      if (!r?.successful) throw new Error(`Unicommerce Myntra order search failed: ${ucErrorText(r)}`);
      for (const e of r.elements ?? []) if (e.status === 'PROCESSING') found.set(String(e.code), Number(e.created) || 0);
      if ((r.elements ?? []).length < 500) break;
    }
  }
  return [...found].map(([code, created]) => ({ code, created }));
}

// ── Retry ─────────────────────────────────────────────────────────────────────────────────────

async function retry(admin: SupabaseClient, code: string) {
  if (!code) throw new Error('package_code is required');
  const { data, error } = await admin.from('myntra_fulfilments').update({ status: 'failed', attempts: 0, next_try_at: null, claimed_at: null, updated_at: iso() })
    .eq('package_code', code).in('status', ['failed', 'attention', 'held']).select('package_code');
  if (error) throw new Error(error.message);
  if (!(data ?? []).length) throw new Error(`${code} is not a failed, held or attention package`);
  return { ok: true, package: code };
}

// ── Labels ────────────────────────────────────────────────────────────────────────────────────

async function markPrinted(admin: SupabaseClient, codes: string[], printed: boolean) {
  if (!codes.length) throw new Error('codes is required');
  const { data, error } = await admin.from('myntra_fulfilments').update({ printed_at: printed ? iso() : null, updated_at: iso() })
    .in('package_code', codes).select('package_code');
  if (error) throw new Error(error.message);
  return { ok: true, updated: (data ?? []).length };
}

// One PDF of the unprinted labels (or of the given packages): every invoiced or dispatched package nobody marked printed,
// whoever invoiced it. The label comes from the link Unicommerce returned when the job invoiced the package; for a package a
// person invoiced on the dashboard, or when that link no longer works, from Unicommerce's getInvoiceLabel (the PDF itself).
// A label that cannot be fetched is named in `missing` and left unprinted, so it shows up again.
async function labels(admin: SupabaseClient, codes: string[] | null) {
  let q = admin.from('myntra_fulfilments').select('package_code, label_url').in('status', ['invoiced', 'dispatched'])
    .order('invoiced_at', { ascending: true, nullsFirst: false }).limit(MAX_LABELS);
  q = codes ? q.in('package_code', codes) : q.is('printed_at', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  if (!(data ?? []).length) return { pdf: null, codes: [], missing: [] };

  const merged = await PDFDocument.create();
  const included: string[] = [];
  const missing: Array<{ package: string; reason: string }> = [];
  for (const r of data ?? []) {
    try {
      const src = await PDFDocument.load(await labelBytes(admin, r.package_code as string, r.label_url as string | null));
      for (const page of await merged.copyPages(src, src.getPageIndices())) merged.addPage(page);
      included.push(r.package_code as string);
    } catch (err) {
      missing.push({ package: r.package_code as string, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!included.length) return { pdf: null, codes: [], missing };
  return { pdf: encode(await merged.save()), codes: included, missing };
}

async function labelBytes(admin: SupabaseClient, code: string, url: string | null): Promise<Uint8Array> {
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch { /* fall back to Unicommerce */ }
  }
  const data = await ucPost(admin, '/services/rest/v1/oms/shippingPackage/getInvoiceLabel', { shippingPackageCode: code });
  if (!data?.successful || !data.label) throw new Error(`Unicommerce has no label: ${ucErrorText(data)}`);
  return decode(String(data.label));
}
