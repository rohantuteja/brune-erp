// Reading the GSTR-2B file that the GST portal lets you download (Returns Dashboard → GSTR-2B → Download), as JSON or Excel.
// GSTR-2B is the portal's list of the purchase invoices and credit notes your suppliers reported about you for one month; the input tax
// credit you may claim in GSTR-3B is what is in it. Pure functions, no network: the page reads the file in the browser, checks it, shows
// what it found, and only then stores the lines (nothing leaves the browser until the person presses Save).
//
// What is read (everything else in the file is counted and reported as "not read"):
//   invoices (B2B) and debit / credit notes (B2B-CDNR): supplier GSTIN, number, date, taxable value, IGST / CGST / SGST / cess,
//   "ITC available" (Y / N and why), reverse charge, and the supplier's return period.
//
// A document is { kind: 'invoice' | 'debit_note' | 'credit_note', ctin, supplier, no, date, value, taxable, igst, cgst, sgst, cess, itc: 'Y' | 'N', reason, rcm, supplierPeriod }.
// Amounts are positive as printed; a credit note reduces input tax credit, an invoice and a debit note add to it (see signOf).
import { xlsxSheets } from './xlsxRead.js';

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (x) => { if (typeof x === 'number') return Number.isFinite(x) ? x : 0; const n = Number(String(x ?? '').replace(/[,\s₹]/g, '')); return Number.isFinite(n) ? n : 0; };
const str = (x) => String(x ?? '').trim();

/** An invoice number reduced to what identifies it, so "SVF/26-27/265" and "svf 2627 265" are the same: no case, punctuation or leading zeros. */
export const normInvoice = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=.)/, '');
export const signOf = (d) => d.kind === 'credit_note' ? -1 : 1;
export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
/** "05-10-2026", "05/10/2026", "2026-10-05", "5-Oct-2026" or an Excel date number → "2026-10-05"; null when it is not a date. */
export function parseDate(s) {
  const t = str(s);
  let m;
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t))) return ymd(+m[3], +m[2], +m[1]);
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]*(\d{4})$/.exec(t))) { const mm = MONTHS[m[2].toLowerCase()]; return mm ? ymd(+m[3], mm, +m[1]) : null; }
  if (/^\d{5}(\.\d+)?$/.test(t)) { const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 864e5); return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
  return null;
}

