// Cancelling an RTO order on Shopify and giving the customer back what they paid, as
// store credit. The same steps as shopify-order-webhook's automatic RTO handling
// (handleRto → cancelOnShopify): the shipment is cancelled first, because Shopify refuses
// to cancel an order whose shipment is active ("Cannot cancel an order that has outstanding
// fulfillments") and Velocity never closes the shipment on an RTO; then the order is
// cancelled with no restock, the customer is emailed, and everything still paid is
// refunded to store credit with no expiry (prepaid money, a part-payment such as the
// ₹199 PPCOD advance, and store credit spent at checkout). Neither step changes stock.
//
// Used by the rto-cancel function. The webhook keeps its own copy of these four functions;
// they must stay the same.

import { type Ctx, gql } from './shopify-admin.ts';

// What's paid and shipped on an order, from Shopify. paid = still held on the
// order (received minus refunded).
export type PaymentInfo = { cancelled: boolean; customerId: string | null; received: number; paid: number; activeFulfillments: string[] };

export async function paymentInfo(ctx: Ctx, orderId: number): Promise<PaymentInfo> {
  const r = await gql(ctx, `query($id: ID!) {
    order(id: $id) {
      cancelledAt
      customer { id }
      totalReceivedSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      fulfillments(first: 20) { id status }
    }
  }`, { id: `gid://shopify/Order/${orderId}` });
  const o = r.data?.order;
  if (!o) throw new Error(`Shopify order ${orderId} not found${r.errors ? `: ${JSON.stringify(r.errors)}` : ''}`);
  const received = Number(o.totalReceivedSet?.shopMoney?.amount ?? 0);
  const refunded = Number(o.totalRefundedSet?.shopMoney?.amount ?? 0);
  return {
    cancelled: !!o.cancelledAt,
    customerId: o.customer?.id ?? null,
    received,
    paid: Math.round((received - refunded) * 100) / 100,
    activeFulfillments: (o.fulfillments ?? []).filter((f: any) => f.status === 'SUCCESS').map((f: any) => f.id),
  };
}

export type CancelOutcome = { cancel_status: string; credit_status: string; credit_amount: number | null; notes: string[] };

// Cancel an RTO order on Shopify: no restock, customer emailed, and anything
// paid refunded to store credit by the cancel itself. Orders with money on
// them get their active shipments cancelled first, or Shopify refuses.
export async function cancelOnShopify(ctx: Ctx, orderId: number, enabled: boolean): Promise<CancelOutcome> {
  const o = await paymentInfo(ctx, orderId);
  const credit_amount = o.paid > 0 ? o.paid : null;
  const nothingToRefund = o.received > 0 ? 'already_refunded' : 'not_prepaid';

  if (o.cancelled) {
    return o.paid > 0
      ? { cancel_status: 'already_cancelled', credit_status: 'needs_review', credit_amount,
          notes: [`credit: order was already cancelled with ₹${o.paid} paid and not refunded`] }
      : { cancel_status: 'already_cancelled', credit_status: nothingToRefund, credit_amount, notes: [] };
  }
  if (!enabled) {
    return { cancel_status: 'disabled', credit_status: o.paid > 0 ? 'disabled' : nothingToRefund, credit_amount,
      notes: o.paid > 0 ? [`RTO Shopify actions are off: not cancelled, ₹${o.paid} not refunded`] : [] };
  }
  if (o.paid <= 0) {
    const err = await cancelOrder(ctx, orderId, false);
    return { cancel_status: err ? 'failed' : 'cancelled', credit_status: nothingToRefund, credit_amount,
      notes: err ? [`cancel: ${err}`] : [] };
  }

  if (!o.customerId) {
    return { cancel_status: 'failed', credit_status: 'needs_review', credit_amount,
      notes: [`cancel: not attempted — ₹${o.paid} was paid but the order has no customer to give store credit to`] };
  }
  for (const id of o.activeFulfillments) {
    const err = await cancelFulfillment(ctx, id);
    if (err) {
      return { cancel_status: 'failed', credit_status: 'needs_review', credit_amount,
        notes: [`cancel: the shipment could not be cancelled: ${err}`] };
    }
  }
  const err = await cancelOrder(ctx, orderId, true);
  if (err) return { cancel_status: 'failed', credit_status: 'needs_review', credit_amount, notes: [`cancel: ${err}`] };

  // Shopify cancels (and refunds) in a background job: confirm both happened.
  for (let i = 0; i < 6; i++) {
    await new Promise(ok => setTimeout(ok, 2000));
    const after = await paymentInfo(ctx, orderId);
    if (after.cancelled && after.paid <= 0) {
      return { cancel_status: 'cancelled', credit_status: 'issued', credit_amount, notes: [] };
    }
  }
  return { cancel_status: 'cancelled', credit_status: 'unknown', credit_amount,
    notes: [`credit: cancel accepted, but the ₹${o.paid} store credit refund wasn't confirmed within 12 s — check the order`] };
}

