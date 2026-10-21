// Run: node --test supabase/functions/_shared/myntra-fulfil.test.ts
// Shapes are the real Unicommerce answers from the 20-21 Oct 2026 tests on Myntra orders (BRUN00458, 461, 462).
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByProvider, invoiceOutcome, manifestBody, manifestOutcome, parseEligibleAfter, paymentOf, planPackage, retryAt, type Pkg } from './myntra-fulfil.ts';

const NOW = new Date('2026-10-20T10:00:00Z');
const pkg = (over: Partial<Pkg> = {}): Pkg => ({
  code: 'BRUN00459', status: 'CREATED', shippingProvider: null, shippingMethod: 'Standard-Prepaid', trackingNumber: null, invoiceCode: null, invoiceDisplayCode: null, labelLink: null, ...over,
});

test("Myntra's \"try after\" time is read as IST", () => {
  assert.equal(parseEligibleAfter('MYNTRAPPMP unable to mark items ReadyToDispatch : This order is not yet eligible for processing by seller, please try after Tue Oct 20 14:00:00 IST 2026 '),
    '2026-10-20T08:30:00.000Z');
  assert.equal(parseEligibleAfter('please try after Wed Dec 2 09:05:00 IST 2026'), '2026-12-02T03:35:00.000Z');
  assert.equal(parseEligibleAfter('some other error'), null);
  assert.equal(parseEligibleAfter(null), null);
});

test('the invoice answer: success, a wait, or a failure', () => {
  const ok = invoiceOutcome({
    successful: true, errors: [], invoiceCode: 'MYNTRAPPMP-I0927RE000000109', invoiceDisplayCode: 'I0927RE000000109', trackingNumber: 'MYSC1362395086',
    shippingProviderCode: 'flipkartlogistics', shippingLabelLink: 'https://unicommerce-channel-shippinglabels-in.s3.amazonaws.com/x_InvoiceLabelConcat.pdf',
  });
  assert.deepEqual(ok, {
    ok: true, invoiceCode: 'MYNTRAPPMP-I0927RE000000109', invoiceDisplayCode: 'I0927RE000000109', trackingNumber: 'MYSC1362395086',
    provider: 'flipkartlogistics', labelUrl: 'https://unicommerce-channel-shippinglabels-in.s3.amazonaws.com/x_InvoiceLabelConcat.pdf',
  });

  const wait = invoiceOutcome({ successful: false, errors: [{ code: 100255, description: 'MYNTRAPPMP unable to mark items ReadyToDispatch : This order is not yet eligible for processing by seller, please try after Tue Oct 20 14:00:00 IST 2026 ', message: 'SCRIPT_EXECUTION_FAILED' }] });
  assert.equal(wait.ok, false);
  assert.equal((wait as any).heldUntil, '2026-10-20T08:30:00.000Z');

  const bad = invoiceOutcome({ successful: false, errors: [{ description: 'Invalid shipping package' }] });
  assert.deepEqual(bad, { ok: false, heldUntil: null, error: 'Invalid shipping package' });
  assert.equal(invoiceOutcome(null).ok, false);
  // successful but no invoice code: not trusted
  assert.equal(invoiceOutcome({ successful: true }).ok, false);
});

test('what to do with a package', () => {
  assert.equal(planPackage(pkg(), undefined, NOW).step, 'invoice');
  assert.equal(planPackage(pkg({ status: 'READY_TO_SHIP' }), undefined, NOW).step, 'dispatch');
  for (const st of ['PICKING', 'PACKED', 'MANIFESTED', 'DISPATCHED', 'CANCELLED', 'RETURN_EXPECTED']) {
    assert.equal(planPackage(pkg({ status: st }), undefined, NOW).step, 'skip', st);
  }
});

test('a held package waits for its time, then goes', () => {
  const held = (next: string) => ({ status: 'held', next_try_at: next, attempts: 0, claimed_at: null });
  assert.equal(planPackage(pkg(), held('2026-10-20T10:30:00Z'), NOW).step, 'skip');
  assert.equal(planPackage(pkg(), held('2026-10-20T09:59:00Z'), NOW).step, 'invoice');
});

