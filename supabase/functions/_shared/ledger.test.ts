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

test('a COD order not delivered yet is in transit: open, not an error', () => {
  const l = buildOrderLedger({ ...base, order: 'X3', goods: 1399, codFee: 100, saleDate: '2026-10-02' }, { cutoff: CUTOFF, today: '2026-10-11' });
  assert.equal(l.balanced, false);
  assert.equal(l.status, 'open');
  assert.equal(l.exceptions[0].type, 'in_transit');
  assert.equal(l.exceptions[0].amount, 1499);
  assert.match(l.exceptions[0].reason, /invoiced 9 days ago/);
});

test('37850: COD with the ₹199 paid up front, not delivered → ₹1,400 still due on delivery', () => {
  const f: Facts = { ...base, order: '37850', goods: 1499, codFee: 100, saleDate: '2026-10-08', payments: [{ date: '2026-10-07', amount: 199, ref: 'p' }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF, today: '2026-10-11' });
  assert.equal(l.exceptions[0].type, 'in_transit'); assert.equal(l.net, 1400); assert.equal(l.status, 'open');
});

test('a COD parcel stuck for weeks is flagged for a courier check', () => {
  const l = buildOrderLedger({ ...base, order: 'X4', goods: 1399, codFee: 100, saleDate: '2026-09-12' }, { cutoff: CUTOFF, today: '2026-10-11' });
  assert.match(l.exceptions[0].reason, /long overdue/);
});

test('37586: prepaid order returned to origin before the ERP handled RTOs, customer never refunded → refund due', () => {
  const f: Facts = { ...base, order: '37586', goods: 1499, codFee: 0, saleDate: '2026-09-24', payments: [{ date: '2026-09-24', amount: 1499, ref: 'p' }],
    returns: [{ kind: 'rto', date: '2026-10-11', goodsReturned: 1499, storeCredit: [] }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF, today: '2026-10-11' });
  assert.equal(l.net, -1499); assert.equal(l.status, 'attention');
  assert.equal(l.exceptions[0].type, 'refund_due'); assert.equal(l.exceptions[0].amount, -1499);
  assert.deepEqual(types(l), ['credit_note_goods']);
});

test('an unpaid prepaid order stays an unexplained residual: it is not a COD parcel in transit', () => {
  const l = buildOrderLedger({ ...base, order: 'X5', goods: 1399, codFee: 0, saleDate: '2026-10-02' }, { cutoff: CUTOFF, today: '2026-10-11' });
  assert.equal(l.exceptions[0].type, 'unexplained_residual'); assert.equal(l.status, 'attention');
});

test('status: complete when it nets to zero, open while travelling, attention for a person', () => {
  const done = buildOrderLedger({ ...base, order: 'X6', goods: 1399, codFee: 100, saleDate: '2026-10-02', delivered: { date: '2026-10-04', amount: 1499 } }, { cutoff: CUTOFF });
  assert.equal(done.status, 'complete');
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

// ── The courier's money: delivered, then remitted (UTR) ──────────────────────────────────────
const codOrder = (over: Partial<Facts> = {}): Facts => ({ ...base, order: 'C1', goods: 1399, codFee: 100, saleDate: '2026-10-02', delivered: { date: '2026-10-04', amount: 1499 }, ...over });

test('COD delivered and remitted in full → the courier receivable is cleared into the bank', () => {
  const l = buildOrderLedger(codOrder({ remitted: { date: '2026-10-09', amount: 1499, utr: 'UTR123' } }), { cutoff: CUTOFF, today: '2026-10-12' });
  assert.equal(l.status, 'complete'); assert.equal(l.net, 0); assert.equal(l.codOpen, 0);
  const r = l.entries.filter(e => e.voucher === 'remittance');
  assert.deepEqual(r.map(e => [e.account, e.debit, e.credit]), [['Bank', 1499, 0], ['COD receivable (Velocity)', 0, 1499]]);
  assert.equal(r[0].doc, 'UTR123'); assert.equal(r[0].date, '2026-10-09');
});

test('COD delivered a few days ago, not remitted yet → money still with the courier, not a problem', () => {
  const l = buildOrderLedger(codOrder(), { cutoff: CUTOFF, today: '2026-10-08' });
  assert.equal(l.status, 'complete'); assert.equal(l.codOpen, 1499); assert.deepEqual(l.exceptions, []);
});

test('COD delivered more than 10 days ago and never remitted → overdue, someone chases Velocity', () => {
  const l = buildOrderLedger(codOrder(), { cutoff: CUTOFF, today: '2026-10-16' });
  assert.equal(l.status, 'attention'); assert.equal(l.exceptions[0].type, 'remittance_overdue');
  assert.equal(l.exceptions[0].amount, 1499); assert.equal(l.net, 0);          // the customer side is fine
  assert.match(l.exceptions[0].reason, /delivered 12 days ago/);
});

test('exactly 10 days is not overdue yet', () => {
  assert.deepEqual(buildOrderLedger(codOrder(), { cutoff: CUTOFF, today: '2026-10-14' }).exceptions, []);
});

test('Velocity paid a different amount than the COD collected → flagged', () => {
  const l = buildOrderLedger(codOrder({ remitted: { date: '2026-10-09', amount: 1399, utr: 'UTR9' } }), { cutoff: CUTOFF, today: '2026-10-12' });
  assert.equal(l.exceptions[0].type, 'remittance_differs'); assert.equal(l.exceptions[0].amount, -100); assert.equal(l.codOpen, 100);
});

test('a delivery date that is only a guess is never called overdue', () => {
  const f = codOrder({ delivered: { date: '2026-09-01', amount: 1499, estimated: true } });
  assert.deepEqual(buildOrderLedger(f, { cutoff: CUTOFF, today: '2026-10-20' }).exceptions, []);
});

test('delivered in September, remitted in October: the receipt is October\'s and exported, the delivery is carried in', () => {
  const f = codOrder({ saleDate: '2026-09-27', delivered: { date: '2026-09-30', amount: 1499 }, remitted: { date: '2026-10-05', amount: 1499, utr: 'UTR5' } });
  const l = buildOrderLedger(f, { cutoff: CUTOFF, today: '2026-10-12' });
  assert.equal(l.status, 'complete');
  assert.deepEqual(l.exportable.map(e => e.voucher), ['remittance', 'remittance']);
  assert.equal(l.opening, 0);                      // sale, delivery both before the cutoff and net out
});

test('a COD return to origin has no delivery, so nothing to remit and nothing overdue', () => {
  const f: Facts = { ...base, order: 'C2', goods: 1399, codFee: 100, saleDate: '2026-09-25',
    returns: [{ kind: 'rto', date: '2026-10-01', goodsReturned: 1399, uc: { doc: 'ISR1', goods: 1399, codFee: 100 }, storeCredit: [] }] };
  const l = buildOrderLedger(f, { cutoff: CUTOFF, today: '2026-10-30' });
  assert.equal(l.status, 'complete'); assert.equal(l.codOpen, 0);
});
