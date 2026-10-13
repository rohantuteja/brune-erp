// Made-up names and amounts, shaped like the real bank and card statements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUCKETS, MERCHANTS, NOTE_BUCKET, COD_BUCKET, GATEWAY_BUCKET, META_BUCKET, RAZORPAY_BUCKET, SUPPLIER_BUCKET, SUSPENSE_BUCKET, classify, parseRemarks, type Ctx, type Line } from './bank-match.ts';
import { VELOCITY_RECHARGE_BUCKET } from './velocity-ledger.ts';
import { BANK, COD_RECEIVABLE, GATEWAY, GATEWAY_FEE, RAZORPAY } from './ledger.ts';

let n = 0;
const bank = (date: string, remarks: string, o: { debit?: number; credit?: number } = {}): Line => ({ key: `b${++n}`, account_kind: 'bank', txn_date: date, remarks, debit: o.debit ?? 0, credit: o.credit ?? 0 });
const card = (date: string, remarks: string, o: { debit?: number; credit?: number; category?: string; section?: string } = {}): Line =>
  ({ key: `c${++n}`, account_kind: 'card', txn_date: date, remarks, debit: o.debit ?? 0, credit: o.credit ?? 0, category: o.category ?? null, section: o.section ?? 'purchase' });
const empty: Ctx = { payouts: [], invoices: [], rules: [] };
const one = (l: Line, ctx: Ctx = empty) => classify([l], ctx).get(l.key)!;

test('narrations: the transfer type, the note you typed, and the other party (digits and bank handles removed)', () => {
  assert.deepEqual(parseRemarks('UPI/110130944179/trims/ramachal.55@okaxis//ICI3ce16b'), { type: 'UPI', note: 'trims', payee: 'ramachal' });
  assert.deepEqual(parseRemarks('UPI/110120696111/UPI Pay/seema.tailor@ybl//ICI0ae9'), { type: 'UPI', note: '', payee: 'seematailor' });
  assert.deepEqual(parseRemarks('MMT/IMPS/512345678/fabric/ChandraFas/HDFC0001'), { type: 'MMT', note: 'fabric', payee: 'chandrafas' });
  assert.deepEqual(parseRemarks('INF/NEFT/IN4261/KKBK0001/#/Salary                        /AshaVerma'), { type: 'INF', note: 'salary', payee: 'ashaverma' });
  assert.deepEqual(parseRemarks('INF/INFT/55512/Rent           /Landlord'), { type: 'INF', note: 'rent', payee: 'landlord' });
  assert.deepEqual(parseRemarks('INF/INFT/88123/#     /FounderName/FSalary'), { type: 'INF', note: 'fsalary', payee: 'foundername' });   // name first, note last
  assert.deepEqual(parseRemarks('INF/INFT/88124/Lavkush'), { type: 'INF', note: '', payee: 'lavkush' });
  assert.equal(parseRemarks('CMS/ CMS123/WHITE WIZARD TECHNOLOGIES PRIV').type, 'CMS');
});

test('a payment the bank returned the same day nets to zero: both lines ignored, no income and no expense', () => {
  const out = bank('2026-09-23', 'INF/NEFT/IN4262/KVBL0001/Purchase   /Vendor', { debit: 106000 });
  const back = bank('2026-09-23', 'NEFT-RETURN-IN4262-Some Co-Closed Account Number  AC04', { credit: 106000 });
  const m = classify([out, back], empty);
  for (const l of [out, back]) { assert.equal(m.get(l.key)!.status, 'ignored'); assert.equal(m.get(l.key)!.kind, 'returned_payment'); }
  assert.equal(m.get(out.key)!.match_ref, back.key);
});

test('a return with no payment to undo is not paired, and a payment is only returned once', () => {
  const back = bank('2026-09-23', 'NEFT-RETURN-IN1-Some Co-Closed Account', { credit: 5000 });
  assert.notEqual(one(back).status, 'ignored');
  const a = bank('2026-07-23', 'INF/NEFT/IN1/X/Purchase /V', { debit: 106000 });
  const r1 = bank('2026-07-23', 'NEFT-RETURN-IN1-Co', { credit: 106000 }), r2 = bank('2026-07-23', 'NEFT-RETURN-IN2-Co', { credit: 106000 });
  const m = classify([a, r1, r2], empty);
  assert.equal(m.get(r1.key)!.status, 'ignored'); assert.notEqual(m.get(r2.key)!.status, 'ignored');
});

