// Run: node --test src/lib/myntraView.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRows, needsPrint, printQueue, viewCounts } from './myntraView.js';

const row = (over = {}) => ({
  package_code: 'BRUN1', sale_order_code: 'abc', status: 'dispatched', source: 'erp', label_url: 'https://x/l.pdf', printed_at: null,
  invoiced_at: '2026-10-21T04:00:00Z', dispatched_at: '2026-10-21T04:01:00Z', invoice_display: 'I0927RE000000109', tracking_number: 'MYSC1', manifest_code: 'SM0031', ...over,
});
const TODAY = '2026-10-21';

test('a label is to print only when the job made it and nobody printed it', () => {
  assert.equal(needsPrint(row()), true);
  assert.equal(needsPrint(row({ status: 'invoiced' })), true);          // still to dispatch, label already exists
  assert.equal(needsPrint(row({ printed_at: '2026-10-21T05:00:00Z' })), false);
  assert.equal(needsPrint(row({ source: 'dashboard' })), false);        // printed from the dashboard
  assert.equal(needsPrint(row({ label_url: null })), false);
  assert.equal(needsPrint(row({ status: 'held' })), false);
  assert.equal(needsPrint(row({ status: 'cancelled' })), false);
});

test('counts per list', () => {
  const rows = [
    row({ package_code: 'A' }),
    row({ package_code: 'B', status: 'invoiced', dispatched_at: null }),
    row({ package_code: 'C', status: 'held', label_url: null, dispatched_at: null }),
    row({ package_code: 'D', status: 'failed', label_url: null, dispatched_at: null }),
    row({ package_code: 'E', status: 'attention', label_url: null, dispatched_at: null }),
    row({ package_code: 'F', printed_at: '2026-10-21T06:00:00Z', dispatched_at: '2026-10-20T04:00:00Z' }),
  ];
  assert.deepEqual(viewCounts(rows, TODAY), { print: 2, waiting: 1, dispatch: 1, attention: 2, today: 1, all: 6 });
});

test('search matches the package, invoice, tracking number or manifest', () => {
  const rows = [row({ package_code: 'BRUN00462', tracking_number: 'MYSP1' }), row({ package_code: 'BRUN00463', invoice_display: 'I0927RE000000200', manifest_code: 'SM0040' })];
  assert.deepEqual(filterRows(rows, 'all', 'brun00462', TODAY).map(r => r.package_code), ['BRUN00462']);
  assert.deepEqual(filterRows(rows, 'all', '200', TODAY).map(r => r.package_code), ['BRUN00463']);
  assert.deepEqual(filterRows(rows, 'all', 'sm0040', TODAY).map(r => r.package_code), ['BRUN00463']);
  assert.equal(filterRows(rows, 'all', '', TODAY).length, 2);
});

test('the print queue is oldest first', () => {
  const rows = [row({ package_code: 'LATE', invoiced_at: '2026-10-21T09:00:00Z' }), row({ package_code: 'EARLY', invoiced_at: '2026-10-21T03:00:00Z' }), row({ package_code: 'DONE', printed_at: 'x' })];
  assert.deepEqual(printQueue(rows).map(r => r.package_code), ['EARLY', 'LATE']);
});
