// Turns what the other systems say about one Shopify order into the Facts the
// ledger (./ledger.ts) works from. Pure mapping, no network: the accounting-ledger
// function fetches the raw data and hands it in.
//
// Sources, and what each one is trusted for:
//   Unicommerce  the sale invoice and the return invoice AMOUNTS (invoice/details/get:
//                total, tax, COD charge), their numbers and dates. Orders placed before
//                29 Sep (or whose Unicommerce copy was cancelled) have no invoice: the
//                amounts then come from Shopify and the ERP issues the documents.
//   Shopify      what was charged, how it was paid, refunds, the customer's store credit.
//   Return Prime what it refunded and when, the return fee, whether the parcel arrived.
//   Velocity     the delivery date of COD parcels (via cod_deliveries or its API).

import type { Facts } from './ledger.ts';

type Return = NonNullable<Facts['returns']>[number];

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
const money = (x: any) => Number(x?.shopMoney?.amount ?? 0);
export const istDate = (t: string | number) => new Date((typeof t === 'number' ? t : Date.parse(t)) + 19_800_000).toISOString().slice(0, 10);

const isStoreCredit = (g: string) => /store.?credit/i.test(g ?? '');
const isCodGateway = (g: string) => /^cash_on_delivery$|^manual$/i.test(g ?? '');
const succeeded = (t: any) => t.status === 'SUCCESS' && (t.kind === 'SALE' || t.kind === 'CAPTURE');

// Credits from just before Return Prime's own credit to a few minutes after
// (GoKwik's second credit lands 5–7 seconds later).
const CREDIT_BEFORE_MS = 30_000;
const CREDIT_AFTER_MS = 10 * 60_000;
// A manual store credit for an RTO is accepted when it is within this much of what the customer paid
// (a person rounds it, or adds a little); further away it is still shown, as a difference to look at.
const MANUAL_CREDIT_RANGE = 250;
// Shopify's refund record lands within seconds of Return Prime's refund.
const REFUND_BEFORE_MS = 2 * 60_000;
const REFUND_AFTER_MS = 10 * 60_000;

export type RawInputs = {
  sellerState: string;                         // province code of the warehouse, e.g. 'UP'
  today: string;                               // IST date, used when a return has no date yet
  shopify: any;                                // the order, as read from Shopify (see accounting-ledger)
  uc: null | {
    order: any;                                // Unicommerce saleOrderDTO
    saleInvoice?: any;                         // invoice/details/get → invoice (return: false)
    returnInvoices: Record<string, any>;       // by Unicommerce return code → invoice (return: true)
  };
  rpRequests: any[];                           // Return Prime requests for this order
  reversalIds?: string[];                      // store credit debits the ERP made to take back a double credit
  codDeliveredOn?: string | null;              // cod_deliveries.delivered_on
  velocityDeliveredOn?: string | null;         // Velocity cod-remittance delivery_date
};

export type Built = { facts: Facts; notes: string[]; skip?: string };

// What an invoice from Unicommerce says, in the ledger's terms (tax-inclusive).
function invoiceAmounts(inv: any) {
  const it = inv.invoiceItems?.[0] ?? {};
  const pct = Number(it.integratedGstPercentage ?? 0) + Number(it.centralGstPercentage ?? 0)
    + Number(it.stateGstPercentage ?? 0) + Number(it.unionTerritoryGstPercentage ?? 0);
  const rate = pct > 0 ? pct / 100 : 0.05;
  const codFee = r2(Number(inv.cashOnDeliveryCharges ?? 0) * (1 + rate));
  const shipping = r2((Number(inv.shippingCharges ?? 0) + Number(inv.shippingMethodCharges ?? 0)) * (1 + rate));
  const total = Number(inv.total ?? 0);
  const igst = Number(inv.integratedGst ?? 0) > 0 || Number(inv.centralGst ?? 0) + Number(inv.stateGst ?? 0) === 0;
  return { rate, codFee, shipping, goods: r2(total - codFee - shipping), igst };
}

