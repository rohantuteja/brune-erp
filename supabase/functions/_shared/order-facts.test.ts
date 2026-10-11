// Run: node --test supabase/functions/_shared/order-facts.test.ts
// Raw inputs are shaped from the real Shopify / Unicommerce / Return Prime responses
// for orders 37807, 37707, 37613 and 37605 (Oct 2026), run through the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, istDate, type RawInputs } from './order-facts.ts';
import { buildOrderLedger } from './ledger.ts';

const CUTOFF = '2026-10-01';
const m = (amount: number) => ({ shopMoney: { amount: String(amount) } });
const ucInvoice = (code: string, created: number, total: number, igst: number, cod: number) => ({
  displayCode: code, created, total, integratedGst: igst, centralGst: 0, stateGst: 0, cashOnDeliveryCharges: cod, shippingCharges: 0, shippingMethodCharges: 0,
  invoiceItems: [{ integratedGstPercentage: 5, centralGstPercentage: 0, stateGstPercentage: 0, unionTerritoryGstPercentage: 0 }],
});
const rpRequest = (num: string, refunded: number, at: string, fee: number, received?: string) => ({
  request_number: num,
  line_items: [{ refund: { status: 'refunded', refunded_at: at, refunded_amount: { shop_money: { amount: refunded } } }, return_fee: { price_set: { shop_money: { amount: fee } } } }],
  received: received ? { status: true, created_at: received } : { status: false },
});
const ledger = (b: ReturnType<typeof buildFacts>) => buildOrderLedger(b.facts, { cutoff: CUTOFF });

test('IST dates: 18:32 UTC on 4 Oct is already 5 Oct in India', () => {
  assert.equal(istDate('2026-10-04T18:32:18Z'), '2026-10-05');
  assert.equal(istDate(1791169865000), '2026-10-05');
});

test('37807: prepaid return with Unicommerce invoices → balanced, amounts read from Unicommerce', () => {
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12',
    shopify: {
      name: '37807', createdAt: '2026-10-04T18:32:18Z', tags: ['Return', 'UPI'], paymentGatewayNames: ['Gokwik UPI', 'shopify_store_credit'],
      subtotalPriceSet: m(1139.15), totalShippingPriceSet: m(0), shippingAddress: { provinceCode: 'DL' },
      transactions: [
        { id: 't1', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1139.15), processedAt: '2026-10-04T18:32:18Z' },
        { id: 't2', kind: 'REFUND', status: 'SUCCESS', gateway: 'shopify_store_credit', amountSet: m(1040.15), processedAt: '2026-10-07T07:03:37Z' }],
      refunds: [{ createdAt: '2026-10-07T07:03:38Z', refundLineItems: { nodes: [{ subtotalSet: m(1139.15) }] },
        transactions: { nodes: [{ kind: 'REFUND', gateway: 'shopify_store_credit', amountSet: m(1040.15) }] } }],
      customer: { storeCreditAccounts: { nodes: [{ transactions: { nodes: [
        { __typename: 'StoreCreditAccountCreditTransaction', amount: { amount: '1040.15' }, createdAt: '2026-10-07T07:03:37Z' }] } }] } },
    },
    uc: {
      order: { status: 'COMPLETE', returns: [{ code: 'BRUN00177', statusCode: 'RETURNED', returnInvoiceDisplayCode: 'ISR0004' }] },
      saleInvoice: ucInvoice('INS0106', 1791169865000, 1139.15, 54.25, 0),
      returnInvoices: { BRUN00177: ucInvoice('ISR0004', 1791667081000, 1139.15, 54.25, 0) },
    },
    rpRequests: [rpRequest('RET737', 1040.15, '2026-10-07T07:03:39.601Z', 99, '2026-10-10T20:00:00Z')],
  };
  const b = buildFacts(raw);
  assert.equal(b.facts.saleDoc, 'INS0106');
  assert.equal(b.facts.goods, 1139.15); assert.equal(b.facts.codFee, 0);
  assert.equal(b.facts.returns![0].uc!.doc, 'ISR0004');
  assert.equal(b.facts.returns![0].returnFee, 99);
  const l = ledger(b);
  assert.equal(l.balanced, true); assert.equal(l.net, 0);
});

