import test from 'node:test';
import assert from 'node:assert/strict';
import { billSummary, changedEdits, failedChecks, filterBills, newVendorDraft, outcomeText } from './billsView.js';

const B = (id, status, o = {}) => ({ id, status, vendor: 'Meta', vendor_id: 1, invoice_no: `INV${id}`, supplier_gstin: '06AABCF5150G1ZZ', total: 100, subtotal: 85, tax: 15, opening: false, file_path: 'p', checks: [], ...o });

test('the status cards count what needs a person, the opening bills and the bills with no PDF', () => {
  const s = billSummary([B(1, 'review', { total: 250.5 }), B(2, 'review', { total: 100 }), B(3, 'accepted', { opening: true, file_path: null }), B(4, 'void', { file_path: null, opening: true })]);
  assert.deepEqual(s, { review: 2, accepted: 1, void: 1, opening: 1, noFile: 1, reviewAmount: 350.5 });
});

test('the filters: status (review by default), vendor, and a search over vendor, number, GSTIN and amount', () => {
  const bills = [B(1, 'review'), B(2, 'accepted', { vendor: 'GoKwik', vendor_id: 4, invoice_no: 'GKHR/1', total: 845 }), B(3, 'void')];
  assert.deepEqual(filterBills(bills).map(b => b.id), [1]);
  assert.deepEqual(filterBills(bills, { status: 'accepted' }).map(b => b.id), [2]);
  assert.deepEqual(filterBills(bills, { status: 'open' }).map(b => b.id), [1, 2]);        // everything not voided
  assert.deepEqual(filterBills(bills, { status: 'all' }).map(b => b.id), [1, 2, 3]);
  assert.deepEqual(filterBills(bills, { status: 'all', vendor: '4' }).map(b => b.id), [2]);
  // "No PDF yet": bills still waiting for their PDF, whatever their status, never a voided one
  const noPdf = [B(1, 'review', { file_path: null }), B(2, 'accepted', { file_path: 'p' }), B(3, 'accepted', { file_path: null }), B(4, 'void', { file_path: null })];
  assert.deepEqual(filterBills(noPdf, { status: 'nofile' }).map(b => b.id), [1, 3]);
  assert.equal(filterBills(noPdf, { status: 'nofile' }).length, billSummary(noPdf).noFile);   // the card and the list always agree
  assert.deepEqual(filterBills(bills, { status: 'all', q: 'gkhr' }).map(b => b.id), [2]);
  assert.deepEqual(filterBills(bills, { status: 'all', q: '845' }).map(b => b.id), [2]);
  assert.deepEqual(filterBills(bills, { status: 'all', q: '06AABC' }).map(b => b.id), [1, 2, 3]);
});

test('failed checks are the ones to show', () => {
  assert.deepEqual(failedChecks({ checks: [{ id: 'a', ok: true }, { id: 'b', ok: false, detail: 'x' }] }).map(c => c.id), ['b']);
  assert.deepEqual(failedChecks({ checks: null }), []);
});

test('what happened to each invoice in an upload, in a sentence', () => {
  assert.match(outcomeText({ outcome: 'accepted', vendor: 'GoKwik', invoice_no: 'GKHR/1' }).text, /GoKwik GKHR\/1: read, every check passed, accepted/);
  const held = outcomeText({ outcome: 'review', vendor: 'GoKwik', invoice_no: 'GKHR/1', reasons: ['The first bill from GoKwik: confirm it once'] });
  assert.equal(held.tone, 'warn'); assert.match(held.text, /held for you\. The first bill from GoKwik/);
  assert.match(outcomeText({ outcome: 'attached', vendor: 'Meta', invoice_no: '1', differs: [] }).text, /figures agree with the PDF/);
  const differs = outcomeText({ outcome: 'attached', vendor: 'Meta', invoice_no: '1', differs: ['total: stored 1, the PDF says 2'] });
  assert.equal(differs.warn, true); assert.match(differs.text, /differs from what was stored: total: stored 1/);
  assert.equal(outcomeText({ outcome: 'already_uploaded', invoice_no: '1' }).tone, 'info');
  assert.equal(outcomeText({ outcome: 'unreadable', reasons: ['no amounts'] }).tone, 'bad');
});

test('a new vendor is offered with what the invoice says: a goods invoice becomes a purchase, anything else an expense', () => {
  assert.deepEqual(newVendorDraft({ vendor: ' SAMPLE  FABRICS A ', supplier_gstin: '07AAAAA1111A1ZY', kind: 'goods' }), { name: 'SAMPLE FABRICS A', tally_ledger_name: 'SAMPLE FABRICS A', gstin: '07AAAAA1111A1ZY', booking: 'purchase', expense_ledger: '' });
  assert.equal(newVendorDraft({ vendor: 'Meta', supplier_gstin: null, kind: 'service' }).booking, 'expense');
});

test('only the numbers a person changed are sent as corrections', () => {
  const bill = { invoice_no: 'CF/1', invoice_date: '2026-10-01', subtotal: 100, tax: 5, total: 105 };
  assert.deepEqual(changedEdits(bill, { invoice_no: 'CF/1', invoice_date: '2026-10-01', taxable: '100', tax: '5.00', total: '105' }), {});
  assert.deepEqual(changedEdits(bill, { invoice_no: ' CF/2 ', invoice_date: '2026-10-02', taxable: '100', tax: '5', total: '105.40' }), { invoice_no: 'CF/2', invoice_date: '2026-10-02', total: 105.4 });
  assert.deepEqual(changedEdits(bill, { invoice_no: 'CF/1', invoice_date: '', taxable: '', tax: '', total: '' }), {});
});
