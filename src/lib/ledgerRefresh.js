// "Refresh now" on Analytics → Ledger: ask the accounting-ledger function to recalculate the ledger now, the same incremental
// run the hourly schedule does, instead of waiting for the schedule. Pure logic with the network and the clock passed in, so
// it is tested without either (ledgerRefresh.test.js).
//
// - A run the schedule (or a colleague) is already doing is waited for, never started twice.
// - Otherwise `sync` is called until it says it has finished; each call works for a bounded time and returns how far it got.
// - A run nobody has touched for STALE_MS has stalled: `sync` continues it (the function does the same).

export const STALE_MS = 3 * 60 * 1000;      // the function's BUSY_MS: a running run untouched this long is continued
export const BUDGET_S = 40;                 // seconds of work per call, so progress shows every 40 s or so
export const MAX_CALLS = 12;                // 12 × 40 s: far more than a refresh needs; stops a loop that never finishes
export const POLL_MS = 3000;
export const MAX_WAIT_MS = 5 * 60 * 1000;   // how long to wait for someone else's run

/** A run that is going on right now (touched within STALE_MS). */
export const isBusy = (run, nowMs) => !!run && run.status === 'running' && nowMs - Date.parse(run.updated_at) < STALE_MS;

/**
 * call({ action, kind, budget_s }) -> { ok, json }       readLatestRun() -> the newest ledger_runs row or null
 * onProgress({ processed, total, joined }) is told how far it got. Resolves { ok, ... }; never throws for a failed refresh.
 */
export async function refreshLedger({ call, readLatestRun, onProgress = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = Date.now, shouldStop = () => false }) {
  let run = await readLatestRun();
  if (isBusy(run, now())) {
    const until = now() + MAX_WAIT_MS;
    while (isBusy(run, now())) {
      if (shouldStop()) return { ok: false, stopped: true };
      if (now() > until) return { ok: false, error: 'A refresh is still running. It keeps going in the background; reload in a minute.' };
      onProgress({ processed: run.pos, total: run.total, joined: true });
      await sleep(POLL_MS);
      run = await readLatestRun();
    }
    return { ok: true, joined: true };
  }

  for (let i = 0; i < MAX_CALLS; i++) {
    if (shouldStop()) return { ok: false, stopped: true };
    const { ok, json } = await call({ action: 'sync', kind: 'incremental', budget_s: BUDGET_S });
    if (!ok || json?.error) return { ok: false, error: json?.error || 'The refresh failed. Try again in a minute.' };
    onProgress({ processed: json.processed, total: json.total });
    if (json.finished) return { ok: true, processed: json.processed, total: json.total, held: json.held ?? 0 };
  }
  return { ok: false, error: 'The refresh is taking longer than expected. It keeps going in the background; reload in a minute.' };
}

/** What the button says while it works. */
export function progressText(p) {
  if (!p || !p.total) return 'Refreshing…';
  return `${p.joined ? 'Refresh in progress' : 'Refreshing'}… ${p.processed ?? 0} of ${p.total} orders`;
}

/** What the page says when it is done. */
export function doneText(r) {
  if (!r.ok) return r.error || 'The refresh failed.';
  if (r.joined) return 'The ledger was already being refreshed and now is.';
  const held = r.held ? `; ${r.held} ${r.held === 1 ? 'order is' : 'orders are'} held back because Velocity or Unicommerce could not be reached` : '';
  return `Ledger refreshed: ${r.total} orders checked${held}.`;
}
