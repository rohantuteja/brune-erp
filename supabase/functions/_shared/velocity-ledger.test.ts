// Made-up wallet lines and a made-up invoice, shaped like Velocity's ledger report and tax invoice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exGst, invoiceCheck, kindOf, matchTopUps, parseVelocityInvoice, parseWalletLedger, VELOCITY_HANDLE } from './velocity-ledger.ts';

const HEAD = 'Transaction Type,Amount,Balance,Tracking Number,Notes,Created At';
// Opening balance 1000.00. The first two lines happened in the same second, and the file is not in time order (as Velocity's is).
const ROWS = [
  'Credit,41.30,10941.0,A1,COD Charges Reversed,2026-09-03 09:00:00',
  'Debit,41.3,899.7,A1,COD Charges,2026-09-01 00:10:00',
  'Debit,59.0,941.0,A1,Shipping Charges,2026-09-01 00:10:00',
  'Credit,10000.0,10899.7,,Wallet Recharge,2026-09-02 08:00:00',
  'Debit,0.59,10940.41,A2,Automation WhatsApp NDR Management Service Charge for Order 1,2026-09-03 09:00:05',
  'Debit,53.1,10887.31,A2,RTO Charges,2026-09-04 10:00:00',
  'Credit,118.0,11005.31,A3,Being financial note issued for lost Shipment,2026-09-05 11:00:00',
];
const FILE = [HEAD, ...ROWS].join('\r\n');

test('every kind of line is recognised from its note', () => {
  assert.equal(kindOf('Shipping Charges'), 'shipping'); assert.equal(kindOf('COD Charges'), 'cod_charge'); assert.equal(kindOf('RTO Charges'), 'rto');
  assert.equal(kindOf('Automation WhatsApp NDR Management Service Charge for Order 37023'), 'ndr_automation');
  assert.equal(kindOf('Weight Discrepancy Shipping Charge Deducted'), 'weight_discrepancy'); assert.equal(kindOf('Weight Discrepancy RTO Charge Deducted'), 'weight_discrepancy');
  assert.equal(kindOf('COD Charges Reversed'), 'cod_reversal'); assert.equal(kindOf('Shipping Charges Reversed'), 'shipping_reversal');
  assert.equal(kindOf('Being financial note issued for lost Shipment'), 'financial_note'); assert.equal(kindOf('Wallet Recharge'), 'recharge');
  assert.equal(kindOf('Something new'), 'other');
});

test('a ledger is read line by line, GST-inclusive amounts split into the amount before GST, and the opening and closing balance found', () => {
  const p = parseWalletLedger(FILE);
  assert.equal(p.lines.length, 7);
  assert.equal(p.period_from, '2026-09-01'); assert.equal(p.period_to, '2026-09-05');
  assert.equal(p.opening, 1000); assert.equal(p.closing, 11005.31);
  assert.ok(p.checks.every(c => c.ok), JSON.stringify(p.checks));
  const cod = p.lines.find(l => l.kind === 'cod_charge')!;
  assert.deepEqual([cod.direction, cod.amount, cod.ex_gst, cod.awb, cod.txn_at], ['debit', 41.3, 35, 'A1', '2026-09-01 00:10:00']);   // 41.30 = 35.00 + 18%
  const topup = p.lines.find(l => l.kind === 'recharge')!;
  assert.deepEqual([topup.direction, topup.amount, topup.ex_gst, topup.awb], ['credit', 10000, null, null]);
  assert.equal(p.lines.find(l => l.kind === 'financial_note')!.ex_gst, null);
});

test('a ledger with a line missing or changed does not tie out and is reported', () => {
  const missing = parseWalletLedger([HEAD, ...ROWS.filter(r => !r.includes('Wallet Recharge'))].join('\n'));
  assert.equal(missing.checks.find(c => c.id === 'running_balance')!.ok, false);
  const changed = parseWalletLedger([HEAD, ...ROWS.map(r => r.replace('Debit,53.1,', 'Debit,63.1,'))].join('\n'));
  assert.equal(changed.checks.find(c => c.id === 'running_balance')!.ok, false);
});

