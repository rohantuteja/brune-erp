// Tally vouchers → the JSON file TallyPrime imports (Import → Data). Modelled on the accountant's own Day Book export of the same
// vouchers (Downloads/DayBook.json): the same keys, the same sign convention (a debit has isdeemedpositive true and a NEGATIVE amount, a
// credit a positive one), dates as YYYYMMDD, bill allocations on the bill-by-bill ledgers. Only the keys an import needs are written;
// Tally fills the rest. The first file should be imported into a COPY company: the import behaviour (unknown ledgers, a voucher sent twice)
// is Tally's and is tested there, not here.
//
// Nothing here talks to Tally. Pure functions, tested without a database.
import { groupOrderVouchers, accountTotals } from './tallyVouchers.js';
import { BOOKS } from './tallyBooks.js';

export const TALLY = {
  gstin: '09AALCR1014K1ZB', state: 'Uttar Pradesh', registration: 'Uttar Pradesh Registration',
  // The owner (18 Nov 2026): SALES UP, Purchase UP and GST EXPENSES are voucher NAMES in his Tally, not types; the types are the standard ones.
  types: { sales: 'Sales', credit_note: 'Credit Note', receipt: 'Receipt', journal: 'Journal', payment: 'Payment', purchase: 'Purchase', expense: 'Purchase', stock_journal: 'Stock Journal' },
  customer: 'Customer (order control)', myntra: 'Myntra receivable (order control)', bank: 'ICICI Bank',
  // The one stock item every sale and return of the ready garments is booked on (owner, 18 Nov 2026: one item for all styles); HSN as on the accountant's own sales vouchers.
  item: 'BRUNE LADIES DRESSES', hsn: '6204', unit: 'Pcs',
};
// Receivable / payable ledgers that Tally tracks bill by bill, and what names their bills.
const BY_SALE_DOC = new Set([TALLY.customer, TALLY.myntra]);           // the bill is the sale invoice
const BY_ORDER = new Set(['Easebuzz Private Limited', 'COD receivable (Velocity)']);   // the bill is the order

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => (r2(n)).toFixed(2);
const ymd = (d) => String(d).slice(0, 10).replace(/-/g, '');

// The bank line of a voucher, with the keys Tally itself writes (the accountant's Day Book): the bank's date is what marks it reconciled.
const bankAlloc = (date, ref, amount, favouring) => ({ date: ymd(date), instrumentdate: ymd(date), bankersdate: ymd(date), transactiontype: 'Others', paymentfavouring: favouring, instrumentnumber: ref, amount: money(amount) });
/** The ledger entries of a written voucher: Tally keeps an invoice's under `ledgerentries` and an accounting voucher's under `allledgerentries`. */
export const entriesOf = (m) => m.ledgerentries ?? m.allledgerentries ?? [];
/** Everything that has to sum to zero in a written voucher: its ledger entries and, on an item invoice, its stock items. */
const entriesSum = (m) => entriesOf(m).reduce((s, e) => s + Number(e.amount), 0) + (m.allinventoryentries ?? []).reduce((s, e) => s + Number(e.amount), 0);

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
  // The goods of a sale or a return with their pieces are stock items (BRUNE LADIES DRESSES, quantity, rate); the COD charge, the return fee and the taxes stay ledger lines.
  const itemised = (v.type === 'sales' || v.type === 'credit_note') ? v.lines.filter(l => l.part === 'goods' && Number(l.qty) > 0 && r2(l.debit - l.credit) !== 0) : [];
  for (const l of v.lines) {
    if (itemised.includes(l)) continue;
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
    if (ledger === TALLY.bank) row.bankallocations = [bankAlloc(v.date, v.doc || number, -e.amount, [...entries.keys()].find(a => a !== TALLY.bank) ?? '')];
    if (e.bills.size) row.billallocations = [...e.bills.values()].map(b => ({ name: b.name, billtype: b.kind, amount: money(-b.amount) }));
    return row;
  });

  const inventory = itemised.map(l => {
    const net = r2(l.debit - l.credit), debit = net > 0, amount = money(-net), qty = ` ${Math.round(Number(l.qty))} ${TALLY.unit}`;
    return { stockitemname: TALLY.item, gstovrdntaxability: 'Taxable', gstsourcetype: 'Ledger', gstledgersource: l.account, hsnsourcetype: 'Ledger', hsnledgersource: l.account, gstovrdntypeofsupply: 'Goods',
      gstrateinferapplicability: 'As per Masters/Company', gsthsnname: TALLY.hsn, gsthsninferapplicability: 'As per Masters/Company', ...(debit ? { isdeemedpositive: true, islastdeemedpositive: true } : {}),
      rate: `${(Math.abs(net) / Number(l.qty)).toFixed(2)}/${TALLY.unit}`, amount, actualqty: qty, billedqty: qty,
      batchallocations: [{ godownname: BOOKS.godown, batchname: BOOKS.batch, amount, actualqty: qty, billedqty: qty }],
      accountingallocations: [{ ledgername: l.account, ...(debit ? { isdeemedpositive: true } : {}), amount }] };
  });
  const typeName = TALLY.types[v.type];
  const id = `${v.type}|${v.id}`;
  const g = guid(`erp-2627|${id}`);
  const base = {
    metadata: { type: 'Voucher', remoteid: g, vchtype: typeName, action: 'Create', objview: needsState ? 'Invoice Voucher View' : 'Accounting Voucher View' },
    date: ymd(v.date), effectivedate: ymd(v.date), guid: g, vouchertypename: typeName, vouchernumber: number,
    narration: `ERP ${v.source.replace(/_/g, ' ')}${v.orders.length === 1 ? ` · order ${v.orders[0]}` : ` · ${v.orders.length} orders`}${v.doc && v.doc !== number ? ` · ${v.doc}` : ''}`,
    gstregistration: { value: TALLY.registration, taxtype: 'GST', taxregistration: TALLY.gstin }, cmpgstin: TALLY.gstin, cmpgststate: TALLY.state,
    persistedview: needsState ? 'Invoice Voucher View' : 'Accounting Voucher View', ...(needsState ? { ledgerentries: list } : { allledgerentries: list }),
  };
  if (needsState) {
    return { ...base, partyledgername: party, partyname: party, basicbuyername: party, placeofsupply: state, statename: state, gstregistrationtype: 'Unregistered/Consumer',
      vchentrymode: inventory.length ? 'Item Invoice' : 'Accounting Invoice', isinvoice: true, reference: number, ...(inventory.length ? { allinventoryentries: inventory } : {}) };
  }
  if (v.type === 'receipt') return { ...base, partyledgername: [...entries.entries()].find(([, e]) => e.amount < 0)?.[0] };   // the receivable the money clears
  return base;
}

