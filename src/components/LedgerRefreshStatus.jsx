import { X } from 'lucide-react';
import { useLedgerRefresh } from '../lib/useLedgerRefresh';
import { clearResult } from '../lib/ledgerRefreshStore';
import { progressText, doneText } from '../lib/ledgerRefresh';

const FRESH_MS = 10 * 60 * 1000;      // a finished message is dropped after this long (the state outlives the page that started it)

// The progress and the outcome of the ledger refresh, the same on every page that can start one (the Refresh now button on
// Analytics → Ledger, and the automatic refresh after a GoKwik or Velocity upload). Shows nothing when idle.
export default function LedgerRefreshStatus() {
  const s = useLedgerRefresh();
  if (s.running) {
    return (
      <div role="status" className="text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded px-3 py-2">
        {progressText(s.progress, s.reason)} <span className="text-stone-500">It runs in the background: you can leave this page.</span>
      </div>
    );
  }
  if (!s.result || Date.now() - (s.finishedAt || 0) > FRESH_MS) return null;
  return (
    <div role="status" className={`text-xs rounded px-3 py-2 border flex items-start justify-between gap-3 ${s.result.ok ? 'text-emerald-900 bg-emerald-50 border-emerald-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
      <span>{doneText(s.result, s.reason)}</span>
      <button type="button" onClick={clearResult} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}
