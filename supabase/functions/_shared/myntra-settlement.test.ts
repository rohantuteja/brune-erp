// Run: node --test supabase/functions/_shared/myntra-settlement.test.ts
// The shapes and the sums are Myntra's real October 2026 ones; invoice numbers, order ids and UTRs are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateShares, gap, isXlsx, parsePaymentDetails, parseSettledReport, payoutsOf, settlementFacts, settlementFingerprint, tieToBank, utrKey, type BankCredit, type SettlementLine } from './myntra-settlement.ts';
import { buildOrderLedger, fyLabel, settlementLines, BANK, GATEWAY_FEE, GST_INPUT_IGST, MYNTRA, MYNTRA_COMMISSION, MYNTRA_RETURN_FEE, type Facts, type MyntraSettlement } from './ledger.ts';

// ── The monthly settled report ───────────────────────────────────────────────────────────────────────────────────────
const NAMES = (fee: string) => ['order_date', 'order_release_id', 'seller_order_id', 'order_line_id', 'invoice_number',
  ...['Postpaid', 'Prepaid'].flatMap(S => [`Settled_Amount_${S}`, `UTR_Number_${S}`, `settlement_date_${S.toLowerCase()}_payment`, `Seller_Product_Amount_${S}`, `Commission_Amount_incl_GST_${S}`,
    `Logistics_Cost_${fee}_incl_Tax_${S}`, `tcs_amount_${S}`, `tds_amount_${S}`, `Pick_and_Pack_Fees_${S}`])];
const sheet = (fee: 'Forward' | 'Reverse', rows: Array<Record<string, string>>) =>
  [['Order Details', '', ''], ['', 'Postpaid', ''], NAMES(fee), ...rows.map(r => NAMES(fee).map(n => r[n] ?? ''))];
const quoted = (s: string) => `"\\"${s}\\""`;          // how the report writes an invoice number

const UTR = 'NFT-/XUTR/DEUTH0TEST00A2EWNX';
const forwardRow = (invoice: string, extra: Record<string, string> = {}) => ({
  order_date: '2026-10-12', order_release_id: '100413613878', seller_order_id: 'uuid-' + invoice, order_line_id: 'L-' + invoice, invoice_number: quoted(invoice),
  Settled_Amount_Postpaid: '1259.423', UTR_Number_Postpaid: UTR, settlement_date_postpaid_payment: '2026-10-30 00:00:00', Seller_Product_Amount_Postpaid: '1326.0',
  Commission_Amount_incl_GST_Postpaid: '0.0', Logistics_Cost_Forward_incl_Tax_Postpaid: '59.0', tcs_amount_Postpaid: '6.314', tds_amount_Postpaid: '1.263', Pick_and_Pack_Fees_Postpaid: '0.0',
  UTR_Number_Prepaid: '""', Settled_Amount_Prepaid: '0.0', settlement_date_prepaid_payment: '""', ...extra,
});
const reverseRow = (invoice: string, extra: Record<string, string> = {}) => ({
  ...forwardRow(invoice), Settled_Amount_Postpaid: '-1443.503', Logistics_Cost_Reverse_incl_Tax_Postpaid: '125.08', Logistics_Cost_Forward_incl_Tax_Postpaid: undefined as unknown as string, ...extra,
});

test('settled report: forward and reverse lines are read, stray quotes cleaned, empty streams skipped', () => {
  const sheets = new Map([
    ['Glossary', [['Column Name', 'Definition']]],
    ['forward_settled', sheet('Forward', [forwardRow('I0000TEST000047'), forwardRow('I0000TEST000058')])],
    ['reverse_settled', sheet('Reverse', [reverseRow('I0000TEST000058')])],
  ]);
  const r = parseSettledReport(sheets);
  assert.equal(r.kind, 'settled_report');
  assert.deepEqual(r.checks.map(c => c.ok), [true, true, true]);
  assert.equal(r.lines.length, 3);
  const [a, , rev] = r.lines;
  assert.deepEqual({ utr: a.utr, invoice: a.invoice, stream: a.stream, dir: a.dir, product: a.product, commission: a.commission, fee: a.fee, tcs: a.tcs, tds: a.tds, net: a.net, on: a.settled_on },
    { utr: UTR, invoice: 'I0000TEST000047', stream: 'postpaid', dir: 'forward', product: 1326, commission: 0, fee: 59, tcs: 6.314, tds: 1.263, net: 1259.423, on: '2026-10-30' });
  assert.equal(rev.dir, 'reverse'); assert.equal(rev.net, -1443.503); assert.equal(rev.fee, 125.08);
  assert.ok(r.lines.every(l => Math.abs(gap(l)) < 0.005));
});

