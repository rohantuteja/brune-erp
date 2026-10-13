// Run: node --test supabase/functions/_shared/order-facts.test.ts
// Raw inputs are shaped from the real Shopify / Unicommerce / Return Prime responses
// for orders 37807, 37707, 37613 and 37605 (Oct 2026), run through the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts, buildMyntraFacts, istDate, type RawInputs, type MyntraInputs } from './order-facts.ts';
import { buildOrderLedger, CUSTOMER, MYNTRA } from './ledger.ts';

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

// ── Cancelled before dispatch, but the customer had paid (order 37937, 14 Oct 2026) ───────────
// It was paid with ₹1,699 of store credit and cancelled 20 seconds later by GoKwik's confirmation page, which credited the
// ₹1,699 back. It was booked as a finished sale because store credit counted as "money moved".
const cancelledPaid = (name: string, txs: any[], o: any = {}): RawInputs => ({
  sellerState: 'UP', today: '2026-10-14', uc: null, rpRequests: [],
  shopify: { name, createdAt: '2026-10-13T19:32:21Z', cancelledAt: '2026-10-13T19:32:42Z', tags: ['Cancelled via GK Order confirmation page', 'StoreCredits', 'UPI'],
    paymentGatewayNames: ['shopify_store_credit'], subtotalPriceSet: m(1699), totalShippingPriceSet: m(0), shippingAddress: { province: 'Haryana', provinceCode: 'HR' },
    transactions: txs, fulfillments: [], refunds: [], customer: null, ...o },
});
const tx = (kind: string, gateway: string, amount: number, status = 'SUCCESS') => ({ id: `${kind}-${gateway}-${amount}`, kind, status, gateway, amountSet: m(amount), processedAt: '2026-10-13T19:32:30Z' });

test('37937: paid with store credit, cancelled before dispatch, credit given back → never a sale', () => {
  const b = buildFacts(cancelledPaid('37937', [tx('CAPTURE', 'Shopify Store Credits', 1699), tx('REFUND', 'Shopify Store Credits', 1699)]));
  assert.equal(b.skip, 'cancelled before dispatch (store credit spent and credited back)');
  assert.equal(ledger(b).entries.length, 0);
});

test('cancelled before dispatch, paid by UPI → no sale booked, but an exception a person must look at', () => {
  const b = buildFacts(cancelledPaid('40001', [tx('CAPTURE', 'Gokwik UPI', 1699), tx('REFUND', 'Gokwik UPI', 1699)]));
  assert.equal(b.skip, undefined);
  assert.equal(b.facts.cancelled?.paid, 1699);
  assert.deepEqual(b.facts.cancelled?.via, ['Gokwik UPI']);
  const l = ledger(b);
  assert.equal(l.entries.length, 0);                                  // nothing is booked on a guess
  assert.equal(l.exceptions[0].type, 'cancelled_after_payment');
  assert.equal(l.status, 'attention');
  assert.equal(l.balanced, false);
});

test('cancelled before dispatch, paid by store credit that was NOT credited back → exception, not a sale', () => {
  const l = ledger(buildFacts(cancelledPaid('40002', [tx('CAPTURE', 'Shopify Store Credits', 1699)])));
  assert.equal(l.exceptions[0].type, 'cancelled_after_payment');
  assert.equal(l.exceptions[0].amount, 1699);
  assert.equal(l.status, 'attention');
});

test('cancelled before dispatch, part store credit and part UPI → exception (a gateway moved money)', () => {
  const b = buildFacts(cancelledPaid('40003', [tx('CAPTURE', 'Gokwik UPI', 99), tx('CAPTURE', 'Shopify Store Credits', 1600), tx('REFUND', 'Shopify Store Credits', 1699)]));
  assert.deepEqual(b.facts.cancelled?.via, ['Gokwik UPI']);
  assert.equal(ledger(b).exceptions[0].type, 'cancelled_after_payment');
});

test('cancelled AFTER it shipped (tracking number) and paid with store credit → still a sale, as before (the RTO flow)', () => {
  const b = buildFacts(cancelledPaid('40004', [tx('CAPTURE', 'Shopify Store Credits', 1699)], { fulfillments: [{ trackingInfo: [{ number: 'AWB1' }] }] }));
  assert.equal(b.skip, undefined);
  assert.equal(b.facts.cancelled, undefined);
  assert.ok(ledger(b).entries.some(e => e.voucher === 'sale'));
});

