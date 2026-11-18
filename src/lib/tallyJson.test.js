import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTallyFile, tallyVoucher, tallyState, guid } from './tallyJson.js';
import { groupOrderVouchers } from './tallyVouchers.js';

const e = (order_name, entry_date, voucher, account, debit, credit, extra = {}) => ({ order_name, entry_date, voucher, account, debit, credit, doc: null, issued_by: 'x', memo: '', part: null, qty: null, ...extra });
const entries = [
  e('A', '2026-10-03', 'sale', 'Customer (order control)', 1050, 0, { doc: 'INS1' }), e('A', '2026-10-03', 'sale', 'GST SALES', 0, 1000, { doc: 'INS1' }), e('A', '2026-10-03', 'sale', 'IGST OUTPUT UP', 0, 50, { doc: 'INS1' }),
  e('A', '2026-10-03', 'payment', 'Easebuzz Private Limited', 1050, 0), e('A', '2026-10-03', 'payment', 'Customer (order control)', 0, 1050),
  e('A', '2026-10-06', 'payout', 'ICICI Bank', 1030, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'Payment Gateway Expenses', 17, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'IGST Input  UP', 3, 0, { doc: 'U1' }), e('A', '2026-10-06', 'payout', 'Easebuzz Private Limited', 0, 1050, { doc: 'U1' }),
  e('A', '2026-10-10', 'credit_note', 'GST SALES RETURN', 200, 0, { doc: 'ISR1' }), e('A', '2026-10-10', 'credit_note', 'IGST OUTPUT UP', 10, 0, { doc: 'ISR1' }), e('A', '2026-10-10', 'credit_note', 'Customer (order control)', 0, 210, { doc: 'ISR1' }),
];
const orders = new Map([['A', { state: 'Jammu and Kashmir', saleDoc: 'INS1', channel: 'shopify' }]]);
const find = (file, type) => file.tallymessage.find(m => m.vouchertypename === type);

test('a sale: party on top, place of supply in Tally\'s spelling, debits negative and credits positive, a New Ref bill named by the invoice', () => {
  const { file, errors } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  assert.deepEqual(errors, []);
  const s = find(file, 'SALES UP');
  assert.deepEqual([s.date, s.vouchernumber, s.partyledgername, s.placeofsupply, s.gstregistrationtype, s.vchentrymode], ['20261003', 'INS1', 'Customer (order control)', 'Jammu & Kashmir', 'Unregistered/Consumer', 'Accounting Invoice']);
  const cust = s.allledgerentries.find(x => x.ledgername === 'Customer (order control)');
  assert.deepEqual([cust.isdeemedpositive, cust.amount, cust.ispartyledger], [true, '-1050.00', true]);
  assert.deepEqual(cust.billallocations, [{ name: 'INS1', billtype: 'New Ref', amount: '-1050.00' }]);
  assert.deepEqual(s.allledgerentries.filter(x => !x.isdeemedpositive).map(x => [x.ledgername, x.amount]), [['GST SALES', '1000.00'], ['IGST OUTPUT UP', '50.00']]);
});

test('a credit note clears the customer\'s bill against the sale invoice; a payout is a receipt with the UTR on the bank line and a bill per order', () => {
  const { file } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  const cn = find(file, 'Credit Note');
  assert.deepEqual(cn.allledgerentries.find(x => x.ledgername === 'Customer (order control)').billallocations, [{ name: 'INS1', billtype: 'Agst Ref', amount: '210.00' }]);
  const rc = find(file, 'Receipt');
  const bank = rc.allledgerentries.find(x => x.ledgername === 'ICICI Bank');
  assert.deepEqual([bank.amount, bank.bankallocations[0].instrumentnumber, bank.isdeemedpositive], ['-1030.00', 'U1', true]);
  assert.deepEqual(rc.allledgerentries.find(x => x.ledgername === 'Easebuzz Private Limited').billallocations, [{ name: 'A', billtype: 'Agst Ref', amount: '1050.00' }]);
  assert.equal(rc.partyledgername, 'Easebuzz Private Limited');
});

