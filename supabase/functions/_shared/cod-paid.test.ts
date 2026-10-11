// Run: node --test supabase/functions/_shared/
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideMark, type OrderForPaid, type VelocityRow } from './cod-paid.ts';

const START = '2026-10-01';
const order = (o: Partial<OrderForPaid> = {}): OrderForPaid => ({
  name: '37765', tags: ['COD', 'GoKwik'], cancelled: false, financialStatus: 'PENDING',
  gateways: ['cash_on_delivery'], outstanding: 1499, awbs: ['34812018108181'], ...o,
});
const vel = (v: Partial<VelocityRow> = {}): VelocityRow => ({
  tracking_number: '34812018108181', delivery_date: '2026-10-07', cod_amount: 1499,
  remittance_date: '2026-10-12', utr_no: null, ...v,
});

test('delivered in October, amounts agree → mark paid', () => {
  const d = decideMark(order(), vel(), START);
  assert.equal(d.action, 'mark');
  if (d.action === 'mark') { assert.equal(d.deliveredOn, '2026-10-07'); assert.equal(d.codAmount, 1499); }
});

test('not delivered yet (remittance_date is only a schedule) → wait', () => {
  assert.equal(decideMark(order(), vel({ delivery_date: null }), START).action, 'wait');
});

test('delivered in September → baseline, never marked', () => {
  const d = decideMark(order(), vel({ delivery_date: '2026-09-28' }), START);
  assert.equal(d.action, 'baseline');
});

test('delivered on the start date itself is in scope', () => {
  assert.equal(decideMark(order(), vel({ delivery_date: '2026-10-01' }), START).action, 'mark');
});

test('return to origin is never marked, even if Velocity shows a date', () => {
  assert.equal(decideMark(order({ tags: ['COD', 'rto_initiated'] }), vel(), START).action, 'skip');
  assert.equal(decideMark(order({ tags: ['COD', 'RTO_DELIVERED'] }), vel(), START).action, 'skip');
});

test('already paid, cancelled or nothing owed → skip', () => {
  assert.equal(decideMark(order({ financialStatus: 'PAID' }), vel(), START).action, 'skip');
  assert.equal(decideMark(order({ financialStatus: 'REFUNDED' }), vel(), START).action, 'skip');
  assert.equal(decideMark(order({ cancelled: true }), vel(), START).action, 'skip');
  assert.equal(decideMark(order({ outstanding: 0 }), vel(), START).action, 'skip');
});

test('prepaid order is not ours', () => {
  assert.equal(decideMark(order({ gateways: ['Gokwik UPI'] }), vel(), START).action, 'skip');
});

test('PPCOD: only the balance is owed, and Velocity collected exactly that', () => {
  const d = decideMark(order({ name: '37759', financialStatus: 'PARTIALLY_PAID', gateways: ['Gokwik PPCOD'], outstanding: 1551 }),
    vel({ cod_amount: 1551 }), START);
  assert.equal(d.action, 'mark');
});

test('COD + store credit: Velocity collected the COD part', () => {
  const d = decideMark(order({ name: '37858', financialStatus: 'PARTIALLY_PAID', gateways: ['cash_on_delivery', 'Shopify Store Credits'], outstanding: 267.9 }),
    vel({ cod_amount: 267.9 }), START);
  assert.equal(d.action, 'mark');
});

test('Velocity collected a different amount → attention, not marked', () => {
  const d = decideMark(order(), vel({ cod_amount: 1399 }), START);
  assert.equal(d.action, 'attention');
});

test('two parcels, no Velocity row, Velocity error → attention / wait', () => {
  assert.equal(decideMark(order({ awbs: ['a', 'b'] }), vel(), START).action, 'attention');
  assert.equal(decideMark(order(), undefined, START).action, 'wait');
  assert.equal(decideMark(order(), vel({ error: 'AWB not found' }), START).action, 'wait');
  assert.equal(decideMark(order({ awbs: [] }), vel(), START).action, 'wait');
});