test('Shopify refunds are read from the REFUND transactions', () => {
  const b = buildFacts(cancelledPaid('40005', [tx('CAPTURE', 'Gokwik UPI', 500), tx('REFUND', 'shopify_store_credit', 300), tx('REFUND', 'shopify_store_credit', 150, 'FAILURE')], { cancelledAt: null }));
  assert.equal(b.facts.refundedOut, 300);
});

// ── The reality check: money Shopify gave back must be visible in the ledger ────────────────
const sold = (o: any = {}) => ({
  order: 'X', rate: 0.05, igst: true, goods: 1000, codFee: 0, saleDate: '2026-10-05', state: { code: '27', name: 'Maharashtra', source: 'shopify' as const },
  payments: [{ date: '2026-10-05', amount: 1000, ref: 'p', gateway: 'Gokwik UPI' }], ...o,
});
const returned = (credit: number) => [{ kind: 'customer' as const, date: '2026-10-08', goodsReturned: 400, qty: 1, pending: false, storeCredit: [{ date: '2026-10-08', amount: credit, ref: 'c' }] }];

test('Shopify refunded money and the ledger shows none going back → refund_not_booked', () => {
  const l = buildOrderLedger(sold({ refundedOut: 400 }), { cutoff: CUTOFF });
  assert.equal(l.exceptions.at(-1)?.type, 'refund_not_booked');
  assert.equal(l.exceptions.at(-1)?.amount, 400);
  assert.equal(l.status, 'attention');
});

test('Shopify refund matches the store credit the ledger issued → no exception', () => {
  const l = buildOrderLedger(sold({ refundedOut: 400, returns: returned(400) }), { cutoff: CUTOFF });
  assert.deepEqual(l.exceptions, []);
  assert.equal(l.balanced, true);
});

test('the ledger shows MORE going back than Shopify refunded (an approved goodwill credit) → not this check\'s business', () => {
  const l = buildOrderLedger(sold({ refundedOut: 300, returns: returned(400) }), { cutoff: CUTOFF });
  assert.ok(!l.exceptions.some(e => e.type === 'refund_not_booked'));
});

