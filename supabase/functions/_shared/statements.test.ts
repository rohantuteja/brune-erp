// Made-up names and amounts, shaped like the real bank (ICICI DetailedStatement) and card (Kotak) statements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { fileKind, isoDate, money, parseBankRows, parseCardText, unzip, xlsxRows } from './statements.ts';

// ── A tiny .xlsx built in memory ─────────────────────────────────────────────────────────────
function zip(files: Record<string, { data: string; deflate: boolean }>): Uint8Array {
  const chunks: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, f] of Object.entries(files)) {
    const raw = Buffer.from(f.data), body = f.deflate ? deflateRawSync(raw) : raw, nm = Buffer.from(name), method = f.deflate ? 8 : 0, crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nm.length, 26);
    chunks.push(local, nm, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nm);
    offset += 30 + nm.length + body.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cd, end]));
}
const colLetter = (i: number) => String.fromCharCode(65 + i);
function xlsx(rows: string[][]): Uint8Array {
  const strings: string[] = [];
  const sheet = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    if (v === '') return `<c r="${colLetter(ci)}${ri + 1}" s="1"/>`;
    strings.push(v);
    return `<c r="${colLetter(ci)}${ri + 1}" t="s"><v>${strings.length - 1}</v></c>`;
  }).join('')}</row>`).join('');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return zip({
    'xl/sharedStrings.xml': { data: `<sst>${strings.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`, deflate: false },
    'xl/worksheets/sheet1.xml': { data: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`, deflate: true },
  });
}

const HEAD = ['S.N.', 'Tran. Id', 'Value Date', 'Transaction Date', 'Transaction Posted Date', 'Cheque. No./Ref. No.', 'Transaction Remarks', 'Withdrawal Amt (INR)', 'Deposit Amt (INR)', 'Balance (INR)'];
const row = (sn: number, id: string, date: string, rem: string, wd: string, dep: string, bal: string) => [String(sn), id, date, date, `${date} 05:34:50 AM`, '', rem, wd, dep, bal];
const PREAMBLE = [['Account Statement'], ['Name:', 'A Person', '', '', '', 'Account Currency:', 'INR'], ['Transaction remarks:'], HEAD];
const GOOD = [
  ...PREAMBLE,
  row(1, 'S1', '01/Jul/2026', 'UPI/1/trims/a@ybl//I', '10,000.00', '', '18,39,240.03'),
  row(2, 'S2', '01/Jul/2026', 'NEFT-EASEBUZZ-Brune', '', '17,984.24', '18,57,224.27'),
  row(3, 'S3', '02/Jul/2026', 'UPI/2/fabric/b@ybl//I', '6,320.00', '', '18,50,904.27'),
];

test('dates and amounts as the statements write them', () => {
  assert.equal(isoDate('01/Jul/2026'), '2026-07-01'); assert.equal(isoDate('4-Sep-2026'), '2026-09-04'); assert.equal(isoDate('31-Dec-2026'), '2026-12-31');
  assert.equal(isoDate('2026-07-01'), null); assert.equal(isoDate(''), null); assert.equal(isoDate('01/Foo/2026'), null);
  assert.equal(money('18,39,240.03'), 1839240.03); assert.equal(money('₹ 1,180.00'), 1180); assert.equal(money(''), 0); assert.equal(money('abc'), 0);
});

test('file types are told apart by their first bytes', () => {
  assert.equal(fileKind(xlsx([['a']])), 'xlsx');
  assert.equal(fileKind(new TextEncoder().encode('%PDF-1.7 ...')), 'pdf');
  assert.equal(fileKind(new TextEncoder().encode('hello')), 'unknown');
});

