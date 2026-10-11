// Made-up payments shaped like GoKwik's rawSettlementReport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gokwikDate, parseCsv, parseGokwikReport, payoutsOf } from './gokwik-report.ts';

const HEAD = 'Transaction Type,Payment Id,Reference Id,Order Id,Amount,Fee,Tax,Additional Fees,Additional Tax,gokwik Deduction,Credit,Debit,Payment Method,Transaction Date,Transaction RRN,Merchant Order Id,Platform Order Id,Shopify Transaction Id,Settlement UTR,Settlement Date,Settled By,Payment Mode,Bank Code,Card Network,Remark,PG Transaction Type,Origin';
const line = (id: string, order: string, amount: string, fee: string, tax: string, credit: string, txn: string, utr: string, settled: string, extra: { debit?: string; type?: string } = {}) =>
  `${extra.type ?? 'Payment'},${id},,KWIK${id},${amount},${fee},${tax},0.0000,0.0000,0.0000,${credit},${extra.debit ?? '0.0000'},upi,${txn},rrn,m1,${order},,${utr},${settled},easebuzz,upi-ba,,,,,GoKwik`;
const FILE = [HEAD,
  line('P1', '37719', '199', '3.9800', '0.7200', '194.3000', '30/9/2026 12:19 PM', 'UTR1', '1/10/2026 05:30 AM'),
  line('P2', '37723', '1349', '26.9800', '4.8600', '1317.1600', '30/9/2026 01:05 PM', 'UTR1', '1/10/2026 05:30 AM'),
  line('P3', '37734', '1350', '33.7500', '6.0800', '1310.1700', '1/10/2026 09:00 AM', 'UTR2', '3/10/2026 05:30 AM'),
].join('\r\n');

test('dates are day first', () => {
  assert.equal(gokwikDate('30/9/2026 12:19 PM'), '2026-09-30'); assert.equal(gokwikDate('1/10/2026 05:30 AM'), '2026-10-01');
  assert.equal(gokwikDate('13/13/2026'), null); assert.equal(gokwikDate(''), null); assert.equal(gokwikDate('2026-10-01'), null);
});

test('CSV: quotes, commas and line breaks inside a quoted field, a leading byte-order mark, and blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,"b,c","d ""e"" f"\n\n1,2,3\r\n'), [['a', 'b,c', 'd "e" f'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('x,"multi\nline"\ny,z'), [['x', 'multi\nline'], ['y', 'z']]);
});

test('a settlement report is read payment by payment, and every payment is checked: amount less fee less GST is what was credited', () => {
  const r = parseGokwikReport(FILE);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { payment_id: 'P1', order_name: '37719', txn_date: '2026-09-30', settlement_date: '2026-10-01', utr: 'UTR1', amount: 199, fee: 3.98, tax: 0.72, credit: 194.3, method: 'upi', remark: null, pg_transaction_type: null });
  assert.ok(r.checks.every(c => c.ok), JSON.stringify(r.checks));
});

test('payments are grouped into the bank transfers they came in, one payout per bank reference', () => {
  const p = payoutsOf(parseGokwikReport(FILE).rows);
  assert.deepEqual(p, [{ utr: 'UTR1', date: '2026-10-01', amount: 1511.46, payments: 2 }, { utr: 'UTR2', date: '2026-10-03', amount: 1310.17, payments: 1 }]);
});

test('a refund (a debit) lowers its payout, and arithmetic that does not add up, a repeated payment or an unsettled payment is reported', () => {
  const refund = parseGokwikReport([HEAD, line('P1', '1', '500', '10', '1.8', '488.2', '30/9/2026', 'U', '1/10/2026'), line('R1', '1', '0', '0', '0', '0', '2/10/2026', 'U', '1/10/2026', { debit: '200.0000', type: 'Refund' })].join('\n'));
  assert.equal(refund.rows[1].credit, -200);
  assert.equal(payoutsOf(refund.rows)[0].amount, 288.2);
  const bad = parseGokwikReport([HEAD, line('P1', '1', '500', '10', '1.8', '400', '30/9/2026', 'U', '1/10/2026'), line('P1', '1', '500', '10', '1.8', '488.2', '30/9/2026', '', '')].join('\n'));
  assert.equal(bad.checks.find(c => c.id === 'amount_less_fees')!.ok, false);
  assert.equal(bad.checks.find(c => c.id === 'unique_payments')!.ok, false);
  assert.equal(bad.checks.find(c => c.id === 'all_settled')!.ok, false);
});

test('a file that is not a GoKwik settlement report is refused', () => {
  assert.throws(() => parseGokwikReport('a,b\n1,2'), /no "Payment Id" column/);
  assert.throws(() => parseGokwikReport(''), /empty/);
});