test('no refund in Shopify → the check stays quiet', () => {
  assert.deepEqual(buildOrderLedger(sold({ refundedOut: 0 }), { cutoff: CUTOFF }).exceptions, []);
  assert.deepEqual(buildOrderLedger(sold(), { cutoff: CUTOFF }).exceptions, []);
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
  assert.deepEqual(ro.map(e => [e.account, e.debit, e.credit]), [['ROUND OFF', 0.9, 0], ['Customer (order control)', 0, 0.9]].map(([a, d, c]) => [a, d, c]));
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

// ── Remittance (UTR) from Velocity ───────────────────────────────────────────────────────────
const codRaw = (over: Partial<RawInputs> = {}): RawInputs => ({
  sellerState: 'UP', today: '2026-10-12', uc: null, rpRequests: [],
  shopify: { name: 'C9', createdAt: '2026-10-02T10:00:00Z', tags: ['COD'], paymentGatewayNames: ['cash_on_delivery'], subtotalPriceSet: m(1399), totalShippingPriceSet: m(100),
    shippingAddress: { provinceCode: 'KA' }, transactions: [{ id: 'c', kind: 'SALE', status: 'SUCCESS', gateway: 'cash_on_delivery', amountSet: m(1499), processedAt: '2026-10-06T10:00:00Z' }], refunds: [], customer: null },
  codDeliveredOn: '2026-10-05', ...over,
});

test('delivered and remitted: the remittance reaches the ledger and clears the courier receivable', () => {
  const b = buildFacts(codRaw({ remittance: { utr: 'UTR55', date: '2026-10-09', amount: 1499 } }));
  assert.deepEqual(b.facts.remitted, { date: '2026-10-09', amount: 1499, utr: 'UTR55' });
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-12' });
  assert.equal(l.codOpen, 0); assert.equal(l.status, 'complete');
});

test('a remittance with no amount is taken as the COD collected', () => {
  const b = buildFacts(codRaw({ remittance: { utr: 'UTR56', date: '2026-10-09', amount: null } }));
  assert.equal(b.facts.remitted?.amount, 1499);
});

test('no remittance yet: the money is still with the courier', () => {
  const b = buildFacts(codRaw());
  assert.equal(b.facts.remitted, undefined);
  assert.equal(buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-12' }).codOpen, 1499);
});

test('a remittance on an order that was never delivered is ignored', () => {
  const b = buildFacts(codRaw({ codDeliveredOn: null, remittance: { utr: 'UTR57', date: '2026-10-09', amount: 1499 }, shopify: { ...codRaw().shopify, transactions: [] } }));
  assert.equal(b.facts.delivered, undefined); assert.equal(b.facts.remitted, undefined);
});

test('a guessed delivery date is marked as an estimate', () => {
  const b = buildFacts(codRaw({ codDeliveredOn: null }));
  assert.equal(b.facts.delivered?.estimated, true);
});

// ── Velocity's note says the parcel is coming back, with no RTO tag ──────────────────────────
test('37762: note says RTO In Transit, no tag → the ledger sees a COD parcel returning, not one still on its way to the customer', () => {
  const b = buildFacts(codRaw({ codDeliveredOn: null, shopify: { ...codRaw().shopify, name: '37762', tags: ['COD', 'GoKwik'], note: 'RTO In Transit on 2026-10-11 00:13:06', transactions: [] } }));
  assert.deepEqual(b.facts.rtoOnTheWay, { state: 'in_transit', since: '2026-10-11' });
  assert.equal(b.facts.delivered, undefined);
  const l = ledger(b);
  assert.equal(l.exceptions[0].type, 'rto_on_the_way'); assert.equal(l.status, 'open');
});

test('a note that says RTO Delivered counts as the parcel being back even if the tag is missing', () => {
  const b = buildFacts(codRaw({ codDeliveredOn: null, shopify: { ...codRaw().shopify, name: 'R9', tags: [], note: 'RTO Delivered on 2026-10-03 16:04:38', transactions: [] } }));
  assert.equal(b.facts.returns?.[0].kind, 'rto'); assert.equal(b.facts.rtoOnTheWay, undefined);
});

test('the RTO tag alone, without a note, still means the parcel is on its way back', () => {
  const b = buildFacts(codRaw({ codDeliveredOn: null, shopify: { ...codRaw().shopify, tags: ['rto_initiated'], note: null, transactions: [] } }));
  assert.equal(b.facts.rtoOnTheWay?.state, 'initiated');
});

// ── Which day a sale is booked on: the Shopify order date, not the Unicommerce invoice date ──
const prepaidOrder = (name: string, createdAt: string, invoiceAt: string, doc: string): RawInputs => ({
  sellerState: 'UP', today: '2026-10-12',
  shopify: {
    name, createdAt, tags: ['UPI'], paymentGatewayNames: ['Gokwik UPI'], subtotalPriceSet: m(1349), totalShippingPriceSet: m(0),
    shippingAddress: { provinceCode: 'DL' }, refunds: [], customer: null,
    transactions: [{ id: 't1', kind: 'CAPTURE', status: 'SUCCESS', gateway: 'Gokwik UPI', amountSet: m(1349), processedAt: createdAt }],
  },
  uc: { order: { status: 'COMPLETE', returns: [] }, saleInvoice: ucInvoice(doc, Date.parse(invoiceAt), 1349, 64.24, 0), returnInvoices: {} },
  rpRequests: [],
});

test('37729: ordered 30 Sep at 23:54 IST, invoiced by Unicommerce on 1 Oct → booked on 30 Sep (September, outside the ledger); the invoice keeps its number and amounts', () => {
  const b = buildFacts(prepaidOrder('37729', '2026-09-30T18:24:28Z', '2026-10-01T02:50:59Z', 'INS0028'));
  assert.equal(b.facts.saleDate, '2026-09-30');
  assert.equal(b.facts.invoiceDate, '2026-10-01');
  assert.equal(b.facts.saleDoc, 'INS0028');
  assert.equal(b.facts.goods, 1349); assert.equal(b.facts.codFee, 0);
  assert.ok(b.notes.some(n => /order date 2026-09-30.*INS0028.*2026-10-01/.test(n)), 'says why the dates differ');
  const l = ledger(b);
  assert.equal(l.entries.find(e => e.voucher === 'sale')?.doc, 'INS0028');
  assert.equal(l.status, 'complete');
  assert.equal(l.opening, 0);                    // the sale and the payment are both on 30 Sep: nothing is carried into October
  assert.equal(l.exportable.length, 0);          // and nothing of it is October's
});

test('37730: ordered at 00:17 IST on 1 Oct (18:47 UTC on 30 Sep) is an October sale', () => {
  const b = buildFacts(prepaidOrder('37730', '2026-09-30T18:47:47Z', '2026-10-01T02:50:54Z', 'INS0029'));
  assert.equal(b.facts.saleDate, '2026-10-01');
  assert.ok(!b.notes.some(n => /later month/.test(n)));
  const l = ledger(b);
  assert.equal(l.exportable.filter(e => e.voucher === 'sale' && e.date === '2026-10-01').length > 0, true);
  assert.equal(l.opening, 0);
});

test('ordered and invoiced in the same month: booked on the order date, no note, amounts unchanged', () => {
  const b = buildFacts(prepaidOrder('37733', '2026-10-01T10:00:00Z', '2026-10-03T06:00:00Z', 'INS0055'));
  assert.equal(b.facts.saleDate, '2026-10-01'); assert.equal(b.facts.invoiceDate, '2026-10-03');
  assert.ok(!b.notes.some(n => /later month/.test(n)));
  assert.equal(ledger(b).entries.find(e => e.voucher === 'sale')?.date, '2026-10-01');
  assert.equal(ledger(b).status, 'complete');
});

test('a COD order placed 30 Sep, invoiced 1 Oct and not delivered: the sale is September\'s opening receivable, and "invoiced N days ago" still counts from the invoice', () => {
  const raw = prepaidOrder('37716', '2026-09-30T02:46:28Z', '2026-10-01T02:50:58Z', 'INS0018');
  raw.shopify = { ...raw.shopify, tags: ['COD'], paymentGatewayNames: ['cash_on_delivery'], transactions: [{ id: 'x', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1449), processedAt: '2026-09-30T02:46:29Z' }] };
  raw.uc!.saleInvoice = ucInvoice('INS0018', Date.parse('2026-10-01T02:50:58Z'), 1449, 69, 100);
  const b = buildFacts(raw);
  assert.equal(b.facts.saleDate, '2026-09-30'); assert.equal(b.facts.invoiceDate, '2026-10-01');
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-11' });
  assert.equal(l.opening, 1449);                 // September's receivable, carried in
  assert.equal(l.exceptions[0].type, 'in_transit');
  assert.match(l.exceptions[0].reason, /invoiced 10 days ago/);   // 1 Oct → 11 Oct, not 30 Sep → 11 Oct
});

test('no Unicommerce invoice (before 29 Sep): booked on the order date as before, and there is no invoice date', () => {
  const raw = prepaidOrder('37500', '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z', 'X');
  raw.uc = null;
  const b = buildFacts(raw);
  assert.equal(b.facts.saleDate, '2026-09-20'); assert.equal(b.facts.invoiceDate, undefined); assert.equal(b.facts.saleDoc, undefined);
});

// ── Myntra: the order lives in Unicommerce only; Myntra owes the money ────────────────────────
const ist = (t: string) => Date.parse(`${t}+05:30`);
const myntraOrder = (over: Record<string, any> = {}, price = 1326, code = 'bb5a16bf-aaaa-4bbb-8ccc-000000000001') => ({
  code, status: 'COMPLETE', displayOrderDateTime: ist('2026-10-06T13:10:05'), created: ist('2026-10-06T13:10:31'),
  saleOrderItems: [{ code: '11439403112', sellingPrice: price, itemSku: 'TOBY-BLACK-DRESS-49-M' }],
  shippingPackages: [{ code: 'BRUN00030', status: 'DISPATCHED', invoiceDisplayCode: 'I0927RE000000030' }],
  returns: [], ...over,
});
const myntra = (order: any, invoice: any, extra: Partial<MyntraInputs['uc']> = {}): MyntraInputs =>
  ({ today: '2026-10-13', bookFrom: CUTOFF, uc: { order, saleInvoice: invoice, returnInvoices: {}, ...extra } });
const myntraInvoice = (code: string, created: string, total: number, igst = true) => ({
  ...ucInvoice(code, ist(created), total, igst ? Math.round(total / 21 * 100) / 100 : 0, 0),
  ...(igst ? {} : { centralGst: Math.round(total / 42 * 100) / 100, stateGst: Math.round(total / 42 * 100) / 100, integratedGst: 0 }),
});

test('Myntra: an invoiced order is booked on Myntra\'s order day, named by its invoice number, owed by Myntra', () => {
  const b = buildMyntraFacts(myntra(myntraOrder(), myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326)));
  assert.equal(b.facts.order, 'I0927RE000000030'); assert.equal(b.facts.channel, 'myntra'); assert.equal(b.facts.channelRef, 'bb5a16bf-aaaa-4bbb-8ccc-000000000001');
  assert.equal(b.facts.saleDate, '2026-10-06'); assert.equal(b.facts.saleDoc, 'I0927RE000000030'); assert.equal(b.facts.goods, 1326); assert.equal(b.facts.codFee, 0);
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-13' });
  const sale = l.entries.filter(e => e.voucher === 'sale');
  assert.equal(sale.find(e => e.account === MYNTRA)?.debit, 1326);
  assert.equal(sale.find(e => e.account === 'GST SALES' && e.part === 'goods')?.credit, 1262.86); assert.equal(sale.find(e => e.account === 'IGST OUTPUT UP')?.credit, 63.14);
  assert.ok(!l.entries.some(e => e.account === CUSTOMER), 'never the customer account');
  assert.equal(l.net, 1326); assert.equal(l.status, 'open'); assert.equal(l.exceptions[0].type, 'awaiting_settlement');
  assert.match(l.exceptions[0].reason, /Myntra collected 1326\.00/);
  assert.equal(l.exportable.length, sale.length);
});

test('Myntra: an order placed in September is booked on 1 October (the September books had no Myntra sales)', () => {
  const b = buildMyntraFacts(myntra(myntraOrder({ displayOrderDateTime: ist('2026-09-30T20:01:47') }), myntraInvoice('I0927RE000000006', '2026-10-01T08:42:06', 1326)));
  assert.equal(b.facts.saleDate, '2026-10-01'); assert.equal(b.facts.invoiceDate, '2026-10-01');
  assert.ok(b.notes.some(n => /placed on 2026-09-30, before the books started: booked on 2026-10-01/.test(n)));
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-13' });
  assert.equal(l.opening, 0); assert.ok(l.exportable.some(e => e.voucher === 'sale'), 'the sale is October\'s');
  // an order invoiced in the same September month it was placed is booked on 1 Oct too
  const c = buildMyntraFacts(myntra(myntraOrder({ displayOrderDateTime: ist('2026-09-27T13:58:25') }), myntraInvoice('I0927RE000000003', '2026-09-28T09:31:09', 1226)));
  assert.equal(c.facts.saleDate, '2026-10-01');
});

test('Myntra: ordered late on 31 Oct and invoiced in November is October\'s sale (the order date rule), with a note', () => {
  const b = buildMyntraFacts({ ...myntra(myntraOrder({ displayOrderDateTime: ist('2026-10-31T23:40:00') }), myntraInvoice('I0927RE000000200', '2026-11-01T09:00:00', 1326)), bookFrom: CUTOFF });
  assert.equal(b.facts.saleDate, '2026-10-31'); assert.equal(b.facts.invoiceDate, '2026-11-01');
  assert.ok(b.notes.some(n => /order date 2026-10-31.*in a later month/.test(n)));
});

test('Myntra: not invoiced yet is not stored; a cancelled invoiced order is not a sale', () => {
  const none = buildMyntraFacts(myntra(myntraOrder({ status: 'PROCESSING', shippingPackages: [{ code: 'P', status: 'CREATED' }] }), undefined));
  assert.equal(none.ignore, 'not invoiced yet');
  const cancelled = buildMyntraFacts(myntra(myntraOrder({ status: 'CANCELLED' }), myntraInvoice('I0927RE000000031', '2026-10-06T14:15:10', 1326)));
  assert.equal(cancelled.skip, 'cancelled');
});

test('Myntra: a customer return still on its way is "waiting for the parcel"; the sale stays open', () => {
  const o = myntraOrder({ returns: [{ code: 'RET1', type: 'Customer Returned', statusCode: 'COURIER_ALLOCATED', returnItems: [{ saleOrderItemCode: '11439403112' }] }] });
  const b = buildMyntraFacts(myntra(o, myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326)));
  assert.equal(b.facts.returns![0].kind, 'customer'); assert.equal(b.facts.returns![0].pending, true); assert.equal(b.facts.returns![0].goodsReturned, 1326);
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-13' });
  assert.equal(l.status, 'open'); assert.equal(l.exceptions[0].type, 'awaiting_return');
});

