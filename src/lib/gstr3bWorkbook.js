// The Excel file behind Analytics → GSTR-3B: the same figures as the screen, laid out as the return is (Tables 3.1, 3.2, 4, 6.1), then the
// lists an accountant checks them against.
//   Summary · 3.2 by state · ITC bills · Bills to upload · Other 2B lines · Suppliers · Payment 6.1
import { HEADS, HEAD_LABEL, MYNTRA_GSTIN } from './gstr3b.js';
import { monthLabel } from './gstReport.js';

const h = (...cols) => cols.map(v => ({ v, s: 'h' }));
const m = (v) => ({ v, s: 'm' });
const t = (v) => ({ v, s: 't' });
const d = (v) => ({ v, s: 'd' });
const note = (v) => ({ v, s: 'note' });
const b = (v) => ({ v, s: 'b' });
const tt = (v) => ({ v, s: 'tt' });
const sum = (x) => Math.round((x.igst + x.cgst + x.sgst) * 100) / 100;
const LEVEL = { ok: 'OK', info: 'Note', warn: 'Check', error: 'ERROR' };

const RESULT = { matched: 'In GSTR-2B: agrees', differs: 'In GSTR-2B: amounts differ (the GSTR-2B figure is claimed)', notIn2b: 'Not in GSTR-2B: not claimed this month', held: 'In GSTR-2B, bill waiting for your review: claimed (accept the bill)', unavailable: 'GSTR-2B says ITC not available', rcm: 'Reverse charge: not in 4(A)(5)' };

/** The bills still to upload because GSTR-2B shows them and the ERP has none: by supplier, oldest first. Used by the workbook and by the page's own download. */
export function buildUploadSheet(r) {
  const rows = [...(r.itc.lists.toUpload ?? [])].sort((a, b) => String(a.vendor).localeCompare(String(b.vendor)) || String(a.date).localeCompare(String(b.date)) || String(a.no).localeCompare(String(b.no)));
  const total = rows.reduce((a, x) => ({ taxable: a.taxable + x.taxable, value: a.value + x.value, igst: a.igst + x.twoB.igst, cgst: a.cgst + x.twoB.cgst, sgst: a.sgst + x.twoB.sgst }), { taxable: 0, value: 0, igst: 0, cgst: 0, sgst: 0 });
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    name: 'Bills to upload', freeze: 4, cols: [34, 18, 14, 22, 13, 15, 13, 13, 13, 15, 15, 40], rows: [
      [{ v: `Bills to upload: ${monthLabel(r.month)}`, s: 'title' }],
      [note('Invoices that suppliers have filed (they are in GSTR-2B and their credit is claimed) but that the ERP has no bill for. Upload each one on Analytics → Bills. A supplier that is not yet a vendor in the ERP is created on the first bill.')],
      [],
      h('Supplier', 'Supplier GSTIN', 'Vendor in the ERP?', 'Invoice no', 'Invoice date', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Tax', 'Invoice value', 'What to upload'),
      ...rows.map(x => [x.vendor || '', x.gstin, x.knownVendor ? 'yes' : 'no: new vendor', x.no, x.date ? d(x.date) : '', m(x.taxable), m(x.twoB.igst), m(x.twoB.cgst), m(x.twoB.sgst), m(sum(x.twoB)), m(x.value),
        x.why === 'gateway' ? 'The invoice, for the gateway fee tie-out' : 'The bill (purchase or expense)']),
      [tt(`${rows.length} invoice${rows.length === 1 ? '' : 's'}`), tt(''), tt(''), tt(''), tt(''), t(r2(total.taxable)), t(r2(total.igst)), t(r2(total.cgst)), t(r2(total.sgst)), t(r2(total.igst + total.cgst + total.sgst)), t(r2(total.value)), tt('')],
    ],
  };
}