test('settled report: commission is negative when charged and positive when given back, and both add up', () => {
  const fwd = forwardRow('I0000TEST000009', { Settled_Amount_Postpaid: '1106.45', Seller_Product_Amount_Postpaid: '1426.0', Commission_Amount_incl_GST_Postpaid: '-252.402', tcs_amount_Postpaid: '6.79', tds_amount_Postpaid: '1.358' });
  const rev = reverseRow('I0000TEST000009', { Settled_Amount_Postpaid: '-1290.53', Seller_Product_Amount_Postpaid: '1426.0', Commission_Amount_incl_GST_Postpaid: '252.402', tcs_amount_Postpaid: '6.79', tds_amount_Postpaid: '1.358' });
  const r = parseSettledReport(new Map([['forward_settled', sheet('Forward', [fwd])], ['reverse_settled', sheet('Reverse', [rev])]]));
  assert.equal(r.checks.every(c => c.ok), true);
  assert.deepEqual(r.lines.map(l => [l.dir, l.commission]), [['forward', 252.402], ['reverse', 252.402]]);
});

test('settled report: a line that does not add up, or a charge nobody has an account for, refuses the file', () => {
  const off = parseSettledReport(new Map([['forward_settled', sheet('Forward', [forwardRow('I0000TEST000047', { Settled_Amount_Postpaid: '1250.0' })])]]));
  assert.equal(off.checks.find(c => c.id === 'adds_up')!.ok, false);
  const extra = parseSettledReport(new Map([['forward_settled', sheet('Forward', [forwardRow('I0000TEST000047', { Pick_and_Pack_Fees_Postpaid: '5.0' })])]]));
  assert.equal(extra.checks.find(c => c.id === 'known_charges')!.ok, false);
  assert.match(extra.checks.find(c => c.id === 'known_charges')!.detail, /Pick_and_Pack_Fees/);
  assert.throws(() => parseSettledReport(new Map([['Sheet1', [['a']]]])), /monthly settlement report/);
});

// ── The payment details report ───────────────────────────────────────────────────────────────────────────────────────
const CSV_HEAD = ['invoice number', 'order line id', 'seller order id', ...['prepaid', 'postpaid'].flatMap(s => [`${s} forward utr number`, `${s} forward settlement date`, `${s} payment eligible forward`, `${s} reverse utr number`,
  `${s} reverse settlement date`, `${s} payment eligible reverse`, `${s} seller product amount`, `${s} total commission plus tcs tds`, `${s} tcs amount`, `${s} tds amount`, `${s} fixed cost`, `${s} tech enablement charges`])];
const csv = (rows: Array<Record<string, string>>) => [CSV_HEAD.join(','), ...rows.map(r => CSV_HEAD.map(h => r[h] ?? '').join(','))].join('\n');