test('Myntra: once Unicommerce receives the parcel its return invoice is the credit note, dated by it, and the order nets to zero', () => {
  const o = myntraOrder({ returns: [{ code: 'RET1', type: 'Customer Returned', statusCode: 'RETURNED', returnInvoiceDisplayCode: 'ISR0010', returnItems: [{ saleOrderItemCode: '11439403112' }] }] });
  const ret = { ...myntraInvoice('ISR0010', '2026-10-14T10:30:00', 1326), displayCode: 'ISR0010' };
  const b = buildMyntraFacts({ ...myntra(o, myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326), { returnInvoices: { RET1: ret } }), today: '2026-10-15' });
  const r = b.facts.returns![0];
  assert.equal(r.pending, false); assert.equal(r.date, '2026-10-14'); assert.equal(r.uc?.doc, 'ISR0010');
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-15' });
  const cn = l.entries.filter(e => e.voucher === 'credit_note');
  assert.equal(cn.find(e => e.account === MYNTRA)?.credit, 1326); assert.equal(cn[0].date, '2026-10-14'); assert.equal(cn[0].doc, 'ISR0010');
  assert.equal(l.net, 0); assert.equal(l.status, 'complete'); assert.equal(l.balancing.length, 0);
});

test('Myntra: an RTO (courier returned) on its way is waiting for the parcel; a return invoice that does not match is not trusted', () => {
  const rto = myntraOrder({ returns: [{ code: 'RET2', type: 'Courier Returned', statusCode: 'RETURN_EXPECTED', returnItems: [{ saleOrderItemCode: '11439403112' }] }] });
  const a = buildMyntraFacts(myntra(rto, myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326)));
  assert.equal(a.facts.returns![0].kind, 'rto'); assert.equal(a.facts.returns![0].pending, true);
  const odd = myntraOrder({ returns: [{ code: 'RET3', type: 'Customer Returned', statusCode: 'RETURNED', returnInvoiceDisplayCode: 'ISR0011', returnItems: [{ saleOrderItemCode: '11439403112' }] }] });
  const b = buildMyntraFacts(myntra(odd, myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326), { returnInvoices: { RET3: { ...myntraInvoice('ISR0099', '2026-10-14T10:30:00', 1326), displayCode: 'ISR0099' } } }));
  assert.equal(b.facts.returns![0].pending, true); assert.ok(b.notes.some(n => /return invoice ISR0011 could not be read/.test(n)));
});