test('37707: COD return to origin, Unicommerce return invoice leaves out the COD charge → ERP credit note of 100', () => {
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12',
    shopify: {
      name: '37707', createdAt: '2026-09-29T16:35:00Z', cancelledAt: '2026-10-07T20:00:00Z', tags: ['COD', 'rto_delivered'], paymentGatewayNames: ['cash_on_delivery'],
      subtotalPriceSet: m(1399), totalShippingPriceSet: m(100), shippingAddress: { provinceCode: 'DL' },
      transactions: [{ id: 't1', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1499), processedAt: '2026-09-29T16:35:00Z' }],
      refunds: [], customer: null,
    },
    uc: {
      order: { status: 'COMPLETE', returns: [{ code: 'BRUN00029', statusCode: 'RETURNED', returnInvoiceDisplayCode: 'ISR0001' }] },
      saleInvoice: ucInvoice('INS0006', 1790749452000, 1499, 71.38, 95.24),
      returnInvoices: { BRUN00029: ucInvoice('ISR0001', 1791404365000, 1399, 66.62, 0) },
    },
    rpRequests: [],
  };
  const b = buildFacts(raw);
  assert.equal(b.facts.goods, 1399); assert.equal(b.facts.codFee, 100);        // split read from the invoice
  assert.equal(b.facts.delivered, undefined);                                   // never delivered
  const r = b.facts.returns![0];
  assert.equal(r.kind, 'rto'); assert.equal(r.uc!.goods, 1399); assert.equal(r.uc!.codFee, 0);
  const l = ledger(b);
  assert.equal(l.balanced, true);
  assert.deepEqual(l.balancing.map(x => x.type), ['credit_note_cod_fee']);
});

test('37613: before Unicommerce, store credit given twice and then taken back → balanced', () => {
  const credit = (amount: number, at: string) => ({ __typename: 'StoreCreditAccountCreditTransaction', amount: { amount: String(amount) }, createdAt: at });
  const debit = (amount: number, at: string, id?: string) => ({ __typename: 'StoreCreditAccountDebitTransaction', id, amount: { amount: String(-amount) }, createdAt: at });
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12', uc: null, velocityDeliveredOn: '2026-09-28', reversalIds: ['erp-reversal'],
    shopify: {
      name: '37613', createdAt: '2026-09-25T09:24:17Z', tags: ['COD', 'Return', 'StoreCredits'], paymentGatewayNames: ['cash_on_delivery', 'Shopify Store Credits'],
      subtotalPriceSet: m(1599), totalShippingPriceSet: m(100), shippingAddress: { provinceCode: 'DL' },
      transactions: [
        { id: 'a', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(358.9), processedAt: '2026-09-25T09:24:17Z' },
        { id: 'b', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Shopify Store Credits', amountSet: m(1340.1), processedAt: '2026-09-25T09:24:17Z' },
        { id: 'c', kind: 'REFUND', status: 'SUCCESS', gateway: 'Shopify Store Credits', amountSet: m(1340.1), processedAt: '2026-10-02T20:00:05Z' }],
      refunds: [{ createdAt: '2026-10-02T20:00:05Z', refundLineItems: { nodes: [{ subtotalSet: m(1599) }] },
        transactions: { nodes: [{ kind: 'REFUND', gateway: 'Shopify Store Credits', amountSet: m(1340.1) }] } }],
      customer: { storeCreditAccounts: { nodes: [{ transactions: { nodes: [
        credit(1340.1, '2026-09-17T04:58:27Z'), debit(1340.1, '2026-09-25T09:24:18Z'),
        credit(1500, '2026-10-02T20:00:03Z'), credit(1340.1, '2026-10-02T20:00:10Z'), debit(1340.1, '2026-10-11T12:55:37Z', 'erp-reversal')] } }] } },
    },
    rpRequests: [rpRequest('RET715', 1500, '2026-10-02T20:00:03.553Z', 99, '2026-10-06T11:13:29.878Z')],
  };
  const b = buildFacts(raw);
  assert.equal(b.facts.storeCreditUsed![0].amount, 1340.1);
  assert.deepEqual(b.facts.delivered, { date: '2026-09-28', amount: 358.9 });   // the COD part, collected by the courier
  const r = b.facts.returns![0];
  assert.equal(r.pending, false); assert.equal(r.date, '2026-10-06'); assert.equal(r.goodsReturned, 1599);
  assert.deepEqual(r.storeCredit!.map(c => c.amount), [1500, 1340.1, -1340.1]);   // the earlier credit and the checkout debit are not this return's
  const l = ledger(b);
  assert.equal(l.balanced, true);
  assert.deepEqual(l.exceptions, []);
  // Without the reversal it is an exception.
  const open = structuredClone(raw);
  open.shopify.customer.storeCreditAccounts.nodes[0].transactions.nodes.pop();
  const l2 = ledger(buildFacts(open));
  assert.equal(l2.balanced, false); assert.equal(l2.exceptions[0].type, 'store_credit_differs');
});

