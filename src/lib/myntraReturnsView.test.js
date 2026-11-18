import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ageDays, ageLabel, ageTone, defaultView, filterOpen, ledgerByOrder, openCounts, parseFilter, parseView, pieceCount, sortOpen, splitAttention, trackingText,
} from './myntraReturnsView.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const ret = (code, kind, opened, over = {}) => ({ return_code: code, order_code: `so-${code}`, kind, skus: ['X-M'], opened_at: opened, tracking_status: 'CIR_COURIER_ASSIGNED', ...over });

test('a view in the URL wins; otherwise what needs a person, then what failed, then what was received', () => {
  assert.equal(defaultView('open', { person: 3, failed: 1 }), 'open');
  assert.equal(defaultView(null, { person: 3, failed: 1 }), 'person');
  assert.equal(defaultView(undefined, { person: 0, failed: 2 }), 'failed');
  assert.equal(defaultView(null, { person: 0, failed: 0 }), 'received');
  assert.equal(defaultView('nonsense', {}), 'received');
  assert.equal(parseView('open'), 'open');
  assert.equal(parseView('x'), null);
});

test('the two attention boxes split the rows the same way they count them (unverified is a person\'s)', () => {
  const rows = [{ status: 'attention' }, { status: 'unverified' }, { status: 'failed' }, { status: 'failed' }];
  const s = splitAttention(rows);
  assert.deepEqual([s.person.length, s.failed.length], [2, 2]);
  assert.deepEqual(splitAttention(undefined), { person: [], failed: [] });
});

test('Myntra\'s tracking is shown in words, and an unknown status is made readable instead of hidden', () => {
  assert.equal(trackingText('CIR_COURIER_ASSIGNED'), 'Pickup arranged');
  assert.equal(trackingText('RTO_INITIATED'), 'On its way back');
  assert.equal(trackingText('RTO_DELIVERED_TO_SELLER'), 'Back with us, being received');
  assert.equal(trackingText('RTO_OUT_FOR_DELIVERY'), 'rto out for delivery');
  assert.equal(trackingText(null), 'No status from Myntra yet');
});

test('age is whole days since Myntra opened the return; unknown stays unknown', () => {
  assert.equal(ageDays(daysAgo(38), NOW), 38);
  assert.equal(ageDays(new Date(NOW - 3.9 * 86_400_000).toISOString(), NOW), 3);
  assert.equal(ageDays(new Date(NOW + 60_000).toISOString(), NOW), 0);   // a clock a minute ahead is not negative
  assert.equal(ageDays(null, NOW), null);
  assert.equal(ageDays('garbage', NOW), null);
  assert.deepEqual([ageLabel(null), ageLabel(0), ageLabel(1), ageLabel(38)], ['—', 'today', '1 day', '38 days']);
});

test('14 days is amber, 30 is red', () => {
  assert.deepEqual([13, 14, 29, 30].map(ageTone), ['normal', 'amber', 'amber', 'red']);
  assert.equal(ageTone(null), 'unknown');
});

const rows = [
  ret('RP3', 'customer', daysAgo(5)),
  ret('BRUN1', 'rto', daysAgo(38), { tracking_status: 'RTO_INITIATED' }),
  ret('RP1', 'customer', daysAgo(20)),
  ret('RP9', 'customer', null),                       // opened date not read yet
  ret('RP2', 'customer', daysAgo(14)),
];

test('counts and filters: customer pickups, RTOs, and 14+ days (a return with no date yet is not counted late)', () => {
  assert.deepEqual(openCounts(rows, NOW), { all: 5, customer: 4, rto: 1, late: 3 });
  assert.deepEqual(filterOpen(rows, 'rto', NOW).map(r => r.return_code), ['BRUN1']);
  assert.deepEqual(filterOpen(rows, 'late', NOW).map(r => r.return_code).sort(), ['BRUN1', 'RP1', 'RP2']);
  assert.equal(filterOpen(rows, 'customer', NOW).length, 4);
  assert.equal(filterOpen(rows, 'all', NOW).length, 5);
  assert.equal(filterOpen(rows, 'whatever', NOW).length, 5);
  assert.equal(parseFilter('rto'), 'rto');
  assert.equal(parseFilter('x'), 'all');
});

test('oldest first, a return with no date last, ties by code', () => {
  assert.deepEqual(sortOpen(rows).map(r => r.return_code), ['BRUN1', 'RP1', 'RP2', 'RP3', 'RP9']);
  const same = [ret('B', 'rto', daysAgo(2)), ret('A', 'rto', daysAgo(2))];
  assert.deepEqual(sortOpen(same).map(r => r.return_code), ['A', 'B']);
  assert.deepEqual(sortOpen(undefined), []);
  assert.equal(rows[0].return_code, 'RP3');           // the input is not reordered
});

test('pieces: one per SKU, and a return with no SKU on record still counts as one', () => {
  assert.equal(pieceCount([ret('A', 'rto', null, { skus: ['A-M', 'A-L'] }), ret('B', 'rto', null, { skus: [] }), ret('C', 'rto', null, { skus: undefined })]), 4);
  assert.equal(pieceCount(undefined), 0);
});

test('the ledger names each order by its invoice number and shows what is still owed on it', () => {
  const m = ledgerByOrder([{ channel_ref: 'so-1', order_name: 'I0927RE000000006', net: '1326.00' }, { channel_ref: 'so-2', order_name: 'I0927RE000000007', net: null }]);
  assert.deepEqual(m.get('so-1'), { name: 'I0927RE000000006', open: 1326 });
  assert.deepEqual(m.get('so-2'), { name: 'I0927RE000000007', open: 0 });
  assert.equal(m.get('so-3'), undefined);
  assert.equal(ledgerByOrder(undefined).size, 0);
});
