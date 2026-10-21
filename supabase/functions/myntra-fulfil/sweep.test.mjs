// Run: node --test supabase/functions/myntra-fulfil/sweep.test.mjs
//
// The real myntra-fulfil job (index.ts) run against a fake database and a fake Unicommerce (sim.mjs) that answers the way the
// live account did on 20-21 Oct 2026. Edge cases: orders arriving during a run, overlapping runs, timeouts that still did the
// work, Myntra holding an order, a person acting at the same time, outages, limits, crashed runs.

import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDb, FakeUc, loadJob } from './sim.mjs';

const T0 = Date.parse('2026-10-21T10:00:00Z');
const MIN = 60_000;
const job = await loadJob();

afterEach(() => mock.timers.reset());

function world(settings = {}) {
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const db = new FakeDb({ myntra_fulfil_mode: 'live', myntra_fulfil_limit: 50, myntra_fulfil_from: '2026-10-19', ...settings });
  const uc = new FakeUc();
  db.uc = uc;
  uc.clock = (ms) => mock.timers.setTime(Date.now() + ms);
  const sweep = () => job.sweep(db, { record: true });
  const at = (minutes) => mock.timers.setTime(T0 + minutes * MIN);
  // an order placed `ageMin` minutes before T0 with one package per entry of `couriers`
  const order = (n, ageMin = 30, couriers = ['flipkartlogistics'], extra = {}) => uc.addOrder({
    code: `ord-${n}`, created: T0 - ageMin * MIN,
    packages: couriers.map((c, i) => ({ code: `BRUN${n}${i ? `-${i}` : ''}`, provider: c, method: n % 2 ? 'Standard-COD' : 'Standard-Prepaid' })), ...extra,
  });
  return { db, uc, sweep, at, order };
}

const statuses = (db) => Object.fromEntries(db.rows().map(r => [r.package_code, r.status]));

test('1. orders that are open are invoiced and dispatched in one run, one manifest per courier', async () => {
  const w = world();
  w.order('001', 50); w.order('002', 40, ['Shadowfax']); w.order('003', 30);
  const out = await w.sweep();
  assert.deepEqual(statuses(w.db), { BRUN001: 'dispatched', BRUN002: 'dispatched', BRUN003: 'dispatched' });
  assert.equal(out.invoiced.length, 3);
  assert.equal(w.uc.closeCalls.length, 2, 'two couriers, two manifests');
  assert.deepEqual(w.uc.closeCalls.map(c => c.length).sort(), [1, 2]);
  assert.ok(w.db.rows().every(r => r.label_url && r.manifest_code && r.invoice_display && r.tracking_number));
  assert.ok([...w.uc.orders.values()].every(o => o.status === 'COMPLETE'));
  // a second run has nothing to do and does not touch Unicommerce beyond the search
  const calls = w.uc.calls.length;
  await w.sweep();
  assert.equal(w.uc.calls.length, calls + 1, 'only the order search');
});

test('2. Myntra holds an order: waits for the time it names, costs nothing meanwhile, then goes at once', async () => {
  const w = world();
  w.order('010', 30, ['flipkartlogistics'], { eligibleAt: T0 + 3 * 60 * MIN });
  const out = await w.sweep();
  assert.equal(w.db.row('BRUN010').status, 'held');
  assert.equal(out.held.length, 1);
  assert.equal(w.db.row('BRUN010').next_try_at, new Date(T0 + 3 * 60 * MIN).toISOString());
  w.at(60);
  const before = w.uc.calls.length;
  await w.sweep();
  assert.equal(w.uc.calls.length, before + 1, 'held order is not even looked at: only the search');
  assert.equal(w.uc.invoiceCalls.BRUN010, 1);
  w.at(3 * 60 + 1);
  await w.sweep();
  assert.equal(w.db.row('BRUN010').status, 'dispatched');
  assert.equal(w.uc.invoiceCalls.BRUN010, 2);
});