test('an .xlsx file is read back cell by cell, from compressed and uncompressed zip entries, with empty cells kept as blanks', async () => {
  const rows = await xlsxRows(xlsx([['S.N.', 'Name & Co', ''], ['1', '', 'x < y']]));
  assert.deepEqual(rows, [['S.N.', 'Name & Co', ''], ['1', '', 'x < y']]);
  const parts = await unzip(xlsx([['a']]));
  assert.deepEqual([...parts.keys()].sort(), ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
  await assert.rejects(() => unzip(new TextEncoder().encode('not a zip at all, just some text padding padding')), /not a zip/);
});

test('a bank statement is read, in order, and checked: the running balance, unique ids and no missing lines', async () => {
  const s = parseBankRows(await xlsxRows(xlsx(GOOD)));
  assert.equal(s.kind, 'bank'); assert.equal(s.lines.length, 3);
  assert.deepEqual(s.lines[0], { key: 'S1', txn_date: '2026-07-01', value_date: '2026-07-01', ref: null, remarks: 'UPI/1/trims/a@ybl//I', debit: 10000, credit: 0, balance: 1839240.03, fx: null, category: null, section: null });
  assert.equal(s.lines[1].credit, 17984.24);
  assert.equal(s.opening, 1849240.03); assert.equal(s.closing, 1850904.27);
  assert.equal(s.period_from, '2026-07-01'); assert.equal(s.period_to, '2026-07-02');
  assert.ok(s.checks.every(c => c.ok), JSON.stringify(s.checks));
});

test('a statement that does not add up is reported, not accepted: a wrong balance, a repeated id, a missing line', () => {
  const wrong = parseBankRows([...PREAMBLE, row(1, 'S1', '01/Jul/2026', 'a', '10,000.00', '', '100.00'), row(2, 'S2', '01/Jul/2026', 'b', '5.00', '', '999.00')]);
  assert.equal(wrong.checks.find(c => c.id === 'running_balance')!.ok, false);
  assert.match(wrong.checks.find(c => c.id === 'running_balance')!.detail, /line\(s\) 2/);
  const dup = parseBankRows([...PREAMBLE, row(1, 'S1', '01/Jul/2026', 'a', '', '10.00', '10.00'), row(2, 'S1', '01/Jul/2026', 'b', '', '5.00', '15.00')]);
  assert.equal(dup.checks.find(c => c.id === 'unique_ids')!.ok, false);
  const gap = parseBankRows([...PREAMBLE, row(1, 'S1', '01/Jul/2026', 'a', '', '10.00', '10.00'), row(3, 'S3', '01/Jul/2026', 'b', '', '5.00', '15.00')]);
  assert.equal(gap.checks.find(c => c.id === 'no_missing_lines')!.ok, false);
});

test('a statement downloaded newest-first is put in order before it is checked', () => {
  const s = parseBankRows([...PREAMBLE,
    row(1, 'S3', '03/Jul/2026', 'c', '1.00', '', '8.00'), row(2, 'S2', '02/Jul/2026', 'b', '1.00', '', '9.00'), row(3, 'S1', '01/Jul/2026', 'a', '', '10.00', '10.00')]);
  assert.deepEqual(s.lines.map(l => l.key), ['S1', 'S2', 'S3']);
  assert.ok(s.checks.every(c => c.ok), JSON.stringify(s.checks));
  assert.equal(s.opening, 0); assert.equal(s.closing, 8);
});

test('a file that is not an ICICI statement is refused with a clear reason', () => {
  assert.throws(() => parseBankRows([['hello'], ['world']]), /does not look like an ICICI DetailedStatement/);
});

const CARD = `Transactions Details from 21-Aug-2026 to 20-Sep-2026
Date Description Spends Category Amount (₹)
Payments and Other Credits
07-Sep-2026 PAYMENT RECEIVED-AUTODEBIT 20,488.45 Cr
Purchases made in this cycle - Primary Card X0191
24-Aug-2026 SOME APP STORE MUMBAI IN 199.00
03-Sep-2026 ACME CLOUD* PRO SUB ACME.COM CA (23.60 USD) Computer 2,320.10
13-Sep-2026 WWW TELCO IN NEW DELHI IN Telecom 2.00
13-Sep-2026 WWW TELCO IN NEW DELHI IN Telecom 2.00 Cr
16-Sep-2026 FUEL STATION DELHI IN (Convert To EMI) Fuel 4,674.52
Total Purchases 7,193.62
Other fees and charges
04-Sep-2026 GST 28.17
Total Fees & Charges 28.17`;
const SUMMARY = `Billing Date 20-Sep-2026
Previous statement dues 20,488.45
Purchases made in this cycle 7,193.62
Other fees & charges 28.17
Payments and Other Credits 20,488.45
Total Amount Due 7,221.79
`;

test('a card statement is read line by line, with its sections, categories and foreign-currency amounts, and every total is checked', () => {
  const s = parseCardText(SUMMARY + CARD);
  assert.equal(s.kind, 'card'); assert.equal(s.lines.length, 7);
  assert.equal(s.period_from, '2026-08-21'); assert.equal(s.period_to, '2026-09-20'); assert.equal(s.closing, 7221.79);
  const by = (txt: string) => s.lines.find(l => l.remarks.startsWith(txt))!;
  assert.deepEqual([by('ACME').debit, by('ACME').category, by('ACME').fx, by('ACME').section], [2320.1, 'Computer', '23.60 USD', 'purchase']);
  assert.deepEqual([by('FUEL').debit, by('FUEL').category], [4674.52, 'Fuel']);
  assert.deepEqual([by('PAYMENT').credit, by('PAYMENT').section, by('PAYMENT').debit], [20488.45, 'credit', 0]);
  assert.deepEqual([by('GST').debit, by('GST').section], [28.17, 'fee']);
  assert.equal(by('SOME APP').category, null);
  const telco = s.lines.filter(l => l.remarks.startsWith('WWW TELCO'));
  assert.deepEqual(telco.map(l => [l.debit, l.credit]), [[2, 0], [0, 2]]);
  assert.equal(new Set(s.lines.map(l => l.key)).size, 7);
  assert.ok(s.checks.every(c => c.ok), JSON.stringify(s.checks));
});

test('two identical card lines on one day stay two lines with different keys, so uploading the same statement twice adds nothing', () => {
  const text = SUMMARY + CARD.replace('13-Sep-2026 WWW TELCO IN NEW DELHI IN Telecom 2.00 Cr', '13-Sep-2026 WWW TELCO IN NEW DELHI IN Telecom 2.00');
  const a = parseCardText(text), b = parseCardText(text);
  assert.deepEqual(a.lines.map(l => l.key), b.lines.map(l => l.key));
  assert.equal(new Set(a.lines.map(l => l.key)).size, a.lines.length);
});

test('a card statement whose lines do not add up to its stated totals is reported', () => {
  const s = parseCardText((SUMMARY + CARD).replace('4,674.52', '4,000.00'));
  assert.equal(s.checks.find(c => c.id === 'purchases')!.ok, false);
  assert.equal(s.checks.find(c => c.id === 'total_due')!.ok, false);
  assert.throws(() => parseCardText('just some text'), /does not look like a Kotak credit card statement/);
});
