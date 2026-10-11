// Reading bank and credit card statements into plain lines. Pure: no network, no database.
// The finance-import function extracts the text (Excel rows, PDF text) and hands it in here.
//
//   bank   an ICICI "DetailedStatement" Excel file: S.N., Tran. Id, Value Date, Transaction Date, Posted date,
//          Cheque/Ref No., Transaction Remarks, Withdrawal Amt, Deposit Amt, Balance. Amounts are text with commas.
//   card   a Kotak credit card statement PDF, as text lines such as
//          "03-Sep-2026 ANTHROPIC* CLAUDE SUB ANTHROPIC.COM CA (23.60 USD) Computer 2,320.10".
//
// Every statement is checked before anything is stored (see `checks`): a statement that does not add up
// is reported, never silently accepted.

export type StatementLine = {
  key: string;                  // unique within an account: the bank's own transaction id, or a hash of the card line
  txn_date: string;             // YYYY-MM-DD
  value_date: string | null;
  ref: string | null;           // cheque / reference number
  remarks: string;
  debit: number;                // money out (card: a purchase)
  credit: number;               // money in (card: a payment or refund)
  balance: number | null;       // bank running balance
  fx: string | null;            // card: "23.60 USD"
  category: string | null;      // card: the issuer's spend category
  section: string | null;       // card: 'purchase' | 'fee' | 'credit'
};
export type Check = { id: string; ok: boolean; detail: string };
export type ParsedStatement = {
  kind: 'bank' | 'card';
  lines: StatementLine[];
  period_from: string | null;
  period_to: string | null;
  opening: number | null;       // bank: balance before the first line
  closing: number | null;       // bank: balance after the last line; card: total amount due
  checks: Check[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "01/Jul/2026" or "01-Jul-2026" → "2026-07-01"; null when it is not a date. */
export function isoDate(s: string | undefined | null): string | null {
  const m = /^(\d{1,2})[/\- ]([A-Za-z]{3})[A-Za-z]*[/\- ](\d{4})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, '0')}` : null;
}

/** "18,39,240.03" → 1839240.03; empty or not a number → 0. */
export const money = (s: string | undefined | null): number => {
  const n = Number(String(s ?? '').replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// ── Excel (.xlsx) → rows ─────────────────────────────────────────────────────────────────────
// An .xlsx file is a zip of XML parts. This is a small reader for exactly what a bank statement needs: the shared
// strings and the first sheet. Inflating uses the runtime's DecompressionStream (Deno and Node both have it).

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const entries = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (name.startsWith('xl/') && (name.endsWith('.xml') || name.endsWith('.rels'))) out.set(name, method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const xmlText = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIndex = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first worksheet of an .xlsx file as rows of strings (empty cells are ''). */
export async function xlsxRows(bytes: Uint8Array): Promise<string[][]> {
  const parts = await unzip(bytes);
  const dec = new TextDecoder();
  const shared: string[] = [];
  const ss = parts.get('xl/sharedStrings.xml');
  if (ss) for (const si of dec.decode(ss).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(xmlText([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const sheetName = [...parts.keys()].filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0];
  if (!sheetName) throw new Error('no worksheet in the file');
  const rows: string[][] = [];
  for (const row of dec.decode(parts.get(sheetName)!).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      let val = '';
      if (type === 's') val = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? '';
      else if (type === 'inlineStr') val = xmlText([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      else val = xmlText(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      cells[colIndex(ref)] = val;
    }
    rows.push(Array.from(cells, v => v ?? ''));
  }
  return rows;
}

// ── Bank statement ───────────────────────────────────────────────────────────────────────────
export function parseBankRows(rows: string[][]): ParsedStatement {
  const norm = (s: string) => String(s ?? '').trim().toLowerCase();
  const hi = rows.findIndex(r => r.some(c => norm(c) === 's.n.') && r.some(c => /transaction remarks/i.test(c ?? '')));
  if (hi < 0) throw new Error('this does not look like an ICICI DetailedStatement: no "S.N." / "Transaction Remarks" header row');
  const head = rows[hi].map(norm);
  const col = (re: RegExp) => head.findIndex(h => re.test(h));
  const c = {
    sn: col(/^s\.n\.$/), id: col(/^tran\.? id/), value: col(/^value date/), date: col(/^transaction date/), ref: col(/cheque|ref/),
    rem: col(/transaction remarks/), wd: col(/withdrawal/), dep: col(/deposit/), bal: col(/balance/),
  };
  for (const [name, i] of Object.entries(c)) if (i < 0) throw new Error(`the statement has no "${name}" column`);

  let lines: (StatementLine & { sn: number })[] = [];
  for (const r of rows.slice(hi + 1)) {
    const sn = Number(String(r[c.sn] ?? '').trim());
    const date = isoDate(r[c.date]);
    if (!Number.isInteger(sn) || sn < 1 || !date) continue;
    lines.push({
      sn, key: String(r[c.id] ?? '').trim() || `sn${sn}`, txn_date: date, value_date: isoDate(r[c.value]), ref: String(r[c.ref] ?? '').trim() || null,
      remarks: String(r[c.rem] ?? '').replace(/\s+/g, ' ').trim(), debit: r2(money(r[c.wd])), credit: r2(money(r[c.dep])), balance: r2(money(r[c.bal])),
      fx: null, category: null, section: null,
    });
  }
  // Banks list oldest-first or newest-first; the running-balance check needs oldest first.
  lines.sort((a, b) => a.sn - b.sn);
  if (lines.length > 1 && lines[0].txn_date > lines[lines.length - 1].txn_date) lines.reverse();

  const checks: Check[] = [];
  const breaks = lines.flatMap((l, i) => i && Math.abs(r2(lines[i - 1].balance! + l.credit - l.debit) - l.balance!) > 0.01 ? [l.sn] : []);
  checks.push({ id: 'running_balance', ok: breaks.length === 0, detail: breaks.length ? `the running balance does not follow from the amounts at line(s) ${breaks.slice(0, 5).join(', ')}` : `the running balance follows from every one of the ${lines.length} lines` });
  const keys = new Set(lines.map(l => l.key));
  checks.push({ id: 'unique_ids', ok: keys.size === lines.length, detail: keys.size === lines.length ? 'every line has its own transaction id' : `${lines.length - keys.size} repeated transaction id(s)` });
  const sns = lines.map(l => l.sn).sort((a, b) => a - b);
  const gaps = sns.some((n, i) => i && n !== sns[i - 1] + 1);
  checks.push({ id: 'no_missing_lines', ok: !gaps, detail: gaps ? 'serial numbers skip: some lines are missing' : 'serial numbers run without a gap' });
  const first = lines[0], last = lines[lines.length - 1];
  const opening = first ? r2(first.balance! - first.credit + first.debit) : null;
  return {
    kind: 'bank', lines: lines.map(({ sn: _sn, ...l }) => l), opening, closing: last ? last.balance : null,
    period_from: lines.reduce<string | null>((m, l) => (!m || l.txn_date < m ? l.txn_date : m), null), period_to: lines.reduce<string | null>((m, l) => (!m || l.txn_date > m ? l.txn_date : m), null), checks,
  };
}

// ── Credit card statement ────────────────────────────────────────────────────────────────────
const CATEGORIES = ['Services', 'Computer', 'Telecom', 'Fuel', 'Travel', 'Dining', 'Shopping', 'Groceries', 'Utilities', 'Entertainment', 'Health', 'Education', 'Insurance', 'Hotels', 'Jewellery', 'Others', 'Miscellaneous', 'Apparel', 'Electronics'];

export function parseCardText(text: string): ParsedStatement {
  const all = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const num = (re: RegExp) => { const m = all.map(l => re.exec(l)).find(Boolean); return m ? money(m[1]) : null; };
  const period = /Transactions Details from (\d{2}-[A-Za-z]{3}-\d{4}) to (\d{2}-[A-Za-z]{3}-\d{4})/.exec(all.join('\n'));
  const billing = all.map(l => /^Billing Date (\d{2}-[A-Za-z]{3}-\d{4})/.exec(l)).find(Boolean);
  const start = all.findIndex(l => /^Date Description/.test(l));
  if (start < 0 || !period) throw new Error('this does not look like a Kotak credit card statement: no "Transactions Details" table');

  let section: 'credit' | 'purchase' | 'fee' | null = null;
  const lines: StatementLine[] = [];
  const seen = new Map<string, number>();
  for (const l of all.slice(start + 1)) {
    if (/^Payments and Other Credits$/i.test(l)) { section = 'credit'; continue; }
    if (/^Purchases made in this cycle/i.test(l)) { section = 'purchase'; continue; }
    if (/^Other fees and charges$/i.test(l)) { section = 'fee'; continue; }
    if (/^Total (Purchases|Fees)/i.test(l)) { if (/Fees/i.test(l)) section = null; continue; }
    const m = /^(\d{2}-[A-Za-z]{3}-\d{4}) (.+?) ([\d,]+\.\d{2})(?: (Cr))?$/.exec(l);
    if (!m || !section) continue;
    let desc = m[2], category: string | null = null;
    const tail = /^(.*) (\S+)$/.exec(desc);
    if (tail && CATEGORIES.includes(tail[2])) { desc = tail[1]; category = tail[2]; }
    const amount = r2(money(m[3])), isCredit = m[4] === 'Cr';
    const base = `${m[1]}|${desc}|${amount}|${isCredit ? 'cr' : 'dr'}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    lines.push({
      key: `${base}|${n}`, txn_date: isoDate(m[1])!, value_date: null, ref: null, remarks: desc, debit: isCredit ? 0 : amount, credit: isCredit ? amount : 0, balance: null,
      fx: /\((\d[\d,.]*\s?[A-Z]{3})\)/.exec(desc)?.[1] ?? null, category, section,
    });
  }

  const sum = (f: (l: StatementLine) => boolean, side: 'debit' | 'credit') => r2(lines.filter(f).reduce((s, l) => s + l[side], 0));
  const checks: Check[] = [];
  const stated = { purchases: num(/^Total Purchases ([\d,]+\.\d{2})/), fees: num(/^Total Fees & Charges ([\d,]+\.\d{2})/), due: num(/^Total Amount Due ([\d,]+\.\d{2})/), prev: num(/^Previous statement dues ([\d,]+\.\d{2})/), pay: num(/^Payments and Other Credits ([\d,]+\.\d{2})/) };
  const purchases = r2(sum(l => l.section === 'purchase', 'debit') - sum(l => l.section === 'purchase', 'credit'));
  const fees = sum(l => l.section === 'fee', 'debit');
  const credits = sum(l => l.section === 'credit', 'credit');
  if (stated.purchases != null) checks.push({ id: 'purchases', ok: Math.abs(purchases - stated.purchases) < 0.01, detail: `purchases on the lines ₹${purchases.toFixed(2)}, statement says ₹${stated.purchases.toFixed(2)}` });
  if (stated.fees != null) checks.push({ id: 'fees', ok: Math.abs(fees - stated.fees) < 0.01, detail: `fees on the lines ₹${fees.toFixed(2)}, statement says ₹${stated.fees.toFixed(2)}` });
  if (stated.due != null && stated.prev != null && stated.pay != null) {
    const calc = r2(stated.prev - stated.pay + purchases + fees);
    checks.push({ id: 'total_due', ok: Math.abs(calc - stated.due) < 0.01, detail: `previous dues ₹${stated.prev.toFixed(2)} − payments ₹${stated.pay.toFixed(2)} + purchases + fees = ₹${calc.toFixed(2)}, statement says ₹${stated.due.toFixed(2)}` });
  }
  if (stated.pay != null) checks.push({ id: 'payments', ok: Math.abs(credits - stated.pay) < 0.01, detail: `payments and credits on the lines ₹${credits.toFixed(2)}, statement says ₹${stated.pay.toFixed(2)}` });
  checks.push({ id: 'has_lines', ok: lines.length > 0, detail: `${lines.length} transaction line(s) read` });
  return { kind: 'card', lines, period_from: isoDate(period[1]), period_to: isoDate(billing?.[1] ?? period[2]), opening: null, closing: stated.due, checks };
}

/** What kind of file this is, from its first bytes. */
export function fileKind(bytes: Uint8Array): 'xlsx' | 'pdf' | 'unknown' {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx';
  if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'pdf';
  return 'unknown';
}