const gstRates = (rate, split) => rate ? (split
  ? [{ gstratedutyhead: 'CGST', gstratevaluationtype: 'Based on Value', gstrate: ` ${rate / 2}` }, { gstratedutyhead: 'SGST/UTGST', gstratevaluationtype: 'Based on Value', gstrate: ` ${rate / 2}` }]
  : [{ gstratedutyhead: 'IGST', gstratevaluationtype: 'Based on Value', gstrate: ` ${rate}` }]) : [];
const qtyText = (n, unit) => ` ${String(Math.round(n * 1000) / 1000)} ${unit}`;

/**
 * A voucher from the Bills or Bank & card data (tallyBooks.js) → one Tally voucher.
 *   purchase  an invoice voucher in the shape of the accountant's own (his GST EXPENSES voucher and the Purchase UP sample): party, its GSTIN and state, place of supply,
 *             the supplier's invoice number as voucher number and reference, the bill allocations on the supplier's line, and for fabric the stock items with godown and batch.
 *   payment / receipt   an accounting voucher: the supplier's line carries its bills (Agst Ref) or an Advance, the bank line the reference and the bank's date.
 */
export function tallyBookVoucher(v) {
  const typeName = TALLY.types[v.type];
  const g = guid(`erp-2627|${v.type}|${v.id}`);
  const company = { gstregistration: { value: TALLY.registration, taxtype: 'GST', taxregistration: TALLY.gstin }, cmpgstin: TALLY.gstin, cmpgststate: TALLY.state };
  const head = (view) => ({ metadata: { type: 'Voucher', remoteid: g, vchtype: typeName, action: 'Create', objview: view }, date: ymd(v.date), effectivedate: ymd(v.date), guid: g, vouchertypename: typeName, vouchernumber: v.number, narration: v.memo, ...company, persistedview: view });

  if (v.type === 'purchase') {
    const rows = v.lines.map(l => {
      const net = r2(l.debit - l.credit);
      const row = { ledgername: l.account, isdeemedpositive: net > 0, amount: money(-net) };
      if (l.account === v.party && net < 0) { row.ispartyledger = true; row.billallocations = v.billRefs.map(b => ({ name: b.name, billtype: b.kind, amount: money(b.amount) })); }
      if (net > 0 && l.account === v.expense) Object.assign(row, { islastdeemedpositive: true, gstovrdntaxability: 'Taxable', gstsourcetype: 'Ledger', gstledgersource: l.account, hsnsourcetype: 'Ledger', hsnledgersource: l.account,
        gstovrdntypeofsupply: v.services ? 'Services' : 'Goods', gstrateinferapplicability: 'As per Masters/Company', ...(v.sac ? { gsthsnname: v.sac } : {}), gsthsninferapplicability: 'As per Masters/Company', ratedetails: gstRates(v.taxRate, v.cgstSgst) });
      return row;
    });
    const inventory = v.items.map(i => {
      const amt = money(-i.amount), q = qtyText(i.qty, i.unit);
      return { stockitemname: i.name, gstovrdntaxability: 'Taxable', gstsourcetype: 'Stock Item', gstitemsource: i.name, hsnsourcetype: 'Stock Item', hsnitemsource: i.name, gstovrdntypeofsupply: 'Goods',
        gstrateinferapplicability: 'As per Masters/Company', ...(i.hsn ? { gsthsnname: i.hsn } : {}), gsthsninferapplicability: 'As per Masters/Company', isdeemedpositive: true, islastdeemedpositive: true,
        rate: `${i.rate.toFixed(2)}/${i.unit}`, amount: amt, actualqty: q, billedqty: q,
        batchallocations: [{ godownname: BOOKS.godown, batchname: BOOKS.batch, amount: amt, actualqty: q, billedqty: q }],
        accountingallocations: [{ ledgername: BOOKS.purchaseLedger, isdeemedpositive: true, amount: amt }], ratedetails: gstRates(v.taxRate, v.cgstSgst) };
    });
    return { ...head('Invoice Voucher View'), referencedate: ymd(v.date), reference: v.reference, partyledgername: v.party, partyname: v.party, partygstin: v.partyGstin, statename: v.partyState, placeofsupply: BOOKS.ourState,
      countryofresidence: 'India', gstregistrationtype: v.partyGstin ? 'Regular' : 'Unregistered/Consumer', consigneegstin: TALLY.gstin, consigneestatename: TALLY.state, consigneecountryname: 'India',
      vchentrymode: v.mode, isinvoice: true, isgstoverridden: true, iseligibleforitc: true, ledgerentries: rows, ...(inventory.length ? { allinventoryentries: inventory } : {}) };
  }
  // payment, receipt and the journals made from the bills and the bank (card journal, true-up, provisions, GST released)
  const isJournal = v.type === 'journal';
  const counter = v.lines.find(l => l.account !== BOOKS.bank)?.account ?? '';
  const rows = v.lines.map(l => {
    const net = r2(l.debit - l.credit);
    const row = { ledgername: l.account, isdeemedpositive: net > 0, amount: money(-net), ...(isJournal ? {} : { ispartyledger: true }) };
    const refs = l.refs?.length ? l.refs : (!isJournal && l.account !== BOOKS.bank && v.billRefs?.length ? v.billRefs : null);
    if (l.account === BOOKS.bank) row.bankallocations = [bankAlloc(v.date, v.ref, -net, v.favouring || counter)];
    else if (refs) { row.ispartyledger = true; row.billallocations = refs.map(b => ({ name: b.name, billtype: b.kind, amount: money(net > 0 ? -b.amount : b.amount) })); }
    return row;
  });
  return { ...head('Accounting Voucher View'), ...(isJournal ? {} : { partyledgername: counter }), allledgerentries: rows };
}