test('3. the invoice call times out but Unicommerce did it: dispatched in the same run, not a failure', async () => {
  const w = world();
  w.order('020'); w.order('021');
  w.uc.timeoutInvoice.add('BRUN020');
  const out = await w.sweep();
  assert.equal(w.db.row('BRUN020').status, 'dispatched');
  assert.equal(w.db.row('BRUN021').status, 'dispatched');
  assert.equal(out.failed.length, 0);
  assert.ok(w.db.row('BRUN020').label_url, 'label link read off the package');
  assert.equal(w.uc.invoiceCalls.BRUN020, 1, 'never invoiced twice');
});

test('4. a person invoices an order on the dashboard between runs: the job only dispatches it, and keeps its label', async () => {
  const w = world();
  w.order('030');
  w.uc.pkg('BRUN030').status = 'READY_TO_SHIP';
  Object.assign(w.uc.pkg('BRUN030'), { shippingProvider: 'flipkartlogistics', invoiceCode: 'MYNTRAPPMP-I1', invoiceDisplayCode: 'I1', trackingNumber: 'MYSC1', shippingLabelLink: 'https://labels.example/BRUN030.pdf' });
  await w.sweep();
  const r = w.db.row('BRUN030');
  assert.equal(r.status, 'dispatched');
  assert.equal(r.source, 'dashboard');
  assert.equal(r.label_url, 'https://labels.example/BRUN030.pdf');
  assert.equal(w.uc.invoiceCalls.BRUN030, undefined, 'no invoice call for a package that is already invoiced');
});

test('4b. the job held an order until Myntra allows it; when the time comes a person has already invoiced it: only the dispatch is left', async () => {
  const w = world();
  w.order('031', 30, ['flipkartlogistics'], { eligibleAt: T0 + 120 * MIN });
  await w.sweep();
  assert.equal(w.db.row('BRUN031').status, 'held');
  w.uc.pkg('BRUN031').status = 'READY_TO_SHIP';        // the minute Myntra allows it, a person invoices it on the dashboard
  Object.assign(w.uc.pkg('BRUN031'), { shippingProvider: 'flipkartlogistics', invoiceCode: 'X', invoiceDisplayCode: 'X', trackingNumber: 'T', shippingLabelLink: 'https://labels.example/BRUN031.pdf' });
  w.at(121);
  await w.sweep();
  assert.equal(w.db.row('BRUN031').status, 'dispatched');
  assert.equal(w.db.row('BRUN031').source, 'dashboard');
  assert.equal(w.uc.invoiceCalls.BRUN031, 1, 'only the first, refused, attempt');
});

test('5. two runs at the same moment: every package is invoiced once and dispatched once', async () => {
  const w = world();
  for (let i = 0; i < 6; i++) w.order(String(100 + i), 60 - i);
  const [a, b] = await Promise.all([w.sweep(), w.sweep()]);
  assert.ok(Object.values(w.uc.invoiceCalls).every(n => n === 1), JSON.stringify(w.uc.invoiceCalls));
  const dispatched = w.uc.closeCalls.flat();
  assert.equal(new Set(dispatched).size, dispatched.length, 'no package on two manifests');
  assert.equal(a.invoiced.length + b.invoiced.length, 6);
  await w.sweep();                                    // whatever one run skipped, the next one finishes
  assert.ok(w.db.rows().every(r => r.status === 'dispatched'), JSON.stringify(statuses(w.db)));
  assert.equal(w.db.rows().length, 6);
});

test('6. a new order arrives while a run is in progress: not lost, picked up by the next run', async () => {
  const w = world();
  w.order('200', 60); w.order('201', 50);
  let added = false;
  w.uc.hooks.beforeInvoice = async (uc, code) => {            // the new order lands in Unicommerce mid-run
    if (!added) { added = true; w.order('202', 0); }
  };
  const first = await w.sweep();
  assert.equal(first.invoiced.length, 2, 'the run works on the orders it found');
  assert.equal(w.db.row('BRUN202'), undefined);
  w.at(5);
  const second = await w.sweep();
  assert.deepEqual(second.invoiced, ['BRUN202']);
  assert.ok(w.db.rows().every(r => r.status === 'dispatched'));
});

