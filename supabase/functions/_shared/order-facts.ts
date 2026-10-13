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

import type { Facts, PlaceOfSupply } from './ledger.ts';
import { resolveState } from './gst-states.ts';
import { parseNote } from './shipments.ts';

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

// The state the goods go to. Shopify's shipping address first (it is the delivery address, spelled out); Unicommerce's order
// address second (its invoices carry no state: the sale order's addresses do, `state` a short code and `stateName` the name;
// the shipping address is the one that is not the billing address, and a Myntra order has just one).
function ucPlace(ucOrder: any) {
  const addresses: any[] = ucOrder?.addresses ?? [];
  const billingId = ucOrder?.billingAddress?.id;
  const ship = addresses.find(a => a && billingId != null && String(a.id) !== String(billingId)) ?? addresses[0] ?? ucOrder?.billingAddress;
  return resolveState({ name: ship?.stateName, code: ship?.state });
}
export function placeOfSupply(shopify: any, ucOrder: any): PlaceOfSupply | null {
  const ship = shopify?.shippingAddress;
  const s = resolveState({ name: ship?.province, code: ship?.provinceCode });
  if (s) return { ...s, source: 'shopify' };
  const u = ucPlace(ucOrder);
  return u ? { ...u, source: 'unicommerce' } : null;
}
// Notes about the state a person should know: Shopify and Unicommerce disagree, or the invoice charged the wrong kind of GST.
function stateNotes(state: PlaceOfSupply | null, ucOrder: any, sellerCode: string | undefined, invoiceIgst: boolean | undefined): string[] {
  const out: string[] = [];
  if (!state) { out.push('no state found on the order: it cannot be exported to Tally'); return out; }
  const u = state.source === 'shopify' ? ucPlace(ucOrder) : null;
  if (u && u.code !== state.code) out.push(`Shopify delivers this to ${state.name} but Unicommerce has ${u.name}: ${state.name} is used`);
  if (invoiceIgst !== undefined && sellerCode) {
    const needsIgst = state.code !== sellerCode;
    if (needsIgst !== invoiceIgst) out.push(`the sale invoice charged ${invoiceIgst ? 'IGST' : 'CGST and SGST'} but the goods go to ${state.name}, which needs ${needsIgst ? 'IGST' : 'CGST and SGST'}: check the invoice`);
  }
  return out;
}
const sellerCodeOf = (sellerState: string | undefined) => resolveState({ name: sellerState, code: sellerState })?.code;

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
  remittance?: { utr: string; date: string; amount: number | null } | null;   // the COD money paid by the courier (UTR set)
  gatewayPayouts?: Array<{ date: string; utr: string; gross: number; fee: number; tax: number; net: number; ref?: string }>;   // GoKwik's settlement report rows for this order ([] = none yet; absent = not looked up)
  adjustments?: Array<{ kind: 'goodwill_credit'; amount: number; reason: string; approved_by: string }>;   // ledger_adjustments for this order
};

// skip: not a sale (stored as such); ignore: nothing to store yet (a Myntra order Unicommerce has not invoiced).
export type Built = { facts: Facts; notes: string[]; skip?: string; ignore?: string };

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
  const items: any[] = inv.invoiceItems ?? [];
  const qty = items.reduce((n, i) => n + (Number(i.quantity) || 1), 0);      // pieces; an item without a quantity counts as one
  return { rate, codFee, shipping, goods: r2(total - codFee - shipping), igst, qty };
}

