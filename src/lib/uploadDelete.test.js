import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDeletion, deletedMessage } from './uploadDelete.js';

const statement = { kind: 'statement', label: 'DetailedStatement (21).xlsx', account: 'ICICI current account', period_from: '2026-09-01', period_to: '2026-09-30', removed: 102, moved_to_other_upload: 0, moved_to: [], filed_by_hand: 1, topup_payments: 6 };

test('a statement says what goes, what was filed by hand and which top-ups lose their bank payment', () => {
  const d = describeDeletion(statement);
  assert.equal(d.title, 'Delete DetailedStatement (21).xlsx?');
  assert.equal(d.lines[0], 'Removes 102 lines dated 1 Sep 2026 to 30 Sep 2026 from ICICI current account.');
  assert.ok(d.cautions.some(c => c.startsWith('1 removed line was filed by you')));
  assert.ok(d.cautions.some(c => c.includes('6 removed payments funded a Velocity top-up') && c.includes('not in the bank statement')));
});

test('lines another upload also holds are said to stay, naming that upload', () => {
  const d = describeDeletion({ ...statement, removed: 40, moved_to_other_upload: 62, moved_to: [{ id: 'x', filename: 'DetailedStatement (22).xlsx', lines: 62 }], filed_by_hand: 0, topup_payments: 0 });
  assert.equal(d.lines[1], '62 lines are also in DetailedStatement (22).xlsx, so they stay there.');
  assert.ok(!d.cautions.some(c => c.includes('filed by you')));
});

test('an upload that only duplicates another says it removes no lines', () => {
  const d = describeDeletion({ ...statement, removed: 0, moved_to_other_upload: 1, moved_to: [{ filename: 'b.xlsx', lines: 1 }], filed_by_hand: 0, topup_payments: 0 });
  assert.equal(d.lines[0], 'Removes no lines: every line in it is also in another upload and stays.');
  assert.equal(d.lines[1], '1 line is also in b.xlsx, so it stays there.');
});

test('a Velocity ledger says how many top-ups go and which bank payments fall back', () => {
  const d = describeDeletion({ kind: 'velocity_ledger', label: 'ledger.csv', period_from: '2026-09-01', period_to: '2026-09-30', removed: 1571, topups: 6, topup_amount: 60000, moved_to_other_upload: 0, bank_lines_reverting: 5, bank_lines_staying: 1 });
  assert.equal(d.lines[0], 'Removes 1,571 ledger lines for 1 Sep 2026 to 30 Sep 2026, including 6 top-ups totalling ₹60,000.00.');
  assert.ok(d.cautions.includes('5 bank payments these top-ups proved go back to “suggested”.'));
  assert.ok(d.cautions.includes('1 bank payment you confirmed by hand stays as you filed it.'));
});

test('an invoice and a GoKwik report are described in their own terms', () => {
  const inv = describeDeletion({ kind: 'velocity_invoice', label: 'SF/1026/1158', total: 58495.95, period_from: '2026-09-01', period_to: '2026-09-30' });
  assert.equal(inv.lines[0], 'Removes invoice SF/1026/1158 (₹58,495.95 with GST, for 1 Sep 2026 to 30 Sep 2026).');
  const gk = describeDeletion({ kind: 'gokwik_report', label: 'report.csv', removed: 97, payouts: 9, to_bank: 122460.07, period_from: '2026-10-01', period_to: '2026-10-09', bank_lines_reverting: 9, bank_lines_staying: 0 });
  assert.equal(gk.lines[0], 'Removes 97 payments settled 1 Oct 2026 to 9 Oct 2026: ₹1,22,460.07 paid to the bank in 9 payouts.');
  assert.ok(gk.cautions.includes('9 bank credits these payouts proved go back to “suggested”.'));
});

test('the result line counts what went and warns when the re-matching failed', () => {
  assert.equal(deletedMessage({ kind: 'statement', label: 'a.xlsx', removed: 13, moved_to_other_upload: 0 }), 'Deleted a.xlsx: 13 lines removed.');
  assert.equal(deletedMessage({ kind: 'statement', label: 'a.xlsx', removed: 1, moved_to_other_upload: 4 }), 'Deleted a.xlsx: 1 line removed, 4 kept in another upload.');
  assert.match(deletedMessage({ kind: 'gokwik_report', label: 'r.csv', removed: 2, matching_error: 'boom' }), /Re-matching failed \(boom\)/);
  assert.equal(deletedMessage({ kind: 'velocity_invoice', label: 'SF/1' }), 'Deleted SF/1.');
});
