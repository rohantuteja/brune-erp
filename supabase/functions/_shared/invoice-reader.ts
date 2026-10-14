// Reads a supplier's tax invoice from the text of its PDF. Pure rules, no network, no AI, no paid service: the caller
// extracts the text with its position (pdf.js, as the card-statement reader does) and hands it in.
//
//   readInvoicePdf(items, { companyGstin })  → every invoice found in the file, with checks that say whether to trust it
//
// How it reads (the layouts differ between billing programs, so nothing depends on where a field sits):
//   - a GSTIN has a fixed shape and a check digit: the first one that is not ours and not the transporter's is the supplier's
//   - "Invoice No" / "Date" are found by their label, the value being the next thing to its right (or below it)
//   - the amounts are SOLVED, not located: it looks for a taxable value, a GST amount at a standard rate and a total that
//     agree with each other to within a rupee of rounding, wherever they are printed
//   - the line items are read by column: every header is a column, text goes to the column it starts under, numbers to the
//     nearest one, and a "Qty Unit" cell is split
//   - the supplier's name is the "for <name>" line above the signature, which every Indian tax invoice carries
// Every field is then checked (the GSTIN's check digit, taxable + GST = total, lines add up, quantity × rate = amount,
// billed to us, IGST vs CGST/SGST for the states involved). Anything doubtful is `review`, never silently accepted.
//
// A file can hold one invoice printed twice ("original for recipient", "duplicate for transporter"): the copies are
// recognised by supplier + invoice number and read once. An invoice that runs onto a second page is joined.

import { GST_STATES, resolveState } from './gst-states.ts';

export type TextItem = { page: number; x: number; y: number; w: number; s: string };   // y as pdf.js gives it: up from the bottom
export type ReadOptions = { companyGstin: string; today?: string };                      // today: YYYY-MM-DD, to refuse a future date
export type InvoiceLine = { description: string; hsn: string | null; qty: number | null; unit: string | null; rate: number | null; amount: number | null };
export type Check = { id: string; ok: boolean; detail: string };
export type ReadInvoice = {
  status: 'ok' | 'review' | 'unreadable';
  supplier: { name: string | null; name_source: 'signature' | 'header' | null; gstin: string | null; pan: string | null; state_code: string | null; state: string | null };
  buyer_gstin: string | null;
  invoice_no: string | null;
  invoice_date: string | null;                    // YYYY-MM-DD
  place_of_supply: string | null;                 // GST state name
  irn: string | null;                             // the e-invoice reference, when the invoice has one
  taxable: number | null;
  tax_type: 'IGST' | 'CGST+SGST' | null;
  tax_rate: number | null;                        // per cent, the whole GST (5 for 2.5 + 2.5)
  tax: number | null;
  round_off: number | null;                       // total − taxable − tax
  total: number | null;
  lines: InvoiceLine[];
  checks: Check[];
  copies: number;                                 // how many times this invoice is printed in the file
};
export type ReadResult = { invoices: ReadInvoice[]; pages: number; problem: 'no_text' | 'no_invoice' | null };

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (s: string) => Number(String(s).replace(/,/g, ''));

// ── GSTIN ────────────────────────────────────────────────────────────────────────────────────
const GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;
const GSTIN_HERE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A GSTIN's 15th character is a check digit over the first 14. */
export function gstinChecksumOk(g: string): boolean {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = GSTIN_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14];
}
export const panOf = (g: string) => g.slice(2, 12);

// ── Dates and units ──────────────────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** 04-10-2026, 4/10/26, 3-Oct-26, 03 October 2026 → 2026-10-04. Null when it is not a real date. */
export function parseInvoiceDate(s: string): string | null {
  let d: number, mo: number, y: number;
  let m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = /(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/., ]+(\d{2,4})/.exec(s))) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()] ?? 0; y = +m[3]; }
  else return null;
  if (y < 100) y += 2000;
  if (!mo || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return back.getUTCDate() === d && back.getUTCMonth() + 1 === mo ? iso : null;
}