test('a clearing journal: the gateway receivable starts a bill named by the order, the customer\'s bill is cleared against the invoice', () => {
  const { file } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  const j = find(file, 'Journal');
  assert.match(j.vouchernumber, /^GW\/A\/1003$/);
  assert.deepEqual(j.allledgerentries.find(x => x.ledgername === 'Easebuzz Private Limited').billallocations, [{ name: 'A', billtype: 'New Ref', amount: '-1050.00' }]);
  assert.deepEqual(j.allledgerentries.find(x => x.ledgername === 'Customer (order control)').billallocations, [{ name: 'INS1', billtype: 'Agst Ref', amount: '1050.00' }]);
});

test('every voucher in the file sums to zero and the ledger totals equal the ledger\'s: the built-in checks pass', () => {
  const { file, checks } = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders });
  for (const m of file.tallymessage) assert.equal(Math.round(m.allledgerentries.reduce((s, x) => s + Number(x.amount), 0) * 100) / 100, 0, m.vouchernumber);
  assert.deepEqual(checks.map(c => c.ok), [true, true, true]);
});

test('an order with no state is left out and said so; an unbalanced voucher is left out too', () => {
  const noState = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders: new Map([['A', { saleDoc: 'INS1' }]]) });
  assert.equal(noState.errors.filter(x => /no state on order A/.test(x.problem)).length, 2);   // the sale and the credit note
  assert.equal(noState.checks.find(c => c.id === 'skipped').ok, false);
  const bad = buildTallyFile({ vouchers: groupOrderVouchers([...entries, e('Z', '2026-10-11', 'goodwill', 'Goodwill credits', 100, 0), e('Z', '2026-10-11', 'goodwill', 'STORE CREDIT BY SHOPIFY', 0, 90)]), orders });
  assert.match(bad.errors.find(x => /goodwill/.test(x.id)).problem, /does not balance/);
});

test('the same voucher always gets the same GUID, so a second import is recognised', () => {
  const a = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders }).file.tallymessage.map(m => m.guid);
  const b = buildTallyFile({ vouchers: groupOrderVouchers(entries), orders }).file.tallymessage.map(m => m.guid);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length);
  assert.match(a[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(guid('x'), guid('y'));
});

test('the test file keeps only the first few vouchers of each type', () => {
  const many = [];
  for (let i = 0; i < 6; i++) many.push(e(`O${i}`, '2026-10-03', 'payment', 'Easebuzz Private Limited', 10, 0), e(`O${i}`, '2026-10-03', 'payment', 'Customer (order control)', 0, 10));
  const { file, counts } = buildTallyFile({ vouchers: groupOrderVouchers(many), orders: new Map(), limit: 3 });
  assert.equal(file.tallymessage.length, 3);
  assert.equal(counts.journal, 3);
});

test('state names follow Tally\'s spelling', () => {
  assert.equal(tallyState('Jammu and Kashmir'), 'Jammu & Kashmir');
  assert.equal(tallyState('Andaman and Nicobar Islands'), 'Andaman & Nicobar Islands');
  assert.equal(tallyState('Dadra and Nagar Haveli and Daman and Diu'), 'Dadra & Nagar Haveli and Daman & Diu');
  assert.equal(tallyState('Uttar Pradesh'), 'Uttar Pradesh');
  assert.equal(tallyState(null), '');
});

test('two clearing journals of one order on one day get different voucher numbers', () => {
  const two = [e('Q', '2026-10-03', 'payment', 'Easebuzz Private Limited', 10, 0, { doc: 'T1' }), e('Q', '2026-10-03', 'payment', 'Customer (order control)', 0, 10, { doc: 'T1' }),
    e('Q', '2026-10-03', 'payment', 'Easebuzz Private Limited', 20, 0, { doc: 'T2' }), e('Q', '2026-10-03', 'payment', 'Customer (order control)', 0, 20, { doc: 'T2' })];
  const { file } = buildTallyFile({ vouchers: groupOrderVouchers(two), orders: new Map() });
  assert.deepEqual(file.tallymessage.map(m => m.vouchernumber), ['GW/Q/1003', 'GW/Q/1003-2']);
});