export function buildGstr3bSheets(r) {
  const label = monthLabel(r.month);
  const O = r.outward, P = r.payment, C = r.itc.claim;
  const T = r.itc.twoB;
  const rows3 = (a) => [m(a.igst), m(a.cgst), m(a.sgst)];

  const summary = {
    name: 'Summary', cols: [58, 18, 16, 16, 16, 16], rows: [
      [{ v: `GSTR-3B working sheet: ${label}`, s: 'title' }],
      [note(`GSTIN ${r.ownGstin ?? ''}. A working sheet to check before filing on the GST portal: it files nothing. Tables 3.1 and 3.2 are filled by the portal from GSTR-1 (and cannot be edited); this is a cross-check. Input credit can only be claimed as shown in GSTR-2B.`)],
      [],
      [b('Table 3.1: outward supplies and inward supplies liable to reverse charge')],
      h('', 'Taxable value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess'),
      ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted): net of credit notes', m(O.taxable), ...rows3(O), m(0)],
      ['(b) Outward taxable supplies (zero rated)', m(0), m(0), m(0), m(0), m(0)],
      ['(c) Other outward supplies (nil rated, exempted)', m(0), '', '', '', ''],
      ['(d) Inward supplies (liable to reverse charge)', m(0), m(0), m(0), m(0), m(0)],
      ['(e) Non-GST outward supplies', m(0), '', '', '', ''],
      [note('Nothing in (b) to (e) is worked out by the ERP. If you have supplies there (for example a service you pay tax on under reverse charge), tell your accountant.')],
      [],
      [b('Table 3.2: inter-state supplies to unregistered persons (by place of supply)')],
      ['Total taxable value and integrated tax: see sheet "3.2 by state"', m(r.interstate.taxable), m(r.interstate.igst)],
      [],
      [b('Table 4: input tax credit')],
      h('', 'Basis', 'Integrated tax', 'Central tax', 'State/UT tax'),
      ...(T ? [
        ['4(A)(5) All other ITC: what GSTR-2B shows (GSTR-2B is the source of truth: all of it is claimed)', 'GSTR-2B', ...rows3(T.portal)],
        ['   of which: invoices that have a bill in the ERP', '', ...rows3(T.withBill)],
        ['   of which: gateway and Myntra (booked at each payout / settlement)', '', ...rows3(T.suppliers)],
        ['   of which: credit / debit notes from suppliers', '', ...rows3(T.notes)],
        ['   of which: invoices with NO bill in the ERP yet (see sheet "Bills to upload")', '', ...rows3(T.noBill)],
      ] : [['Input credit in your books (not checked against GSTR-2B)', 'Books', ...rows3(r.itc.books.total)]]),
      ['4(C) Net ITC claimable this month', T ? 'GSTR-2B' : 'Books (not checked)', ...rows3(C)],
      [],
      [b('TCS and TDS deducted by Myntra (from the settlements)')],
      ['TCS collected under section 52: compare with the TCS credit in the portal\'s electronic cash ledger', m(r.tcs.tcs)],
      ['TDS deducted under section 194-O: an income-tax item, not GST', m(r.tcs.tds)],
      [],
      [b('Table 6.1: payment of tax')],
      h('', 'Tax payable', 'Paid with integrated tax credit', 'Paid with central tax credit', 'Paid with state/UT tax credit', 'Paid in cash'),
      ...HEADS.map(k => [HEAD_LABEL[k], m(P.liability[k]), m(P.used[k].igst), m(P.used[k].cgst), m(P.used[k].sgst), m(P.cash[k])]),
      [tt('Total'), t(sum(P.liability)), t(HEADS.reduce((s, k) => s + P.used[k].igst, 0)), t(HEADS.reduce((s, k) => s + P.used[k].cgst, 0)), t(HEADS.reduce((s, k) => s + P.used[k].sgst, 0)), t(P.cashTotal)],
      [`Credit carried in${r.openingSet ? (r.openingLabel ? `: ${r.openingLabel}` : '') : ' (NOT AVAILABLE: counted as nil)'}`, '', ...rows3(P.opening)],
      ['Credit left after this return (carry to next month)', '', ...rows3(P.closing)],
      [],
      [b('Things to know')],
      ...r.checks.map(c => [LEVEL[c.level] || 'Note', c.text]),
    ],
  };

  const stateSheet = {
    name: '3.2 by state', freeze: 3, cols: [26, 10, 18, 16], rows: [
      [{ v: `Table 3.2: inter-state supplies to unregistered persons, ${label}, by place of supply`, s: 'title' }],
      [note('Net of credit notes. Home-state sales (CGST + SGST) are not in this table.')],
      h('Place of supply', 'State code', 'Taxable value', 'Integrated tax'),
      ...r.interstate.rows.map(x => [x.state, x.stateCode, m(x.taxable), m(x.igst)]),
      [tt('Total'), tt(''), t(r.interstate.taxable), t(r.interstate.igst)],
    ],
  };

  const L = r.itc.lists;
  const billRow = (x, key) => [x.vendor, x.gstin || '', x.no, x.date ? d(x.date) : '', m(x.taxable), m(x.heads.igst), m(x.heads.cgst), m(x.heads.sgst),
    x.twoB ? m(x.twoB.igst) : '', x.twoB ? m(x.twoB.cgst) : '', x.twoB ? m(x.twoB.sgst) : '', RESULT[key], x.reason || ''];
  const billsSheet = {
    name: 'ITC bills', freeze: 1, cols: [30, 18, 20, 13, 15, 13, 13, 13, 13, 13, 13, 40, 30], rows: [
      h('Supplier', 'Supplier GSTIN', 'Invoice no', 'Invoice date', 'Taxable value (bill)', 'IGST (bill)', 'CGST (bill)', 'SGST (bill)', 'IGST (2B)', 'CGST (2B)', 'SGST (2B)', 'Result', 'Reason (from 2B)'),
      ...['matched', 'differs', 'notIn2b', 'held', 'unavailable', 'rcm'].flatMap(k => L[k].filter(x => x.heads).map(x => billRow(x, k))),
    ],
  };

  const other = [...L.notes.map(x => [x.kind === 'credit_note' ? 'Credit note from supplier (reduces credit)' : 'Debit note from supplier', x]),
    ...['unavailable', 'rcm'].flatMap(k => L[k].filter(x => !x.heads).map(x => [RESULT[k], x]))];
  const otherSheet = {
    name: 'Other 2B lines', freeze: 1, cols: [40, 30, 18, 20, 13, 13, 13, 13, 30], rows: [
      h('What', 'Supplier', 'Supplier GSTIN', 'Number', 'Date', 'IGST', 'CGST', 'SGST', 'Reason'),
      ...other.map(([what, x]) => [what, x.vendor || '', x.gstin || '', x.no, x.date ? d(x.date) : '', ...rows3(x.twoB), x.reason || '']),
    ],
  };
  const uploadSheet = buildUploadSheet(r);

  const suppliersSheet = {
    name: 'Suppliers', cols: [44, 12, 15, 15, 15, 15, 15, 15, 15, 15], rows: [
      [{ v: 'Suppliers booked at each payout or settlement (the ERP holds no invoice numbers for them)', s: 'title' }],
      [note(`GSTR-2B by supplier against the input GST the order ledger booked in ${label}. Myntra's GSTIN is ${MYNTRA_GSTIN}. Their invoices and the ledger lines fall in different months, so a difference is normal.`)],
      h('Supplier', 'Invoices in 2B', 'IGST (2B)', 'CGST (2B)', 'SGST (2B)', 'IGST (books)', 'CGST (books)', 'SGST (books)', 'Difference (2B - books)'),
      ...(L.suppliers.length ? L.suppliers : r.itc.books.groups.map(g => ({ name: g.name, docs: '', twoB: { igst: '', cgst: '', sgst: '' }, books: g.heads, diff: null }))).map(s => [s.name, s.docs, ...(s.twoB.igst === '' ? ['', '', ''] : rows3(s.twoB)), ...rows3(s.books), s.diff ? m(sum(s.diff)) : '']),
    ],
  };

  const payHead = ['Liability head', 'Tax payable', 'Integrated tax credit', 'Central tax credit', 'State/UT tax credit', 'Paid in cash'];
  const paySheet = {
    name: 'Payment 6.1', cols: [30, 16, 20, 20, 20, 16], rows: [
      [{ v: `Table 6.1: payment of tax, ${label}`, s: 'title' }],
      [note('The order of set-off follows sections 49, 49A and 49B and Rule 88A: credit of one tax pays that tax first; integrated tax credit then pays central and state tax; central and state credit pay integrated tax once integrated tax credit is used up, and never each other. Your accountant has the last word.')],
      [],
      h('Credit available', 'Opening (carried in)', 'This month (claim)', 'Total'),
      ...HEADS.map(k => [HEAD_LABEL[k], m(P.opening[k]), m(P.claim[k]), m(P.credit[k])]),
      [],
      h(...payHead),
      ...HEADS.map(k => [HEAD_LABEL[k], m(P.liability[k]), m(P.used[k].igst), m(P.used[k].cgst), m(P.used[k].sgst), m(P.cash[k])]),
      [tt('Cash to pay'), tt(''), tt(''), tt(''), tt(''), t(P.cashTotal)],
      [],
      h('Credit left after this return', 'Integrated tax', 'Central tax', 'State/UT tax'),
      ['Carry to next month', ...rows3(P.closing)],
    ],
  };
  return [summary, stateSheet, billsSheet, uploadSheet, otherSheet, suppliersSheet, paySheet];
}

export const gstr3bFileName = (r) => `GSTR-3B-${r.month}.xlsx`;