test('payment details: forward and reverse lines come from one row, the return fee is what is left of the amount taken back', () => {
  const row = { 'invoice number': 'I0000TEST000009', 'order line id': 'L9', 'seller order id': 'u9',
    'prepaid forward utr number': 'NFT-/XUTR/DEUTH0TEST00AAAAX', 'prepaid forward settlement date': '2026-10-22 05:30:00.000', 'prepaid payment eligible forward': '1106.45',
    'prepaid reverse utr number': 'NFT-/XUTR/DEUTH0TEST00BBBBX', 'prepaid reverse settlement date': '2026-10-23 05:30:00.000', 'prepaid payment eligible reverse': '1290.53',
    'prepaid seller product amount': '1426.0', 'prepaid total commission plus tcs tds': '260.55', 'prepaid tcs amount': '6.79', 'prepaid tds amount': '1.358', 'prepaid fixed cost': '50.0' };
  const r = parsePaymentDetails(csv([row, { ...row, 'invoice number': 'I0000TEST000099', 'prepaid forward utr number': '', 'prepaid reverse utr number': '' }]));
  assert.equal(r.kind, 'payment_details');
  assert.deepEqual(r.checks.map(c => c.ok), [true, true, true]);
  assert.equal(r.lines.length, 2);
  const [f, v] = r.lines;
  assert.deepEqual([f.dir, f.commission, f.fee, f.net, f.settled_on], ['forward', 252.402, 59, 1106.45, '2026-10-22']);
  assert.deepEqual([v.dir, v.commission, v.fee, v.net, v.settled_on], ['reverse', 252.402, 125.08, -1290.53, '2026-10-23']);
});

test('payment details: not a settled line (no UTR yet), a forward line that does not add up, an unknown charge', () => {
  const row = { 'invoice number': 'I0000TEST000001', 'order line id': 'L1', 'seller order id': 'u1', 'prepaid seller product amount': '1326', 'prepaid fixed cost': '50', 'prepaid payment eligible forward': '1259.4' };
  assert.equal(parsePaymentDetails(csv([row])).lines.length, 0);               // no UTR: unpaid, not stored
  const off = parsePaymentDetails(csv([{ ...row, 'prepaid forward utr number': 'NFT-/XUTR/DEUTH0TEST00CCCCX', 'prepaid payment eligible forward': '1200', 'prepaid total commission plus tcs tds': '7.577', 'prepaid tcs amount': '6.314', 'prepaid tds amount': '1.263' }]));
  assert.equal(off.checks.find(c => c.id === 'adds_up')!.ok, false);
  const extra = parsePaymentDetails(csv([{ ...row, 'prepaid forward utr number': 'NFT-/XUTR/DEUTH0TEST00CCCCX', 'prepaid tech enablement charges': '3' }]));
  assert.equal(extra.checks.find(c => c.id === 'known_charges')!.ok, false);
  assert.throws(() => parsePaymentDetails('a,b\n1,2'), /payment details report/);
});

test('isXlsx tells the two files apart by their first bytes', () => {
  assert.equal(isXlsx(new Uint8Array([0x50, 0x4b, 3, 4])), true);
  assert.equal(isXlsx(new TextEncoder().encode('invoice number,order line id')), false);
});

// ── Payouts, the bank, and the shares ────────────────────────────────────────────────────────────────────────────────
const line = (invoice: string, dir: 'forward' | 'reverse', net: number, over: Partial<SettlementLine> = {}): SettlementLine => ({
  utr: UTR, settled_on: '2026-10-30', invoice, line_id: 'L-' + invoice, order_ref: 'u', stream: 'postpaid', dir, product: 1326, commission: 0,
  fee: dir === 'forward' ? 59 : 125.08, tcs: 6.314, tds: 1.263, net, ...over });
const THE_PAYOUT = [line('I0000TEST000047', 'forward', 1259.423), line('I0000TEST000058', 'forward', 1259.423), line('I0000TEST000058', 'reverse', -1443.503)];
const bank = (credit: number, remarks = 'NEFT-DEUTH0TEST00A2EWN-MYNTRA DESIGNS PRIVATE LIMITED-97092 DIZKSLS6VR130K-2056539000-DEUT0', txn_date = '2026-10-30', id = 1): BankCredit => ({ id, txn_date, credit, remarks });