test('a charge reversed on the card nets to zero; the founder paying his card bill needs no company entry', () => {
  const ch = card('2026-09-13', 'WWW AIRTEL IN NEW DELHI IN', { debit: 2 });
  const rv = card('2026-09-13', 'WWW AIRTEL IN NEW DELHI IN', { credit: 2 });
  const m = classify([ch, rv], empty);
  assert.equal(m.get(ch.key)!.status, 'ignored'); assert.equal(m.get(rv.key)!.kind, 'reversed_charge');
  const pay = one(card('2026-09-07', 'PAYMENT RECEIVED-AUTODEBIT', { credit: 20488.45, section: 'credit' }));
  assert.equal(pay.status, 'ignored'); assert.equal(pay.bucket, 'Founder card payment (no company entry)');
});

test('a GoKwik payout (an Easebuzz credit) is matched when a settlement agrees on amount and date, and is only used once', () => {
  const ctx: Ctx = { ...empty, payouts: [{ source: 'gokwik', utr: 'UTR111', date: '2026-10-03', amount: 15178.96, payments: 12 }] };
  const a = bank('2026-10-03', 'NEFT-EASEBUZZ PRIVATE LIMITED-Brune Collection', { credit: 15178.96 });
  const b = bank('2026-10-04', 'NEFT-EASEBUZZ PRIVATE LIMITED-Brune Collection', { credit: 15178.96 });
  const m = classify([a, b], ctx);
  assert.equal(m.get(a.key)!.status, 'matched'); assert.equal(m.get(a.key)!.match_ref, 'UTR UTR111'); assert.equal(m.get(a.key)!.bucket, 'Easebuzz Private Limited');
  assert.match(m.get(a.key)!.reason, /12 payments/);
  assert.equal(m.get(b.key)!.status, 'suggested');                       // the same settlement cannot explain two credits
  const wrong = one(bank('2026-10-03', 'NEFT-EASEBUZZ PRIVATE LIMITED-X', { credit: 15000 }), ctx);
  assert.equal(wrong.status, 'suggested'); assert.match(wrong.reason, /upload the GoKwik report/);
  assert.equal(one(bank('2026-10-20', 'NEFT-EASEBUZZ PRIVATE LIMITED-X', { credit: 15178.96 }), ctx).status, 'suggested');   // a different week
});

test('a Velocity COD remittance (a White Wizard credit) is matched to the payout with the same amount', () => {
  const ctx: Ctx = { ...empty, payouts: [{ source: 'velocity', utr: 'UTR222', date: '2026-10-05', amount: 53978.6, payments: 36 }] };
  const m = one(bank('2026-10-05', 'CMS/ CMS987/WHITE WIZARD TECHNOLOGIES PRIV', { credit: 53978.6 }), ctx);
  assert.equal(m.status, 'matched'); assert.equal(m.bucket, 'COD receivable (Velocity)'); assert.match(m.reason, /36 COD parcels/);
  assert.equal(one(bank('2026-10-05', 'CMS/ CMS987/WHITE WIZARD TECHNOLOGIES PRIV', { credit: 1000 }), ctx).status, 'suggested');
});