test('6b. an order arrives between the search and the end of the run, and another while dispatching', async () => {
  const w = world();
  w.order('210', 60);
  w.uc.hooks.beforeClose = async () => { if (!w.uc.orders.has('ord-211')) w.order('211', 0); };
  await w.sweep();
  assert.equal(w.db.row('BRUN210').status, 'dispatched');
  w.at(5);
  await w.sweep();
  assert.equal(w.db.row('BRUN211').status, 'dispatched');
});

test('7. the per-run limit takes the oldest first and nothing is dropped across runs', async () => {
  const w = world({ myntra_fulfil_limit: 2 });
  for (let i = 0; i < 5; i++) w.order(String(300 + i), 100 - i * 10);   // 300 is the oldest
  const r1 = await w.sweep();
  assert.deepEqual(r1.invoiced, ['BRUN300', 'BRUN301']);
  assert.equal(r1.deferred, 3);
  w.at(5); const r2 = await w.sweep(); assert.deepEqual(r2.invoiced, ['BRUN302', 'BRUN303']);
  w.at(10); const r3 = await w.sweep(); assert.deepEqual(r3.invoiced, ['BRUN304']);
  assert.equal(w.db.rows().filter(r => r.status === 'dispatched').length, 5);
});

test('8. createclose is refused: the label stays on the print list, the dispatch is retried later', async () => {
  const w = world();
  w.order('400');
  w.uc.failClose = 'Manifest service unavailable';
  const out = await w.sweep();
  const r = w.db.row('BRUN400');
  assert.equal(r.status, 'invoiced');
  assert.equal(out.failed.length, 1);
  assert.ok(r.next_try_at && Date.parse(r.next_try_at) > Date.now());
  assert.equal(w.uc.invoiceCalls.BRUN400, 1);
  w.at(5); await w.sweep();
  assert.equal(w.db.row('BRUN400').status, 'invoiced', 'still backing off');
  w.uc.failClose = null;
  w.at(20); await w.sweep();
  assert.equal(w.db.row('BRUN400').status, 'dispatched');
  assert.equal(w.uc.invoiceCalls.BRUN400, 1, 'never invoiced twice');
});

test('8b. createclose times out but Unicommerce dispatched: recorded as dispatched, with its manifest', async () => {
  const w = world();
  w.order('410'); w.order('411');
  w.uc.timeoutClose = true;
  const out = await w.sweep();
  assert.deepEqual(statuses(w.db), { BRUN410: 'dispatched', BRUN411: 'dispatched' });
  assert.ok(w.db.rows().every(r => r.manifest_code), 'manifest read off the package');
  assert.equal(out.failed.length, 0);
});

test('9. a customer cancels while the order waits: no loop, no alarm, the row ends cancelled', async () => {
  const w = world();
  w.order('500', 30, ['flipkartlogistics'], { eligibleAt: T0 + 60 * MIN });
  await w.sweep();
  assert.equal(w.db.row('BRUN500').status, 'held');
  w.uc.orders.get('ord-500').status = 'CANCELLED'; w.uc.pkg('BRUN500').status = 'CANCELLED';
  w.at(61);
  await w.sweep();
  assert.equal(w.db.row('BRUN500').status, 'cancelled');
  assert.equal(w.uc.invoiceCalls.BRUN500, 1);
});

test('9b. cancelled between the lookup and the invoice: one failure, then it is left alone', async () => {
  const w = world();
  w.order('501');
  w.uc.hooks.beforeInvoice = async () => { w.uc.orders.get('ord-501').status = 'CANCELLED'; w.uc.pkg('BRUN501').status = 'CANCELLED'; };
  const out = await w.sweep();
  assert.equal(out.failed.length, 1);
  w.at(20);
  await w.sweep();
  assert.equal(w.db.row('BRUN501').status, 'cancelled');
  assert.equal(w.uc.invoiceCalls.BRUN501, 1);
});

