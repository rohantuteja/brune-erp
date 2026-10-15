import test from 'node:test';
import assert from 'node:assert/strict';
import { billSummary, changedEdits, expenseGroups, failedChecks, filterBills, findLedger, ledgerNote, ledgerOk, newVendorDraft, normLedger, outcomeText, similarLedgers } from './billsView.js';

const B = (id, status, o = {}) => ({ id, status, vendor: 'Meta', vendor_id: 1, invoice_no: `INV${id}`, supplier_gstin: '06AABCF5150G1ZZ', total: 100, subtotal: 85, tax: 15, opening: false, file_path: 'p', checks: [], ...o });

test('the status cards count what needs a person, the opening bills and the bills with no PDF', () => {
  const s = billSummary([B(1, 'review', { total: 250.5 }), B(2, 'review', { total: 100 }), B(3, 'accepted', { opening: true, file_path: null }), B(4, 'void', { file_path: null, opening: true })]);
  assert.deepEqual(s, { review: 2, accepted: 1, void: 1, opening: 1, noFile: 1, reviewAmount: 350.5 });
});

test('the filters: status (review by default), vendor, and a search over vendor, number, GSTIN and amount', () => {
  const bills = [B(1, 'review'), B(2, 'accepted', { vendor: 'GoKwik', vendor_id: 4, invoice_no: 'GKHR/1', total: 845 }), B(3, 'void')];
  assert.deepEqual(filterBills(bills).map(b => b.id), [1]);
  assert.deepEqual(filterBills(bills, { status: 'accepted' }).map(b => b.id), [2]);
  assert.deepEqual(filterBills(bills, { status: 'open' }).map(b => b.id), [1, 2]);        // everything not voided
  assert.deepEqual(filterBills(bills, { status: 'all' }).map(b => b.id), [1, 2, 3]);
  assert.deepEqual(filterBills(bills, { status: 'all', vendor: '4' }).map(b => b.id), [2]);
  // "No PDF yet": bills still waiting for their PDF, whatever their status, never a voided one
  const noPdf = [B(1, 'review', { file_path: null }), B(2, 'accepted', { file_path: 'p' }), B(3, 'accepted', { file_path: null }), B(4, 'void', { file_path: null })];
  assert.deepEqual(filterBills(noPdf, { status: 'nofile' }).map(b => b.id), [1, 3]);
  assert.equal(filterBills(noPdf, { status: 'nofile' }).length, billSummary(noPdf).noFile);   // the card and the list always agree
  assert.deepEqual(filterBills(bills, { status: 'all', q: 'gkhr' }).map(b => b.id), [2]);
  assert.deepEqual(filterBills(bills, { status: 'all', q: '845' }).map(b => b.id), [2]);
  assert.deepEqual(filterBills(bills, { status: 'all', q: '06AABC' }).map(b => b.id), [1, 2, 3]);
});

test('failed checks are the ones to show', () => {
  assert.deepEqual(failedChecks({ checks: [{ id: 'a', ok: true }, { id: 'b', ok: false, detail: 'x' }] }).map(c => c.id), ['b']);
  assert.deepEqual(failedChecks({ checks: null }), []);
});

test('what happened to each invoice in an upload, in a sentence', () => {
  assert.match(outcomeText({ outcome: 'accepted', vendor: 'GoKwik', invoice_no: 'GKHR/1' }).text, /GoKwik GKHR\/1: read, every check passed, accepted/);
  const held = outcomeText({ outcome: 'review', vendor: 'GoKwik', invoice_no: 'GKHR/1', reasons: ['The first bill from GoKwik: confirm it once'] });
  assert.equal(held.tone, 'warn'); assert.match(held.text, /held for you\. The first bill from GoKwik/);
  assert.match(outcomeText({ outcome: 'attached', vendor: 'Meta', invoice_no: '1', differs: [] }).text, /figures agree with the PDF/);
  const differs = outcomeText({ outcome: 'attached', vendor: 'Meta', invoice_no: '1', differs: ['total: stored 1, the PDF says 2'] });
  assert.equal(differs.warn, true); assert.match(differs.text, /differs from what was stored: total: stored 1/);
  assert.equal(outcomeText({ outcome: 'already_uploaded', invoice_no: '1' }).tone, 'info');
  assert.equal(outcomeText({ outcome: 'unreadable', reasons: ['no amounts'] }).tone, 'bad');
});

