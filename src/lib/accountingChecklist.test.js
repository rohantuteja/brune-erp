import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklist, missingLedgers, monthEnd } from './accountingChecklist.js';

const good = () => ({
  month: '2026-10', today: '2026-11-18',
  accounts: [{ kind: 'bank', name: 'ICICI', periodTo: '2026-10-31' }, { kind: 'card', name: 'Kotak', periodTo: '2026-10-20' }],
  gokwikSettledTo: '2026-10-31', gokwikPayouts: 29, gokwikUnproven: 0, velocityTo: '2026-10-31', myntraSettledTo: '2026-11-11', billsReview: 0,
  bills: ['Meta', 'Velocity', 'GoKwik', 'Easebuzz'].map((v, i) => ({ vendor: v, invoice_date: v === 'Easebuzz' ? '2026-10-31' : '2026-11-01' })),
  toUpload: [], twoBLoaded: true, bankUnresolved: 0, orders: { waitingInvoice: 0, open: { awaiting_payout: 3 } }, attentionAll: 0,
  ledgerRun: { finishedAt: '2026-11-18T10:40:00Z', held: 0 }, missing: [], exportedAt: null,
});
const step = (c, id) => c.steps.find(s => s.id === id);

test('a month with everything in place is ready, with no blockers', () => {
  const c = buildChecklist(good());
  assert.equal(c.ready, true);
  assert.deepEqual(c.blockers, []);
  assert.equal(step(c, 'open').status, 'info');
  assert.match(step(c, 'open').detail, /3 waiting for a gateway payout/);
});

test('a month that has not ended blocks the file', () => {
  const c = buildChecklist({ ...good(), today: '2026-10-25' });
  assert.equal(step(c, 'month').status, 'todo');
  assert.equal(c.ready, false);
});

test('uploads that stop short of the month end are blockers, each saying where they stop', () => {
  const c = buildChecklist({ ...good(), accounts: [{ kind: 'bank', name: 'ICICI', periodTo: '2026-10-25' }, { kind: 'card', name: 'Kotak', periodTo: '2026-09-20' }], gokwikSettledTo: '2026-10-12', gokwikPayouts: 12, gokwikUnproven: 17, velocityTo: '2026-09-30' });
  for (const id of ['bank', 'card', 'gokwik', 'velocity']) { assert.equal(step(c, id).status, 'todo', id); assert.equal(step(c, id).blocker, true, id); }
  assert.match(step(c, 'bank').detail, /25\/10\/2026/);
  assert.match(step(c, 'gokwik').title, /17 Easebuzz credits in the bank not matched/);
  assert.match(step(c, 'gokwik').detail, /12\/10\/2026/);
  assert.equal(c.blockers.length, 4);
});

test('with nothing uploaded the steps say so instead of failing', () => {
  const c = buildChecklist({ ...good(), accounts: [], gokwikSettledTo: null, velocityTo: null, myntraSettledTo: null });
  assert.match(step(c, 'bank').detail, /No bank statement/);
  assert.match(step(c, 'gokwik').detail, /No GoKwik report/);
  assert.match(step(c, 'myntra').detail, /None loaded/);
});

test('bills: review is a blocker; bills still to upload (per the 2B) are a blocker only once a 2B is loaded', () => {
  let c = buildChecklist({ ...good(), billsReview: 2, toUpload: [{ vendor: 'Aggarwal Traders', no: '1068', date: '2026-10-25', tax: 23260.25 }] });
  assert.equal(step(c, 'review').blocker, true);
  assert.equal(step(c, 'toupload').status, 'todo');
  assert.match(step(c, 'toupload').items[0], /Aggarwal Traders 1068/);
  c = buildChecklist({ ...good(), twoBLoaded: false });
  assert.equal(step(c, 'toupload'), undefined);
  assert.equal(step(c, '2b').status, 'todo');
  assert.equal(step(c, '2b').blocker, false);
});

test('regular supplier invoices dated at the turn of the month are expected, for vendors that have billed before', () => {
  const c = buildChecklist({ ...good(), bills: [{ vendor: 'Meta', invoice_date: '2026-10-01' }, { vendor: 'Velocity', invoice_date: '2026-11-01' }] });
  assert.equal(step(c, 'recurring').status, 'todo');
  assert.deepEqual(step(c, 'recurring').items.map(x => x.split(':')[0]), ['Meta']);
  assert.equal(step(c, 'recurring').blocker, false);
});

test('clear-up blockers: lines to decide, orders needing attention, orders not invoiced, held orders', () => {
  const c = buildChecklist({ ...good(), bankUnresolved: 4, attentionAll: 1, orders: { waitingInvoice: 12, open: {} }, ledgerRun: { finishedAt: '2026-11-18T10:00:00Z', held: 2 } });
  for (const id of ['lines', 'attention', 'waiting', 'ledger']) assert.equal(step(c, id).blocker && step(c, id).status === 'todo', true, id);
  assert.match(step(c, 'lines').title, /4 bank or card lines/);
});