test('10. a run that died mid-way leaves a claim: respected while fresh, taken over once stale', async () => {
  const w = world();
  w.order('600');
  w.db.rows().push({ package_code: 'BRUN600', sale_order_code: 'ord-600', status: 'working', source: 'erp', attempts: 0, claimed_at: new Date(T0 - 1 * MIN).toISOString(), next_try_at: null, label_url: null, invoiced_at: null, provider: null, printed_at: null });
  await w.sweep();
  assert.equal(w.db.row('BRUN600').status, 'working', 'fresh claim: another run is on it');
  assert.equal(w.uc.invoiceCalls.BRUN600, undefined);
  w.at(15);
  await w.sweep();
  assert.equal(w.db.row('BRUN600').status, 'dispatched');
});

test('10b. a claim that died and the package was dispatched by hand meanwhile: the row is closed, not stuck', async () => {
  const w = world();
  w.order('610');
  w.db.rows().push({ package_code: 'BRUN610', sale_order_code: 'ord-610', status: 'working', source: 'erp', attempts: 0, claimed_at: new Date(T0).toISOString(), next_try_at: null, label_url: null, invoiced_at: null, provider: null, printed_at: null });
  Object.assign(w.uc.pkg('BRUN610'), { status: 'DISPATCHED', shippingProvider: 'flipkartlogistics', invoiceCode: 'I', invoiceDisplayCode: 'I', trackingNumber: 'T' });
  w.uc.orders.get('ord-610').status = 'COMPLETE';
  w.at(30);
  await w.sweep();
  assert.equal(w.db.row('BRUN610').status, 'dispatched');
});

test('11. Unicommerce is down: the run fails cleanly, nothing is half-written, the next run works', async () => {
  const w = world();
  w.order('700'); w.order('701');
  w.uc.down = true;
  await assert.rejects(() => w.sweep(), /Unicommerce call failed/);
  assert.equal(w.db.rows().length, 0);
  w.uc.down = false; w.at(5);
  await w.sweep();
  assert.deepEqual(statuses(w.db), { BRUN700: 'dispatched', BRUN701: 'dispatched' });
});

test('12. slow Unicommerce: invoicing stops at the time budget and what is invoiced is dispatched at once', async () => {
  const w = world();
  for (let i = 0; i < 12; i++) w.order(String(800 + i), 100 - i);
  w.uc.slow = 20_000;                                  // each call takes 20 s of (fake) clock
  const started = Date.now();
  const out = await w.sweep();
  const took = Date.now() - started;
  assert.ok(took < 140_000, `the run took ${Math.round(took / 1000)} s of fake clock, over the edge function limit`);
  assert.ok(out.dispatched.reduce((n, d) => n + d.packages.length, 0) === out.invoiced.length, 'everything invoiced is dispatched in the same run');
  assert.ok(out.invoiced.length < 12 && out.invoiced.length > 0);
  assert.ok(out.deferred > 0);
  w.uc.slow = 0; w.at(30);
  await w.sweep(); await w.sweep();
  assert.equal(w.db.rows().filter(r => r.status === 'dispatched').length, 12);
});

test('13. a big batch is dispatched in manifests of at most 10 packages', async () => {
  const w = world();
  for (let i = 0; i < 25; i++) w.order(String(900 + i), 100 - i);
  await w.sweep();
  assert.ok(w.uc.closeCalls.every(c => c.length <= 10), JSON.stringify(w.uc.closeCalls.map(c => c.length)));
  assert.equal(w.uc.closeCalls.flat().length, 25);
  assert.equal(w.db.rows().filter(r => r.status === 'dispatched').length, 25);
});