/** The units fabric comes in, as one spelling each: KGS, MTR, PCS; anything else as printed, upper case. */
export function normalizeUnit(u: string | null | undefined): string | null {
  const t = String(u ?? '').trim().replace(/\.$/, '');
  if (!t) return null;
  if (/^(kgs?|kilo(gram)?s?)$/i.test(t)) return 'KGS';
  if (/^(mtrs?|metres?|meters?|m)$/i.test(t)) return 'MTR';
  if (/^(pcs?|pieces?|nos?)$/i.test(t)) return 'PCS';
  return t.toUpperCase();
}

// ── Rows of text ─────────────────────────────────────────────────────────────────────────────
type Cell = { x: number; w: number; s: string };
type Row = { y: number; cells: Cell[]; text: string };

const PAGE_GAP = 100000;      // pages are stacked into one tall sheet so rows of different pages never merge

function rowsOf(items: Array<{ x: number; y: number; w: number; s: string }>): Row[] {
  const rows: Row[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const s = it.s.trim();
    if (!s) continue;
    const row = rows.find(r => Math.abs(r.y - it.y) <= 3);
    const cell = { x: it.x, w: it.w, s };
    if (row) row.cells.push(cell); else rows.push({ y: it.y, cells: [cell], text: '' });
  }
  for (const r of rows) { r.cells.sort((a, b) => a.x - b.x); r.text = r.cells.map(c => c.s).join(' | '); }
  return rows;
}

/** The value printed after a label: the rest of the same cell, else the next non-empty cell to its right, else the row below. */
function valueAfter(rows: Row[], label: RegExp, accept: (v: string) => boolean = () => true, not?: RegExp): string | null {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].cells.map(c => c.s);
    for (let j = 0; j < cells.length; j++) {
      if (!label.test(cells[j]) || (not && not.test(cells[j]))) continue;
      const candidates: string[] = [cells[j].replace(label, '').replace(/^[\s:.\-]+/, '')];
      for (let k = j + 1; k < cells.length; k++) candidates.push(cells[k].replace(/^[\s:]+/, ''));
      if (rows[i + 1]) candidates.push(rows[i + 1].cells[0]?.s ?? '');
      for (const c of candidates) { const v = c.trim(); if (v && v !== ':' && accept(v)) return v; }
    }
  }
  return null;
}

