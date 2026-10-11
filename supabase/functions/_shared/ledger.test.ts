// Run: node --test supabase/functions/_shared/ledger.test.ts
// Orders are the real ones found in Oct 2026; every one must net to zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderLedger, CUSTOMER, type Facts } from './ledger.ts';

const CUTOFF = '2026-10-01';
const base = { rate: 0.05, igst: true };
const sum = (l: ReturnType<typeof buildOrderLedger>, key: 'debit' | 'credit') => Math.round(l.entries.reduce((s, e) => s + e[key], 0) * 100) / 100;
const tax = (l: ReturnType<typeof buildOrderLedger>, voucher: string) =>
  Math.round(l.entries.filter(e => e.voucher === voucher && /GST/.test(e.account)).reduce((s, e) => s + e.credit - e.debit, 0) * 100) / 100;
const types = (l: ReturnType<typeof buildOrderLedger>) => l.balancing.map(b => b.type).sort();

test('37807: prepaid return, Unicommerce invoice complete → nets to zero, only the ₹99 fee is the ERP\'s', () => {
  const f: Facts = { ...base, order: '37807', goods: 1139.15, codFee: 0, saleDate: '2026-10-05', saleDoc: 'INS0106',
    payments: [{ date: '2026-10-05', amount: 1139.15, ref: 'KWIKYM6Q4OQM' }],
    returns: [{ kind: 'customer', date: '2026-10-11', goodsReturned: 1139.15, uc: { doc: 'ISR0004', goods: 1139.15, codFee: 0 },
      storeCredit: [{ date: '2026-10-07', amount: 1040.15, ref: 'refund' }], returnFee: 99 }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.balanced, true); assert.deepEqual(l.exceptions, []);
  assert.deepEqual(types(l), ['return_fee_invoice']);
  assert.equal(tax(l, 'sale'), 54.25);          // IGST on 1,139.15 incl.
  assert.equal(tax(l, 'invoice'), 4.71);        // IGST on the ₹99 fee
  assert.equal(sum(l, 'debit'), sum(l, 'credit'));
});

test('37562: COD customer return, Unicommerce reverses goods only → the ₹100 COD fee stays in the sale', () => {
  const f: Facts = { ...base, order: '37562', goods: 1399, codFee: 100, saleDate: '2026-10-02', saleDoc: 'INS0900',
    delivered: { date: '2026-10-04', amount: 1499 },
    returns: [{ kind: 'customer', date: '2026-10-08', goodsReturned: 1399, uc: { doc: 'ISR0900', goods: 1399, codFee: 0 },
      storeCredit: [{ date: '2026-10-07', amount: 1300, ref: 'RET733' }], returnFee: 99 }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.balanced, true);
  assert.deepEqual(types(l), ['return_fee_invoice']);
  assert.equal(tax(l, 'sale'), 71.38);
});

test('COD customer return when Unicommerce reverses the COD charge too → the ERP bills the retained ₹100 back', () => {
  const f: Facts = { ...base, order: 'X1', goods: 1399, codFee: 100, saleDate: '2026-10-02',
    delivered: { date: '2026-10-04', amount: 1499 },
    returns: [{ kind: 'customer', date: '2026-10-08', goodsReturned: 1399, uc: { doc: 'ISR1', goods: 1399, codFee: 100 },
      storeCredit: [{ date: '2026-10-07', amount: 1300, ref: 'r' }], returnFee: 99 }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.balanced, true);
  assert.deepEqual(types(l), ['retained_cod_fee_invoice', 'return_fee_invoice']);
});

test('37707: COD return to origin, Unicommerce reverses goods only → the ERP credits the COD charge', () => {
  const f: Facts = { ...base, order: '37707', goods: 1399, codFee: 100, saleDate: '2026-09-30', saleDoc: 'INS0006',
    returns: [{ kind: 'rto', date: '2026-10-08', goodsReturned: 1399, uc: { doc: 'ISR0001', goods: 1399, codFee: 0 } }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.balanced, true);
  assert.deepEqual(types(l), ['credit_note_cod_fee']);
  assert.equal(l.balancing[0].amount, 100);
  const cn = l.entries.filter(e => e.voucher === 'credit_note' && e.by === 'erp');
  assert.equal(cn.find(e => e.account === 'COD charge income')?.debit, 95.24);
  assert.equal(cn.find(e => e.account === 'Output IGST')?.debit, 4.76);
});

test('COD return to origin when Unicommerce reverses everything → nothing to add', () => {
  const f: Facts = { ...base, order: 'X2', goods: 1399, codFee: 100, saleDate: '2026-10-02',
    returns: [{ kind: 'rto', date: '2026-10-08', goodsReturned: 1399, uc: { doc: 'ISR2', goods: 1399, codFee: 100 } }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.deepEqual(l.balancing, []);
});

test('37605: placed in September before Unicommerce, returned in October → ERP issues the credit note; only October is exported', () => {
  const f: Facts = { ...base, order: '37605', goods: 1089.15, codFee: 0, saleDate: '2026-09-24',
    payments: [{ date: '2026-09-24', amount: 1089.15, ref: 'KWIK' }],
    returns: [{ kind: 'customer', date: '2026-10-11', goodsReturned: 1089.15,
      storeCredit: [{ date: '2026-10-11', amount: 1089.15, ref: 'RET741' }] }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.balanced, true);
  assert.deepEqual(types(l), ['credit_note_goods']);
  assert.equal(l.opening, 0);                                        // the September sale was settled in September
  assert.ok(l.exportable.every(e => e.date >= CUTOFF));
  assert.ok(l.exportable.length > 0 && l.exportable.length < l.entries.length);
});

test('37613: store credit issued twice → exception, not exportable; once the extra is taken back it balances', () => {
  const f: Facts = { ...base, order: '37613', goods: 1599, codFee: 100, saleDate: '2026-09-25',
    storeCreditUsed: [{ date: '2026-09-25', amount: 1340.10 }], delivered: { date: '2026-09-28', amount: 358.90 },
    returns: [{ kind: 'customer', date: '2026-10-06', goodsReturned: 1599, returnFee: 99,
      storeCredit: [{ date: '2026-10-02', amount: 1500, ref: 'RP' }, { date: '2026-10-02', amount: 1340.10, ref: 'GoKwik' }] }] };
  const bad = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(bad.balanced, false);
  assert.equal(bad.exceptions[0].type, 'store_credit_differs');
  assert.equal(bad.exceptions[0].amount, 1340.10);
  assert.equal(bad.net, 1340.10);

  f.returns![0].storeCredit!.push({ date: '2026-10-11', amount: -1340.10, ref: 'reversal' });
  const good = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(good.net, 0); assert.equal(good.balanced, true);
});

test('37711: sold 29 Sep, delivered 6 Oct → September carries the receivable, October exports the delivery', () => {
  const f: Facts = { ...base, order: '37711', goods: 1399, codFee: 100, saleDate: '2026-09-29',
    delivered: { date: '2026-10-06', amount: 1499 } };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.opening, 1499);
  assert.equal(l.exportable.length, 2);                              // delivery: COD receivable, customer
  assert.equal(l.exportable.filter(e => e.account === CUSTOMER).reduce((s, e) => s + e.debit - e.credit, 0), -1499);
});

test('a COD order never delivered or paid is an unexplained residual, not exported as balanced', () => {
  const l = buildOrderLedger({ ...base, order: 'X3', goods: 1399, codFee: 100, saleDate: '2026-10-02' }, { cutoff: CUTOFF });
  assert.equal(l.balanced, false);
  assert.equal(l.exceptions[0].type, 'unexplained_residual');
  assert.equal(l.exceptions[0].amount, 1499);
});

test('intra-state sale splits the tax into CGST and SGST that add back up', () => {
  const l = buildOrderLedger({ rate: 0.05, igst: false, order: 'X4', goods: 1399, codFee: 0, saleDate: '2026-10-02',
    payments: [{ date: '2026-10-02', amount: 1399, ref: 'p' }] }, { cutoff: CUTOFF });
  const cgst = l.entries.find(e => e.account === 'Output CGST')!.credit;
  const sgst = l.entries.find(e => e.account === 'Output SGST')!.credit;
  assert.equal(Math.round((cgst + sgst) * 100) / 100, 66.62);
  assert.equal(l.net, 0);
});

test('every voucher balances: total debits equal total credits on every scenario', () => {
  const l = buildOrderLedger({ ...base, order: 'X5', goods: 1399, codFee: 100, saleDate: '2026-10-02',
    delivered: { date: '2026-10-04', amount: 1499 },
    returns: [{ kind: 'customer', date: '2026-10-08', goodsReturned: 1399, storeCredit: [{ date: '2026-10-07', amount: 1300, ref: 'r' }], returnFee: 99 }] }, { cutoff: CUTOFF });
  assert.equal(sum(l, 'debit'), sum(l, 'credit'));
  assert.equal(l.net, 0);
});

test('37605: refunded but the parcel is still travelling → waiting, no credit note yet, store credit still checked', () => {
  const f: Facts = { ...base, order: '37605', goods: 1089.15, codFee: 0, saleDate: '2026-09-24',
    payments: [{ date: '2026-09-24', amount: 1089.15, ref: 'KWIK' }],
    returns: [{ kind: 'customer', date: '2026-10-11', goodsReturned: 1089.15, pending: true,
      storeCredit: [{ date: '2026-10-11', amount: 1089.15, ref: 'RET741' }] }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.balanced, false);
  assert.equal(l.exceptions[0].type, 'awaiting_return');
  assert.deepEqual(l.balancing, []);                                   // nothing issued until the parcel is back
  assert.ok(!l.entries.some(e => e.voucher === 'credit_note'));
});

test('a double store credit is caught even while the parcel is still travelling', () => {
  const f: Facts = { ...base, order: 'X6', goods: 1599, codFee: 100, saleDate: '2026-09-25',
    storeCreditUsed: [{ date: '2026-09-25', amount: 1340.10 }], delivered: { date: '2026-09-28', amount: 358.90 },
    returns: [{ kind: 'customer', date: '2026-10-06', goodsReturned: 1599, returnFee: 99, pending: true,
      storeCredit: [{ date: '2026-10-02', amount: 1500, ref: 'RP' }, { date: '2026-10-02', amount: 1340.10, ref: 'GoKwik' }] }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF });
  assert.equal(l.exceptions[0].type, 'store_credit_differs');
  assert.equal(l.exceptions[0].amount, 1340.10);
});

test('a return waiting a long time says how long the customer has been refunded', () => {
  const f: Facts = { ...base, order: '37528', goods: 1649, codFee: 100, saleDate: '2026-09-21', delivered: { date: '2026-09-24', amount: 1749 },
    returns: [{ kind: 'customer', date: '2026-10-02', goodsReturned: 1649, returnFee: 99, pending: true, refundedOn: '2026-10-02',
      storeCredit: [{ date: '2026-10-02', amount: 1550, ref: 'r' }] }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF, today: '2026-10-12' });
  assert.equal(l.exceptions[0].type, 'awaiting_return');
  assert.match(l.exceptions[0].reason, /refunded 10 days ago/);
});