test('a new vendor is offered with what the invoice says: a goods invoice becomes a purchase, anything else an expense', () => {
  assert.deepEqual(newVendorDraft({ vendor: ' SAMPLE  FABRICS A ', supplier_gstin: '07AAAAA1111A1ZY', kind: 'goods' }), { name: 'SAMPLE FABRICS A', tally_ledger_name: 'SAMPLE FABRICS A', gstin: '07AAAAA1111A1ZY', booking: 'purchase', expense_ledger: '', ledger_new: false });
  assert.equal(newVendorDraft({ vendor: 'Meta', supplier_gstin: null, kind: 'service' }).booking, 'expense');
});

test('only the numbers a person changed are sent as corrections', () => {
  const bill = { invoice_no: 'CF/1', invoice_date: '2026-10-01', subtotal: 100, tax: 5, total: 105 };
  assert.deepEqual(changedEdits(bill, { invoice_no: 'CF/1', invoice_date: '2026-10-01', taxable: '100', tax: '5.00', total: '105' }), {});
  assert.deepEqual(changedEdits(bill, { invoice_no: ' CF/2 ', invoice_date: '2026-10-02', taxable: '100', tax: '5', total: '105.40' }), { invoice_no: 'CF/2', invoice_date: '2026-10-02', total: 105.4 });
  assert.deepEqual(changedEdits(bill, { invoice_no: 'CF/1', invoice_date: '', taxable: '', tax: '', total: '' }), {});
});

// A few of the owner's real Tally ledgers (his trial balance of 30 Sep 2026) and the agreed changes.
const L = (name, under, role, o = {}) => ({ name, under, role, status: 'in_tally', renamed_from: null, ...o });
const LEDGERS = [
  L('Chandra Fashion', 'Sundry Creditors', 'party'), L('Vool Fashion', 'Sundry Creditors', 'party'), L('Shree Vinayak Fab', 'Sundry Creditors', 'party'),
  L('M/s Bharti Airtel Ltd  UP', 'Sundry Creditors', 'party'), L('Mittal Textile', 'Sundry Debtors', 'party'), L('Easebuzz Private Limited', 'Sundry Debtors', 'party'),
  L('online sale (Delhi)', 'Sundry Debtors', 'other'), L('ICICI Bank', 'Bank Accounts', 'other'),
  L('Velocity Prepaid Recharge Account', 'Sundry Debtors', 'party', { status: 'will_rename', renamed_from: 'Shipfast-Prepaid Recharge Account' }),
  L('Goodwill credits', 'Indirect Expenses', 'expense', { status: 'will_create' }),
  L('Marketing Expenses', 'Marketing Expenses', 'expense'), L('Payment Gateway Expenses', 'PAYMENT GATEWAY CHARGES', 'expense'), L('Software Expenses @ 18%', 'Software Expenses', 'expense'),
];

