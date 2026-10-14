import { supabase } from './supabase';
import { callFunction } from './edgeCall';
import { startRefresh } from './ledgerRefreshStore.js';

const readLatestRun = async () => {
  const { data } = await supabase.from('ledger_runs').select('id, status, pos, total, updated_at').order('started_at', { ascending: false }).limit(1);
  return data?.[0] ?? null;
};

/**
 * Recalculate the ledger now (the accounting-ledger function, admins only). `reason` says what started it ("the GoKwik upload"); the
 * button passes none. Fire and forget: the outcome is in the store and shown by <LedgerRefreshStatus />.
 */
export const refreshLedgerNow = (reason = null) => startRefresh({ reason, call: (body) => callFunction('accounting-ledger', body), readLatestRun });