test('37605: refunded, parcel still on its way, order from before Unicommerce → waiting', () => {
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12', uc: null,
    shopify: {
      name: '37605', createdAt: '2026-09-24T17:52:59Z', tags: ['Return'], paymentGatewayNames: ['Gokwik UPI', 'shopify_store_credit'],
      subtotalPriceSet: m(1089.15), totalShippingPriceSet: m(0), shippingAddress: { provinceCode: 'DL' },
      transactions: [{ id: 'p', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1089.15), processedAt: '2026-09-24T17:52:59Z' }],
      refunds: [{ createdAt: '2026-10-10T23:58:10Z', refundLineItems: { nodes: [{ subtotalSet: m(1089.15) }] }, transactions: { nodes: [{ kind: 'REFUND', gateway: 'shopify_store_credit', amountSet: m(1089.15) }] } }],
      customer: { storeCreditAccounts: { nodes: [{ transactions: { nodes: [{ __typename: 'StoreCreditAccountCreditTransaction', amount: { amount: '1089.15' }, createdAt: '2026-10-10T23:58:08Z' }] } }] } },
    },
    rpRequests: [rpRequest('RET741', 1089.15, '2026-10-10T23:58:09.955Z', 0)],
  };
  const b = buildFacts(raw);
  assert.equal(b.facts.returns![0].pending, true);
  assert.equal(ledger(b).exceptions[0].type, 'awaiting_return');
});

test('a COD order with no delivery yet has no delivered fact (the order is still open)', () => {
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12', uc: null,
    shopify: { name: '37900', createdAt: '2026-10-09T10:00:00Z', tags: ['COD'], paymentGatewayNames: ['cash_on_delivery'], subtotalPriceSet: m(1399), totalShippingPriceSet: m(100),
      shippingAddress: { provinceCode: 'KA' }, transactions: [{ id: 'x', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1499), processedAt: '2026-10-09T10:00:00Z' }], refunds: [], customer: null },
    rpRequests: [],
  };
  const b = buildFacts(raw);
  assert.equal(b.facts.delivered, undefined);
  assert.equal(b.facts.codFee, 100);
  assert.equal(ledger(b).exceptions[0].type, 'in_transit');
  assert.equal(ledger(b).status, 'open');
});

test('37599: the customer spent exactly the credit on a new order → that debit is NOT a reversal, the return still balances', () => {
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12', uc: null,
    shopify: {
      name: '37599', createdAt: '2026-09-24T14:11:00Z', tags: ['Return'], paymentGatewayNames: ['Gokwik UPI', 'shopify_store_credit'],
      subtotalPriceSet: m(1349), totalShippingPriceSet: m(0), shippingAddress: { provinceCode: 'DL' },
      transactions: [{ id: 'p', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1349), processedAt: '2026-09-24T14:11:53Z' }],
      refunds: [{ createdAt: '2026-10-01T16:03:16Z', refundLineItems: { nodes: [{ subtotalSet: m(1349) }] }, transactions: { nodes: [{ kind: 'REFUND', gateway: 'shopify_store_credit', amountSet: m(1250) }] } }],
      customer: { storeCreditAccounts: { nodes: [{ transactions: { nodes: [
        { __typename: 'StoreCreditAccountCreditTransaction', id: 'c1', amount: { amount: '1250' }, createdAt: '2026-10-01T16:03:16Z' },
        { __typename: 'StoreCreditAccountDebitTransaction', id: 'spent', amount: { amount: '-1250' }, createdAt: '2026-10-10T02:01:19Z' }] } }] } },
    },
    rpRequests: [rpRequest('RET713', 1250, '2026-10-01T16:03:15.000Z', 99, '2026-10-09T10:00:00Z')],
    reversalIds: [],
  };
  const l = ledger(buildFacts(raw));
  assert.deepEqual(buildFacts(raw).facts.returns![0].storeCredit!.map(c => c.amount), [1250]);
  assert.equal(l.balanced, true); assert.deepEqual(l.exceptions, []);
});