test('Myntra: a two-item order with one item returned credits only that item; intra-state tax is split into CGST and SGST', () => {
  const two = myntraOrder({
    saleOrderItems: [{ code: 'A1', sellingPrice: 1326 }, { code: 'A2', sellingPrice: 1426.01 }],
    returns: [{ code: 'RET4', type: 'Customer Returned', statusCode: 'COURIER_ALLOCATED', returnItems: [{ saleOrderItemCode: 'A2' }] }],
  });
  const b = buildMyntraFacts(myntra(two, myntraInvoice('I0927RE000000006', '2026-10-06T14:15:10', 2752.01)));
  assert.equal(b.facts.goods, 2752.01); assert.equal(b.facts.returns![0].goodsReturned, 1426.01);
  const intra = buildMyntraFacts(myntra(myntraOrder(), myntraInvoice('I0927RE000000018', '2026-10-06T14:15:10', 1326, false)));
  assert.equal(intra.facts.igst, false);
  const l = buildOrderLedger(intra.facts, { cutoff: CUTOFF, today: '2026-10-13' });
  assert.ok(l.entries.some(e => e.account === 'CGST Output UP') && l.entries.some(e => e.account === 'SGST Output UP') && !l.entries.some(e => e.account === 'IGST OUTPUT UP'));
});

