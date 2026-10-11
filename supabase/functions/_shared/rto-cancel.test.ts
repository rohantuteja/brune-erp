// Run: node --test supabase/functions/_shared/rto-cancel.test.ts
// The guard that stops rto-cancel crediting a customer twice. Transactions are the real
// store-credit histories of orders 37560, 37535 and 37586 (Oct 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import { earlierCredit, type CreditTx } from './rto-cancel.ts';

const credit = (amount: number, at: string): CreditTx => ({ kind: 'StoreCreditAccountCreditTransaction', amount, at });
const debit = (amount: number, at: string): CreditTx => ({ kind: 'StoreCreditAccountDebitTransaction', amount: -amount, at });

test('37560: only credits from BEFORE the order was placed → nothing given yet, safe to credit', () => {
  const txs = [debit(1430.1, '2026-09-22T21:12:14Z'), credit(1430.1, '2026-09-17T03:56:59Z'), debit(1430.1, '2026-04-25T23:58:31Z'), credit(1430.1, '2026-04-23T14:51:05Z')];
  assert.equal(earlierCredit(txs, 1629.1, '2026-09-22T21:12:12Z'), undefined);
});

test('37535: a credit of 1,300 given by hand after the order → refuse a second one; the older 1,300 does not count', () => {
  const txs = [credit(1300, '2026-10-09T15:02:52Z'), debit(1300, '2026-09-21T15:00:34Z'), credit(1300, '2026-09-18T09:16:21Z')];
  const found = earlierCredit(txs, 1300, '2026-09-21T15:00:32Z');
  assert.equal(found?.at, '2026-10-09T15:02:52Z');
});

test('37586: 1,599 given for 1,499 held → within range, so it counts as already credited', () => {
  assert.equal(earlierCredit([credit(1599, '2026-10-09T12:10:13Z')], 1499, '2026-09-24T02:56:47Z')?.amount, 1599);
});

test('debits and unrelated amounts are ignored', () => {
  const txs = [debit(1500, '2026-10-05T00:00:00Z'), credit(300, '2026-10-05T00:00:00Z'), credit(5000, '2026-10-05T00:00:00Z')];
  assert.equal(earlierCredit(txs, 1500, '2026-09-24T00:00:00Z'), undefined);
});

test('the closest credit is the one reported', () => {
  const txs = [credit(1400, '2026-10-05T00:00:00Z'), credit(1510, '2026-10-06T00:00:00Z')];
  assert.equal(earlierCredit(txs, 1500, '2026-09-24T00:00:00Z')?.amount, 1510);
});