test('37740: cancelled by the customer before it shipped → never a sale', () => {
  const raw: RawInputs = {
    sellerState: 'UP', today: '2026-10-12', uc: null,
    shopify: { name: '37740', createdAt: '2026-10-01T12:40:16Z', cancelledAt: '2026-10-01T12:40:51Z', tags: ['COD'], paymentGatewayNames: ['cash_on_delivery'],
      subtotalPriceSet: m(1249), totalShippingPriceSet: m(100), shippingAddress: { provinceCode: 'DL' },
      transactions: [{ id: 'a', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1349), processedAt: '2026-10-01T12:40:16Z' },
        { id: 'b', kind: 'VOID', status: 'SUCCESS', gateway: 'cash_on_delivery', amountSet: m(0), processedAt: '2026-10-01T12:40:50Z' }],
      fulfillments: [], refunds: [], customer: null },
    rpRequests: [],
  };
  const b = buildFacts(raw);
  assert.equal(b.skip, 'cancelled before dispatch');
  assert.equal(ledger(b).balanced, true);
});

// ── Returns to origin before the ERP handled RTOs: credit a person gave by hand ──────────────
const credit = (amount: number, createdAt: string) => ({ __typename: 'StoreCreditAccountCreditTransaction', amount: { amount: String(amount) }, createdAt });
const debit = (amount: number, createdAt: string) => ({ __typename: 'StoreCreditAccountDebitTransaction', amount: { amount: String(-amount) }, createdAt });
const account = (...txs: any[]) => ({ storeCreditAccounts: { nodes: [{ transactions: { nodes: txs } }] } });
const rtoOrder = (name: string, o: any): RawInputs => ({
  sellerState: 'UP', today: '2026-10-11', uc: null, rpRequests: [],
  shopify: { name, tags: ['rto_delivered'], refunds: [], cancelledAt: null, totalShippingPriceSet: m(0), shippingAddress: { provinceCode: 'KA' }, ...o },
});