test('repeated lines, unreadable rows and notes not seen before are reported; a file that is not a ledger is refused', () => {
  const twice = parseWalletLedger([HEAD, ...ROWS, ROWS[0]].join('\n'));
  assert.equal(twice.checks.find(c => c.id === 'unique_lines')!.ok, false);
  const junk = parseWalletLedger([HEAD, ...ROWS, 'Debit,abc,1,,Shipping Charges,2026-09-05 12:00:00'].join('\n'));
  assert.equal(junk.checks.find(c => c.id === 'rows_readable')!.ok, false);
  const odd = parseWalletLedger([HEAD, 'Debit,10.0,990.0,,Mystery fee,2026-09-01 00:00:00'].join('\n'));
  assert.equal(odd.checks.find(c => c.id === 'known_notes')!.ok, false);
  assert.throws(() => parseWalletLedger('a,b\n1,2'), /no "transaction type" column/);
  assert.throws(() => parseWalletLedger(''), /empty/);
});

const INVOICE_TEXT = `TAX
INVOICE
White Wizard Technologies Pvt. Ltd.
Some Street, Bangalore - 560102
GSTIN: 29AAAAA0000A1ZA
Invoice To:
Example Company Private Limited
Noida
Invoice Period: 01/09/2026 to 30/09/2026
Invoice No.: SF/1026/0001
Invoice Date: 01/10/2026
Due Date: 08/10/2026
Place of Supply: Uttar Pradesh
GSTIN: 09BBBBB1111B1ZB
SAC No. Description Total
996812 VAS Charges ₹10.00
996812 Velocity Freight Charges ₹1,090.00
IGST (18%) ₹198.00
Grand Total Value ₹1,298.00`;

test('a Velocity tax invoice is read: number, dates, GSTINs, lines, tax and total, and it is checked to add up', () => {
  const inv = parseVelocityInvoice(INVOICE_TEXT);
  assert.deepEqual([inv.invoice_no, inv.invoice_date, inv.period_from, inv.period_to], ['SF/1026/0001', '2026-10-01', '2026-09-01', '2026-09-30']);
  assert.deepEqual([inv.supplier_gstin, inv.bill_to_gstin], ['29AAAAA0000A1ZA', '09BBBBB1111B1ZB']);
  assert.deepEqual(inv.lines, [{ sac: '996812', description: 'VAS Charges', amount: 10 }, { sac: '996812', description: 'Velocity Freight Charges', amount: 1090 }]);
  assert.deepEqual([inv.subtotal, inv.tax, inv.total], [1100, 198, 1298]);
  assert.ok(inv.checks.every(c => c.ok), JSON.stringify(inv.checks));
  const wrong = parseVelocityInvoice(INVOICE_TEXT.replace('₹1,298.00', '₹1,300.00'));
  assert.equal(wrong.checks.find(c => c.id === 'adds_up')!.ok, false);
  const badRate = parseVelocityInvoice(INVOICE_TEXT.replace('IGST (18%) ₹198.00', 'IGST (18%) ₹150.00').replace('₹1,298.00', '₹1,250.00'));
  assert.equal(badRate.checks.find(c => c.id === 'gst_rate')!.ok, false);
});

test('anything that is not a Velocity invoice is refused', () => {
  assert.throws(() => parseVelocityInvoice('TAX INVOICE Some Other Company'), /does not look like a Velocity/);
  assert.throws(() => parseVelocityInvoice('White Wizard Technologies TAX INVOICE nothing else'), /could not read/);
});