/**
 * The file for a month. Returns { file: { tallymessage }, errors, counts, totals, checks }.
 *   vouchers  groupOrderVouchers(...) output (plus later the bill and bank vouchers)
 *   limit     optional: only the first N vouchers of each type (the test file for a copy company)
 */
export function buildTallyFile({ vouchers, orders, books = [], limit = null }) {
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
  for (const v of books) {
    if (!v.balanced) { errors.push({ id: v.id, problem: `does not balance (${v.debit} against ${v.credit})` }); continue; }
    if (limit && (seen[v.type] = (seen[v.type] ?? 0) + 1) > limit) continue;
    const t = tallyBookVoucher(v);
    const nk = `${t.vouchertypename}|${t.vouchernumber}`;
    numbers[nk] = (numbers[nk] ?? 0) + 1;
    if (numbers[nk] > 1) t.vouchernumber = `${t.vouchernumber}-${numbers[nk]}`.slice(-32);          // two suppliers can print the same invoice number
    messages.push(t); counts[v.type] = (counts[v.type] ?? 0) + 1;
  }
  // A bill or a sale is opened before it is settled: on one day the vouchers that open a bill go first, so every Agst Ref finds its bill.
  const RANK = { Sales: 0, Purchase: 0, 'Credit Note': 1, Journal: 2, Receipt: 3, Payment: 3 };   // a journal of the order ledger clears a bill, one of the bills / bank may open none
  messages.sort((a, b) => a.date.localeCompare(b.date) || (RANK[a.vouchertypename] ?? 2) - (RANK[b.vouchertypename] ?? 2));
  // The built-in checks: every voucher in the file balances in Tally's own signs, and the ledger totals of what was written equal the ERP ledger's.
  const unbalanced = messages.filter(m => Math.abs(entriesSum(m)) > 0.005);
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