export function buildFacts(inp: RawInputs): Built {
  const o = inp.shopify;
  const notes: string[] = [];
  const tags: string[] = (o.tags ?? []).map((t: string) => t.toLowerCase());
  const txs: any[] = o.transactions ?? [];
  const ucOrder = inp.uc?.order && inp.uc.order.status !== 'CANCELLED' ? inp.uc.order : null;

  // An order cancelled before it shipped was never a sale: no invoice, nothing delivered.
  const shipped = (o.fulfillments ?? []).some((f: any) => (f.trackingInfo ?? []).length) || !!inp.uc?.saleInvoice;
  const movedMoney = txs.some(t => succeeded(t) && t.kind !== 'REFUND');
  if (o.cancelledAt && !shipped && !movedMoney && !tags.includes('rto_delivered')) {
    return {
      facts: { order: String(o.name).replace(/^#/, ''), rate: 0.05, igst: true, goods: 0, codFee: 0, saleDate: istDate(o.createdAt) },
      notes: ['cancelled before dispatch: never a sale'], skip: 'cancelled before dispatch',
    };
  }

  // ── The sale ───────────────────────────────────────────────────────────────
  let rate = 0.05, igst: boolean, goods: number, codFee: number, saleDate: string, saleDoc: string | undefined;
  const sale = ucOrder ? inp.uc?.saleInvoice : undefined;
  if (sale) {
    const a = invoiceAmounts(sale);
    ({ rate, igst, codFee } = a);
    goods = a.goods;
    if (a.shipping > 0) {
      notes.push(`the sale invoice has a shipping charge of ${a.shipping.toFixed(2)}; treated as part of the goods`);
      goods = r2(goods + a.shipping);
    }
    saleDate = istDate(Number(sale.created));
    saleDoc = sale.displayCode;
  } else {
    const ship = money(o.totalShippingPriceSet);
    const cod = (o.paymentGatewayNames ?? []).some((g: string) => /cash_on_delivery|ppcod/i.test(g));
    goods = money(o.subtotalPriceSet);
    codFee = cod ? ship : 0;
    if (!cod && ship > 0) { goods = r2(goods + ship); notes.push('a shipping charge on a prepaid order is treated as part of the goods'); }
    igst = (o.shippingAddress?.provinceCode ?? '') !== inp.sellerState;
    saleDate = istDate(o.createdAt);
    notes.push('no Unicommerce invoice: amounts from Shopify, GST rate assumed 5%');
  }

  // ── How it was settled ─────────────────────────────────────────────────────
  const payments = txs.filter(t => succeeded(t) && !isStoreCredit(t.gateway) && !isCodGateway(t.gateway))
    .map(t => ({ date: istDate(t.processedAt), amount: money(t.amountSet), ref: String(t.id ?? t.gateway) }));
  const storeCreditUsed = txs.filter(t => succeeded(t) && isStoreCredit(t.gateway))
    .map(t => ({ date: istDate(t.processedAt), amount: money(t.amountSet) }));

  const owedInCash = r2(goods + codFee - sum(payments.map(p => p.amount)) - sum(storeCreditUsed.map(s => s.amount)));
  const isRto = tags.includes('rto_delivered');
  let delivered: Facts['delivered'];
  if (owedInCash > 0.005 && !isRto) {
    const codTx = txs.find(t => succeeded(t) && isCodGateway(t.gateway));
    const date = inp.codDeliveredOn ?? inp.velocityDeliveredOn ?? (codTx ? istDate(codTx.processedAt) : null);
    if (date) {
      delivered = { date, amount: owedInCash };
      if (!inp.codDeliveredOn && !inp.velocityDeliveredOn) notes.push('delivery date taken from the Shopify payment date');
    }
  }

  // ── Returns ────────────────────────────────────────────────────────────────
  const refunds: any[] = o.refunds ?? [];
  const account = o.customer?.storeCreditAccounts?.nodes?.[0];
  const acctTx: any[] = account?.transactions?.nodes ?? [];
  const ucReturns: any[] = (ucOrder?.returns ?? []).filter((r: any) => r.statusCode !== 'CANCELLED');
  const usedReturns = new Set<string>();
  const ucReturnInvoice = (): { doc: string; goods: number; codFee: number; date: string } | undefined => {
    for (const r of ucReturns) {
      if (usedReturns.has(r.code) || !r.returnInvoiceDisplayCode) continue;
      const inv = inp.uc?.returnInvoices[r.code];
      if (!inv) continue;
      usedReturns.add(r.code);
      const a = invoiceAmounts(inv);
      return { doc: inv.displayCode ?? r.returnInvoiceDisplayCode, goods: a.goods, codFee: a.codFee, date: istDate(Number(inv.created)) };
    }
    return undefined;
  };
  const ucOpenReturn = () => ucReturns.some((r: any) => !r.returnInvoiceDisplayCode);

  const returns: Return[] = [];

  // Customer returns: one per Return Prime request that refunded something.
  for (const rq of inp.rpRequests) {
    const lines = (rq.line_items ?? []).filter((l: any) => l.refund?.status === 'refunded' && l.refund?.refunded_at);
    if (!lines.length) continue;
    const rpRefunded = sum(lines.map((l: any) => Number(l.refund.refunded_amount?.shop_money?.amount ?? 0)));
    const rpAt: string = lines.map((l: any) => l.refund.refunded_at as string).sort()[0];
    const at = Date.parse(rpAt);
    const returnFee = sum(lines.map((l: any) => Number(l.return_fee?.price_set?.shop_money?.amount ?? 0)));

    // The refund Shopify recorded for this return: goods returned, and any part sent to store credit.
    const near = refunds.filter(r => { const t = Date.parse(r.createdAt); return t >= at - REFUND_BEFORE_MS && t <= at + REFUND_AFTER_MS; });
    const goodsFromShopify = sum(near.flatMap(r => (r.refundLineItems?.nodes ?? []).map((n: any) => money(n.subtotalSet))));
    const goodsReturned = goodsFromShopify > 0 ? goodsFromShopify : r2(rpRefunded + returnFee);
    if (goodsFromShopify <= 0) notes.push(`return ${rq.request_number}: no Shopify refund on the order, goods returned taken from Return Prime's refund plus fee`);
    // Store credit actually on the account for this return, and anything since taken back.
    const storeCredit: Array<{ date: string; amount: number; ref: string }> = [];
    for (const t of acctTx) {
      const when = Date.parse(t.createdAt);
      const amt = Number(t.amount?.amount ?? 0);
      if (t.__typename === 'StoreCreditAccountCreditTransaction' && when >= at - CREDIT_BEFORE_MS && when <= at + CREDIT_AFTER_MS) {
        storeCredit.push({ date: istDate(t.createdAt), amount: amt, ref: `credit ${t.createdAt}` });
      } else if (t.__typename === 'StoreCreditAccountDebitTransaction' && when > at && t.id && (inp.reversalIds ?? []).includes(String(t.id))) {
        // Only a debit the ERP itself made counts: a customer spending the credit looks the same.
        storeCredit.push({ date: istDate(t.createdAt), amount: amt, ref: `reversal ${t.createdAt}` });
      }
    }

    const uc = ucOrder ? ucReturnInvoice() : undefined;
    const receivedAt: string | undefined = rq.received?.status ? rq.received.created_at : undefined;
    // A credit note is due once the parcel is back. Unicommerce issues its own when it
    // receives the return; without Unicommerce, Return Prime's receipt date is the date.
    const pending = uc ? false : ucOrder ? ucOpenReturn() || !receivedAt : !receivedAt;
    const date = uc?.date ?? (receivedAt ? istDate(receivedAt) : istDate(rpAt));
    returns.push({
      kind: 'customer', date, goodsReturned, pending, refundedOn: istDate(rpAt), returnFee: returnFee || undefined,
      uc: uc ? { doc: uc.doc, goods: uc.goods, codFee: uc.codFee } : undefined, storeCredit,
    });
  }

  // Returned to origin: the whole order comes back, nothing was delivered.
  if (isRto) {
    const uc = ucOrder ? ucReturnInvoice() : undefined;
    const cancelledAt: string | undefined = o.cancelledAt ?? undefined;
    const pending = ucOrder ? !uc : false;
    // The courier's note on the order says when the parcel got back ("RTO Delivered on 2026-10-03 16:04:38").
    const rtoDay: string | undefined = /RTO Delivered on (\d{4}-\d{2}-\d{2})/i.exec(String(o.note ?? ''))?.[1];
    const date = uc?.date ?? rtoDay ?? (cancelledAt ? istDate(cancelledAt) : inp.today);
    // Paid orders are refunded to store credit when the ERP cancels the RTO.
    const rf = refunds[0];
    const storeCredit: Array<{ date: string; amount: number; ref: string }> = [];
    if (rf) {
      const at = Date.parse(rf.createdAt);
      for (const t of acctTx) {
        const when = Date.parse(t.createdAt);
        if (t.__typename === 'StoreCreditAccountCreditTransaction' && when >= at - CREDIT_BEFORE_MS && when <= at + CREDIT_AFTER_MS) {
          storeCredit.push({ date: istDate(t.createdAt), amount: Number(t.amount?.amount ?? 0), ref: `credit ${t.createdAt}` });
        }
      }
    }
    // No refund on the order (parcels returned before the ERP handled RTOs): look for a credit a person
    // gave by hand after the parcel came back. The closest to what the customer paid is taken.
    const paidTotal = sum([...payments.map(p => p.amount), ...storeCreditUsed.map(s => s.amount)]);
    if (!storeCredit.length && paidTotal > 0) {
      const since = rtoDay ? Date.parse(`${rtoDay}T00:00:00+05:30`) : Date.parse(o.createdAt);
      const candidates = acctTx
        .filter(t => t.__typename === 'StoreCreditAccountCreditTransaction' && Date.parse(t.createdAt) >= since
          && Math.abs(Number(t.amount?.amount ?? 0) - paidTotal) <= MANUAL_CREDIT_RANGE)
        .sort((a, b) => Math.abs(Number(a.amount.amount) - paidTotal) - Math.abs(Number(b.amount.amount) - paidTotal) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const t = candidates[0];
      if (t) {
        storeCredit.push({ date: istDate(t.createdAt), amount: Number(t.amount.amount), ref: `manual credit ${t.createdAt}` });
        notes.push(`store credit of ${Number(t.amount.amount).toFixed(2)} was given by hand on ${istDate(t.createdAt)}`);
      }
    }
    returns.push({ kind: 'rto', date, goodsReturned: goods, pending, uc: uc ? { doc: uc.doc, goods: uc.goods, codFee: uc.codFee } : undefined, storeCredit });
  }

  return {
    facts: { order: String(o.name).replace(/^#/, ''), rate, igst, goods, codFee, saleDate, saleDoc, delivered, payments, storeCreditUsed, returns },
    notes,
  };
}
