// Tally vouchers → the JSON file TallyPrime imports (Import → Data). Modelled on the accountant's own Day Book export of the same
// vouchers (Downloads/DayBook.json): the same keys, the same sign convention (a debit has isdeemedpositive true and a NEGATIVE amount, a
// credit a positive one), dates as YYYYMMDD, bill allocations on the bill-by-bill ledgers. Only the keys an import needs are written;
// Tally fills the rest. The first file should be imported into a COPY company: the import behaviour (unknown ledgers, a voucher sent twice)
// is Tally's and is tested there, not here.
//
// Nothing here talks to Tally. Pure functions, tested without a database.
import { groupOrderVouchers, accountTotals } from './tallyVouchers.js';

export const TALLY = {
  gstin: '09AALCR1014K1ZB', state: 'Uttar Pradesh', registration: 'Uttar Pradesh Registration',
  types: { sales: 'SALES UP', credit_note: 'Credit Note', receipt: 'Receipt', journal: 'Journal', payment: 'Payment', purchase: 'Purchase UP', expense: 'GST EXPENSES' },
  customer: 'Customer (order control)', myntra: 'Myntra receivable (order control)', bank: 'ICICI Bank',
};
// Receivable / payable ledgers that Tally tracks bill by bill, and what names their bills.
const BY_SALE_DOC = new Set([TALLY.customer, TALLY.myntra]);           // the bill is the sale invoice
const BY_ORDER = new Set(['Easebuzz Private Limited', 'COD receivable (Velocity)']);   // the bill is the order

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => (r2(n)).toFixed(2);
const ymd = (d) => String(d).slice(0, 10).replace(/-/g, '');

/** The standard GST state name → the spelling TallyPrime uses ("Jammu & Kashmir"). */
export function tallyState(name) {
  return String(name ?? '').trim().replace(/\band\b/gi, '&').replace(/\s+/g, ' ').replace(/^Dadra & Nagar Haveli & Daman & Diu$/i, 'Dadra & Nagar Haveli and Daman & Diu');
}