test('a failed package backs off, and after too many failures needs a person', () => {
  const failed = (next: string) => ({ status: 'failed', next_try_at: next, attempts: 2, claimed_at: null });
  assert.equal(planPackage(pkg(), failed('2026-10-20T10:20:00Z'), NOW).step, 'skip');
  assert.equal(planPackage(pkg(), failed('2026-10-20T09:00:00Z'), NOW).step, 'invoice');
  assert.equal(planPackage(pkg(), { status: 'attention', next_try_at: null, attempts: 6, claimed_at: null }, NOW).step, 'skip');
  assert.equal(retryAt(1, NOW), '2026-10-20T10:15:00.000Z');
  assert.equal(retryAt(3, NOW), '2026-10-20T10:45:00.000Z');
  assert.equal(retryAt(20, NOW), '2026-10-20T12:00:00.000Z');   // capped at 2 hours
});

test('an invoice that was refused or timed out does not delay the dispatch of a package that is READY_TO_SHIP anyway', () => {
  const waiting = (status: string) => ({ status, next_try_at: '2026-10-20T10:30:00Z', attempts: 1, claimed_at: null });
  assert.equal(planPackage(pkg({ status: 'READY_TO_SHIP' }), waiting('failed'), NOW).step, 'dispatch');
  assert.equal(planPackage(pkg({ status: 'READY_TO_SHIP' }), waiting('held'), NOW).step, 'dispatch');
  assert.equal(planPackage(pkg({ status: 'CREATED' }), waiting('failed'), NOW).step, 'skip');
  // a failed dispatch keeps its own back-off
  assert.equal(planPackage(pkg({ status: 'READY_TO_SHIP' }), waiting('invoiced'), NOW).step, 'skip');
});

test('another run holds a package only while its claim is fresh', () => {
  const claimed = (at: string) => ({ status: 'working', next_try_at: null, attempts: 0, claimed_at: at });
  assert.equal(planPackage(pkg(), claimed('2026-10-20T09:55:00Z'), NOW).step, 'skip');
  assert.equal(planPackage(pkg(), claimed('2026-10-20T09:40:00Z'), NOW).step, 'invoice');   // stale: that run crashed
});

test('a package dispatched earlier but back at READY_TO_SHIP is dispatched again', () => {
  const k = { status: 'dispatched', next_try_at: null, attempts: 0, claimed_at: null };
  assert.equal(planPackage(pkg({ status: 'READY_TO_SHIP' }), k, NOW).step, 'dispatch');
  assert.equal(planPackage(pkg({ status: 'DISPATCHED' }), k, NOW).step, 'skip');
});

test('one manifest per courier, prepaid and COD together', () => {
  const g = groupByProvider([
    { code: 'A', provider: 'flipkartlogistics' }, { code: 'B', provider: 'Shadowfax' }, { code: 'C', provider: 'flipkartlogistics' },
  ]);
  assert.deepEqual([...g.keys()], ['flipkartlogistics', 'Shadowfax']);
  assert.deepEqual(g.get('flipkartlogistics')!.map(x => x.code), ['A', 'C']);
  assert.equal(paymentOf('Standard-COD'), 'cod');
  assert.equal(paymentOf('Standard-Prepaid'), 'prepaid');
  const body: any = manifestBody('flipkartlogistics', ['BRUN00462']);
  assert.equal(body.channel, 'MYNTRAPPMP');
  assert.equal('shippingMethodCode' in body, false);
  assert.deepEqual(body.shippingPackageCodes, ['BRUN00462']);
});

test("the manifest answer: done only when Unicommerce says every package was dispatched", () => {
  const done = { successful: true, errors: [], shippingManifestCode: 'SM0031', shippingManifestStatus: { completed: true, successful: true, currentStatus: 'All packages successfully dispatched', failedShippingPackages: null } };
  assert.deepEqual(manifestOutcome(done), { ok: true, manifest: 'SM0031' });
  assert.equal(manifestOutcome({ ...done, shippingManifestStatus: { ...done.shippingManifestStatus, failedShippingPackages: ['BRUN1'] } }).ok, false);
  assert.equal(manifestOutcome({ ...done, shippingManifestStatus: { ...done.shippingManifestStatus, successful: false } }).ok, false);
  const refused = manifestOutcome({ successful: false, errors: [{ description: 'Shipping package not in READY_TO_SHIP' }] });
  assert.deepEqual(refused, { ok: false, error: 'Shipping package not in READY_TO_SHIP' });
  assert.equal(manifestOutcome(null).ok, false);
});