/** "102026" (the portal's MMYYYY) → "2026-10". */
const periodOf = (s) => { const m = /^(\d{2})(\d{4})$/.exec(str(s)); return m && +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${m[1]}` : null; };

function doc(kind, sup, x, no, date, value, amounts) {
  return {
    kind, ctin: str(sup.ctin).toUpperCase(), supplier: str(sup.trdnm), no: str(no), date: parseDate(date), value: r2(num(value)),
    taxable: r2(amounts.taxable), igst: r2(amounts.igst), cgst: r2(amounts.cgst), sgst: r2(amounts.sgst), cess: r2(amounts.cess),
    itc: str(x.itcavl).toUpperCase() === 'N' ? 'N' : 'Y', reason: str(x.rsn), rcm: str(x.rev).toUpperCase() === 'Y', supplierPeriod: str(sup.supprd),
  };
}
const amountsOf = (x) => {
  const list = Array.isArray(x.items) && x.items.length ? x.items : [x];
  return list.reduce((a, i) => ({ taxable: a.taxable + num(i.txval), igst: a.igst + num(i.igst), cgst: a.cgst + num(i.cgst), sgst: a.sgst + num(i.sgst), cess: a.cess + num(i.cess) }), { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
};

/** What ITC the file's own documents add up to (credit notes taken off), for the lines that the portal counts as available and not reverse charge. */
export function availableTotals(docs) {
  const t = { igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const d of docs) if (d.itc === 'Y' && !d.rcm) for (const k of Object.keys(t)) t[k] = r2(t[k] + signOf(d) * d[k]);
  return t;
}

const NOT_READ_JSON = ['b2ba', 'cdnra', 'isd', 'isda', 'impg', 'impgsez', 'ecom', 'ecoma'];
const NOT_READ_LABEL = { b2ba: 'amended invoices (B2BA)', cdnra: 'amended credit / debit notes (CDNRA)', isd: 'input service distributor credit (ISD)', isda: 'amended ISD', impg: 'imports of goods (IMPG)', impgsez: 'imports from SEZ (IMPGSEZ)', ecom: 'supplies through e-commerce operators (ECO)', ecoma: 'amended ECO supplies' };

function finish(base, docs, extraChecks = []) {
  const checks = [...extraChecks];
  const nb = docs.filter(d => d.kind === 'invoice').length, nc = docs.filter(d => d.kind === 'credit_note').length, nd = docs.filter(d => d.kind === 'debit_note').length;
  checks.unshift({ id: 'read', ok: docs.length > 0, detail: docs.length ? `Read ${nb} invoice${nb === 1 ? '' : 's'}${nc ? `, ${nc} credit note${nc === 1 ? '' : 's'}` : ''}${nd ? `, ${nd} debit note${nd === 1 ? '' : 's'}` : ''} from ${new Set(docs.map(d => d.ctin)).size} supplier${new Set(docs.map(d => d.ctin)).size === 1 ? '' : 's'}.` : 'The file has no invoices or credit notes in it (an empty month, or it was not read).' });
  const noDate = docs.filter(d => !d.date).length;
  if (noDate) checks.push({ id: 'dates', ok: false, detail: `${noDate} document${noDate === 1 ? ' has' : 's have'} no readable date.` });
  const badGstin = docs.filter(d => !GSTIN_RE.test(d.ctin)).length;
  if (badGstin) checks.push({ id: 'gstin', ok: false, detail: `${badGstin} document${badGstin === 1 ? ' has' : 's have'} a supplier GSTIN that is not 15 characters in the usual shape.` });
  return { ...base, docs, checks };
}

// ── JSON ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseGstr2bJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('This is not a readable JSON file.'); }
  const d = j && typeof j === 'object' && j.data && typeof j.data === 'object' ? j.data : j;
  const dd = d?.docdata;
  if (!dd || typeof dd !== 'object') throw new Error('This does not look like a GSTR-2B JSON file: it has no "docdata" section.');
  const docs = [];
  for (const sup of Array.isArray(dd.b2b) ? dd.b2b : []) for (const inv of Array.isArray(sup.inv) ? sup.inv : []) docs.push(doc('invoice', sup, inv, inv.inum, inv.dt, inv.val, amountsOf(inv)));
  for (const sup of Array.isArray(dd.cdnr) ? dd.cdnr : []) for (const nt of Array.isArray(sup.nt) ? sup.nt : []) docs.push(doc(str(nt.typ).toUpperCase() === 'D' ? 'debit_note' : 'credit_note', sup, nt, nt.ntnum, nt.dt, nt.val, amountsOf(nt)));

  const checks = [];
  const ns = d?.itcsumm?.itcavl?.nonrevsup;
  if (ns && ['igst', 'cgst', 'sgst'].every(k => Number.isFinite(Number(ns[k])))) {
    const mine = availableTotals(docs);
    const off = ['igst', 'cgst', 'sgst'].filter(k => Math.abs(mine[k] - Number(ns[k])) > 1);
    checks.push({ id: 'summary', ok: off.length === 0, detail: off.length
      ? `The file's own summary of available credit (IGST ${r2(Number(ns.igst))}, CGST ${r2(Number(ns.cgst))}, SGST ${r2(Number(ns.sgst))}) differs from the documents read (IGST ${mine.igst}, CGST ${mine.cgst}, SGST ${mine.sgst}). Some lines may not have been read.`
      : 'The documents add up to the file\'s own summary of available credit.' });
  }
  const skipped = NOT_READ_JSON.filter(k => Array.isArray(dd[k]) && dd[k].length);
  const warnings = skipped.map(k => `The file also has ${NOT_READ_LABEL[k]}, which this screen does not read. Look at it on the portal.`);
  return finish({ source: 'json', gstin: str(d.gstin).toUpperCase() || null, legalName: str(d.legalName || d.lgnm) || null, period: periodOf(d.rtnprd), generatedOn: parseDate(d.gendt), warnings }, docs, checks);
}