test('a stale ledger refresh is asked for but does not block', () => {
  const c = buildChecklist({ ...good(), ledgerRun: { finishedAt: '2026-11-10T10:00:00Z', held: 0 } });
  assert.equal(step(c, 'ledger').status, 'todo');
  assert.equal(step(c, 'ledger').blocker, false);
});

test('ledgers the file would use that are not in Tally are listed, with why', () => {
  const tally = [{ name: 'ICICI Bank', status: 'in_tally' }, { name: 'Customer (order control)', status: 'will_create' }, { name: 'Old name', status: 'will_rename' }];
  const m = missingLedgers({ used: ['ICICI Bank', 'Customer (order control)', 'Old name', 'Myntra Commission', 'ICICI Bank'], tally });
  assert.deepEqual(m.map(x => [x.name, x.why]), [['Customer (order control)', 'to be created in Tally'], ['Myntra Commission', 'not in the list of Tally ledgers'], ['Old name', 'to be renamed in Tally']]);
  const c = buildChecklist({ ...good(), missing: m });
  assert.equal(step(c, 'ledgers').blocker, true);
  assert.equal(step(c, 'ledgers').items.length, 2);          // the rename and the unknown name; the ledger to create is made by the file itself
});

test('the checklist is grouped into the four sections, in order', () => {
  const c = buildChecklist(good());
  assert.deepEqual(c.sections.map(s => s.id), ['uploads', 'bills', 'clear', 'tally']);
  assert.ok(c.sections.every(s => s.steps.length > 0));
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(monthEnd('2026-12'), '2026-12-31');
});

test('GSTR-1 and GSTR-3B are not steps of the checklist: they are filed from Tally after the export', () => {
  const c = buildChecklist(good());
  assert.equal(c.steps.some(x => x.id === '3b' || x.section === 'gst'), false);
  assert.equal(c.steps.some(x => /file gstr|gstr-3b recorded|gstr-1/i.test(x.title)), false);
  assert.equal(c.ready, true);
});

test('ledgers the file creates itself do not block; renames and unknown names still do', () => {
  const tally = [{ name: 'Customer (order control)', status: 'will_create' }, { name: 'COD receivable (Velocity)', status: 'will_rename' }];
  let c = buildChecklist({ ...good(), missing: missingLedgers({ used: ['Customer (order control)'], tally }) });
  assert.equal(step(c, 'ledgers').status, 'info');
  assert.equal(step(c, 'ledgers').blocker, false);
  assert.equal(c.ready, true);
  c = buildChecklist({ ...good(), missing: missingLedgers({ used: ['Customer (order control)', 'COD receivable (Velocity)', 'Brand new ledger'], tally }) });
  assert.equal(step(c, 'ledgers').blocker, true);
  assert.match(step(c, 'ledgers').title, /^2 ledgers/);
  assert.match(step(c, 'ledgers').detail, /1 to be renamed by hand/);
  assert.match(step(c, 'ledgers').detail, /1 not in the list/);
  assert.equal(step(c, 'ledgers').items.length, 2);
});

test('GoKwik: payments of the last day of the month paid out next month do not make the report incomplete (the bank decides, not the last transaction date)', () => {
  const c = buildChecklist({ ...good(), gokwikSettledTo: '2026-10-31', gokwikPayouts: 29, gokwikUnproven: 0 });
  assert.equal(step(c, 'gokwik').status, 'done');
  assert.match(step(c, 'gokwik').detail, /29 Easebuzz credits in the bank, all matched/);
  assert.match(step(c, 'gokwik').detail, /next month/);
  // a report that stops early but with no Easebuzz credit left unmatched is fine too; one credit left unmatched is a blocker
  assert.equal(step(buildChecklist({ ...good(), gokwikSettledTo: '2026-10-20', gokwikPayouts: 20, gokwikUnproven: 0 }), 'gokwik').status, 'done');
  const bad = buildChecklist({ ...good(), gokwikUnproven: 1 });
  assert.equal(step(bad, 'gokwik').blocker, true);
  assert.match(step(bad, 'gokwik').title, /^1 Easebuzz credit in the bank/);
});

test('a quiet last day (a holiday) does not block: a bank statement or wallet ledger up to 3 days short is asked about, more is a blocker', () => {
  for (const [id, key, mk] of [['bank', 'accounts', (to) => [{ kind: 'bank', name: 'ICICI', periodTo: to }, { kind: 'card', name: 'Kotak', periodTo: '2026-10-20' }]], ['velocity', 'velocityTo', (to) => to]]) {
    const at = (to) => step(buildChecklist({ ...good(), [key]: mk(to) }), id);
    assert.equal(at('2026-10-31').status, 'done');
    for (const to of ['2026-10-30', '2026-10-29', '2026-10-28']) { assert.equal(at(to).status, 'todo', `${id} ${to}`); assert.equal(at(to).blocker, false, `${id} ${to}`); }
    assert.match(at('2026-10-30').title, /1 day before the month end/);
    assert.match(at('2026-10-30').detail, /holiday/);
    assert.equal(at('2026-10-27').blocker, true);
  }
  // ... and the file is still ready when the only thing open is such a note
  assert.equal(buildChecklist({ ...good(), accounts: [{ kind: 'bank', name: 'ICICI', periodTo: '2026-10-30' }, { kind: 'card', name: 'Kotak', periodTo: '2026-10-20' }] }).ready, true);
});

