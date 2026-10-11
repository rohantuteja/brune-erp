// Pure helpers for storing the order ledger (migration 017). No network.
//
//   ledgerRow    one order's result → the object ledger_save_orders() saves
//   decideTick   what the scheduled sync should do right now

import type { Facts, OrderLedger } from './ledger.ts';

export type OrderResult = {
  order: string;
  orderId: number;
  facts: Facts;
  notes: string[];
  skip?: string;
  ledger: OrderLedger;
};

export function ledgerRow(r: OrderResult, cutoff: string) {
  const sold = !r.skip;
  return {
    order_name: r.order,
    order_id: r.orderId,
    status: sold ? r.ledger.status : 'not_a_sale',
    net: sold ? r.ledger.net : 0,
    opening: sold ? r.ledger.opening : 0,
    cod_open: sold ? r.ledger.codOpen : 0,
    sale_date: sold ? r.facts.saleDate : null,
    exception_type: sold ? r.ledger.exceptions[0]?.type ?? null : null,
    exceptions: sold ? r.ledger.exceptions : [],
    balancing: sold ? r.ledger.balancing : [],
    notes: sold ? r.notes : [r.skip],
    facts: sold ? r.facts : null,
    entries: sold ? r.ledger.entries.map(e => ({ ...e, exportable: e.date >= cutoff })) : [],
  };
}

export type RunInfo = { kind: string; status: string; startedAt: number; updatedAt: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A chunk takes under two minutes. A running run that was touched more recently than
// this is still being worked on by another call.
export const BUSY_MS = 3 * MINUTE;
export const INCREMENTAL_EVERY_MS = 55 * MINUTE;
export const FULL_EVERY_MS = 23 * HOUR;

// running: the latest run if it is still running, otherwise null.
// lastDone / lastFullDone: when the latest finished run / finished full run started.
export function decideTick(
  now: number,
  running: RunInfo | null,
  lastDoneStartedAt: number | null,
  lastFullDoneStartedAt: number | null,
): 'busy' | 'continue' | 'full' | 'incremental' | 'wait' {
  if (running) return now - running.updatedAt < BUSY_MS ? 'busy' : 'continue';
  if (lastFullDoneStartedAt === null || now - lastFullDoneStartedAt >= FULL_EVERY_MS) return 'full';
  if (lastDoneStartedAt === null || now - lastDoneStartedAt >= INCREMENTAL_EVERY_MS) return 'incremental';
  return 'wait';
}