test('a Meta payment is matched to its invoice by number and amount; paid net of 2% TDS is recognised; a wrong amount is flagged', () => {
  const inv = { vendor: 'Meta', invoice_no: '2380919690', invoice_date: '2026-09-01', period: 'Aug-26', subtotal: 679432.69, tax: 122297.89, total: 801730.58 };
  const ctx: Ctx = { ...empty, invoices: [inv] };
  const rem = 'INF/NEFT/IN42627454553388/CITI0000006/2380919690   /FACEBOOK';
  const full = one(bank('2026-10-01', rem, { debit: 801730.58 }), ctx);
  assert.equal(full.status, 'matched'); assert.equal(full.bucket, 'Facebook India Online Services Private Limited'); assert.match(full.reason, /no TDS was deducted/);
  const tds = one(bank('2026-10-01', rem, { debit: 801730.58 - 13588.65 }), ctx);
  assert.equal(tds.status, 'matched'); assert.match(tds.reason, /less 2% TDS of ₹13588.65/);
  const off = one(bank('2026-10-01', rem, { debit: 800000 }), ctx);
  assert.equal(off.status, 'needs_review'); assert.match(off.reason, /801730.58 but .*800000/);
  const unknown = one(bank('2026-10-01', 'INF/NEFT/IN1/CITI0000006/2380999999   /FACEBOOK', { debit: 5000 }), ctx);
  assert.equal(unknown.status, 'suggested'); assert.match(unknown.reason, /upload that invoice/);
});

test('your own rule beats the built-in guesses and is applied as your decision', () => {
  const ctx: Ctx = { ...empty, rules: [{ id: 7, match_type: 'payee', pattern: 'ramachal', bucket: 'Labour Charges' }] };
  const m = one(bank('2026-10-02', 'UPI/1/trims/ramachal.55@okaxis//ICI3', { debit: 750 }), ctx);
  assert.equal(m.status, 'matched'); assert.equal(m.bucket, 'Labour Charges'); assert.equal(m.rule_id, 7); assert.match(m.reason, /payments to ramachal/);
  const contains = one(bank('2026-10-02', 'UPI/1/UPI Pay/zippo@ybl//ICI3 ZIPPER HOUSE', { debit: 100 }), { ...empty, rules: [{ id: 8, match_type: 'contains', pattern: 'zipper house', bucket: 'Fabric and Consumbale' }] });
  assert.equal(contains.bucket, 'Fabric and Consumbale');
  assert.notEqual(one(bank('2026-10-02', 'UPI/1/trims/someoneelse@ybl//ICI3', { debit: 750 }), ctx).kind, 'rule');
});

test('the note you type on a payment becomes a suggested bucket', () => {
  const t = (rem: string, debit: number) => one(bank('2026-10-02', rem, { debit }));
  assert.equal(t('UPI/1/trims/a@ybl//I', 500).bucket, 'Fabric and Consumbale');
  assert.equal(t('UPI/1/pcrate/a@ybl//I', 4000).bucket, 'Labour Charges');
  assert.equal(t('UPI/1/fabric/a@ybl//I', 40000).bucket, "The supplier's own ledger (one per payee)");
  assert.equal(t('UPI/1/transport/a@ybl//I', 300).bucket, 'FREIGHT INWARD NON GST');
  assert.equal(t('UPI/1/machine/a@ybl//I', 56700).bucket, 'Sewing Machine GST');
  assert.equal(t('UPI/1/velocity/a@ybl//I', 10000).bucket, 'Velocity Prepaid Recharge Account');
  assert.equal(t('INF/NEFT/IN1/UTIB0001/# /Salary                        /AshaVerma', 28000).bucket, 'Salary Payable');
  assert.equal(t('INF/INFT/55512/Rent           /Landlord', 23004).bucket, 'Rent Payable');
  assert.equal(t('INF/NEFT/IN1/UTIB0001/# /Advance                       /AshaVerma', 2000).bucket, 'Suspense');
  const s = t('UPI/1/fabric/a@ybl//I', 40000);
  assert.equal(s.status, 'suggested'); assert.equal(s.needs_bill, true); assert.match(s.reason, /You wrote "fabric"/);
});