export function buildFacts(inp: RawInputs): Built {
  const o = inp.shopify;
  const notes: string[] = [];
  const tags: string[] = (o.tags ?? []).map((t: string) => t.toLowerCase());
  const txs: any[] = o.transactions ?? [];
  const ucOrder = inp.uc?.order && inp.uc.order.status !== 'CANCELLED' ? inp.uc.order : null;

  const sellerCode = sellerCodeOf(inp.sellerState);

  // An order cancelled before it shipped was never a sale: no invoice, nothing delivered, whatever the customer paid.
  // What is left to decide is the money. Nothing paid, or store credit that all went back to the customer, leaves
  // nothing to book. Money that went through a real gateway, or store credit that did not all come back, is NOT booked
  // automatically: the order is an exception (order 37937 was once booked as a finished sale because it was paid with
  // store credit, which counted as "money moved").
  const shipped = (o.fulfillments ?? []).some((f: any) => (f.trackingInfo ?? []).length) || !!inp.uc?.saleInvoice;
  const refundedOut = sum(txs.filter(t => t.kind === 'REFUND' && t.status === 'SUCCESS').map(t => money(t.amountSet)));
  const returnedToOrigin = tags.includes('rto_delivered') || parseNote(o.note).rto?.state === 'delivered';
  if (o.cancelledAt && !shipped && !returnedToOrigin) {
    const paidIn = txs.filter(t => succeeded(t) && !isCodGateway(t.gateway));
    const viaGateway = [...new Set(paidIn.filter(t => !isStoreCredit(t.gateway)).map(t => String(t.gateway ?? 'gateway')))];
    const paid = sum(paidIn.map(t => money(t.amountSet)));
    const base = { order: String(o.name).replace(/^#/, ''), rate: 0.05, igst: true, goods: 0, codFee: 0, saleDate: istDate(o.createdAt) };
    if (paid <= 0.005) {
      return { facts: base, notes: ['cancelled before dispatch: never a sale'], skip: 'cancelled before dispatch' };
    }
    if (!viaGateway.length && refundedOut >= paid - 0.005) {
      return {
        facts: base,
        notes: [`cancelled before dispatch: never a sale (${paid.toFixed(2)} of store credit was spent and credited back)`],
        skip: 'cancelled before dispatch (store credit spent and credited back)',
      };
    }
    const place = placeOfSupply(o, ucOrder);
    return {
      facts: { ...base, ...(place ? { state: place } : {}), cancelled: { paid, refunded: refundedOut, via: viaGateway.length ? viaGateway : ['store credit'] } },
      notes: ['cancelled before dispatch: never a sale, but the customer had paid'],
    };
  }

  const state = placeOfSupply(o, ucOrder);

  // ── The sale ───────────────────────────────────────────────────────────────
  let rate = 0.05, igst: boolean, goods: number, codFee: number, saleDate: string, saleDoc: string | undefined, invoiceDate: string | undefined, qty: number | undefined;
  const sale = ucOrder ? inp.uc?.saleInvoice : undefined;
  if (sale) {
    const a = invoiceAmounts(sale);
    ({ rate, igst, codFee } = a);
    qty = a.qty;
    goods = a.goods;
    if (a.shipping > 0) {
      notes.push(`the sale invoice has a shipping charge of ${a.shipping.toFixed(2)}; treated as part of the goods`);
      goods = r2(goods + a.shipping);
    }
    // The sale is booked on the day the customer ordered (Shopify, IST): that is the date Shopify's sales report, and so the
    // returns filed from it, use. Unicommerce's invoice keeps its number and amounts here, and its own date is kept as invoiceDate.
    saleDate = istDate(o.createdAt);
    invoiceDate = istDate(Number(sale.created));
    saleDoc = sale.displayCode;
    if (invoiceDate.slice(0, 7) !== saleDate.slice(0, 7)) notes.push(`sale booked on the order date ${saleDate}; the Unicommerce invoice ${saleDoc} is dated ${invoiceDate}, in a later month`);
  } else {
    const ship = money(o.totalShippingPriceSet);
    const cod = (o.paymentGatewayNames ?? []).some((g: string) => /cash_on_delivery|ppcod/i.test(g));
    goods = money(o.subtotalPriceSet);
    codFee = cod ? ship : 0;
    if (!cod && ship > 0) { goods = r2(goods + ship); notes.push('a shipping charge on a prepaid order is treated as part of the goods'); }
    igst = state && sellerCode ? state.code !== sellerCode : (o.shippingAddress?.provinceCode ?? '') !== inp.sellerState;
    saleDate = istDate(o.createdAt);
    const lines: any[] = o.lineItems?.nodes ?? [];
    qty = lines.length ? lines.reduce((n, l) => n + (Number(l.quantity) || 0), 0) : undefined;
    notes.push('no Unicommerce invoice: amounts from Shopify, GST rate assumed 5%');
  }

  // ── How it was settled ─────────────────────────────────────────────────────
  const payments = txs.filter(t => succeeded(t) && !isStoreCredit(t.gateway) && !isCodGateway(t.gateway))
    .map(t => ({ date: istDate(t.processedAt), amount: money(t.amountSet), ref: String(t.id ?? t.gateway), gateway: String(t.gateway ?? '') }));
  const storeCreditUsed = txs.filter(t => succeeded(t) && isStoreCredit(t.gateway))
    .map(t => ({ date: istDate(t.processedAt), amount: money(t.amountSet) }));

  const owedInCash = r2(goods + codFee - sum(payments.map(p => p.amount)) - sum(storeCreditUsed.map(s => s.amount)));
  // Velocity writes "RTO Initiated / In Transit / Delivered on <date>" in the order note and does not always tag the
  // order. The tag still counts; so does a note that says the parcel is back.
  const noteRto = parseNote(o.note).rto;
  const isRto = tags.includes('rto_delivered') || noteRto?.state === 'delivered';
  const rtoOnTheWay = !isRto && (noteRto && noteRto.state !== 'delivered' ? noteRto : tags.includes('rto_initiated') ? { state: 'initiated' as const, on: '' } : null);
  let delivered: Facts['delivered'];
  if (owedInCash > 0.005 && !isRto) {
    const codTx = txs.find(t => succeeded(t) && isCodGateway(t.gateway));
    const date = inp.codDeliveredOn ?? inp.velocityDeliveredOn ?? (codTx ? istDate(codTx.processedAt) : null);
    if (date) {
      const guessed = !inp.codDeliveredOn && !inp.velocityDeliveredOn;
      delivered = { date, amount: owedInCash, ...(guessed ? { estimated: true } : {}) };
      if (guessed) notes.push('delivery date taken from the Shopify payment date');
    }
  }

  // ── Returns ────────────────────────────────────────────────────────────────
  const refunds: any[] = o.refunds ?? [];
  const account = o.customer?.storeCreditAccounts?.nodes?.[0];
  const acctTx: any[] = account?.transactions?.nodes ?? [];
  const ucReturns: any[] = (ucOrder?.returns ?? []).filter((r: any) => r.statusCode !== 'CANCELLED');
  const usedReturns = new Set<string>();
  const ucReturnInvoice = (): { doc: string; goods: number; codFee: number; qty: number; date: string } | undefined => {
    for (const r of ucReturns) {
      if (usedReturns.has(r.code) || !r.returnInvoiceDisplayCode) continue;
      const inv = inp.uc?.returnInvoices[r.code];
      if (!inv) continue;
      usedReturns.add(r.code);
      const a = invoiceAmounts(inv);
      return { doc: inv.displayCode ?? r.returnInvoiceDisplayCode, goods: a.goods, codFee: a.codFee, qty: a.qty, date: istDate(Number(inv.created)) };
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
    const pcsReturned = near.flatMap(r => r.refundLineItems?.nodes ?? []).reduce((n: number, l: any) => n + (Number(l.quantity) || 0), 0);
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
      kind: 'customer', date, goodsReturned, qty: pcsReturned || undefined, pending, refundedOn: istDate(rpAt), returnFee: returnFee || undefined,
      uc: uc ? { doc: uc.doc, goods: uc.goods, codFee: uc.codFee, qty: uc.qty } : undefined, storeCredit,
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
    returns.push({ kind: 'rto', date, goodsReturned: goods, qty, pending, uc: uc ? { doc: uc.doc, goods: uc.goods, codFee: uc.codFee, qty: uc.qty } : undefined, storeCredit });
  }

  notes.push(...stateNotes(state, ucOrder, sellerCode, sale ? igst : undefined));

  return {
    facts: {
      order: String(o.name).replace(/^#/, ''), ...(state ? { state } : {}), rate, igst, goods, codFee, saleDate, saleDoc, qty, invoiceDate, delivered, payments, storeCreditUsed, returns, refundedOut,
      ...(inp.gatewayPayouts ? { gatewayPayouts: inp.gatewayPayouts } : {}),
      rtoOnTheWay: rtoOnTheWay ? { state: rtoOnTheWay.state, since: rtoOnTheWay.on || undefined } : undefined,
      remitted: delivered && inp.remittance ? { date: inp.remittance.date, amount: inp.remittance.amount ?? delivered.amount, utr: inp.remittance.utr } : undefined,
      approved: (inp.adjustments ?? []).map(a => ({ kind: a.kind, amount: Number(a.amount), reason: a.reason, by: a.approved_by })),
    },
    notes,
  };
}

// ── Myntra ────────────────────────────────────────────────────────────────────────────────────
// A Myntra order lives only in Unicommerce (channel MYNTRAPPMP). Everything comes from there: the sale invoice (number,
// amounts, tax) and, when a parcel comes back, the return invoice. Myntra is a marketplace: the invoice is to the END CUSTOMER
// (B2C; the customer's state decides IGST or CGST+SGST), but Myntra collects the payment and pays us later, so the order's
// control account is "Myntra receivable", a clearing account like a gateway's. What Myntra then pays (net of its own fees,
// TCS and TDS) is matched later from its settlement reports, so until then a sold order stays open ("awaiting settlement").
//   - Booked on Myntra's own order time (displayOrderDateTime, IST), like a Shopify order is booked on its order date,
//     but never before `bookFrom` (the first day of the books): September's books had no Myntra sales, so the few
//     orders placed before it are booked on that day.
//   - The order's name is its Unicommerce invoice number (a Myntra order enters the ledger only once it is invoiced).
//   - Myntra's own customer charge (the "GT charge") is not ours and is not on the invoice.

export type MyntraInputs = {
  sellerState?: string;                 // province code of the warehouse, e.g. 'UP' (to check the invoice's kind of GST against the state)
  today: string;                        // IST date
  bookFrom: string;                     // first day of the books (accounting_start_date)
  uc: {
    order: any;                         // Unicommerce saleOrderDTO
    saleInvoice?: any;                  // invoice/details/get → invoice (return: false)
    returnInvoices: Record<string, any>;// by Unicommerce return code → invoice (return: true)
  };
};

export function buildMyntraFacts(inp: MyntraInputs): Built {
  const o = inp.uc.order;
  const notes: string[] = [];
  const code = String(o.code);
  const sale = inp.uc.saleInvoice;
  const name = String(sale?.displayCode ?? (o.shippingPackages ?? []).find((p: any) => p?.invoiceDisplayCode)?.invoiceDisplayCode ?? '');
  const base: Facts = { order: name, channel: 'myntra', channelRef: code, rate: 0.05, igst: true, goods: 0, codFee: 0, saleDate: istDate(Number(o.displayOrderDateTime ?? o.created)) };
  if (!name) return { facts: base, notes: ['no Unicommerce invoice yet: not a sale until it is invoiced'], ignore: 'not invoiced yet' };
  if (o.status === 'CANCELLED') return { facts: base, notes: ['cancelled: never a sale'], skip: 'cancelled' };
  if (!sale) return { facts: base, notes: [`invoice ${name} could not be read from Unicommerce`], ignore: 'invoice unreadable' };

  // ── The sale ───────────────────────────────────────────────────────────────
  const state = placeOfSupply(null, o);
  const a = invoiceAmounts(sale);
  let goods = a.goods;
  if (a.shipping > 0) { notes.push(`the sale invoice has a shipping charge of ${a.shipping.toFixed(2)}; treated as part of the goods`); goods = r2(goods + a.shipping); }
  const ordered = istDate(Number(o.displayOrderDateTime ?? o.created));
  const invoiceDate = istDate(Number(sale.created));
  const saleDate = ordered < inp.bookFrom ? inp.bookFrom : ordered;
  if (saleDate !== ordered) notes.push(`placed on ${ordered}, before the books started: booked on ${saleDate} (the earlier months' books had no Myntra sales)`);
  else if (invoiceDate.slice(0, 7) !== saleDate.slice(0, 7)) notes.push(`sale booked on the order date ${saleDate}; the Unicommerce invoice ${name} is dated ${invoiceDate}, in a later month`);

  // ── Returns ────────────────────────────────────────────────────────────────
  // A "Courier Returned" return is the parcel coming back undelivered (RTO); "Customer Returned" is the customer sending it back.
  // A credit note exists once Unicommerce has received the parcel and issued its return invoice; until then the return is pending.
  const items: any[] = o.saleOrderItems ?? [];
  const returns: NonNullable<Facts['returns']> = [];
  for (const r of (o.returns ?? []).filter((x: any) => x.statusCode !== 'CANCELLED')) {
    const inv = r.returnInvoiceDisplayCode ? inp.uc.returnInvoices[r.code] : undefined;
    const readable = inv && String(inv.displayCode ?? '') === String(r.returnInvoiceDisplayCode);
    if (r.returnInvoiceDisplayCode && !readable) notes.push(`return invoice ${r.returnInvoiceDisplayCode} could not be read from Unicommerce: treated as not received yet`);
    const uc = readable ? invoiceAmounts(inv) : undefined;
    const returned = (r.returnItems ?? []).map((ri: any) => items.find(i => String(i.code) === String(ri.saleOrderItemCode))).filter(Boolean);
    const goodsReturned = r2(sum((returned.length ? returned : items).map((i: any) => Number(i.sellingPrice ?? 0))));
    returns.push({
      kind: /courier/i.test(String(r.type)) ? 'rto' : 'customer',
      date: uc ? istDate(Number(inv.created)) : inp.today,
      goodsReturned, qty: uc?.qty ?? (returned.length || items.length), pending: !uc,
      uc: uc ? { doc: String(inv.displayCode), goods: uc.goods, codFee: uc.codFee, qty: uc.qty } : undefined,
      storeCredit: [],
    });
  }

  notes.push(...stateNotes(state, o, sellerCodeOf(inp.sellerState), a.igst));

  return {
    facts: { ...base, ...(state ? { state } : {}), rate: a.rate, igst: a.igst, goods, codFee: a.codFee, saleDate, saleDoc: name, qty: a.qty, invoiceDate, returns, payments: [], storeCreditUsed: [], approved: [] },
    notes,
  };
}
