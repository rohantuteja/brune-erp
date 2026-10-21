// A fake Supabase (just the calls myntra-fulfil makes) and a fake Unicommerce with the answers seen on the live account,
// so sweep.test.mjs can run the real job code against them. Test support only: nothing here ships.

import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── Load the real index.ts with its Deno URL imports replaced by stubs ────────────────────────
const STUBS = {
  'https://deno.land/std@0.177.0/http/server.ts': 'export function serve() {}',
  'https://deno.land/std@0.177.0/encoding/base64.ts': "export const encode = (b) => Buffer.from(b).toString('base64'); export const decode = (s) => new Uint8Array(Buffer.from(s, 'base64'));",
  'https://esm.sh/@supabase/supabase-js@2': 'export function createClient() { throw new Error("not in tests"); }',
  'https://esm.sh/pdf-lib@1.17.1': 'export const PDFDocument = {};',
};

export async function loadJob() {
  globalThis.Deno = { env: { get: () => undefined } };
  const out = await build({
    entryPoints: [path.join(HERE, 'index.ts')], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    plugins: [{
      name: 'deno-url-stubs',
      setup(b) {
        b.onResolve({ filter: /^https:/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: STUBS[a.path] ?? 'export {}', loader: 'js' }));
      },
    }],
  });
  const file = path.join(os.tmpdir(), `myntra-job-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(file, out.outputFiles[0].text);
  return await import(pathToFileURL(file).href);
}

// ── Fake database ─────────────────────────────────────────────────────────────────────────────
const PK = { myntra_fulfilments: 'package_code', app_settings: 'key' };

function match(row, f) {
  const v = row[f.col];
  switch (f.op) {
    case 'eq': return v === f.val;
    case 'in': return f.val.includes(v);
    case 'is': return f.val === null ? (v === null || v === undefined) : v === f.val;
    case 'notnull': return !(v === null || v === undefined);
    case 'or': return f.alts.some(a => match(row, a));
    default: throw new Error(`fake db: filter ${f.op}`);
  }
}

function parseOr(str) {
  return str.split(',').map(p => {
    const m = /^(\w+)\.(is\.null|lt\.(.+))$/.exec(p);
    if (!m) throw new Error(`fake db: or(${p})`);
    return m[2] === 'is.null' ? { op: 'is', col: m[1], val: null } : { op: 'lt', col: m[1], val: m[3] };
  });
}
const lt = (row, f) => row[f.col] !== null && row[f.col] !== undefined && String(row[f.col]) < String(f.val);

export class FakeDb {
  constructor(settings = {}) {
    this.tables = { myntra_fulfilments: [], app_settings: [], unicommerce_token: [{ id: true, access_token: 'tok', refresh_token: 'r', expires_at: '2999-01-01T00:00:00Z' }] };
    for (const [key, value] of Object.entries(settings)) this.tables.app_settings.push({ key, value });
    this.uc = null;
    this.writes = 0;
  }
  rows() { return this.tables.myntra_fulfilments; }
  row(code) { return this.rows().find(r => r.package_code === code); }
  from(table) { return new Query(this, table); }
  async rpc(name, args) {
    if (name !== 'uc_post') throw new Error(`fake db: rpc ${name}`);
    try { return { data: await this.uc.handle(args.p_path, args.p_body), error: null }; }
    catch (e) { return { data: null, error: { message: e.message } }; }
  }
}

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.op = 'select'; this.filters = []; this.order_ = null; this.limit_ = null; this.returning = false; this.single_ = false; }
  select() { if (this.op !== 'select') this.returning = true; return this; }
  insert(p) { this.op = 'insert'; this.payload = p; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  upsert(p, o) { this.op = 'upsert'; this.payload = p; this.onConflict = o?.onConflict; return this; }
  eq(col, val) { this.filters.push({ op: 'eq', col, val }); return this; }
  in(col, val) { this.filters.push({ op: 'in', col, val }); return this; }
  is(col, val) { this.filters.push({ op: 'is', col, val }); return this; }
  not(col, op, val) { if (op === 'is' && val === null) this.filters.push({ op: 'notnull', col }); else throw new Error('fake db: not'); return this; }
  or(str) { this.filters.push({ op: 'or', alts: parseOr(str) }); return this; }
  order(col, o) { this.order_ = { col, asc: o?.ascending !== false }; return this; }
  limit(n) { this.limit_ = n; return this; }
  maybeSingle() { this.single_ = true; return this; }
  single() { this.single_ = true; return this; }
  matches(row) {
    return this.filters.every(f => (f.op === 'or' ? f.alts.some(a => (a.op === 'lt' ? lt(row, a) : match(row, a))) : match(row, f)));
  }
  then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }
  run() {
    const t = this.db.tables[this.table];
    const pk = PK[this.table];
    const clone = (r) => JSON.parse(JSON.stringify(r));
    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const p of list) {
        if (pk && t.some(r => r[pk] === p[pk])) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      for (const p of list) { t.push({ attempts: 0, printed_at: null, label_url: null, next_try_at: null, claimed_at: null, invoiced_at: null, dispatched_at: null, manifest_code: null, detail: null, ...p }); this.db.writes++; }
      return { data: null, error: null };
    }
    if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const p of list) {
        const at = t.find(r => r[pk] === p[pk]);
        if (at) Object.assign(at, p); else t.push({ ...p });
        this.db.writes++;
      }
      return { data: null, error: null };
    }
    let rows = t.filter(r => this.matches(r));
    if (this.op === 'update') {
      for (const r of rows) Object.assign(r, this.payload);
      this.db.writes += rows.length;
      return { data: this.returning ? rows.map(clone) : null, error: null };
    }
    if (this.order_) {
      const { col, asc } = this.order_;
      rows = [...rows].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (asc ? 1 : -1));
    }
    if (this.limit_ !== null) rows = rows.slice(0, this.limit_);
    rows = rows.map(clone);
    if (this.single_) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

// ── Fake Unicommerce ──────────────────────────────────────────────────────────────────────────
const tick = () => new Promise(r => setImmediate(r));

export class FakeUc {
  constructor() {
    this.orders = new Map();
    this.counters = { invoice: 100, manifest: 40, tracking: 5000 };
    this.calls = [];                    // every path called, in order
    this.invoiceCalls = {};             // package → times the invoice call was made
    this.closeCalls = [];               // packages of each createclose call
    this.hooks = {};                    // test hooks
    this.timeoutInvoice = new Set();    // do the invoice, then the call "times out"
    this.timeoutClose = false;          // do the createclose, then the call "times out"
    this.failClose = null;              // refuse createclose with this text
    this.failInvoice = new Map();       // package → refusal text
    this.down = false;                  // every call fails
    this.slow = 0;                      // ms of (fake) clock each call takes
    this.clock = null;
  }
  addOrder({ code, created, packages, status = 'PROCESSING', eligibleAt = 0 }) {
    this.orders.set(code, { code, status, created, eligibleAt, packages: packages.map(p => ({
      code: p.code, status: p.status ?? 'CREATED', shippingProvider: p.provider ?? null, shippingMethod: p.method ?? 'Standard-Prepaid',
      trackingNumber: null, invoiceCode: null, invoiceDisplayCode: null, shippingLabelLink: null, shippingManifestCode: null, ...(p.extra ?? {}),
    })) });
    return this.orders.get(code);
  }
  pkg(code) { for (const o of this.orders.values()) for (const p of o.packages) if (p.code === code) return p; return null; }
  orderOf(pkgCode) { for (const o of this.orders.values()) if (o.packages.some(p => p.code === pkgCode)) return o; return null; }

  async handle(pathName, body) {
    this.calls.push(pathName);
    if (this.slow && this.clock) this.clock(this.slow);
    await tick();
    if (this.down) throw new Error('Unicommerce call failed: connection refused');
    const ok = (extra) => ({ status: 200, content: JSON.stringify({ successful: true, errors: [], ...extra }) });
    const err = (description, message) => ({ status: 200, content: JSON.stringify({ successful: false, errors: [{ description, message }] }) });
    switch (pathName) {
      case '/services/rest/v1/oms/saleOrder/search': {
        const els = [...this.orders.values()].filter(o => o.created >= Date.parse(body.fromDate) && o.created <= Date.parse(body.toDate))
          .map(o => ({ code: o.code, status: o.status, created: o.created, channel: 'MYNTRAPPMP' }));
        const out = ok({ elements: els });
        if (this.hooks.afterSearch) this.hooks.afterSearch(this);
        return out;
      }
      case '/services/rest/v1/oms/saleorder/get': {
        const o = this.orders.get(body.code);
        if (!o) return err('Invalid sale order code', 'INVALID_SALE_ORDER_CODE');
        return ok({ saleOrderDTO: { code: o.code, status: o.status, shippingPackages: o.packages.map(p => ({ ...p })) } });
      }
      case '/services/rest/v1/oms/shippingPackage/createInvoiceAndAllocateShippingProvider': {
        const code = body.shippingPackageCode;
        this.invoiceCalls[code] = (this.invoiceCalls[code] ?? 0) + 1;
        if (this.hooks.beforeInvoice) await this.hooks.beforeInvoice(this, code);
        const p = this.pkg(code); const o = this.orderOf(code);
        if (!p) return err('Invalid shipping package', 'INVALID_SHIPPING_PACKAGE');
        if (this.failInvoice.has(code)) return err(this.failInvoice.get(code), 'SCRIPT_EXECUTION_FAILED');
        if (o.status === 'CANCELLED' || p.status === 'CANCELLED') return err('Shipping package is cancelled', 'INVALID_STATE');
        if (p.status !== 'CREATED') return err(`Shipping package is in ${p.status}`, 'INVALID_STATE');
        if (this.now() < o.eligibleAt) {
          const d = new Date(o.eligibleAt + 5.5 * 3600e3);
          const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const p2 = (n) => String(n).padStart(2, '0');
          return err(`MYNTRAPPMP unable to mark items ReadyToDispatch : This order is not yet eligible for processing by seller, please try after ${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${d.getUTCDate()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} IST ${d.getUTCFullYear()} `, 'SCRIPT_EXECUTION_FAILED');
        }
        const n = ++this.counters.invoice;
        p.status = 'READY_TO_SHIP'; p.shippingProvider = p.shippingProvider ?? 'flipkartlogistics';
        p.invoiceCode = `MYNTRAPPMP-I0927RE${String(n).padStart(9, '0')}`; p.invoiceDisplayCode = `I0927RE${String(n).padStart(9, '0')}`;
        p.trackingNumber = `MYS${++this.counters.tracking}`; p.shippingLabelLink = `https://labels.example/${code}_InvoiceLabelConcat.pdf`;
        if (this.timeoutInvoice.has(code)) throw new Error('Unicommerce call failed: canceling statement due to statement timeout');
        return ok({ invoiceCode: p.invoiceCode, invoiceDisplayCode: p.invoiceDisplayCode, trackingNumber: p.trackingNumber, shippingProviderCode: p.shippingProvider, shippingLabelLink: p.shippingLabelLink });
      }
      case '/services/rest/v1/oms/shippingManifest/createclose': {
        this.closeCalls.push([...body.shippingPackageCodes]);
        if (this.hooks.beforeClose) await this.hooks.beforeClose(this, body);
        if (this.failClose) return err(this.failClose, 'INVALID_STATE');
        for (const c of body.shippingPackageCodes) {
          const p = this.pkg(c);
          if (!p || p.status !== 'READY_TO_SHIP') return err(`Shipping package ${c} is not READY_TO_SHIP`, 'INVALID_STATE');
          if (p.shippingProvider !== body.shippingProviderCode) return err(`Shipping package ${c} has another courier`, 'INVALID_STATE');
        }
        const m = `SM${String(++this.counters.manifest).padStart(4, '0')}`;
        for (const c of body.shippingPackageCodes) { const p = this.pkg(c); p.status = 'DISPATCHED'; p.shippingManifestCode = m; }
        for (const o of this.orders.values()) if (o.packages.every(p => ['DISPATCHED', 'CANCELLED'].includes(p.status)) && o.status === 'PROCESSING') o.status = 'COMPLETE';
        if (this.timeoutClose) throw new Error('Unicommerce call failed: canceling statement due to statement timeout');
        return ok({ shippingManifestCode: m, shippingManifestStatus: { completed: true, successful: true, currentStatus: 'All packages successfully dispatched', failedShippingPackages: null } });
      }
      default: throw new Error(`fake uc: ${pathName}`);
    }
  }
  now() { return Date.now(); }
}