test('37370: prepaid by UPI, returned, customer given ₹1,260 by hand → balanced, the ₹0.90 goes to Round off', () => {
  const b = buildFacts(rtoOrder('37370', {
    createdAt: '2026-09-14T13:32:05Z', note: 'RTO Delivered on 2026-10-03 16:04:38', paymentGatewayNames: ['Gokwik Upi'], subtotalPriceSet: m(1259.1),
    transactions: [{ id: 'p', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik Upi', amountSet: m(1259.1), processedAt: '2026-09-14T13:32:06Z' }],
    customer: account(credit(1260, '2026-10-09T11:52:12Z')),
  }));
  const l = ledger(b);
  assert.equal(l.status, 'complete'); assert.equal(l.net, 0);
  assert.equal(b.facts.returns![0].date, '2026-10-03');                        // dated by the courier's note, not today
  assert.ok(b.notes.some(n => /given by hand on 2026-10-09/.test(n)));
  const ro = l.entries.filter(e => e.voucher === 'round_off');
  assert.deepEqual(ro.map(e => [e.account, e.debit, e.credit]), [['Round off', 0.9, 0], ['Customer (order control)', 0, 0.9]].map(([a, d, c]) => [a, d, c]));
});

test('37535: ₹1,300 store credit spent on a COD order, returned, ₹1,300 credited by hand → balanced; an older credit is not mistaken for it', () => {
  const b = buildFacts(rtoOrder('37535', {
    createdAt: '2026-09-21T15:00:32Z', note: 'RTO Delivered on 2026-10-03 16:04:14', paymentGatewayNames: ['cash_on_delivery', 'shopify_store_credit'],
    subtotalPriceSet: m(1599), totalShippingPriceSet: m(100),
    transactions: [
      { id: 'sc', kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_store_credit', amountSet: m(1300), processedAt: '2026-09-21T15:00:33Z' },
      { id: 'cod', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(399), processedAt: '2026-09-21T15:00:33Z' }],
    customer: account(credit(1300, '2026-10-09T15:02:52Z'), debit(1300, '2026-09-21T15:00:34Z'), credit(1300, '2026-09-18T09:16:21Z')),
  }));
  const l = ledger(b);
  assert.equal(l.status, 'complete'); assert.equal(l.net, 0);
  assert.equal(b.facts.returns![0].storeCredit![0].date, '2026-10-09');
  assert.equal(l.entries.filter(e => e.voucher === 'round_off').length, 0);
});

test('37586: paid ₹1,499, given ₹1,599 by hand → ₹100 more than paid, needs a look', () => {
  const b = buildFacts(rtoOrder('37586', {
    createdAt: '2026-09-24T02:56:47Z', note: 'RTO Delivered on 2026-10-03 11:36:35', paymentGatewayNames: ['Gokwik Cards'], subtotalPriceSet: m(1499),
    transactions: [{ id: 'p', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik Cards', amountSet: m(1499), processedAt: '2026-09-24T02:56:48Z' }],
    customer: account(credit(1599, '2026-10-09T12:10:13Z')),
  }));
  const l = ledger(b);
  assert.equal(l.status, 'attention');
  assert.equal(l.exceptions[0].type, 'store_credit_differs');
  assert.equal(l.exceptions[0].amount, 100);
  assert.match(l.exceptions[0].reason, /1599\.00 was credited .* paid 1499\.00, 100\.00 more/);
});

test('37560: part-paid (₹199 UPI + ₹1,430.10 store credit), returned, nothing credited since → refund due for all of it', () => {
  const b = buildFacts(rtoOrder('37560', {
    createdAt: '2026-09-22T21:12:12Z', note: 'RTO Delivered on 2026-10-06 15:57:05', paymentGatewayNames: ['Gokwik Ppcod', 'shopify_store_credit'],
    subtotalPriceSet: m(4097), totalShippingPriceSet: m(100),
    transactions: [
      { id: 'adv', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik Ppcod', amountSet: m(199), processedAt: '2026-09-22T21:12:13Z' },
      { id: 'sc', kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_store_credit', amountSet: m(1430.1), processedAt: '2026-09-22T21:12:13Z' }],
    customer: account(debit(1430.1, '2026-09-22T21:12:14Z'), credit(1430.1, '2026-09-17T03:56:59Z')),   // all before the parcel came back
  }));
  const l = ledger(b);
  assert.equal(l.status, 'attention');
  assert.equal(l.exceptions[0].type, 'refund_due');
  assert.equal(l.exceptions[0].amount, -1629.1);
});

test('a credit given by hand BEFORE the parcel came back is not counted for the return', () => {
  const b = buildFacts(rtoOrder('X9', {
    createdAt: '2026-09-14T13:32:05Z', note: 'RTO Delivered on 2026-10-03 16:04:38', paymentGatewayNames: ['Gokwik Upi'], subtotalPriceSet: m(1259.1),
    transactions: [{ id: 'p', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik Upi', amountSet: m(1259.1), processedAt: '2026-09-14T13:32:06Z' }],
    customer: account(credit(1259.1, '2026-09-30T10:00:00Z')),
  }));
  assert.equal(ledger(b).exceptions[0].type, 'refund_due');
});

// ── A person approved an extra credit (ledger_adjustments) ───────────────────────────────────
const order37586 = (adjustments?: any[]): RawInputs => ({
  ...rtoOrder('37586', {
    createdAt: '2026-09-24T02:56:47Z', note: 'RTO Delivered on 2026-10-03 11:36:35', paymentGatewayNames: ['Gokwik Cards'], subtotalPriceSet: m(1499),
    transactions: [{ id: 'p', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik Cards', amountSet: m(1499), processedAt: '2026-09-24T02:56:48Z' }],
    customer: account(credit(1599, '2026-10-09T12:10:13Z')),
  }),
  adjustments,
});
const goodwill = (amount: number) => [{ kind: 'goodwill_credit' as const, amount, reason: 'deliberate extra credit', approved_by: 'owner, chat 11 Oct 2026' }];

test('37586: the extra ₹100 was approved → booked to Goodwill credits, the order is complete', () => {
  const l = ledger(buildFacts(order37586(goodwill(100))));
  assert.equal(l.status, 'complete'); assert.equal(l.net, 0); assert.deepEqual(l.exceptions, []);
  const g = l.entries.filter(e => e.voucher === 'goodwill');
  assert.deepEqual(g.map(e => [e.account, e.debit, e.credit]), [['Goodwill credits', 100, 0], ['Customer (order control)', 0, 100]]);
  assert.equal(g[0].date, '2026-10-09');
  assert.match(g[0].memo, /approved by owner, chat 11 Oct 2026/);
});

test('an approval for a different amount does not clear the difference', () => {
  const l = ledger(buildFacts(order37586(goodwill(50))));
  assert.equal(l.status, 'attention'); assert.equal(l.exceptions[0].type, 'store_credit_differs');
});

test('without an approval the same difference is flagged', () => {
  assert.equal(ledger(buildFacts(order37586())).exceptions[0].type, 'store_credit_differs');
});

test('an approval never covers a shortfall: credited less than paid is still flagged', () => {
  const raw = order37586(goodwill(100));
  (raw.shopify.customer as any) = account(credit(1399, '2026-10-09T12:10:13Z'));
  assert.equal(ledger(buildFacts(raw)).exceptions[0].type, 'store_credit_differs');
});