test('a payout is the sum of its lines; its UTR is found in the bank narration and the amount must agree to the paisa', () => {
  assert.equal(utrKey(UTR), 'DEUTH0TEST00A2EW'.slice(0, 16));
  const [p] = payoutsOf(THE_PAYOUT);
  assert.deepEqual({ net: p.net, lines: p.lines, forward: p.forward, reverse: p.reverse, orders: p.orders, on: p.settled_on }, { net: 1075.34, lines: 3, forward: 2, reverse: 1, orders: 2, on: '2026-10-30' });
  assert.equal(tieToBank(p, [bank(1075.34)]).state, 'tied');
  assert.equal(tieToBank(p, [bank(1075.35)]).state, 'tied');                       // a paisa is rounding
  const off = tieToBank(p, [bank(1000)]);
  assert.deepEqual([off.state, off.diff], ['differs', -75.34]);
  assert.equal(tieToBank(p, []).state, 'not_in_bank');
  assert.equal(tieToBank(p, [bank(1075.34, 'NEFT-SOMEONE ELSE')]).state, 'not_in_bank');
});

test('the lines carry the bank credit exactly: the running total is rounded, not each line', () => {
  assert.deepEqual(allocateShares(THE_PAYOUT, 1075.34), [1259.42, 1259.43, -1443.51]);      // 1259.423 + 1259.423 = 2518.846, which is 2518.85: the second line takes the extra paisa
  // three lines of x.xx5 would each round up and drift by 3 paise
  const drift = [1.005, 1.005, 1.005].map((net, i) => ({ invoice: 'I' + i, line_id: 'L', stream: 'prepaid' as const, dir: 'forward' as const, net }));
  const shares = allocateShares(drift, 3.02);
  assert.equal(Math.round(shares.reduce((a, b) => a + b, 0) * 100), 302);
  // property: whatever the amounts, the shares add up to the credit
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 200; n++) {
    const ls = Array.from({ length: 1 + Math.floor(rnd() * 9) }, (_, i) => ({ invoice: 'I' + i, line_id: 'L' + i, stream: 'prepaid' as const, dir: rnd() < 0.3 ? 'reverse' as const : 'forward' as const, net: Math.round((rnd() * 2000 - 400) * 1000) / 1000 }));
    const credit = Math.round(ls.reduce((s, l) => s + l.net, 0) * 100) / 100;
    assert.equal(Math.round(allocateShares(ls, credit).reduce((a, b) => a + b, 0) * 100), Math.round(credit * 100));
  }
});

test('settlementFacts: only payouts proved by a bank credit on or after the cutoff become order facts, dated by the bank', () => {
  const { facts, payouts } = settlementFacts(THE_PAYOUT, [bank(1075.34, undefined, '2026-10-31')], '2026-10-01');
  assert.deepEqual(payouts.map(p => p.state), ['tied']);
  assert.deepEqual([...facts.keys()], ['I0000TEST000047', 'I0000TEST000058']);
  const f58 = facts.get('I0000TEST000058')![0];
  assert.deepEqual([f58.utr, f58.date, f58.lines.map(l => [l.dir, l.share])], [UTR, '2026-10-31', [['forward', 1259.43], ['reverse', -1443.51]]]);
  assert.equal(settlementFacts(THE_PAYOUT, [bank(1075.34)], '2026-11-01').facts.size, 0);            // money received before the cutoff is never touched
  assert.equal(settlementFacts(THE_PAYOUT, [bank(999)], '2026-10-01').facts.size, 0);                // the total differs: nothing is booked
  assert.equal(settlementFacts(THE_PAYOUT, [], '2026-10-01').facts.size, 0);                          // not in the bank statement yet
});

// ── The ledger's side ────────────────────────────────────────────────────────────────────────────────────────────────
const sumAcc = (legs: Array<[string, number, number]>, account: string) => Math.round(legs.filter(l => l[0] === account).reduce((s, l) => s + l[1] - l[2], 0) * 100) / 100;
const forward47: MyntraSettlement = { utr: UTR, date: '2026-10-30', lines: [{ dir: 'forward', product: 1326, commission: 0, fee: 59, tcs: 6.314, tds: 1.263, share: 1259.42 }] };
const both58: MyntraSettlement = { utr: UTR, date: '2026-10-30', lines: [
  { dir: 'forward', product: 1326, commission: 0, fee: 59, tcs: 6.314, tds: 1.263, share: 1259.42 },
  { dir: 'reverse', product: 1326, commission: 0, fee: 125.08, tcs: 6.314, tds: 1.263, share: -1443.5 }] };

