// One ledger refresh at a time in this browser tab, whichever page started it (the Refresh now button, or an upload on Bank & card or
// Velocity). It lives here rather than in a component so that leaving the page does not cut it off, and so every page can show the
// same progress. Nothing here touches the network: `run` is ledgerRefresh.refreshLedger with the real calls passed in by
// ledgerRefreshNow.js. Tested in ledgerRefreshStore.test.js.
//
// A request that arrives while a refresh is running means something changed again (a second upload): the running one may have read
// its inputs before that, so exactly one more refresh follows it, however many requests came in meanwhile.
import { refreshLedger } from './ledgerRefresh.js';

let state = { running: false, progress: null, result: null, reason: null, finishedAt: null };
const listeners = new Set();
let current = null;
let again = null;

export const getState = () => state;
export const subscribe = (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };

/** Forget the last result (the user dismissed the message). */
export const clearResult = () => set({ result: null });

/** Start a refresh, or queue one more behind the running one. Resolves with the outcome of the last refresh; never rejects. */
export function startRefresh(request) {
  if (current) { again = request; return current; }
  current = loop(request);
  return current;
}

async function loop(first) {
  let next = first;
  let result = null;
  let reason = null;
  while (next) {
    again = null;
    reason = next.reason ?? null;
    set({ running: true, progress: null, result: null, reason });
    try {
      result = await (next.run || refreshLedger)({ call: next.call, readLatestRun: next.readLatestRun, onProgress: (progress) => set({ progress }) });
    } catch (err) {
      result = { ok: false, error: err?.message || 'The refresh failed. Try again in a minute.' };
    }
    next = again;
  }
  set({ running: false, progress: null, result, reason, finishedAt: Date.now() });
  current = null;
  return result;
}
