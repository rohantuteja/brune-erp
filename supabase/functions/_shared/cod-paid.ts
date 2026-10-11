// When may the ERP mark a COD / PPCOD order paid on Shopify? (cod-paid-on-delivery)
//
// The customer pays the courier on delivery; Velocity pays Brune later in a COD
// remittance. So the order is paid once Velocity reports a delivery date. Pure
// rules, no network — the function feeds in what Shopify and Velocity say.
//
// Accounting cutoff: only parcels delivered on or after `startDate` (app_settings
// accounting_start_date, 2026-10-01) are marked. Earlier deliveries belong to
// months already closed in Tally; Velocity's own mark-paid at remittance still
// handles them, so they are left alone ('baseline').

export type VelocityRow = {
  tracking_number: string;
  delivery_date: string | null;   // YYYY-MM-DD, null until delivered
  cod_amount: number | null;
  remittance_date: string | null; // the scheduled or actual settlement date
  utr_no: string | null;          // set once the money has been paid
  error?: string;
};

export type OrderForPaid = {
  name: string;
  tags: string[];
  cancelled: boolean;
  financialStatus: string;        // Shopify displayFinancialStatus
  gateways: string[];
  outstanding: number;
  awbs: string[];
};

export type PaidDecision =
  | { action: 'mark'; awb: string; deliveredOn: string; codAmount: number }
  | { action: 'wait'; reason: string }                       // not delivered yet / no data yet
  | { action: 'skip'; reason: string }                       // never ours to mark
  | { action: 'baseline'; reason: string; awb: string; deliveredOn: string }
  | { action: 'attention'; reason: string; awb?: string; deliveredOn?: string; codAmount?: number };

const RTO_TAGS = new Set(['rto_initiated', 'rto_delivered']);
const PAYABLE = new Set(['PENDING', 'PARTIALLY_PAID']);
const money = (n: number) => `₹${n.toFixed(2)}`;

export function decideMark(order: OrderForPaid, velocity: VelocityRow | undefined, startDate: string): PaidDecision {
  if (order.cancelled) return { action: 'skip', reason: 'cancelled' };
  if (order.tags.some(t => RTO_TAGS.has(t.trim().toLowerCase()))) return { action: 'skip', reason: 'return to origin, never delivered' };
  if (!PAYABLE.has(order.financialStatus)) return { action: 'skip', reason: `already ${order.financialStatus.toLowerCase()}` };
  if (!(order.outstanding > 0)) return { action: 'skip', reason: 'nothing outstanding' };
  const isCod = order.gateways.some(g => /cash_on_delivery|ppcod/i.test(g));
  if (!isCod) return { action: 'skip', reason: 'not a COD or PPCOD order' };

  if (!order.awbs.length) return { action: 'wait', reason: 'no tracking number yet' };
  if (order.awbs.length > 1) return { action: 'attention', reason: `${order.awbs.length} parcels; mark by hand once all are delivered` };
  const awb = order.awbs[0];

  if (!velocity) return { action: 'wait', reason: 'Velocity has no record of the parcel yet' };
  if (velocity.error) return { action: 'wait', reason: `Velocity: ${velocity.error}` };
  if (!velocity.delivery_date) return { action: 'wait', reason: 'not delivered yet' };

  if (velocity.delivery_date < startDate) {
    return { action: 'baseline', reason: `delivered ${velocity.delivery_date}, before ${startDate}: left to Velocity at remittance`, awb, deliveredOn: velocity.delivery_date };
  }
  // The amount Velocity collected must be what Shopify says is still owed.
  // A mismatch (store credit added later, an edited order) is for a person.
  const cod = velocity.cod_amount;
  if (cod === null || Math.abs(cod - order.outstanding) > 0.01) {
    return {
      action: 'attention', awb, deliveredOn: velocity.delivery_date, codAmount: cod ?? undefined,
      reason: `Velocity collected ${cod === null ? 'an unknown amount' : money(cod)} but Shopify shows ${money(order.outstanding)} outstanding`,
    };
  }
  return { action: 'mark', awb, deliveredOn: velocity.delivery_date, codAmount: cod };
}