test('a kept order: bank share, fixed fee, its GST, TCS and TDS against what Myntra owed; the paisa goes in the TCS line', () => {
  const legs = settlementLines(forward47)!;
  assert.deepEqual(legs.map(l => l[0]), [BANK, GATEWAY_FEE, GST_INPUT_IGST, 'Tax Collected at source 26-27', 'Tax Deducted at source 26-27', MYNTRA]);
  assert.deepEqual(legs.map(l => [l[1], l[2]]), [[1259.42, 0], [50, 0], [9, 0], [6.32, 0], [1.26, 0], [0, 1326]]);
  assert.equal(Math.round(legs.reduce((s, l) => s + l[1] - l[2], 0) * 100), 0);
});

test('a returned order paid and taken back in one payout: only what it cost is left, money, TCS, TDS and the receivable cancel', () => {
  const legs = settlementLines(both58)!;
  assert.deepEqual(legs.map(l => [l[0], l[1], l[2]]), [[BANK, 0, 184.08], [GATEWAY_FEE, 50, 0], [MYNTRA_RETURN_FEE, 106, 0], [GST_INPUT_IGST, 28.08, 0]]);
});

test('commission is its own line with its GST claimed as input, and a return gives it back', () => {
  const paid: MyntraSettlement = { utr: UTR, date: '2026-10-22', lines: [{ dir: 'forward', product: 1426, commission: 252.402, fee: 59, tcs: 6.79, tds: 1.358, share: 1106.45 }] };
  const legs = settlementLines(paid)!;
  assert.equal(sumAcc(legs, MYNTRA_COMMISSION), 213.9);
  assert.equal(sumAcc(legs, GST_INPUT_IGST), 47.5);                 // 38.50 on the commission + 9 on the fixed fee
  const taken: MyntraSettlement = { utr: 'U2', date: '2026-10-23', lines: [{ dir: 'reverse', product: 1426, commission: 252.402, fee: 125.08, tcs: 6.79, tds: 1.358, share: -1290.53 }] };
  const back = settlementLines(taken)!;
  assert.equal(sumAcc(back, MYNTRA_COMMISSION), -213.9);
  assert.equal(sumAcc(back, MYNTRA_RETURN_FEE), 106);
  assert.equal(sumAcc(back, MYNTRA), 1426);                         // the receivable is open again until the credit note
});

test('a line more than 5 paise out is refused, and the financial year picks the TCS / TDS ledger', () => {
  assert.equal(settlementLines({ ...forward47, lines: [{ ...forward47.lines[0], share: 1259.0 }] }), null);
  assert.deepEqual([fyLabel('2026-03-31'), fyLabel('2026-04-01'), fyLabel('2026-10-30'), fyLabel('2027-04-01')], ['25-26', '26-27', '26-27', '27-28']);
  assert.equal(settlementLines({ ...forward47, date: '2027-04-02' })!.some(l => l[0] === 'Tax Collected at source 27-28'), true);
});

const order = (name: string, extra: Partial<Facts> = {}): Facts => ({ order: name, channel: 'myntra', rate: 0.05, igst: true, goods: 1326, codFee: 0, saleDate: '2026-10-12', saleDoc: name, qty: 1, ...extra });
const CUTOFF = '2026-10-01';

test('ledger: a kept order is complete once its payout is booked; before it, it is awaiting settlement', () => {
  assert.equal(buildOrderLedger(order('I1'), { cutoff: CUTOFF }).exceptions[0].type, 'awaiting_settlement');
  const l = buildOrderLedger(order('I1', { myntraSettlements: [forward47] }), { cutoff: CUTOFF });
  assert.equal(l.net, 0); assert.equal(l.status, 'complete'); assert.deepEqual(l.exceptions, []);
  const settlement = l.entries.filter(e => e.voucher === 'settlement');
  assert.ok(settlement.length > 0 && settlement.every(e => e.date === '2026-10-30' && e.doc === UTR && e.by === 'myntra'));
  assert.equal(l.exportable.length, l.entries.length);
});