test('GoKwik: a month with no Easebuzz credit at all is fine; the detail says so', () => {
  const c = buildChecklist({ ...good(), gokwikPayouts: 0, gokwikUnproven: 0 });
  assert.equal(step(c, 'gokwik').status, 'done');
  assert.match(step(c, 'gokwik').detail, /No Easebuzz credit in the bank this month/);
});

test('bills booked from GSTR-2B with no invoice copy are information, never a blocker', () => {
  const c = buildChecklist({ ...good(), noCopy: [{ vendor: 'Google', no: '5732193357', date: '2026-10-31' }] });
  assert.equal(step(c, 'nocopy').status, 'info');
  assert.notEqual(step(c, 'nocopy').blocker, true);
  assert.equal(c.ready, true);
  assert.equal(step(buildChecklist(good()), 'nocopy'), undefined);
});

test('purchase and payment steps: unlinked payments block the file, advances and unpaid bills are only information, TDS to confirm is a to-do that does not block', () => {
  const none = buildChecklist({ ...good(), books: { unlinked: [], problems: [], notes: [], advances: [], unpaid: [], tdsPending: [], purchases: 5, payments: 52 } });
  assert.equal(step(none, 'billbuild').status, 'done'); assert.equal(step(none, 'suppliers').status, 'done'); assert.equal(none.steps.some(x => x.id === 'advances' || x.id === 'unpaid' || x.id === 'tds'), false);
  const c = buildChecklist({ ...good(), books: { unlinked: [{ id: 5, txn_date: '2026-10-18', debit: 777, payee: 'mystery' }], problems: [{ text: 'Meta X: no expense ledger' }], notes: [],
    advances: [{ vendor: 'Shree Vinayak Fab', left: 89019, date: '2026-10-27' }], unpaid: [{ vendor: 'Chandra', name: 'CF/1', left: 29447 }], tdsPending: ['Meta'], purchases: 4, payments: 3 } });
  assert.equal(step(c, 'suppliers').blocker, true); assert.equal(step(c, 'billbuild').blocker, true);
  assert.equal(step(c, 'advances').status, 'info'); assert.equal(step(c, 'unpaid').status, 'info'); assert.match(step(c, 'unpaid').title, /29,447/);
  assert.equal(step(c, 'tds').status, 'todo'); assert.equal(step(c, 'tds').blocker, false);
  assert.equal(c.ready, false);
  assert.equal(buildChecklist({ ...good(), books: { unlinked: [], problems: [], notes: [], advances: [], unpaid: [], tdsPending: ['Meta'], purchases: 1, payments: 1 } }).ready, true);   // the TDS to-do does not block
});

test('advances are grouped by supplier and invoice: one invoice paid in two parts reads as one line that names the invoice and what is still to pay', () => {
  const adv = (left, date) => ({ vendor: 'Shree Vinayak Fab', left, date, against: { no: 'SVF/26-27/306', date: '2026-11-03', total: 89061, stillDue: 42 } });
  const c = buildChecklist({ ...good(), books: { unlinked: [], problems: [], notes: [], advances: [adv(15000, '2026-10-10'), adv(74019, '2026-10-27'), { vendor: 'Chandra', left: 500, date: '2026-10-05' }], unpaid: [], tdsPending: [], purchases: 1, payments: 1 } });
  const a = step(c, 'advances');
  assert.equal(a.status, 'info'); assert.match(a.title, /2 suppliers paid before the invoice is dated \(3 payments\)/);
  assert.equal(a.items.length, 2);
  assert.match(a.items[0], /Shree Vinayak Fab: ₹15,000\.00 on 10\/10\/2026 \+ ₹74,019\.00 on 27\/10\/2026 = ₹89,019\.00 paid towards invoice SVF\/26-27\/306 dated 03\/11\/2026 \(₹89,061\.00\); the invoice settles them when its month is booked\. ₹42\.00 of it is still to pay\./);
  assert.match(a.items[1], /Chandra: ₹500\.00 on 05\/10\/2026: no invoice for it is on the Bills page yet\./);
  assert.match(a.detail, /Nothing to do/);
});

test('an advance whose invoice carries a discount says the invoice is paid in full, not that something is still to pay', () => {
  const adv = (left, date) => ({ vendor: 'Shree Vinayak Fab', left, date, against: { no: 'SVF/26-27/306', date: '2026-11-03', total: 89061, discount: 42 } });
  const c = buildChecklist({ ...good(), books: { unlinked: [], problems: [], notes: [], advances: [adv(15000, '2026-10-10'), adv(74019, '2026-10-27')], unpaid: [], tdsPending: [], purchases: 1, payments: 1 } });
  const a = step(c, 'advances');
  assert.equal(a.items.length, 1);
  assert.match(a.items[0], /= ₹89,019\.00 paid towards invoice SVF\/26-27\/306.*The other ₹42\.00 is a discount the supplier allowed: the invoice is paid in full\./);
  assert.doesNotMatch(a.items[0], /still to pay/);
});