test('a month of ledger lines is compared with the invoice before GST; every way of netting credits is shown and the closest is named', () => {
  const L = (kind: string, direction: 'debit' | 'credit', amount: number) => ({ kind: kind as any, direction, amount, ex_gst: kind === 'recharge' ? null : exGst(amount) });
  const lines = [
    L('shipping', 'debit', 944), L('cod_charge', 'debit', 118), L('rto', 'debit', 59),                 // 800 + 100 + 50 before GST
    L('ndr_automation', 'debit', 11.8),                                                                  // 10
    L('shipping_reversal', 'credit', 59), L('cod_reversal', 'credit', 35.4), L('financial_note', 'credit', 118), L('recharge', 'credit', 10000),   // 50, 30 and 100 before GST
  ];
  const c = invoiceCheck(lines, { lines: [{ sac: '996812', description: 'VAS Charges', amount: 10 }, { sac: '996812', description: 'Velocity Freight Charges', amount: 800 }] });
  assert.deepEqual(c.vas, { invoice: 10, ledger: 10, diff: 0 });
  assert.equal(c.freight!.invoice, 800);
  assert.equal(c.freight!.closest.diff, 0);
  assert.equal(c.freight!.closest.label, 'all charges, less shipping-charge reversals and lost-shipment credits');
  assert.equal(c.freight!.variants.length, 8);
  assert.equal(c.gross_debits_ex_gst, 950); assert.equal(c.credits_ex_gst, 180);
});

test('the Velocity payee is recognised under each handle seen on the bank statement', () => {
  for (const r of ['UPI/1/UPI Pay/shipfast.cf@axi//ICI1', 'UPI/2/UPI Pay/cf.shipfast@cas//ICI2', 'UPI/3/UPI Pay/XXt.cf@axisban//ICI3', 'UPI/4/velocity/XXt.cf@axisban//ICI4', 'UPI/6/UPI Pay/XXfast@cashfre//ICI6']) assert.ok(VELOCITY_HANDLE.test(r), r);
  assert.ok(!VELOCITY_HANDLE.test('UPI/5/UPI Pay/someone@ybl//ICI5'));
});

test('each wallet top-up is matched to the bank payment that funded it, one bank line for one top-up', () => {
  const bank = [
    { id: 1, date: '2026-09-02', amount: 10000, remarks: 'UPI/1/UPI Pay/shipfast.cf@axi//ICI1' },
    { id: 2, date: '2026-09-07', amount: 10000, remarks: 'UPI/2/UPI Pay/XXt.cf@axisban//ICI2' },
    { id: 3, date: '2026-09-03', amount: 10000, remarks: 'UPI/3/UPI Pay/someone@ybl//ICI3' },             // not a Velocity handle
    { id: 4, date: '2026-09-20', amount: 5000, remarks: 'UPI/4/UPI Pay/shipfast.cf@axi//ICI4' },          // another amount
  ];
  const top = (key: string, at: string, amount = 10000) => ({ key, at, date: at.slice(0, 10), amount });
  const m = matchTopUps([top('A', '2026-09-02 08:00:00'), top('B', '2026-09-07 05:26:00'), top('C', '2026-09-17 10:25:00'), top('D', '2026-09-03 09:00:00'), top('E', '2026-09-02 09:00:00')], bank);
  assert.equal(m.get('A'), 1); assert.equal(m.get('B'), 2);
  assert.equal(m.has('C'), false);      // no bank payment that day: paid from somewhere else
  assert.equal(m.has('D'), false);      // the only nearby payment is not to a Velocity handle
  assert.equal(m.has('E'), false);      // bank line 1 already served top-up A
});

test('a bank line a person filed as a wallet recharge counts as the payment that funded the top-up, whatever its payee looks like', () => {
  const top = { key: 'T', at: '2026-09-17 10:25:08', date: '2026-09-17', amount: 10000 };
  const odd = { id: 9, date: '2026-09-17', amount: 10000, remarks: 'UPI/1/UPI Pay/someone.else@bank//ICI1' };
  assert.equal(matchTopUps([top], [odd]).has('T'), false);                           // an unknown payee on its own is not enough
  assert.equal(matchTopUps([top], [{ ...odd, filed: true }]).get('T'), 9);            // but filed there by a person it is
  assert.equal(matchTopUps([top], [{ ...odd, filed: true, amount: 9000 }]).has('T'), false);   // the amount must still agree
  assert.equal(matchTopUps([top], [{ ...odd, filed: true, date: '2026-09-20' }]).has('T'), false);   // and the date
});