// ── The amounts ──────────────────────────────────────────────────────────────────────────────
const AMOUNT = /(?<![\d.,])(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{1,2}(?!\d)/g;
const GST_RATES = [0.25, 3, 5, 12, 18, 28];
export type Solved = { taxable: number; rate: number; kind: 'IGST' | 'CGST+SGST'; tax: number; total: number; round_off: number };

/**
 * Finds the taxable value, the GST and the total among every amount on the invoice: a taxable value T, a standard rate, a
 * GST amount that is T × rate (IGST, or two equal halves for CGST + SGST), and a total that is T + GST within a rupee of
 * rounding. Of the combinations that agree, the one with the least rounding wins, then the one whose taxable value sits
 * next to a "taxable / before tax" label.
 */
export function solveAmounts(text: string): Solved | null {
  const all = [...text.matchAll(AMOUNT)].map(m => r2(num(m[0])));
  const values = [...new Set(all)].filter(v => v >= 50);
  const count = (v: number) => all.filter(x => Math.abs(x - v) <= 0.005).length;
  const near = (v: number, tol: number) => values.find(x => Math.abs(x - v) <= tol);
  const labelled = new Set<number>();
  for (const m of text.matchAll(/(?:taxable|before\s+tax)[^\d\n]{0,40}((?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{1,2})/gi)) labelled.add(r2(num(m[1])));

  let best: (Solved & { cost: number }) | null = null;
  for (const rate of GST_RATES) {
    for (const T of values) {
      const tax = r2(T * rate / 100);
      const halves = rate >= 3 ? near(r2(tax / 2), 0.51) : undefined;
      const igst = near(tax, 1.01);
      const split = halves !== undefined && count(halves) >= 2;          // CGST and SGST are both printed
      const options: Array<{ kind: 'IGST' | 'CGST+SGST'; tax: number }> = [];
      if (split) options.push({ kind: 'CGST+SGST', tax: r2((halves as number) * 2) });
      else if (igst !== undefined) options.push({ kind: 'IGST', tax: igst });
      for (const o of options) {
        const total = values.find(x => x > T && Math.abs(x - (T + o.tax)) <= 1.0);
        if (total === undefined) continue;
        const ro = r2(total - T - o.tax);
        const cost = Math.abs(ro) * 1000 + (labelled.has(T) ? 0 : 50) - T / 1e4;
        if (!best || cost < best.cost) best = { taxable: T, rate, kind: o.kind, tax: o.tax, total, round_off: ro, cost };
      }
    }
  }
  if (!best) return null;
  const { cost: _cost, ...solved } = best;
  return solved;
}

// ── The line items ───────────────────────────────────────────────────────────────────────────
type Col = 'desc' | 'hsn' | 'qty' | 'unit' | 'rate' | 'amount' | 'other';
const HEADER_COL: Array<[Col, RegExp]> = [
  ['desc', /description|design|particulars|item/i], ['hsn', /^hsn/i], ['qty', /^(qty|quantity|weight|meters?|mtrs?)\b/i],
  ['unit', /^unit$/i], ['rate', /^(rate|price)$/i], ['amount', /^amount/i],
];
// a number, or a number with its unit ("10.000 kgs"): placed by where its middle is, not by where it starts
const isNumeric = (s: string) => /^[\d,.\-%\s]+$/.test(s) || /^[\d,]*\.?\d+\s*(kgs?|mtrs?|metres?|meters?|pcs?|nos)\.?$/i.test(s);

function lineItems(rows: Row[]): InvoiceLine[] {
  const hi = rows.findIndex(r => /description|design name|particulars/i.test(r.text) && /hsn/i.test(r.text) && /rate|price/i.test(r.text) && /amount/i.test(r.text));
  if (hi < 0) return [];
  const cols = rows[hi].cells.map(c => ({ left: c.x, mid: c.x + c.w / 2, col: (HEADER_COL.find(([, re]) => re.test(c.s))?.[0] ?? 'other') as Col }));
  const colOf = (c: Cell): Col => {
    if (!isNumeric(c.s)) {      // text sits under the header where it starts (a left-aligned description, a colour, a unit)
      const under = [...cols].filter(h => h.left <= c.x + 3).sort((a, b) => b.left - a.left)[0];
      if (under) return under.col;
    }
    const mid = c.x + c.w / 2;
    return [...cols].sort((a, b) => Math.abs(a.mid - mid) - Math.abs(b.mid - mid))[0].col;
  };
  const hsnHead = cols.find(h => h.col === 'hsn');
  const items: Array<Partial<Record<Col, string>>> = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    if (/^(total|remark|payment status|add |less |igst|cgst|sgst|r\/o|round|hsn\/sac|tax rate|tax analysis|amount chargeable)/i.test(r.cells[0].s)) break;
    const hsnCell = r.cells.find(c => /^\d{4,8}$/.test(c.s));
    const isItem = /^\d+\.?$/.test(r.cells[0].s) || !!hsnCell;
    // The description is whatever sits between the serial number and the HSN (headers are often centred over a left-aligned
    // description, so where the header sits says little about where the text starts); without an HSN, the first text.
    const afterSerial = /^\d+\.?$/.test(r.cells[0].s) ? r.cells.slice(1) : r.cells;
    const descCells = !isItem ? [] : hsnCell ? afterSerial.filter(c => c.x < hsnCell.x) : afterSerial.filter(c => !isNumeric(c.s)).slice(0, 1);
    const row: Partial<Record<Col, string>> = {};
    for (const c of r.cells) {
      const left = !isItem && !isNumeric(c.s) && hsnHead && c.x + c.w / 2 < hsnHead.mid;     // a continuation line of the description
      const col: Col = descCells.includes(c) || left ? 'desc' : colOf(c);
      row[col] = `${row[col] ?? ''} ${c.s}`.trim();
    }
    if (isItem) items.push(row);
    else if (items.length && row.desc && !row.amount) items[items.length - 1].desc = `${items[items.length - 1].desc ?? ''} ${row.desc}`;
  }
  return items.map(it => {
    const qtyCell = it.qty ?? '';
    const qty = /[\d,]*\.?\d+/.exec(qtyCell)?.[0];
    const unitWord = /(kgs?|mtrs?|metres?|meters?|pcs?)\b/i.exec(qtyCell)?.[1] ?? it.unit ?? null;
    const money = (s?: string) => { const m = /[\d,]*\.?\d+/.exec(s ?? ''); return m ? num(m[0]) : null; };
    return {
      description: (it.desc ?? '').replace(/\s+\d+\.\d\d$/, '').replace(/\s+/g, ' ').trim(),
      hsn: /\d{4,8}/.exec(it.hsn ?? '')?.[0] ?? null,
      qty: qty ? num(qty) : null, unit: normalizeUnit(unitWord), rate: money(it.rate), amount: money(it.amount),
    };
  });
}

// ── The supplier's name ──────────────────────────────────────────────────────────────────────
const NOT_A_NAME = /\b(the|any|all|this|that|your|goods|payment|delivery|each|every|you|us|office|use|recipient|transporter|customer)\b/i;
function supplierName(rows: Row[], companyWords: RegExp): { name: string; source: 'signature' | 'header' } | null {
  // "for CHANDRA FASHION" above the signature: the last one on the page that names a business
  let found: string | null = null;
  for (const r of rows) for (const c of r.cells) {
    const m = /^for[,.]?\s+([A-Za-z0-9][A-Za-z0-9 &.,'()\-]{2,60})$/i.exec(c.s);
    if (m && !NOT_A_NAME.test(m[1]) && !companyWords.test(m[1]) && m[1].trim().split(/\s+/).length <= 7) found = m[1].trim().replace(/[.,]+$/, '');
  }
  if (found) return { name: found, source: 'signature' };
  // else the first line of the header that looks like a business name, above the supplier's GSTIN
  const gi = rows.findIndex(r => GSTIN_HERE.test(r.text));
  const head = rows.slice(0, gi < 0 ? 6 : Math.max(gi, 1));
  const noise = /^(tax\s+)?invoice$|^original|^duplicate|^triplicate|^\(?(original|duplicate)|copy|^!!|^gstin|^shop|^plot|^phone|^mobile|^tel|^e-?mail|^pan|^cin|^msme|^bill of supply|^page/i;
  for (const r of head) {
    const t = r.cells.length === 1 ? r.cells[0].s : '';
    if (t && /^[A-Z][A-Za-z0-9 &.,'()\-]{3,60}$/.test(t) && !noise.test(t) && !companyWords.test(t)) return { name: t, source: 'header' };
  }
  return null;
}

// ── One invoice ──────────────────────────────────────────────────────────────────────────────
type Found = { gstin: string; valid: boolean };
function gstinsOf(rows: Row[], company: string): { supplier: Found | null; buyerIsUs: boolean } {
  let supplier: Found | null = null, buyerIsUs = false;
  for (const r of rows) {
    for (const m of r.text.matchAll(GSTIN)) {
      const g = m[1];
      if (g === company) { buyerIsUs = true; continue; }
      if (/transport|carrier|logistic/i.test(r.text)) continue;
      if (!supplier) supplier = { gstin: g, valid: gstinChecksumOk(g) };
    }
  }
  return { supplier, buyerIsUs };
}

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function readOne(items: Array<{ x: number; y: number; w: number; s: string }>, opts: ReadOptions): ReadInvoice {
  const rows = rowsOf(items);
  const text = rows.map(r => r.text).join('\n');
  const company = opts.companyGstin;
  const companyWords = /rethought/i;
  const { supplier, buyerIsUs } = gstinsOf(rows, company);

  const invoice_no = valueAfter(rows, /^(tax\s+)?invoice\s*(no|number|#)\.?\s*:?/i, v => !/^(date|dated|gr|l\.?r|e-?way|ack|irn)/i.test(v) && v.length <= 40, /date/i)
    ?? valueAfter(rows, /^bill\s*(no|number)\.?\s*:?/i, v => v.length <= 40);
  const dateRaw = [/^(invoice\s*date|date\s*of\s*invoice|bill\s*date)\s*:?/i, /^dated\s*:?/i]
    .map(re => valueAfter(rows, re, v => parseInvoiceDate(v) !== null)).find(Boolean) ?? null;
  const invoice_date = dateRaw ? parseInvoiceDate(dateRaw) : null;
  const posRaw = valueAfter(rows, /^place\s*of\s*supply\s*:?/i);
  const pos = posRaw ? resolveState({ name: posRaw.replace(/\s*\(\d+\)\s*$/, ''), code: /\((\d{2})\)/.exec(posRaw)?.[1] ?? null }) : null;
  const irn = /\b[0-9a-f]{64}\b/.exec(text)?.[0] ?? null;

  const solved = solveAmounts(text);
  const lines = lineItems(rows);
  const name = supplierName(rows, companyWords);
  const stateCode = supplier ? supplier.gstin.slice(0, 2) : null;
  const state = stateCode ? GST_STATES.find(s => s.code === stateCode)?.name ?? null : null;

  // ── the checks ──
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  add('supplier_gstin', !!supplier && supplier.valid, !supplier ? 'no supplier GSTIN found' : supplier.valid ? `${supplier.gstin} is a valid GSTIN (${state ?? 'state ' + stateCode})` : `${supplier.gstin} fails the GSTIN check digit: misprinted or misread`);
  add('billed_to_us', buyerIsUs, buyerIsUs ? 'billed to our GSTIN' : 'our GSTIN is not on the invoice: it may be addressed to someone else');
  add('invoice_number', !!invoice_no, invoice_no ? `invoice ${invoice_no}` : 'no invoice number found');
  const future = invoice_date && opts.today && invoice_date > opts.today;
  add('invoice_date', !!invoice_date && !future, !invoice_date ? 'no valid invoice date found' : future ? `${invoice_date} is in the future` : `dated ${invoice_date}`);
  add('amounts', !!solved, solved ? `${money(solved.taxable)} + ${solved.kind} ${solved.rate}% ${money(solved.tax)} = ${money(solved.total)}${solved.round_off ? ` (round-off ${money(solved.round_off)})` : ''}` : 'could not find a taxable value, GST and total that agree');
  if (solved) {
    const supplyState = pos?.code ?? company.slice(0, 2);
    const wantsIgst = !!stateCode && stateCode !== supplyState;
    const fits = !stateCode || (wantsIgst === (solved.kind === 'IGST'));
    add('tax_type', fits, fits ? `${solved.kind} fits supply from ${state ?? stateCode} to ${pos?.name ?? 'the buyer\'s state'}` : `${solved.kind} charged, but supply from ${state ?? stateCode} to ${pos?.name ?? 'the buyer\'s state'} needs ${wantsIgst ? 'IGST' : 'CGST + SGST'}`);
    if (lines.length) {
      const sum = r2(lines.reduce((s, l) => s + (l.amount ?? 0), 0));
      add('lines_total', Math.abs(sum - solved.taxable) <= 1, Math.abs(sum - solved.taxable) <= 1 ? `the lines add up to ${money(sum)}` : `the lines add up to ${money(sum)} but the taxable value is ${money(solved.taxable)}`);
    }
  }
  if (lines.length) {
    const bad = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.qty === null || l.rate === null || l.amount === null || Math.abs(l.qty * l.rate - l.amount) > Math.max(1, l.amount * 0.005));
    add('line_math', bad.length === 0, bad.length === 0 ? 'every line: quantity × rate = amount' : `line ${bad.map(b => b.i + 1).join(', ')}: quantity × rate does not equal the amount`);
  } else add('line_items', false, 'no line items found');

  // unreadable: neither a supplier nor an invoice number could be found. review: something was found but a check failed. ok: every check passed.
  const status: ReadInvoice['status'] = !supplier && !invoice_no ? 'unreadable' : checks.every(c => c.ok) ? 'ok' : 'review';
  return {
    status,
    supplier: { name: name?.name ?? null, name_source: name?.source ?? null, gstin: supplier?.gstin ?? null, pan: supplier ? panOf(supplier.gstin) : null, state_code: stateCode, state },
    buyer_gstin: buyerIsUs ? company : null,
    invoice_no, invoice_date, place_of_supply: pos?.name ?? null, irn,
    taxable: solved?.taxable ?? null, tax_type: solved?.kind ?? null, tax_rate: solved?.rate ?? null, tax: solved?.tax ?? null, round_off: solved?.round_off ?? null, total: solved?.total ?? null,
    lines, checks, copies: 1,
  };
}

// ── A whole file ─────────────────────────────────────────────────────────────────────────────
/** The page's own supplier GSTIN and invoice number: what tells one invoice from the next, and a copy from a continuation. */
function headerOf(rows: Row[], opts: ReadOptions): { gstin: string | null; no: string | null } {
  const { supplier } = gstinsOf(rows, opts.companyGstin);
  const no = valueAfter(rows, /^(tax\s+)?invoice\s*(no|number|#)\.?\s*:?/i, v => !/^(date|dated|gr|l\.?r|e-?way|ack|irn)/i.test(v) && v.length <= 40, /date/i);
  return { gstin: supplier?.gstin ?? null, no };
}

export function readInvoicePdf(items: TextItem[], opts: ReadOptions): ReadResult {
  const pages = items.length ? Math.max(...items.map(i => i.page)) : 0;
  if (!items.some(i => i.s.trim())) return { invoices: [], pages, problem: 'no_text' };

  // Group the pages into invoices: a page that names the same supplier and number as the invoice before it is a copy of
  // it (read once, counted); a page with no supplier or no number is the next page of the invoice before it.
  type Doc = { key: string; pages: number[]; copies: number };
  const docs: Doc[] = [];
  const byPage = new Map<number, TextItem[]>();
  for (const it of items) (byPage.get(it.page) ?? byPage.set(it.page, []).get(it.page)!).push(it);
  for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
    const h = headerOf(rowsOf(byPage.get(p)!), opts);
    const key = h.gstin && h.no ? `${h.gstin}|${h.no}` : '';
    const last = docs[docs.length - 1];
    if (key && last && last.key === key) { last.copies++; continue; }
    if (!key && last) { last.pages.push(p); continue; }
    docs.push({ key, pages: [p], copies: 1 });
  }

  const invoices = docs.map(d => {
    const stacked = d.pages.flatMap((p, n) => byPage.get(p)!.map(it => ({ x: it.x, y: it.y - n * PAGE_GAP, w: it.w, s: it.s })));
    return { ...readOne(stacked, opts), copies: d.copies };
  });
  const real = invoices.filter(i => i.status !== 'unreadable' || i.supplier.gstin || i.invoice_no);
  return real.length ? { invoices: real, pages, problem: null } : { invoices: [], pages, problem: 'no_invoice' };
}