test('14. one order that cannot be invoiced does not block the others, backs off, and after 6 failures needs a person', async () => {
  const w = world();
  w.order('950'); w.order('951');
  w.uc.failInvoice.set('BRUN950', 'Item master data missing');
  const out = await w.sweep();
  assert.equal(w.db.row('BRUN951').status, 'dispatched');
  assert.equal(w.db.row('BRUN950').status, 'failed');
  assert.equal(out.failed.length, 1);
  let t = 0;
  for (let i = 0; i < 8; i++) { t += 200; w.at(t); await w.sweep(); }
  assert.equal(w.db.row('BRUN950').status, 'attention');
  assert.equal(w.db.row('BRUN950').attempts, 6);
  const calls = w.uc.invoiceCalls.BRUN950;
  w.at(t + 500); await w.sweep();
  assert.equal(w.uc.invoiceCalls.BRUN950, calls, 'an attention package is left alone');
});

test('15. orders before myntra_fulfil_from and orders that are not PROCESSING are ignored', async () => {
  const w = world({ myntra_fulfil_from: '2026-10-21' });
  w.uc.addOrder({ code: 'ord-old', created: Date.parse('2026-10-19T05:00:00Z'), packages: [{ code: 'BRUNOLD', provider: 'flipkartlogistics' }] });
  w.uc.addOrder({ code: 'ord-done', created: T0 - 30 * MIN, status: 'COMPLETE', packages: [{ code: 'BRUNDONE', provider: 'flipkartlogistics', status: 'DISPATCHED' }] });
  w.uc.addOrder({ code: 'ord-cx', created: T0 - 30 * MIN, status: 'CANCELLED', packages: [{ code: 'BRUNCX', provider: 'flipkartlogistics', status: 'CANCELLED' }] });
  await w.sweep();
  assert.equal(w.db.rows().length, 0);
  assert.deepEqual(w.uc.invoiceCalls, {});
});

test('15b. an order older than the 5-day lookback is no longer searched', async () => {
  const w = world();
  w.uc.addOrder({ code: 'ord-6d', created: T0 - 6 * 24 * 60 * MIN, packages: [{ code: 'BRUN6D', provider: 'flipkartlogistics' }] });
  w.order('991', 30);
  await w.sweep();
  assert.deepEqual(Object.keys(statuses(w.db)), ['BRUN991']);
});

test('16. dry mode reads only: nothing is written and nothing is changed in Unicommerce', async () => {
  const w = world({ myntra_fulfil_mode: 'dry' });
  w.order('990'); w.uc.addOrder({ code: 'ord-rts', created: T0 - 10 * MIN, packages: [{ code: 'BRUNRTS', provider: 'flipkartlogistics', status: 'READY_TO_SHIP' }] });
  const out = await w.sweep();
  assert.equal(w.db.rows().length, 0);
  assert.deepEqual(w.uc.invoiceCalls, {});
  assert.equal(w.uc.closeCalls.length, 0);
  assert.deepEqual(out.would_invoice, ['BRUN990']);
  assert.deepEqual(out.would_dispatch, ['BRUNRTS']);
});

test('17. an order with two packages: each is invoiced, and all are dispatched', async () => {
  const w = world();
  w.order('960', 30, ['flipkartlogistics', 'flipkartlogistics']);
  await w.sweep();
  assert.deepEqual(statuses(w.db), { BRUN960: 'dispatched', 'BRUN960-1': 'dispatched' });
  assert.equal(w.uc.orders.get('ord-960').status, 'COMPLETE');
});

test('18. a package with no courier is not dispatched blindly: it is flagged for a person', async () => {
  const w = world();
  w.uc.addOrder({ code: 'ord-nc', created: T0 - 10 * MIN, packages: [{ code: 'BRUNNC', status: 'READY_TO_SHIP' }] });
  const out = await w.sweep();
  assert.equal(w.db.row('BRUNNC').status, 'attention');
  assert.equal(out.dispatched.length, 0);
  assert.equal(w.uc.closeCalls.length, 0);
});
