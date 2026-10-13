// Pure helpers for storing the order ledger (migration 017). No network.
//
//   ledgerRow    one order's result → the object ledger_save_orders() saves
//   decideTick   what the scheduled sync should do right now (including retrying held-back orders)

import type { Facts, OrderLedger } from './ledger.ts';

export type OrderResult = {
  order: string;
  orderId: number | null;       // Shopify's id; none for a Myntra order
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
    channel: r.facts.channel ?? 'shopify',
    channel_ref: r.facts.channelRef ?? null,
    status: sold ? r.ledger.status : 'not_a_sale',
    net: sold ? r.ledger.net : 0,
    opening: sold ? r.ledger.opening : 0,
    cod_open: sold ? r.ledger.codOpen : 0,
    gateway_open: sold ? r.ledger.gatewayOpen : 0,
    sale_date: sold ? r.facts.saleDate : null,
    state: sold ? r.facts.state?.name ?? null : null,
    state_code: sold ? r.facts.state?.code ?? null : null,
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

// A run that held orders back (an upstream system could not be reached) is followed by a retry of just those orders.
export const RETRY_HELD_EVERY_MS = 10 * MINUTE;

// running: the latest run if it is still running, otherwise null.
// lastDone / lastFullDone: when the latest finished scheduled run / finished full run started (retry runs are not
// scheduled runs and are left out, so a retry never pushes the hourly or nightly run back).
// lastHeld: the latest finished run of any kind, if it held orders back.
export function decideTick(
  now: number,
  running: RunInfo | null,
  lastDoneStartedAt: number | null,
  lastFullDoneStartedAt: number | null,
  lastHeld: { startedAt: number; count: number } | null = null,
): 'busy' | 'continue' | 'full' | 'incremental' | 'retry' | 'wait' {
  if (running) return now - running.updatedAt < BUSY_MS ? 'busy' : 'continue';
  if (lastFullDoneStartedAt === null || now - lastFullDoneStartedAt >= FULL_EVERY_MS) return 'full';
  if (lastDoneStartedAt === null || now - lastDoneStartedAt >= INCREMENTAL_EVERY_MS) return 'incremental';
  if (lastHeld && lastHeld.count > 0 && now - lastHeld.startedAt >= RETRY_HELD_EVERY_MS) return 'retry';
  return 'wait';
}
