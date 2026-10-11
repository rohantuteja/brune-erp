// Run: node --test supabase/functions/_shared/
// Cases are the real returns found in Oct 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReturn } from './credit-guard.ts';

test('37613: COD + store credit, credited twice → reverse the store-credit part', () => {
  const d = evaluateReturn({
    rpRefunded: 1500, rpRefundedAt: '2026-10-02T20:00:03.553Z', storeCreditRefund: 1340.1, balance: 2840.1,
    credits: [
      { amount: 1340.1, at: '2026-09-17T04:58:27Z' },   // an earlier return's credit: outside the window
      { amount: 1500, at: '2026-10-02T20:00:03Z' },     // Return Prime, by hand
      { amount: 1340.1, at: '2026-10-02T20:00:10Z' },   // GoKwik, from the Shopify refund
    ],
  });
  assert.equal(d.action, 'reverse');
  assert.equal(d.excess, 1340.1);
  assert.equal(d.credited, 2840.1);
});

test('36791: same pattern, 17 Sep', () => {
  const d = evaluateReturn({
    rpRefunded: 1300, rpRefundedAt: '2026-09-17T03:57:02.236Z', storeCreditRefund: 1259.1, balance: 2559.1,
    credits: [
      { amount: 1259.1, at: '2026-08-16T15:42:46Z' },
      { amount: 1300, at: '2026-09-17T03:57:02Z' },
      { amount: 1259.1, at: '2026-09-17T03:57:09Z' },
    ],
  });
  assert.equal(d.action, 'reverse');
  assert.equal(d.excess, 1259.1);
});

test('37562: plain COD, refund went to cash on delivery → one credit, nothing to do', () => {
  const d = evaluateReturn({
    rpRefunded: 1300, rpRefundedAt: '2026-10-07T00:57:15.509Z', storeCreditRefund: 0, balance: 1300,
    credits: [{ amount: 1300, at: '2026-10-07T00:57:15Z' }],
  });
  assert.equal(d.action, 'ok');
});

test('37807: prepaid, the Shopify refund to store credit IS the credit → one credit', () => {
  const d = evaluateReturn({
    rpRefunded: 1040.15, rpRefundedAt: '2026-10-07T07:03:39.601Z', storeCreditRefund: 1040.15, balance: 1040.15,
    credits: [{ amount: 1040.15, at: '2026-10-07T07:03:37Z' }],
  });
  assert.equal(d.action, 'ok');
  assert.equal(d.excess, 0);
});

test('customer already spent the extra credit → flag, never reverse', () => {
  const d = evaluateReturn({
    rpRefunded: 1500, rpRefundedAt: '2026-10-02T20:00:03Z', storeCreditRefund: 1340.1, balance: 1000,
    credits: [{ amount: 1500, at: '2026-10-02T20:00:03Z' }, { amount: 1340.1, at: '2026-10-02T20:00:10Z' }],
  });
  assert.equal(d.action, 'flag');
  assert.match(d.reason, /already spent/);
});

test('extra credit that is not the store-credit refund → flag for a person', () => {
  const d = evaluateReturn({
    rpRefunded: 1500, rpRefundedAt: '2026-10-02T20:00:03Z', storeCreditRefund: 1340.1, balance: 5000,
    credits: [{ amount: 1500, at: '2026-10-02T20:00:03Z' }, { amount: 900, at: '2026-10-02T20:00:10Z' }],
  });
  assert.equal(d.action, 'flag');
});

test('a credit minutes later on the same account is not counted', () => {
  const d = evaluateReturn({
    rpRefunded: 1500, rpRefundedAt: '2026-10-02T20:00:03Z', storeCreditRefund: 1340.1, balance: 2840.1,
    credits: [{ amount: 1500, at: '2026-10-02T20:00:03Z' }, { amount: 1340.1, at: '2026-10-02T21:30:00Z' }],
  });
  assert.equal(d.action, 'ok');
});