test('card lines: the merchant or category decides the bucket, and personal-looking ones are asked about', () => {
  const t = (rem: string, debit: number, o: { category?: string; section?: string } = {}) => one(card('2026-09-03', rem, { debit, ...o }));
  assert.equal(t('GOOGLE WORKSPACE CYBS MUMBAI IN', 1150.5, { category: 'Services' }).bucket, 'Software Expenses @ 18%');
  assert.equal(t('ANTHROPIC* CLAUDE SUB ANTHROPIC.COM CA', 2320.1, { category: 'Computer' }).bucket, 'Software Expenses');
  assert.match(t('OPENAI *CHATGPT SUBSCR OPENAI.COM CA', 2308.26).reason, /no GST invoice/);
  assert.equal(t('GOKWIK NEW DELHI IN', 1180, { category: 'Services' }).bucket, 'Goexcelsior Private Limited');   // KwikChat on the card
  assert.equal(t('SOME FUEL STATION DELHI IN', 4674.52, { category: 'Fuel' }).bucket, 'Car Fuel Expenses');
  assert.equal(t('GST', 28.17, { section: 'fee' }).bucket, 'Bank Charges');
  assert.equal(t('YOUTUBE DI SI MUMBAI IN', 149).bucket, 'Suspense');
  assert.equal(t('GOOGLE PLAY APP SI MUMBAI IN', 199).bucket, 'Suspense');
  assert.equal(t('AMAZON INDIA CYBS SI MUMBAI IN', 299).bucket, 'Subscription Charges');
  assert.equal(t('SHOPIFY* 12345 OTTAWA CA', 4000).bucket, 'Shopify Commerce Signapore Pte. Ltd.');
  assert.equal(t('GOOGLE WORKSPACE CYBS MUMBAI IN', 383.5).needs_bill, true);
});

test('small bank charges are filed as bank charges', () => {
  assert.equal(one(bank('2026-04-02', 'IMPS chg Apr', { debit: 12 })).bucket, 'Bank Charges');
  assert.equal(one(bank('2026-03-02', 'CashDep Chgs 01', { debit: 236 })).bucket, 'Bank Charges');
  assert.equal(one(bank('2026-03-02', 'GIB/000123/GST', { debit: 41 })).bucket, 'Bank Charges');
});

test('deposits that are not sale payouts are asked about, and a line nothing explains is left for a person', () => {
  assert.equal(one(bank('2026-08-18', 'RTGS-IDFBR12345-SOME CO-1234-IDFB0001', { credit: 782334 })).bucket, 'Suspense');
  assert.equal(one(bank('2026-08-21', 'CAM/1234SRY/CASH DEP-Other/21-08-26/1', { credit: 89500 })).bucket, 'CASH AT POS DELHI');
  const u = one(bank('2026-10-02', 'UPI/1/UPI Pay/mystery@ybl//I', { debit: 1234 }));
  assert.equal(u.status, 'needs_review'); assert.equal(u.bucket, null);
  assert.equal(u.payee, 'mystery');
});

test('bucket names are unique, and a rule that points at an unknown bucket is ignored rather than filing a line under it', () => {
  const names = BUCKETS.map(b => b.name);
  assert.equal(new Set(names).size, names.length);
  const ctx: Ctx = { ...empty, rules: [{ id: 1, match_type: 'payee', pattern: 'x', bucket: 'No such bucket' }] };
  const m = one(bank('2026-10-02', 'UPI/1/UPI Pay/x@ybl//I', { debit: 1 }), ctx);
  assert.equal(m.status, 'needs_review'); assert.equal(m.bucket, null);
});

test('a payment to a Velocity wallet handle is proved by the wallet ledger: same amount, within a day, one payment per top-up', () => {
  const topup = (key: string, at: string) => ({ key, at, date: at.slice(0, 10), amount: 10000 });
  const ctx: Ctx = { ...empty, topups: [topup('t1', '2026-09-07 05:26:00'), topup('t2', '2026-09-12 04:50:00')] };
  const a = bank('2026-09-07', 'UPI/1/UPI Pay/shipfast.cf@axi//ICI1', { debit: 10000 });
  const b = bank('2026-09-12', 'UPI/2/UPI Pay/XXt.cf@axisban//ICI2', { debit: 10000 });
  const again = bank('2026-09-12', 'UPI/3/UPI Pay/cf.shipfast@cas//ICI3', { debit: 10000 });   // a second payment, no second top-up
  const m = classify([a, b, again], ctx);
  assert.deepEqual([m.get(a.key)!.status, m.get(a.key)!.kind, m.get(a.key)!.bucket, m.get(a.key)!.match_ref], ['matched', 'velocity_recharge', 'Velocity Prepaid Recharge Account', 'Wallet recharge 2026-09-07 05:26:00']);
  assert.equal(m.get(b.key)!.status, 'matched');
  assert.equal(m.get(again.key)!.status, 'suggested');     // looks like a top-up, nothing proves it yet
  assert.equal(m.get(again.key)!.bucket, 'Velocity Prepaid Recharge Account');
  // another payee for the same amount is not taken for a top-up
  assert.equal(one(bank('2026-09-07', 'UPI/4/UPI Pay/someone@ybl//ICI4', { debit: 10000 }), ctx).kind, 'unknown');
});