// ── Excel ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The portal's Excel has a "Read me" sheet, then B2B, B2B-CDNR and others, each with a two-line header (a group line, then the field names).
const cleanLabel = (s) => str(s).toLowerCase().replace(/\s+/g, ' ');
const COLS = {
  ctin: /gstin of supplier/, supplier: /trade\/legal name|legal name|trade name/, no: /^(invoice|note|debit note|credit note) (number|no)/, type: /^(invoice|note) type/, date: /^(invoice|note) date/,
  value: /^(invoice|note) value/, rcm: /reverse charge/, rate: /^rate/, taxable: /^taxable value/, igst: /^integrated tax/, cgst: /^central tax/, sgst: /^state\/ut tax|^state tax/, cess: /^cess/,
  period: /(gstr-?1|iff|gstr-?5).*period/, itc: /itc availability/, reason: /^reason/,
};

function tableOf(rows) {
  const hi = rows.findIndex(r => r.some(c => /gstin of supplier/.test(cleanLabel(c))));
  if (hi < 0) return null;
  const top = rows[hi], sub = rows[hi + 1] ?? [];
  const width = Math.max(top.length, sub.length);
  const labels = Array.from({ length: width }, (_, i) => cleanLabel(sub[i]) || cleanLabel(top[i]));
  const at = {};
  for (const [k, re] of Object.entries(COLS)) { const i = labels.findIndex(l => re.test(l)); if (i >= 0) at[k] = i; }
  const need = ['ctin', 'no', 'date', 'taxable', 'igst', 'cgst', 'sgst'];
  const missing = need.filter(k => at[k] === undefined);
  if (missing.length) return { error: `could not find the column${missing.length === 1 ? '' : 's'} for ${missing.join(', ')}` };
  const body = rows.slice(hi + 2).filter(r => GSTIN_RE.test(str(r[at.ctin]).toUpperCase()));
  return { at, body };
}

const yes = (s) => /^(y|yes)$/i.test(str(s));
function readExcelSheet(rows, kindOf) {
  const t = tableOf(rows);
  if (!t) return { docs: [] };
  if (t.error) return { error: t.error, docs: [] };
  // One invoice can take several lines (one per tax rate): they are added up.
  const byKey = new Map();
  for (const r of t.body) {
    const kind = kindOf(t.at.type !== undefined ? str(r[t.at.type]) : '');
    const a = { taxable: num(r[t.at.taxable]), igst: num(r[t.at.igst]), cgst: num(r[t.at.cgst]), sgst: num(r[t.at.sgst]), cess: t.at.cess !== undefined ? num(r[t.at.cess]) : 0 };
    const key = `${str(r[t.at.ctin]).toUpperCase()}|${normInvoice(r[t.at.no])}|${kind}`;
    const itcavl = t.at.itc !== undefined ? (yes(r[t.at.itc]) ? 'Y' : 'N') : 'Y';
    const prior = byKey.get(key);
    if (prior) { for (const k of Object.keys(a)) prior[k] = r2(prior[k] + a[k]); if (itcavl === 'N') prior.itc = 'N'; continue; }
    const x = { itcavl, rsn: t.at.reason !== undefined ? r[t.at.reason] : '', rev: t.at.rcm !== undefined ? (yes(r[t.at.rcm]) ? 'Y' : 'N') : 'N' };
    byKey.set(key, doc(kind, { ctin: r[t.at.ctin], trdnm: t.at.supplier !== undefined ? r[t.at.supplier] : '', supprd: t.at.period !== undefined ? r[t.at.period] : '' }, x, r[t.at.no], r[t.at.date], t.at.value !== undefined ? r[t.at.value] : 0, a));
  }
  return { docs: [...byKey.values()] };
}

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function readMe(rows) {
  const out = {};
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      const label = cleanLabel(r[i]);
      if (!label) continue;
      const next = () => { for (let k = i + 1; k < r.length; k++) if (str(r[k])) return str(r[k]); return ''; };
      if (/^gstin\b/.test(label) && !out.gstin) { const v = next().toUpperCase(); if (GSTIN_RE.test(v)) out.gstin = v; }
      else if (/^(legal name|legal name of the registered person)/.test(label)) out.legalName = out.legalName || next();
      else if (/^financial year/.test(label)) out.fy = out.fy || next();
      else if (/^(tax period|return period|period)\b/.test(label)) out.period = out.period || next();
      else if (/date of generation|generated on/.test(label)) out.generatedOn = out.generatedOn || next();
    }
  }
  return out;
}