test('ledger: a returned order awaits its parcel after Myntra took the money back, and is complete once the credit note exists', () => {
  const open = buildOrderLedger(order('I2', { myntraSettlements: [both58] }), { cutoff: CUTOFF });
  assert.equal(open.net, 1326); assert.equal(open.exceptions[0].type, 'awaiting_return'); assert.equal(open.status, 'open');
  const credited = buildOrderLedger(order('I2', { myntraSettlements: [both58], returns: [{ kind: 'customer', date: '2026-11-04', goodsReturned: 1326, uc: { doc: 'ISR1', goods: 1326, codFee: 0 } }] }), { cutoff: CUTOFF });
  assert.equal(credited.net, 0); assert.equal(credited.status, 'complete');
  // the same order with no payout at all (Myntra netted it before paying) is complete too: no money moved
  const none = buildOrderLedger(order('I3', { returns: [{ kind: 'customer', date: '2026-11-04', goodsReturned: 1326, uc: { doc: 'ISR2', goods: 1326, codFee: 0 } }] }), { cutoff: CUTOFF });
  assert.equal(none.status, 'complete');
});

test('ledger: credit note issued while Myntra has paid and not yet taken the money back is an open stage, not an error', () => {
  const l = buildOrderLedger(order('I4', { myntraSettlements: [forward47], returns: [{ kind: 'customer', date: '2026-11-04', goodsReturned: 1326, uc: { doc: 'ISR3', goods: 1326, codFee: 0 } }] }), { cutoff: CUTOFF });
  assert.equal(l.net, -1326); assert.equal(l.exceptions[0].type, 'awaiting_clawback'); assert.equal(l.status, 'open');
  // when the taken-back line arrives in a later payout, it completes
  const later: MyntraSettlement = { utr: 'U2', date: '2026-11-12', lines: [{ dir: 'reverse', product: 1326, commission: 0, fee: 125.08, tcs: 6.314, tds: 1.263, share: -1443.5 }] };
  const done = buildOrderLedger(order('I4', { myntraSettlements: [forward47, later], returns: [{ kind: 'customer', date: '2026-11-04', goodsReturned: 1326, uc: { doc: 'ISR3', goods: 1326, codFee: 0 } }] }), { cutoff: CUTOFF });
  assert.equal(done.net, 0); assert.equal(done.status, 'complete');
});

test('ledger: a payout line that does not add up is an exception and books nothing', () => {
  const l = buildOrderLedger(order('I5', { myntraSettlements: [{ ...forward47, lines: [{ ...forward47.lines[0], share: 1000 }] }] }), { cutoff: CUTOFF });
  assert.equal(l.entries.some(e => e.voucher === 'settlement'), false);
  assert.equal(l.exceptions[0].type, 'bad_facts');
});

test('a payout dated before the cutoff is not exportable', () => {
  const l = buildOrderLedger(order('I6', { myntraSettlements: [{ ...forward47, date: '2026-09-29' }] }), { cutoff: CUTOFF });
  assert.equal(l.exportable.some(e => e.voucher === 'settlement'), false);
});

test('the fingerprint of an order\'s payouts ignores order and key order but notices any change', () => {
  const a: MyntraSettlement = { utr: 'U1', date: '2026-10-22', lines: [{ dir: 'forward', product: 1326, commission: 0, fee: 59, tcs: 6.314, tds: 1.263, share: 1259.42 }] };
  const b: MyntraSettlement = { utr: 'U2', date: '2026-10-30', lines: [{ dir: 'reverse', product: 1326, commission: 0, fee: 125.08, tcs: 6.314, tds: 1.263, share: -1443.5 }] };
  assert.equal(settlementFingerprint([a, b]), settlementFingerprint([b, a]));
  assert.equal(settlementFingerprint(undefined), settlementFingerprint([]));
  assert.notEqual(settlementFingerprint([a]), settlementFingerprint([a, b]));
  assert.notEqual(settlementFingerprint([a]), settlementFingerprint([{ ...a, date: '2026-10-23' }]));
  const viaJson = JSON.parse(JSON.stringify(a));       // what comes back from jsonb
  assert.equal(settlementFingerprint([viaJson]), settlementFingerprint([a]));
});