// ── Pieces, gateway names and GoKwik payouts ─────────────────────────────────────────────────────────────
test('pieces come from the Unicommerce invoice items (an item without a quantity counts as one)', () => {
  const raw = prepaidOrder('37950', '2026-10-09T10:00:00Z', '2026-10-09T12:00:00Z', 'INS0900');
  raw.uc!.saleInvoice.invoiceItems = [{ quantity: 2, integratedGstPercentage: 5 }, { integratedGstPercentage: 5 }];
  assert.equal(buildFacts(raw).facts.qty, 3);
  assert.equal(buildFacts(prepaidOrder('37951', '2026-10-09T10:00:00Z', '2026-10-09T12:00:00Z', 'INS0901')).facts.qty, 1);
});

test('without a Unicommerce invoice the pieces come from the Shopify line items', () => {
  const raw = prepaidOrder('37500', '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z', 'X');
  raw.uc = null; raw.shopify.lineItems = { nodes: [{ quantity: 2 }, { quantity: 1 }] };
  assert.equal(buildFacts(raw).facts.qty, 3);
});

test('a payment remembers its gateway, and GoKwik\'s payout rows are passed through only when they were looked up', () => {
  const raw = prepaidOrder('37952', '2026-10-09T10:00:00Z', '2026-10-09T12:00:00Z', 'INS0902');
  const without = buildFacts(raw).facts;
  assert.equal(without.payments![0].gateway, 'Gokwik UPI'); assert.equal('gatewayPayouts' in without, false);
  const rows = [{ date: '2026-10-11', utr: 'U1', gross: 1349, fee: 27.8, tax: 5, net: 1316.2, ref: 'p1' }];
  assert.deepEqual(buildFacts({ ...raw, gatewayPayouts: rows }).facts.gatewayPayouts, rows);
  assert.deepEqual(buildFacts({ ...raw, gatewayPayouts: [] }).facts.gatewayPayouts, []);
});