// A stable GUID from the voucher's identity, so importing the same voucher again is recognised by Tally as the same voucher.
function guid(seed) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0, h3 = 0x1b873593, h4 = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); h3 = Math.imul(h3 ^ c, 2246822507); h4 = Math.imul(h4 ^ c, 3266489909);
  }
  const hex = [h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const SHORT = { payment: 'GW', delivery: 'COD', store_credit: 'SC', store_credit_used: 'SCU', goodwill: 'GOOD', round_off: 'RND' };
/** The number Tally shows: the invoice or credit note's own; the UTR for a receipt; a stable code for a clearing journal. */
function numberOf(v) {
  if (v.type === 'sales' || v.type === 'credit_note') return v.doc || `${v.orders[0]}`;
  if (v.type === 'receipt') return v.doc || `${v.source}-${v.orders[0]}`;
  return `${SHORT[v.source] ?? v.source}/${v.orders[0]}/${ymd(v.date).slice(4)}`;
}

/** One voucher → one Tally voucher object, or { error }. `orders`: Map orderName → { state, saleDoc, channel }. */
export function tallyVoucher(v, orders) {
  const info = (o) => orders.get(o) ?? {};
  const saleDocOf = (o) => info(o).saleDoc || o;
  const number = numberOf(v);
  const entries = new Map();                                  // account → { amount (positive debit / negative credit), bills: Map ref → { amount, kind } }
  for (const l of v.lines) {
    const net = r2(l.debit - l.credit);
    if (net === 0 && l.debit === 0 && l.credit === 0) continue;
    const e = entries.get(l.account) ?? { amount: 0, bills: new Map() };
    e.amount = r2(e.amount + net);
    const byDoc = BY_SALE_DOC.has(l.account), byOrder = BY_ORDER.has(l.account);
    if (byDoc || byOrder) {
      const ref = net > 0 && (v.type === 'sales') ? number : byDoc ? saleDocOf(l.order) : l.order;
      const kind = net > 0 ? 'New Ref' : 'Agst Ref';
      const b = e.bills.get(`${kind}|${ref}`) ?? { name: ref, kind, amount: 0 };
      b.amount = r2(b.amount + net); e.bills.set(`${kind}|${ref}`, b);
    }
    entries.set(l.account, e);
  }
  const party = [...entries.keys()].find(a => a === TALLY.customer || a === TALLY.myntra);
  const needsState = v.type === 'sales' || v.type === 'credit_note';
  const state = needsState ? tallyState(info(v.orders[0]).state) : '';
  if (needsState && !state) return { error: `no state on order ${v.orders[0]}` };

  const list = [...entries.entries()].map(([ledger, e]) => {
    const debit = e.amount > 0;
    const row = { ledgername: ledger, isdeemedpositive: debit, amount: money(-e.amount) };
    if (ledger === party) row.ispartyledger = true;
    if (ledger === TALLY.bank) row.bankallocations = [{ date: ymd(v.date), instrumentdate: ymd(v.date), instrumentnumber: v.doc || number, transfermode: 'NEFT', amount: money(-e.amount) }];
    if (e.bills.size) row.billallocations = [...e.bills.values()].map(b => ({ name: b.name, billtype: b.kind, amount: money(-b.amount) }));
    return row;
  });

  const typeName = TALLY.types[v.type];
  const id = `${v.type}|${v.id}`;
  const g = guid(`erp-2627|${id}`);
  const base = {
    metadata: { type: 'Voucher', remoteid: g, vchtype: typeName, action: 'Create', objview: needsState ? 'Invoice Voucher View' : 'Accounting Voucher View' },
    date: ymd(v.date), effectivedate: ymd(v.date), guid: g, vouchertypename: typeName, vouchernumber: number,
    narration: `ERP ${v.source.replace(/_/g, ' ')}${v.orders.length === 1 ? ` · order ${v.orders[0]}` : ` · ${v.orders.length} orders`}${v.doc && v.doc !== number ? ` · ${v.doc}` : ''}`,
    gstregistration: { value: TALLY.registration, taxtype: 'GST', taxregistration: TALLY.gstin }, cmpgstin: TALLY.gstin, cmpgststate: TALLY.state,
    persistedview: needsState ? 'Invoice Voucher View' : 'Accounting Voucher View', allledgerentries: list,
  };
  if (needsState) {
    return { ...base, partyledgername: party, partyname: party, basicbuyername: party, placeofsupply: state, statename: state, gstregistrationtype: 'Unregistered/Consumer',
      vchentrymode: 'Accounting Invoice', isinvoice: true, reference: number };
  }
  if (v.type === 'receipt') return { ...base, partyledgername: [...entries.entries()].find(([, e]) => e.amount < 0)?.[0] };   // the receivable the money clears
  return base;
}

/**
 * The file for a month. Returns { file: { tallymessage }, errors, counts, totals, checks }.
 *   vouchers  groupOrderVouchers(...) output (plus later the bill and bank vouchers)
 *   limit     optional: only the first N vouchers of each type (the test file for a copy company)
 */
export function buildTallyFile({ vouchers, orders, limit = null }) {
  const errors = [], messages = [], counts = {};
  const seen = {}, numbers = {};
  for (const v of vouchers) {
    if (!v.balanced) { errors.push({ id: v.id, problem: `does not balance (${v.debit} against ${v.credit})` }); continue; }
    if (limit && (seen[v.type] = (seen[v.type] ?? 0) + 1) > limit) continue;
    const t = tallyVoucher(v, orders);
    if (t.error) { errors.push({ id: v.id, problem: t.error }); continue; }
    // Two clearing events of one order on one day (a split payment) would share a number: the second and later get -2, -3.
    const nk = `${t.vouchertypename}|${t.vouchernumber}`;
    numbers[nk] = (numbers[nk] ?? 0) + 1;
    if (numbers[nk] > 1) t.vouchernumber = `${t.vouchernumber}-${numbers[nk]}`.slice(-32);
    messages.push(t); counts[v.type] = (counts[v.type] ?? 0) + 1;
  }
  // The built-in checks: every voucher in the file balances in Tally's own signs, and the ledger totals of what was written equal the ERP ledger's.
  const unbalanced = messages.filter(m => Math.abs(m.allledgerentries.reduce((s, e) => s + Number(e.amount), 0)) > 0.005);
  const written = accountTotals(vouchers.filter(v => messages.some(m => m.guid === guid(`erp-2627|${v.type}|${v.id}`))));
  const all = accountTotals(vouchers);
  const gaps = limit ? [] : Object.keys(all).filter(a => Math.abs((written[a]?.debit ?? 0) - all[a].debit) > 0.005 || Math.abs((written[a]?.credit ?? 0) - all[a].credit) > 0.005);
  const checks = [
    { id: 'balanced', ok: unbalanced.length === 0, detail: unbalanced.length ? `${unbalanced.length} voucher(s) do not sum to zero in the file.` : `Every one of the ${messages.length} vouchers sums to zero.` },
    { id: 'totals', ok: gaps.length === 0, detail: limit ? 'A test file: ledger totals are not compared.' : gaps.length ? `The file's totals differ from the ledger's for: ${gaps.slice(0, 5).join(', ')}.` : 'Every ledger\'s debit and credit total in the file equals the order ledger\'s.' },
    { id: 'skipped', ok: errors.length === 0, detail: errors.length ? `${errors.length} voucher(s) left out: ${errors.slice(0, 3).map(e => e.problem).join('; ')}.` : 'No voucher was left out.' },
  ];
  return { file: { tallymessage: messages }, errors, counts, checks, totals: written };
}

export const tallyFileName = (month, test) => `Tally-vouchers-${month}${test ? '-TEST' : ''}.json`;
export { groupOrderVouchers, guid };