// Cancel without restock; Shopify emails the customer. With refundToStoreCredit
// everything still paid is refunded to store credit (no expiry); otherwise
// nothing is refunded. Returns an error or null.
async function cancelOrder(ctx: Ctx, orderId: number, refundToStoreCredit: boolean): Promise<string | null> {
  try {
    const r = await gql(ctx, `mutation($id: ID!, $note: String, $refundMethod: OrderCancelRefundMethodInput!) {
      orderCancel(orderId: $id, reason: OTHER, restock: false, notifyCustomer: true,
        refundMethod: $refundMethod, staffNote: $note) {
        orderCancelUserErrors { message }
      }
    }`, {
      id: `gid://shopify/Order/${orderId}`,
      note: refundToStoreCredit
        ? 'RTO delivered — paid amount refunded to store credit, cancelled by Brune ERP'
        : 'RTO delivered — cancelled by Brune ERP',
      refundMethod: refundToStoreCredit ? { storeCreditRefund: {} } : { originalPaymentMethodsRefund: false },
    });
    const errs = [...(r.data?.orderCancel?.orderCancelUserErrors ?? []), ...(r.errors ?? [])];
    return errs.length ? errs.map((e: any) => e.message).join('; ') : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Cancel one shipment (fulfillment). Doesn't change Shopify stock. Returns an error or null.
async function cancelFulfillment(ctx: Ctx, fulfillmentId: string): Promise<string | null> {
  try {
    const r = await gql(ctx, `mutation($id: ID!) {
      fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { message } }
    }`, { id: fulfillmentId });
    const errs = [...(r.data?.fulfillmentCancel?.userErrors ?? []), ...(r.errors ?? [])];
    return errs.length ? errs.map((e: any) => e.message).join('; ') : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// What cancelOnShopify would do, for the dry runs.
export async function describeCancel(ctx: Ctx, orderId: number) {
  const o = await paymentInfo(ctx, orderId);
  if (o.cancelled) {
    return { cancel: 'already cancelled', refund: o.paid > 0 ? `₹${o.paid} paid and not refunded — needs a person` : 'nothing to refund' };
  }
  if (o.paid <= 0) {
    return { cancel: 'cancel the order (no restock, customer emailed)', refund: o.received > 0 ? 'already refunded' : 'nothing paid' };
  }
  if (!o.customerId) return { cancel: 'not possible', refund: `₹${o.paid} paid but no customer to give store credit to` };
  return {
    cancel: `cancel ${o.activeFulfillments.length} active shipment(s), then cancel the order (no restock, customer emailed)`,
    refund: `₹${o.paid} to store credit, no expiry`,
  };
}

// ── Guard against crediting twice ─────────────────────────────────────────────

export type CreditTx = { kind: string; amount: number; at: string };

// A credit on the customer's account since the order was placed that is close to what is
// still held on the order: someone already gave it by hand. Returns that credit, if any.
export function earlierCredit(txs: CreditTx[], paid: number, orderCreatedAt: string, range = 250): CreditTx | undefined {
  const since = Date.parse(orderCreatedAt);
  return txs
    .filter(t => /CreditTransaction$/.test(t.kind) && Date.parse(t.at) >= since && Math.abs(t.amount - paid) <= range)
    .sort((a, b) => Math.abs(a.amount - paid) - Math.abs(b.amount - paid))[0];
}

export async function creditsSince(ctx: Ctx, orderId: number): Promise<{ createdAt: string; txs: CreditTx[] }> {
  const r = await gql(ctx, `query($id: ID!) {
    order(id: $id) {
      createdAt
      customer { storeCreditAccounts(first: 5) { nodes { transactions(first: 50, reverse: true) { nodes { __typename amount { amount } createdAt } } } } }
    }
  }`, { id: `gid://shopify/Order/${orderId}` });
  const o = r.data?.order;
  if (!o) throw new Error(`Shopify order ${orderId} not found`);
  const txs: CreditTx[] = (o.customer?.storeCreditAccounts?.nodes ?? [])
    .flatMap((a: any) => a.transactions?.nodes ?? [])
    .map((t: any) => ({ kind: String(t.__typename), amount: Number(t.amount?.amount ?? 0), at: t.createdAt }));
  return { createdAt: o.createdAt, txs };
}
