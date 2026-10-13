import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshLedger, isBusy, progressText, doneText, STALE_MS, MAX_CALLS, BUDGET_S } from './ledgerRefresh.js';

const NOW = Date.parse('2026-10-14T06:00:00Z');
const run = (over = {}) => ({ id: 70, status: 'done', pos: 207, total: 207, updated_at: new Date(NOW - 10 * 60000).toISOString(), ...over });
const clock = () => { let t = NOW; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

test('nothing running: sync is called until it finishes, and says how far it got each time', async () => {
  const c = clock(); const calls = []; const seen = [];
  const answers = [{ finished: false, processed: 80, total: 207 }, { finished: false, processed: 160, total: 207 }, { finished: true, processed: 207, total: 207, held: 0 }];
  const r = await refreshLedger({ ...c, readLatestRun: async () => run(), call: async (b) => { calls.push(b); return { ok: true, json: answers[calls.length - 1] }; }, onProgress: p => seen.push(p) });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { action: 'sync', kind: 'incremental', budget_s: BUDGET_S });
  assert.deepEqual(seen.map(p => p.processed), [80, 160, 207]);
  assert.deepEqual(r, { ok: true, processed: 207, total: 207, held: 0 });
});

test('a run the schedule is doing right now is waited for, never started a second time', async () => {
  const c = clock(); let reads = 0; let called = 0; const seen = [];
  const readLatestRun = async () => (++reads <= 3 ? run({ status: 'running', pos: reads * 50, total: 207, updated_at: new Date(c.now() - 5000).toISOString() }) : run({ status: 'done' }));
  const r = await refreshLedger({ ...c, readLatestRun, call: async () => { called++; return { ok: true, json: {} }; }, onProgress: p => seen.push(p) });
  assert.equal(called, 0);
  assert.deepEqual(r, { ok: true, joined: true });
  assert.ok(seen.length >= 2 && seen.every(p => p.joined));
});

test('a running run nobody has touched for 3 minutes has stalled: sync continues it', async () => {
  const stalled = run({ status: 'running', updated_at: new Date(NOW - STALE_MS - 1000).toISOString() });
  assert.equal(isBusy(stalled, NOW), false);
  assert.equal(isBusy({ ...stalled, updated_at: new Date(NOW - STALE_MS + 5000).toISOString() }, NOW), true);
  let called = 0;
  const r = await refreshLedger({ ...clock(), readLatestRun: async () => stalled, call: async () => { called++; return { ok: true, json: { finished: true, processed: 50, total: 50, held: 2 } }; } });
  assert.equal(called, 1); assert.equal(r.ok, true); assert.equal(r.held, 2);
});

test('an error from the function (not an admin, a failed run) stops at once and is reported as it is', async () => {
  let called = 0;
  const r = await refreshLedger({ ...clock(), readLatestRun: async () => run(), call: async () => { called++; return { ok: false, json: { error: 'Forbidden: admin only' } }; } });
  assert.equal(called, 1); assert.deepEqual(r, { ok: false, error: 'Forbidden: admin only' });
  const r2 = await refreshLedger({ ...clock(), readLatestRun: async () => run(), call: async () => ({ ok: true, json: { error: 'saving the ledger: boom' } }) });
  assert.equal(r2.ok, false); assert.equal(r2.error, 'saving the ledger: boom');
  const r3 = await refreshLedger({ ...clock(), readLatestRun: async () => run(), call: async () => ({ ok: false, json: {} }) });
  assert.match(r3.error, /failed/);
});

test('a refresh that never says finished gives up after MAX_CALLS instead of looping', async () => {
  let called = 0;
  const r = await refreshLedger({ ...clock(), readLatestRun: async () => run(), call: async () => { called++; return { ok: true, json: { finished: false, processed: called, total: 999 } }; } });
  assert.equal(called, MAX_CALLS); assert.equal(r.ok, false); assert.match(r.error, /longer than expected/);
});

test('someone else\'s run that never ends is given up on after 5 minutes', async () => {
  const c = clock();
  const r = await refreshLedger({ ...c, readLatestRun: async () => run({ status: 'running', updated_at: new Date(c.now() - 1000).toISOString() }), call: async () => { throw new Error('must not be called'); } });
  assert.equal(r.ok, false); assert.match(r.error, /still running/);
});

test('leaving the page stops it between calls', async () => {
  let called = 0;
  const r = await refreshLedger({ ...clock(), readLatestRun: async () => run(), shouldStop: () => called >= 1, call: async () => { called++; return { ok: true, json: { finished: false, processed: 1, total: 9 } }; } });
  assert.equal(called, 1); assert.deepEqual(r, { ok: false, stopped: true });
});

test('the button and the page say plain things', () => {
  assert.equal(progressText(null), 'Refreshing…');
  assert.equal(progressText({ processed: 120, total: 207 }), 'Refreshing… 120 of 207 orders');
  assert.equal(progressText({ processed: 50, total: 207, joined: true }), 'Refresh in progress… 50 of 207 orders');
  assert.equal(doneText({ ok: true, total: 207, held: 0 }), 'Ledger refreshed: 207 orders checked.');
  assert.match(doneText({ ok: true, total: 207, held: 1 }), /1 order is held back/);
  assert.match(doneText({ ok: true, total: 207, held: 3 }), /3 orders are held back/);
  assert.equal(doneText({ ok: true, joined: true }), 'The ledger was already being refreshed and now is.');
  assert.equal(doneText({ ok: false, error: 'Forbidden: admin only' }), 'Forbidden: admin only');
});
