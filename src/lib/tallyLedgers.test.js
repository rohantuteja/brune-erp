import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgersFile } from './tallyLedgers.js';

const rows = [
  { name: 'ICICI Bank', under: 'Bank Accounts', status: 'in_tally' },
  { name: 'Customer (order control)', under: 'Sundry Debtors', status: 'will_create' },
  { name: 'Myntra receivable (order control)', under: 'Sundry Debtors', status: 'will_create' },
  { name: 'Myntra Commission', under: 'Indirect Expenses', status: 'will_create' },
  { name: 'Tax Collected at source 26-27', under: 'Current Assets', status: 'will_create' },
  { name: 'COD receivable (Velocity)', under: 'Sundry Debtors', status: 'will_rename', renamed_from: 'Outstanding COD Sales White Wizzard' },
];

test('only the ledgers still to create go in the file, each under its group', () => {
  const { file, create, rename } = buildLedgersFile(rows);
  assert.deepEqual(file.tallymessage.map(m => [m.name, m.parent]), [['Customer (order control)', 'Sundry Debtors'], ['Myntra Commission', 'Indirect Expenses'], ['Myntra receivable (order control)', 'Sundry Debtors'], ['Tax Collected at source 26-27', 'Current Assets']]);
  assert.equal(create.length, 4);
  assert.deepEqual(rename.map(r => r.name), ['COD receivable (Velocity)']);                  // renames are listed for the accountant, never in the file
});

test('the customer control ledgers are bill by bill and unregistered/consumer; plain ledgers carry only name and group', () => {
  const m = Object.fromEntries(buildLedgersFile(rows).file.tallymessage.map(x => [x.name, x]));
  assert.equal(m['Customer (order control)'].isbillwiseon, true);
  assert.equal(m['Customer (order control)'].gstregistrationtype, 'Unregistered/Consumer');
  assert.equal(m['Myntra receivable (order control)'].isbillwiseon, true);
  assert.equal(m['Myntra Commission'].isbillwiseon, undefined);
  assert.equal(m['Tax Collected at source 26-27'].gstregistrationtype, undefined);
  assert.deepEqual(m['Myntra Commission'].metadata.action, 'Create');
  assert.equal(m['Myntra Commission'].metadata.type, 'Ledger');
});

test('nothing to create gives an empty file', () => {
  assert.deepEqual(buildLedgersFile([{ name: 'ICICI Bank', under: 'Bank Accounts', status: 'in_tally' }]).file.tallymessage, []);
});

test('one file: the ledgers to create come first, then the vouchers, so a single import creates and then posts', async () => {
  const { withLedgers } = await import('./tallyLedgers.js');
  const vouchers = { tallymessage: [{ metadata: { type: 'Voucher' }, vouchernumber: 'INS1' }, { metadata: { type: 'Voucher' }, vouchernumber: 'INS2' }] };
  const out = withLedgers(vouchers, rows);
  assert.deepEqual(out.tallymessage.map(m => m.metadata.type), ['Ledger', 'Ledger', 'Ledger', 'Ledger', 'Voucher', 'Voucher']);
  assert.equal(out.tallymessage[0].name, 'Customer (order control)');
  assert.deepEqual(withLedgers(vouchers, []).tallymessage.map(m => m.metadata.type), ['Voucher', 'Voucher']);       // nothing missing: vouchers only
});

test('a supplier\'s own ledger is created with its GSTIN, PAN, state and registration type, never as a bare name', () => {
  const ledgers = [{ name: 'VIPUL ENTERPRISES', under: 'Sundry Creditors', status: 'will_create' }, { name: 'Goodwill credits', under: 'Indirect Expenses', status: 'will_create' }];
  const vendors = [{ name: 'VIPUL ENTERPRISES', tally_ledger_name: 'VIPUL ENTERPRISES', gstin: '07AFJPJ5098M1ZS', pan: 'AFJPJ5098M', state_code: '07' }];
  const m = buildLedgersFile(ledgers, vendors).file.tallymessage;
  const v = m.find(x => x.name === 'VIPUL ENTERPRISES');
  assert.deepEqual([v.parent, v.isbillwiseon, v.gstregistrationtype, v.partygstin, v.incometaxnumber, v.ledstatename, v.countryofresidence], ['Sundry Creditors', true, 'Regular', '07AFJPJ5098M1ZS', 'AFJPJ5098M', 'Delhi', 'India']);
  assert.deepEqual(v.ledgstregdetails[0], { applicablefrom: '20260401', gstregistrationtype: 'Regular', placeofsupply: 'Delhi', gstin: '07AFJPJ5098M1ZS' });
  assert.equal(v.ledgermailingdetails[0].state, 'Delhi');
  assert.equal(m.find(x => x.name === 'Goodwill credits').partygstin, undefined);                       // an expense ledger stays as it was
  const noGstin = buildLedgersFile([{ name: 'Local Shop', under: 'Sundry Creditors', status: 'will_create' }], [{ name: 'Local', tally_ledger_name: 'Local Shop', gstin: null, pan: 'ABCDE1234F', state_code: '09' }]).file.tallymessage[0];
  assert.deepEqual([noGstin.gstregistrationtype, noGstin.incometaxnumber, noGstin.ledstatename, noGstin.partygstin], ['Unregistered/Consumer', 'ABCDE1234F', 'Uttar Pradesh', undefined]);
});