test('a supplier whose ledger Tally already has is offered that ledger, spelled exactly as Tally has it', () => {
  assert.equal(normLedger('Mittal Hosiery Private Limited (Delhi)'), 'mittalhosiery');
  assert.equal(normLedger('M/s Bharti Airtel Ltd  UP'), 'bhartiairtelup');
  assert.equal(newVendorDraft({ vendor: 'CHANDRA FASHION', kind: 'goods', supplier_gstin: '24AASFC4987G1ZY' }, LEDGERS).tally_ledger_name, 'Chandra Fashion');
  assert.equal(newVendorDraft({ vendor: 'SHREE VINAYAK FAB', kind: 'goods' }, LEDGERS).tally_ledger_name, 'Shree Vinayak Fab');
  assert.equal(findLedger('chandra  fashion pvt ltd', LEDGERS)?.name, 'Chandra Fashion');
  // a different firm that shares a word is never taken for it
  assert.equal(findLedger('Mittal Hosiery Private Limited (Delhi)', LEDGERS), null);
  assert.equal(newVendorDraft({ vendor: 'Mittal Hosiery Private Limited (Delhi)', kind: 'goods' }, LEDGERS).tally_ledger_name, 'Mittal Hosiery Private Limited (Delhi)');
  // only party ledgers are matched by spelling: a bank or a sales ledger is never a supplier
  assert.equal(findLedger('icici bank', LEDGERS), null);
});

test('the note on a ledger name: in Tally, agreed rename, agreed new ledger, a spelling to correct, or not there', () => {
  assert.deepEqual([ledgerNote('Chandra Fashion', LEDGERS).kind, ledgerNote('Chandra Fashion', LEDGERS).tone], ['tally', 'ok']);
  assert.match(ledgerNote('Chandra Fashion', LEDGERS).text, /under Sundry Creditors/);
  const renamed = ledgerNote('Velocity Prepaid Recharge Account', LEDGERS);
  assert.equal(renamed.kind, 'rename'); assert.match(renamed.text, /Tally still calls it "Shipfast-Prepaid Recharge Account"/);
  assert.equal(ledgerNote('Goodwill credits', LEDGERS).kind, 'create');
  const spelled = ledgerNote('CHANDRA FASHION', LEDGERS);
  assert.equal(spelled.kind, 'spelling'); assert.equal(spelled.suggest, 'Chandra Fashion'); assert.equal(spelled.tone, 'warn');
  const missing = ledgerNote('Mittal Hosiery Private Limited (Delhi)', LEDGERS);
  assert.equal(missing.kind, 'missing'); assert.deepEqual(missing.similar, ['Mittal Textile']);          // "did you mean", never chosen for him
  assert.deepEqual(ledgerNote('VIPUL ENTERPRISES', LEDGERS).similar, []);
  assert.equal(ledgerNote('  ', LEDGERS), null);
  assert.deepEqual(similarLedgers('Gaurav Fashion House', LEDGERS), []);                                    // "fashion" alone does not make two firms alike
});

test('a vendor ledger is acceptable when Tally has it exactly, or the person said it is a new one', () => {
  assert.equal(ledgerOk({ tally_ledger_name: 'Chandra Fashion' }, LEDGERS), true);
  assert.equal(ledgerOk({ tally_ledger_name: 'CHANDRA FASHION' }, LEDGERS), false);                          // a different spelling would create a second ledger
  assert.equal(ledgerOk({ tally_ledger_name: 'VIPUL ENTERPRISES' }, LEDGERS), false);
  assert.equal(ledgerOk({ tally_ledger_name: 'VIPUL ENTERPRISES', ledger_new: true }, LEDGERS), true);
  assert.equal(ledgerOk({ tally_ledger_name: '', ledger_new: true }, LEDGERS), false);
});

test('the expense ledgers are the ones Tally has, listed under their groups', () => {
  const groups = expenseGroups(LEDGERS);
  assert.deepEqual(groups.map(g => g.under), ['Indirect Expenses', 'Marketing Expenses', 'PAYMENT GATEWAY CHARGES', 'Software Expenses']);
  assert.deepEqual(groups.flatMap(g => g.items.map(l => l.name)), ['Goodwill credits', 'Marketing Expenses', 'Payment Gateway Expenses', 'Software Expenses @ 18%']);
  assert.ok(!groups.flatMap(g => g.items).some(l => l.name === 'ICICI Bank'));
  assert.ok(expenseGroups(LEDGERS, 'ICICI Bank').flatMap(g => g.items).some(l => l.name === 'ICICI Bank'));   // one already chosen stays visible
});