test('an RTO sends all the pieces back', () => {
  const raw = prepaidOrder('37953', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z', 'INS0903');
  raw.uc!.saleInvoice.invoiceItems = [{ quantity: 2, integratedGstPercentage: 5 }];
  raw.shopify = { ...raw.shopify, tags: ['rto_delivered'], cancelledAt: '2026-10-07T10:00:00Z' };
  const r = buildFacts(raw).facts.returns![0];
  assert.equal(r.kind, 'rto'); assert.equal(r.qty, 2);
});

test('a Myntra order carries its pieces on the sale and on the return', () => {
  const o = myntraOrder({ returns: [{ code: 'RET9', type: 'Customer Returned', statusCode: 'COURIER_ALLOCATED', returnItems: [{ saleOrderItemCode: '11439403112' }] }] });
  const b = buildMyntraFacts(myntra(o, myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326)));
  assert.equal(b.facts.qty, 1); assert.equal(b.facts.returns![0].qty, 1);
});

// ── The state the goods go to: on every voucher ───────────────────────────────────────────────
const stateOrder = (shipping: any, uc: any, sale = ucInvoice('INS0200', Date.parse('2026-10-08T06:00:00Z'), 1499, 71.38, 100)): RawInputs => ({
  sellerState: 'UP', today: '2026-10-12',
  shopify: {
    name: '37900', createdAt: '2026-10-08T05:00:00Z', tags: ['COD'], paymentGatewayNames: ['cash_on_delivery'],
    subtotalPriceSet: m(1399), totalShippingPriceSet: m(100), shippingAddress: shipping,
    transactions: [{ id: 'x', kind: 'SALE', status: 'PENDING', gateway: 'cash_on_delivery', amountSet: m(1499), processedAt: '2026-10-08T05:00:00Z' }],
    refunds: [], fulfillments: [{ trackingInfo: [{ number: 'AWB1' }] }],
  },
  uc: { order: { status: 'COMPLETE', returns: [], ...uc }, saleInvoice: sale, returnInvoices: {} },
  rpRequests: [],
});

test('state: Shopify\'s shipping address names it, and the GST code comes with it', () => {
  const b = buildFacts(stateOrder({ province: 'Maharashtra', provinceCode: 'MH' }, {}));
  assert.deepEqual(b.facts.state, { code: '27', name: 'Maharashtra', source: 'shopify' });
  assert.equal(b.facts.igst, true);
  assert.ok(!b.notes.some(n => /state|CGST|IGST/.test(n)), b.notes.join(' | '));
});

test('state: a short code alone is enough, and a Shopify code that differs from Unicommerce\'s (TS / TG) is the same state', () => {
  assert.equal(buildFacts(stateOrder({ provinceCode: 'TS' }, { addresses: [{ id: 2, state: 'TG', stateName: 'Telangana' }] })).facts.state?.code, '36');
  const b = buildFacts(stateOrder({ provinceCode: 'TS' }, { addresses: [{ id: 2, state: 'TG', stateName: 'Telangana' }] }));
  assert.ok(!b.notes.some(n => /Unicommerce has/.test(n)));
});

