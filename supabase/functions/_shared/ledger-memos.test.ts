// Run: node --test supabase/functions/_shared/ledger-memos.test.ts
//
// The credit notes and invoices the ERP issues itself are numbered (ERP/CN/2627/0001, ERP/IN/2627/0001: migration 042) against the
// identity (order, voucher, memo). The ledger rewrites every entry on each run, so if one of these memos is reworded the same
// document would be numbered a second time and the first number would be left behind. Change a memo here only together with a
// plan for the numbers already issued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderLedger, type Facts } from './ledger.ts';

const CUTOFF = '2026-10-01';
const base = { rate: 0.05, igst: true };
const erpMemos = (l: ReturnType<typeof buildOrderLedger>) =>
  [...new Set(l.entries.filter(e => e.by === 'erp' && (e.voucher === 'credit_note' || e.voucher === 'invoice')).map(e => `${e.voucher}: ${e.memo}`))].sort();

test('an older order (no Unicommerce invoice) returned by the customer: a goods credit note and the return-fee invoice', () => {
  const f: Facts = { ...base, order: 'M1', goods: 1500, codFee: 0, saleDate: '2026-09-20',
    payments: [{ date: '2026-09-20', amount: 1500, ref: 'k1' }],
    returns: [{ kind: 'customer', date: '2026-10-10', goodsReturned: 1500, storeCredit: [{ date: '2026-10-10', amount: 1401, ref: 'r1' }], returnFee: 99 }] };
  assert.deepEqual(erpMemos(buildOrderLedger(f, { cutoff: CUTOFF })), [
    'credit_note: return 1 (customer): credit note for goods',
    'invoice: return 1 (customer): return fee',
  ]);
});

test('a COD parcel returned to origin whose Unicommerce return invoice leaves out the COD charge: the ₹100 credit note', () => {
  const f: Facts = { ...base, order: 'M2', goods: 1399, codFee: 100, saleDate: '2026-10-02', saleDoc: 'INS0001',
    returns: [{ kind: 'rto', date: '2026-10-09', goodsReturned: 1399, uc: { doc: 'ISR0001', goods: 1399, codFee: 0 }, storeCredit: [] }] };
  assert.deepEqual(erpMemos(buildOrderLedger(f, { cutoff: CUTOFF })), ['credit_note: return 1 (rto): credit note for the COD charge']);
});

test('a COD customer return whose Unicommerce credit note reverses the COD charge too: the ERP bills the retained charge back', () => {
  const f: Facts = { ...base, order: 'M3', goods: 1399, codFee: 100, saleDate: '2026-10-02', saleDoc: 'INS0002',
    delivered: { date: '2026-10-04', amount: 1499 },
    returns: [{ kind: 'customer', date: '2026-10-08', goodsReturned: 1399, uc: { doc: 'ISR0002', goods: 1399, codFee: 100 }, storeCredit: [{ date: '2026-10-07', amount: 1300, ref: 'r3' }], returnFee: 99 }] };
  assert.deepEqual(erpMemos(buildOrderLedger(f, { cutoff: CUTOFF })), [
    'invoice: return 1 (customer): retained COD charge',
    'invoice: return 1 (customer): return fee',
  ]);
});
