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
