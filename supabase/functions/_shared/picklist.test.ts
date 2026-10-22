// Run: node --test supabase/functions/_shared/picklist.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePicklist, istStamp, wrapText, type PickItem } from './picklist.ts';

const it = (pkg: string, sku: string, over: Partial<PickItem> = {}): PickItem => ({ package: pkg, sku, name: `Name of ${sku}`, brand: 'Brune', imageUrl: null, status: 'DISPATCHED', ...over });

test('one row per SKU with the units to pick, in SKU order', () => {
  const r = aggregatePicklist([it('BRUN3', 'MONA-L'), it('BRUN1', 'KIRA-S'), it('BRUN2', 'MONA-L'), it('BRUN4', 'KIRA-S'), it('BRUN5', 'KIRA-S')]);
  assert.deepEqual(r.rows.map(x => [x.sku, x.qty]), [['KIRA-S', 3], ['MONA-L', 2]]);
  assert.equal(r.units, 5);
  assert.deepEqual(r.rows[0].packages, ['BRUN1', 'BRUN4', 'BRUN5']);
});

test('a cancelled item is not picked, and a parcel left with nothing is not listed', () => {
  const r = aggregatePicklist([it('BRUN1', 'A'), it('BRUN2', 'B', { status: 'CANCELLED' }), it('BRUN3', 'A')]);
  assert.deepEqual(r.rows.map(x => [x.sku, x.qty]), [['A', 2]]);
  assert.deepEqual(r.parcels.map(p => p.package), ['BRUN1', 'BRUN3']);
  assert.equal(r.units, 2);
});

test('parcels keep the order the items came in (the order the labels print) and count repeats within a parcel', () => {
  const r = aggregatePicklist([it('BRUN2', 'B'), it('BRUN1', 'A'), it('BRUN2', 'B'), it('BRUN2', 'C')]);
  assert.deepEqual(r.parcels, [{ package: 'BRUN2', skus: [{ sku: 'B', qty: 2 }, { sku: 'C', qty: 1 }] }, { package: 'BRUN1', skus: [{ sku: 'A', qty: 1 }] }]);
});

test('the image of the first item that has one is kept; an item with no SKU is ignored', () => {
  const r = aggregatePicklist([it('BRUN1', 'A'), it('BRUN2', 'A', { imageUrl: 'https://x/a.png' }), it('BRUN3', '')]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].imageUrl, 'https://x/a.png');
});

test('long SKUs wrap at the hyphens, words at spaces', () => {
  const w = (s: string) => s.length * 5;
  assert.deepEqual(wrapText('MONA-WHITE-DRESS-58-XL', w, 60), ['MONA-WHITE-', 'DRESS-58-XL']);
  assert.deepEqual(wrapText('Mona Plunge Cowl Midi Dress', w, 70), ['Mona Plunge', 'Cowl Midi', 'Dress']);
  assert.deepEqual(wrapText('', w, 60), ['']);
});

test('Generated at is in IST like Unicommerce prints it', () => {
  assert.equal(istStamp(new Date('2026-10-21T06:51:12Z')), '21-10-2026 | 12:21:12');
});
