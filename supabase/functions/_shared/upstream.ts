// Telling "the other system did not answer" from "the other system answered: there is nothing".
// No network here: the caller passes the function that makes the request.
//
// The ledger is rebuilt from scratch on every sync. If a call that failed is read as "no data", an outage rewrites
// good orders as worse ones: on 13 Oct 2026 a Velocity 503 made a full sync save 56 delivered COD orders without
// their remittances. So an order whose inputs could not be had is HELD BACK: not saved, its last rows kept, its
// name and reason recorded on the run, and tried again by the next scheduled run.
//
//   ucUnreachable    Unicommerce: the response is not an answer
//   lookupVelocity   Velocity's COD remittance API, by AWB
//   partitionHeld    split a batch of results into those to save and those held back
//   heldKeys         the orders a finished run held back, to be queued again

export class Unreachable extends Error {
  system: string;
  constructor(system: string, detail: string) {
    super(`${system} could not be reached: ${detail}`);
    this.system = system;
  }
}

// ucPost reports a failed HTTP call as { successful: false, errors: [{ description: "HTTP 503…" }] } and a body it
// cannot read as {}. A real answer, including "no such order" (INVALID_SALE_ORDER_CODE) and "no invoice yet", is a
// parsed response with a boolean `successful`. Returns why the response is not an answer, or null if it is one.
export function ucUnreachable(resp: any): string | null {
  if (typeof resp?.successful !== 'boolean') return 'no usable response';
  if (resp.successful === false) {
    const why = String(resp.errors?.[0]?.description ?? '');
    if (/^HTTP \d{3}/.test(why)) return why;
  }
  return null;
}

export type VelocityRec = { delivery_date: string | null; cod_amount: number | null; remittance_date: string | null; utr_no: string | null };
export type VelocityAsk = (awbs: string[]) => Promise<{ status: number; body: any }>;

// Velocity's COD remittance API: delivery date, COD amount and the remittance (UTR set once paid), 100 parcels a
// call. `ask` makes one call (and keeps to Velocity's rate limit); a 429 is retried once after `pause`. A batch is
// unreachable when the call failed, was refused, or came back without a `data` list (an error body such as
// {"message":"Unauthorized"} is not an answer). A parcel Velocity answers for with an error (a prepaid order)
// is an answer: it has a record with nothing in it.
export async function lookupVelocity(
  awbs: string[], ask: VelocityAsk, pause: (ms: number) => Promise<void>,
): Promise<{ recs: Map<string, VelocityRec>; unreachable: Set<string> }> {
  const recs = new Map<string, VelocityRec>();
  const unreachable = new Set<string>();
  const list = [...new Set(awbs)];
  for (let i = 0; i < list.length; i += 100) {
    const batch = list.slice(i, i + 100);
    let res = await ask(batch);
    if (res.status === 429) { await pause(30_000); res = await ask(batch); }
    const data = res.status >= 200 && res.status < 300 ? res.body?.data : null;
    if (!Array.isArray(data)) { for (const a of batch) unreachable.add(a); continue; }
    for (const r of data) {
      recs.set(String(r.tracking_number), {
        delivery_date: r.delivery_date ?? null, cod_amount: r.cod_amount ?? null,
        remittance_date: r.remittance_date ?? null, utr_no: r.utr_no ?? null,
      });
    }
  }
  return { recs, unreachable };
}

// An order a run could not read all its inputs for. `key` is what the run queue holds for it: the Shopify order id,
// or "M:<Unicommerce code>" for a Myntra order.
export type Held = { key: number | string; order: string; why: string };

export function partitionHeld<T extends { order: string; orderId: number | null; facts: { channelRef?: string }; held?: string }>(
  results: T[],
): { save: T[]; held: Held[] } {
  const save: T[] = [];
  const held: Held[] = [];
  for (const r of results) {
    if (!r.held) { save.push(r); continue; }
    const key = r.orderId ?? (r.facts.channelRef ? `M:${r.facts.channelRef}` : null);
    if (key !== null) held.push({ key, order: r.order, why: r.held });
  }
  return { save, held };
}

// The orders a finished run held back, as queue entries (a run summary is jsonb, so check what is in it).
export function heldKeys(summary: any): Array<number | string> {
  const out: Array<number | string> = [];
  for (const h of Array.isArray(summary?.held) ? summary.held : []) {
    const k = h?.key;
    if (typeof k === 'number' && Number.isFinite(k)) out.push(k);
    else if (typeof k === 'string' && k.startsWith('M:') && k.length > 2) out.push(k);
  }
  return [...new Set(out)];
}
