import { useSyncExternalStore } from 'react';
import { getState, subscribe } from './ledgerRefreshStore.js';

/** { running, progress, result, reason, finishedAt }: the state of the ledger refresh, shared by every page. */
export const useLedgerRefresh = () => useSyncExternalStore(subscribe, getState);
