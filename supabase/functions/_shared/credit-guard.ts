// Did a Return Prime return put too much store credit on a customer's account?
// (store-credit-guard)
//
// What happens (Oct 2026, orders 36791 and 37613): on a COD order Return Prime
// credits the customer by hand with the full refund (goods minus the ₹99 return
// fee) and ALSO records a Shopify refund for each way the order was paid. The
// part paid with "Shopify Store Credits" is a real credit: GoKwik adds it to the
// account a few seconds later. The customer ends up with the refund plus the
// store credit they had spent at checkout.
//
//   Return Prime credits   R   (its own record: refund.refunded_amount)
//   Shopify refund to the store-credit payment method   S
//   credits that actually landed around the refund      T = R + S
//   excess = T − R = S
//
// Pure rules, no network. The function feeds in Return Prime's amount, Shopify's
// refund and the customer's credit transactions.

export type Credit = { amount: number; at: string };   // at: ISO timestamp

export type GuardInput = {
  rpRefunded: number;          // Return Prime's refunded amount for the request
  rpRefundedAt: string;        // ISO
  storeCreditRefund: number;   // Shopify refund transactions on the store-credit gateway, near the refund
  credits: Credit[];           // every credit transaction on the account
  balance: number;             // account balance now
};

export type GuardDecision =
  | { action: 'ok'; reason: string; credited: number; excess: 0 }
  | { action: 'reverse'; reason: string; credited: number; excess: number }
  | { action: 'flag'; reason: string; credited: number; excess: number };

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `₹${n.toFixed(2)}`;

// Credits belong to this return if they land from just before Return Prime's own
// credit to a few minutes after (GoKwik's came 5–7 seconds later).
const BEFORE_MS = 30_000;
const AFTER_MS = 10 * 60_000;

export function evaluateReturn(inp: GuardInput): GuardDecision {
  const at = Date.parse(inp.rpRefundedAt);
  const credited = round2(inp.credits
    .filter(c => { const t = Date.parse(c.at); return t >= at - BEFORE_MS && t <= at + AFTER_MS; })
    .reduce((sum, c) => sum + c.amount, 0));

  if (inp.storeCreditRefund < 0.01) {
    return { action: 'ok', reason: 'no refund went to the store-credit payment method, so there is one credit', credited, excess: 0 };
  }
  const excess = round2(credited - inp.rpRefunded);
  if (excess < 0.01) {
    return { action: 'ok', reason: `credits (${money(credited)}) match the refund (${money(inp.rpRefunded)})`, credited, excess: 0 };
  }
  if (Math.abs(excess - inp.storeCreditRefund) > 0.01) {
    return {
      action: 'flag', credited, excess,
      reason: `${money(excess)} more than the refund was credited, which is not the store-credit refund of ${money(inp.storeCreditRefund)}; check by hand`,
    };
  }
  if (inp.balance + 0.005 < excess) {
    return {
      action: 'flag', credited, excess,
      reason: `${money(excess)} too much was credited but the balance is only ${money(inp.balance)}; the customer has already spent part of it`,
    };
  }
  return { action: 'reverse', credited, excess, reason: `${money(excess)} credited twice: Return Prime's ${money(inp.rpRefunded)} plus the ${money(inp.storeCreditRefund)} store-credit refund` };
}