test('state: with no Shopify address Unicommerce\'s is used, and its shipping address is the one that is not the billing address', () => {
  const uc = { billingAddress: { id: 11 }, addresses: [{ id: 11, state: 'DL', stateName: 'Delhi' }, { id: 10, state: 'KA', stateName: 'Karnataka' }] };
  const b = buildFacts(stateOrder(null, uc));
  assert.deepEqual(b.facts.state, { code: '29', name: 'Karnataka', source: 'unicommerce' });
  assert.equal(buildFacts(stateOrder(undefined, { addresses: [{ id: 5, state: 'MH', stateName: 'Maharashtra' }] })).facts.state?.name, 'Maharashtra');   // a single address
});

test('state: Shopify and Unicommerce disagree → Shopify\'s delivery state is used and a note says so', () => {
  const b = buildFacts(stateOrder({ province: 'Kerala', provinceCode: 'KL' }, { billingAddress: { id: 1 }, addresses: [{ id: 2, state: 'DL', stateName: 'Delhi' }] }));
  assert.equal(b.facts.state?.name, 'Kerala');
  assert.ok(b.notes.some(n => /Shopify delivers this to Kerala but Unicommerce has Delhi/.test(n)));
});

test('state: the invoice charged IGST but the goods stay in Uttar Pradesh → a note to check the invoice', () => {
  const b = buildFacts(stateOrder({ province: 'Uttar Pradesh', provinceCode: 'UP' }, {}));      // the invoice above is IGST
  assert.equal(b.facts.state?.code, '09');
  assert.ok(b.notes.some(n => /charged IGST but the goods go to Uttar Pradesh, which needs CGST and SGST/.test(n)), b.notes.join(' | '));
  const ok = buildFacts(stateOrder({ province: 'Uttar Pradesh', provinceCode: 'UP' }, {}, { ...ucInvoice('INS0201', Date.parse('2026-10-08T06:00:00Z'), 1499, 0, 100), centralGst: 35.69, stateGst: 35.69 }));
  assert.equal(ok.facts.igst, false);
  assert.ok(!ok.notes.some(n => /charged/.test(n)));
});

test('state: with no Unicommerce invoice the kind of GST follows the state', () => {
  const raw = stateOrder({ province: 'Uttar Pradesh', provinceCode: 'UP' }, {});
  raw.uc = null;
  assert.equal(buildFacts(raw).facts.igst, false);
  raw.shopify.shippingAddress = { province: 'Delhi', provinceCode: 'DL' };
  assert.equal(buildFacts(raw).facts.igst, true);
});

test('state: none found → no state on the facts, a note, and with requireState an exception that keeps the order out of Tally', () => {
  const b = buildFacts(stateOrder(null, {}));
  assert.equal(b.facts.state, undefined);
  assert.ok(b.notes.some(n => /no state found/.test(n)));
  const l = buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-12', requireState: true });
  assert.ok(l.exceptions.some(e => e.type === 'no_state'));
  assert.equal(l.status, 'attention');
  assert.equal(buildOrderLedger(b.facts, { cutoff: CUTOFF, today: '2026-10-12' }).exceptions.some(e => e.type === 'no_state'), false);   // off unless asked for
  const withState = buildFacts(stateOrder({ province: 'Delhi' }, {}));
  assert.equal(buildOrderLedger(withState.facts, { cutoff: CUTOFF, today: '2026-10-12', requireState: true }).exceptions.some(e => e.type === 'no_state'), false);
});

test('state: a Myntra order\'s state is its one Unicommerce address, and the invoice\'s kind of GST is checked against it', () => {
  const order = myntraOrder({ addresses: [{ id: 1, state: 'MH', stateName: 'Maharashtra' }], billingAddress: { id: 2 } });
  const b = buildMyntraFacts({ ...myntra(order, myntraInvoice('I0927RE000000030', '2026-10-06T14:15:10', 1326)), sellerState: 'UP' });
  assert.deepEqual(b.facts.state, { code: '27', name: 'Maharashtra', source: 'unicommerce' });
  assert.ok(!b.notes.some(n => /charged/.test(n)));
  const wrong = buildMyntraFacts({ ...myntra(myntraOrder({ addresses: [{ id: 1, state: 'UP', stateName: 'Uttar Pradesh' }] }), myntraInvoice('I0927RE000000031', '2026-10-06T14:15:10', 1326)), sellerState: 'UP' });
  assert.ok(wrong.notes.some(n => /charged IGST but the goods go to Uttar Pradesh/.test(n)));
  assert.equal(buildMyntraFacts(myntra(myntraOrder(), myntraInvoice('I0927RE000000032', '2026-10-06T14:15:10', 1326))).facts.state, undefined);
});
