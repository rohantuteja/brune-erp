import test from 'node:test';
import assert from 'node:assert/strict';
import { startRefresh, getState, subscribe, clearResult } from './ledgerRefreshStore.js';

const ok = (total = 207) => ({ ok: true, processed: total, total, held: 0 });
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

test('a refresh shows it is running, passes on progress, and ends with its result and the reason that started it', async () => {
  const seen = [];
  const off = subscribe(() => seen.push({ ...getState() }));
  const r = await startRefresh({ reason: 'the GoKwik upload', run: async ({ onProgress }) => { onProgress({ processed: 80, total: 207 }); return ok(); } });
  off();
  assert.deepEqual(r, ok());
  assert.ok(seen.some(s => s.running && s.reason === 'the GoKwik upload'));
  assert.ok(seen.some(s => s.running && s.progress?.processed === 80));
  const end = getState();
  assert.equal(end.running, false); assert.equal(end.progress, null); assert.deepEqual(end.result, ok()); assert.equal(end.reason, 'the GoKwik upload');
  assert.ok(end.finishedAt > 0);
  clearResult(); assert.equal(getState().result, null);
});

test('a request while one is running does not run alongside it: exactly one more follows, however many came in', async () => {
  const g = gate(); let started = 0; let overlap = 0; let live = 0;
  const run = async () => { started++; live++; overlap = Math.max(overlap, live); if (started === 1) await g.p; live--; return ok(started); };
  const first = startRefresh({ reason: 'the GoKwik upload', run });
  const second = startRefresh({ reason: 'the GoKwik upload', run });
  const third = startRefresh({ reason: 'the Velocity upload', run });
  assert.equal(first, second); assert.equal(second, third);       // one promise: the whole chain
  g.open();
  const r = await first;
  assert.equal(started, 2);                                       // the first, and ONE follow-up for the second and third requests
  assert.equal(overlap, 1);                                       // never two at once
  assert.equal(r.total, 2);                                       // the result is the follow-up's
  assert.equal(getState().reason, 'the Velocity upload');         // the follow-up is the last request's
});

test('a refresh that throws ends as a failed result, and the next one can start', async () => {
  const r = await startRefresh({ run: async () => { throw new Error('You are signed out. Sign in again and retry.'); } });
  assert.deepEqual(r, { ok: false, error: 'You are signed out. Sign in again and retry.' });
  assert.equal(getState().running, false);
  const r2 = await startRefresh({ run: async () => ok() });
  assert.equal(r2.ok, true);
});

test('a failed first refresh still lets the queued one run', async () => {
  const g = gate(); let n = 0;
  const run = async () => { n++; if (n === 1) { await g.p; return { ok: false, error: 'boom' }; } return ok(); };
  const p = startRefresh({ run }); startRefresh({ run }); g.open();
  assert.equal((await p).ok, true); assert.equal(n, 2);
});