/** "October" + "2026-27" → "2026-10"; "102026" → "2026-10"; null when it cannot be told. */
function periodFromReadMe(m) {
  const direct = periodOf(str(m.period).replace(/\D/g, ''));
  if (direct && str(m.period).replace(/\D/g, '').length === 6) return direct;
  const mi = FULL_MONTHS.findIndex(n => cleanLabel(m.period).startsWith(n.slice(0, 3)));
  const fy = /^(\d{4})/.exec(str(m.fy));
  if (mi < 0 || !fy) return null;
  const month = mi + 1, year = month >= 4 ? +fy[1] : +fy[1] + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function parseGstr2bSheets(sheets) {
  const names = [...sheets.keys()];
  const find = (re) => names.find(n => re.test(n.trim()));
  const b2b = find(/^b2b$/i), cdn = find(/^b2b[- _]?cdnr$/i);
  if (!b2b && !cdn) throw new Error('This does not look like a GSTR-2B Excel file: it has no "B2B" sheet.');
  const errors = [];
  const inv = b2b ? readExcelSheet(sheets.get(b2b), () => 'invoice') : { docs: [] };
  if (inv.error) errors.push(`B2B sheet: ${inv.error}`);
  const nt = cdn ? readExcelSheet(sheets.get(cdn), (t) => /^d/i.test(t) ? 'debit_note' : 'credit_note') : { docs: [] };
  if (nt.error) errors.push(`B2B-CDNR sheet: ${nt.error}`);
  if (errors.length) throw new Error(`The columns in this file are not the ones expected (${errors.join('; ')}). Download the file again from the portal, or use the JSON version.`);

  const me = find(/^read ?me$/i) ? readMe(sheets.get(find(/^read ?me$/i))) : {};
  const warnings = [];
  for (const [re, label] of [[/^b2ba$/i, NOT_READ_LABEL.b2ba], [/^b2b[- _]?cdnra$/i, NOT_READ_LABEL.cdnra], [/^isd$/i, NOT_READ_LABEL.isd], [/^eco$/i, NOT_READ_LABEL.ecom]]) {
    const n = find(re);
    if (n && (sheets.get(n) ?? []).some(r => GSTIN_RE.test(str(r[0]).toUpperCase()))) warnings.push(`The file also has ${label}, which this screen does not read. Look at it on the portal.`);
  }
  return finish({ source: 'excel', gstin: me.gstin ?? null, legalName: me.legalName ?? null, period: periodFromReadMe(me), generatedOn: parseDate(me.generatedOn), warnings }, [...inv.docs, ...nt.docs]);
}

/** A picked file (name + bytes) → the parsed 2B. Throws an Error with a plain sentence when it cannot be read. */
export async function parseGstr2bFile(name, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isZip = u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4b;
  if (isZip) {
    let sheets;
    try { sheets = await xlsxSheets(u8); } catch (e) { throw new Error(`This Excel file could not be opened (${e.message}).`); }
    return { ...parseGstr2bSheets(sheets), fileName: name };
  }
  return { ...parseGstr2bJson(new TextDecoder().decode(u8)), fileName: name };
}