test('a GoKwik line on the bank is a payment to GoKwik, while on the card it is the KwikChat subscription', () => {
  assert.equal(one(bank('2026-09-20', 'NEFT-GOKWIK TECHNOLOGIES-INV 77', { debit: 5900 })).bucket, 'Payment Gateway Expenses');
  assert.equal(one(card('2026-08-25', 'GOKWIK NEW DELHI IN', { debit: 1180 })).bucket, 'Goexcelsior Private Limited');
});

// A bucket is a Tally ledger and the order ledger posts to the same ledgers, so the names must be one and the same.
test('the buckets that share a ledger with the order ledger carry exactly its account name', () => {
  assert.equal(GATEWAY_BUCKET, GATEWAY);
  assert.equal(COD_BUCKET, COD_RECEIVABLE);
  assert.equal(RAZORPAY_BUCKET, RAZORPAY);
  assert.equal(BUCKETS.find(b => b.name === GATEWAY_FEE)?.kind, 'expense');
  for (const name of [GATEWAY, COD_RECEIVABLE, RAZORPAY, GATEWAY_FEE]) assert.ok(BUCKETS.some(b => b.name === name), `${name} is a bucket`);
  assert.ok(!BUCKETS.some(b => b.name === BANK), 'the bank itself is never a bucket');
});

test('every bucket the engine can suggest exists, and none is one of the old names', () => {
  const names = new Set(BUCKETS.map(b => b.name));
  for (const [note, bucket] of Object.entries(NOTE_BUCKET)) assert.ok(names.has(bucket), `note "${note}" points at ${bucket}`);
  for (const [, bucket] of MERCHANTS) assert.ok(names.has(bucket), `merchant guess points at ${bucket}`);
  for (const b of [GATEWAY_BUCKET, COD_BUCKET, RAZORPAY_BUCKET, META_BUCKET, SUPPLIER_BUCKET, SUSPENSE_BUCKET, VELOCITY_RECHARGE_BUCKET]) assert.ok(names.has(b), b);
  for (const old of ['GoKwik payout', 'Velocity COD remittance', 'Velocity wallet recharge', 'Meta ads (invoice payment)', 'Customer receipts (other gateway)', 'Employee Benefit Expenses',
    'Rent Expenses', 'Rent Sector 63 Noida', 'Purchase Accounts', 'PAYMENT GATEWAY CHARGES', 'Bank Charges GST', 'Miscellaneous Expenses', 'FINANCE COST', 'To confirm: other']) {
    assert.ok(!names.has(old), `${old} is gone`);
  }
});

// The database is migrated by 029_finance_buckets_tally_names.sql: the list there must be this list.
test('migration 029 creates exactly the buckets the engine knows, with the same kind and bill flag', () => {
  const sql = readFileSync(new URL('../../migrations/029_finance_buckets_tally_names.sql', import.meta.url), 'utf8');
  const rows = [...sql.matchAll(/^\s*\('((?:[^']|'')+)', '(\w+)', (true|false), '((?:[^']|'')*)', (\d+)\),?;?$/gm)].map(m => ({ name: m[1].replace(/''/g, "'"), kind: m[2], needs_bill: m[3] === 'true', note: m[4].replace(/''/g, "'") }));
  assert.deepEqual(rows.map(r => r.name), BUCKETS.map(b => b.name));
  assert.deepEqual(rows.map(r => [r.kind, r.needs_bill, r.note]), BUCKETS.map(b => [b.kind, b.needs_bill, b.note]));
});
