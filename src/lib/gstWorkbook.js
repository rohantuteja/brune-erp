// The Excel file behind Analytics → GST: the same figures as the screen, one sheet per thing an accountant looks up.
//   Summary · B2C all (Table 7) · HSN summary (Table 12) · Documents issued (Table 13) · Myntra (Table 14) · Shopify by state · Sales invoices · Fee invoices (ERP) · Credit notes · Not invoiced yet
import { CHANNEL_LABEL, MYNTRA_ECO_GSTIN, stateTable, hsnSummary, documentSeries } from './gstReport.js';

const h = (...cols) => cols.map(v => ({ v, s: 'h' }));
const m = (v) => ({ v, s: 'm' });
const t = (v) => ({ v, s: 't' });
const d = (v) => ({ v, s: 'd' });
const note = (v) => ({ v, s: 'note' });
const issuer = (x) => x.issuedBy === 'unicommerce' ? 'Unicommerce' : x.number ? 'ERP' : 'ERP (not numbered yet)';
const tax = (b) => Math.round((b.igst + b.cgst + b.sgst) * 100) / 100;

function stateSheet(report, channel) {
  const { rows, total } = stateTable(report, channel);
  const title = channel === 'all'
    ? `Shopify and Myntra together, ${report.label}, by state and rate: the figures for GSTR-1 Table 7 (B2C)`
    : channel === 'myntra'
      ? `Myntra, ${report.label}: the summary for GSTR-1 Table 14(a), under the e-commerce operator (GSTIN ${MYNTRA_ECO_GSTIN}). These sales are also in Table 7.`
      : `Shopify on its own, ${report.label}, by state and rate (not a GSTR-1 table: Table 7 needs Myntra's sales too)`;
  const booksTax = (r) => tax(r.net);
  const body = rows.map(r => [r.state, r.stateCode, r.ratePct, m(r.sales.taxable), m(r.fees.taxable), m(r.returns.taxable), m(r.net.taxable), m(r.net.goods), m(r.net.cod), m(r.net.retFee),
    m(r.gstr1.igst), m(r.gstr1.cgst), m(r.gstr1.sgst), m(r.gstr1.tax), m(booksTax(r)), m(Math.round((r.gstr1.tax - booksTax(r)) * 100) / 100), r.sales.docs, r.returns.docs]);
  const totalRow = [{ v: 'Total', s: 'tt' }, { v: '', s: 'tt' }, { v: '', s: 'tt' }, t(total.sales.taxable), t(total.fees.taxable), t(total.returns.taxable), t(total.net.taxable), t(total.net.goods), t(total.net.cod), t(total.net.retFee),
    t(total.gstr1.igst), t(total.gstr1.cgst), t(total.gstr1.sgst), t(total.gstr1.tax), t(tax(total.net)), t(Math.round((total.gstr1.tax - tax(total.net)) * 100) / 100), { v: total.sales.docs, s: 'tt' }, { v: total.returns.docs, s: 'tt' }];
  return {
    name: channel === 'all' ? 'B2C all (Table 7)' : channel === 'myntra' ? 'Myntra (Table 14)' : 'Shopify by state', freeze: 4, cols: [24, 11, 8, 16, 16, 16, 18, 16, 16, 14, 14, 14, 14, 14, 14, 12, 11, 12],
    rows: [[{ v: title, s: 'title' }],
      [note('Net taxable value = sales + fee invoices - credit notes, split into goods, the COD / shipping charge and the return fee. Sales count in the month the order was placed; credit notes in the month they are dated.')],
      [note('Tax for GSTR-1 = the rate on the net taxable value; for Uttar Pradesh CGST and SGST are equal (half each). "Tax per books" is what the invoices and credit notes added up to, each rounded on its own: the difference is that rounding, a few paise.')],
      h('State', 'State code', 'Rate %', 'Sales (taxable value)', 'Fee invoices (taxable)', 'Credit notes (taxable)', 'Net taxable value', 'of which goods', 'of which COD / shipping charge', 'of which return fee', 'IGST', 'CGST', 'SGST', 'Tax for GSTR-1', 'Tax per books', 'Difference', 'Sales invoices', 'Credit notes'), ...body, totalRow],
  };
}

function hsnSheet(report) {
  const { rows, total } = hsnSummary(report);
  return {
    name: 'HSN summary (Table 12)', freeze: 4, cols: [10, 52, 12, 10, 8, 16, 16, 14, 14, 14],
    rows: [[{ v: `HSN summary of outward supplies, ${report.label}: the figures for GSTR-1 Table 12`, s: 'title' }],
      [note('Shopify and Myntra together, net of credit notes, by rate. Pieces are sold minus returned. The COD / shipping charge and the return fee are services. The goods HSN is the one on the Tally stock item (Myntra\'s own reports say 61044300 for some styles): the accountant confirms it.')],
      [],
      h('HSN / SAC', 'Description', 'UQC', 'Quantity', 'Rate %', 'Total value', 'Taxable value', 'IGST', 'CGST', 'SGST'),
      ...rows.map(x => [x.code, x.what, x.uqc, x.kind === 'goods' ? x.qty : '', x.ratePct, m(x.value), m(x.taxable), m(x.igst), m(x.cgst), m(x.sgst)]),
      [{ v: 'Total', s: 'tt' }, { v: '', s: 'tt' }, { v: '', s: 'tt' }, { v: total.qty, s: 'tt' }, { v: '', s: 'tt' }, t(total.value), t(total.taxable), t(total.igst), t(total.cgst), t(total.sgst)]],
  };
}

function documentsSheet(report) {
  const rows = documentSeries(report);
  return {
    name: 'Documents issued (Table 13)', freeze: 4, cols: [58, 22, 22, 22, 12, 12, 52],
    rows: [[{ v: `Documents issued in ${report.label}: the figures for GSTR-1 Table 13`, s: 'title' }],
      [note('For each series, the first and last number issued in the month and how many. "Not in this month\'s file" are numbers between the first and the last that this file does not hold: cancelled, or issued in another month. The accountant enters those as cancelled where that is what they are.')],
      [],
      h('Nature of document', 'Series', 'From', 'To', 'Total issued', 'Not in this month\'s file', 'Examples of those numbers'),
      ...rows.map(x => [x.nature, x.prefix, x.from, x.to, x.total, x.missing, x.missingList.join(', ')])],
  };
}

export function buildGstSheets(report) {
  const T = report.totals;
  const G = { shopify: stateTable(report, 'shopify').total.gstr1, myntra: stateTable(report, 'myntra').total.gstr1, all: stateTable(report, 'all').total.gstr1 };
  const line = (label, x, g) => [label, m(x.sales.taxable), m(x.fees.taxable), m(x.returns.taxable), m(x.net.taxable), m(x.net.goods), m(x.net.cod), m(x.net.retFee), m(g.igst), m(g.cgst), m(g.sgst), m(g.tax), m(tax(x.net))];
  const ucNotes = report.docs.returns.filter(x => x.issuedBy === 'unicommerce').length;
  const summary = {
    name: 'Summary', cols: [40, 16, 18, 16, 18, 16, 16, 14, 14, 14, 14, 14, 14],
    rows: [
      [{ v: `GST sales: ${report.label}`, s: 'title' }],
      [note('Worked out from the order ledger (Shopify and Myntra orders, Unicommerce invoices and credit notes, and the invoices and credit notes the ERP issues itself).')],
      [note('A sale counts in the month the ORDER was placed, whether or not it has been paid. A return reduces the month its credit note is dated.')],
      [],
      [note('Tax for GSTR-1 is the rate on the net taxable value, with CGST equal to SGST. "Tax per books" is what the invoices and credit notes added up to, each rounded on its own; the two differ by a few paise.')],
      h('Taxable value and tax', 'Sales', 'Fee invoices (ERP)', 'Credit notes', 'Net taxable value', 'of which goods', 'of which COD / shipping charge', 'of which return fee', 'IGST', 'CGST', 'SGST', 'Tax for GSTR-1', 'Tax per books'),
      line('Shopify', T.shopify, G.shopify), line('Myntra', T.myntra, G.myntra), [{ v: 'Total', s: 'tt' }, t(T.all.sales.taxable), t(T.all.fees.taxable), t(T.all.returns.taxable), t(T.all.net.taxable), t(T.all.net.goods), t(T.all.net.cod), t(T.all.net.retFee), t(G.all.igst), t(G.all.cgst), t(G.all.sgst), t(G.all.tax), t(tax(T.all.net))],
      [],
      [{ v: 'Where it goes in GSTR-1', s: 'b' }],
      h('Table', 'Which sales', 'Net taxable value', 'Net tax'),
      ['Table 7: B2C, state and rate wise', 'Shopify + Myntra (sheet "B2C all (Table 7)")', m(T.all.net.taxable), m(G.all.tax)],
      ['Table 12: HSN summary', 'Goods, COD / shipping charge, return fee (sheet "HSN summary (Table 12)")', m(T.all.net.taxable), m(G.all.tax)],
      ['Table 13: documents issued', 'Series, first and last number (sheet "Documents issued (Table 13)")', '', ''],
      [`Table 14(a): supplies through an e-commerce operator, GSTIN ${MYNTRA_ECO_GSTIN}`, 'Myntra only (sheet "Myntra (Table 14)")', m(T.myntra.net.taxable), m(G.myntra.tax)],
      [note('Myntra collects TCS under section 52, so its sales are summarised under its GSTIN in Table 14(a) AND are in Table 7: the GSTN advisory on Notification 26/2022 says the Table 14(a) summary is of supplies already reported in tables 4 to 10. No tax flows from Table 14(a) to GSTR-3B. Your accountant maps these figures onto the return.')],
      [],
      [{ v: 'Documents', s: 'b' }],
      ['Sales invoices (Unicommerce)', T.all.sales.docs], ['Fee invoices (issued by the ERP)', T.all.fees.docs],
      ['Credit notes from Unicommerce', ucNotes], ['Credit notes issued by the ERP', report.docs.returns.length - ucNotes],
      ['Orders placed this month, not invoiced yet', report.waiting.length],
      [],
      [{ v: 'Checks', s: 'b' }],
      ...report.checks.map(c => [c.level === 'ok' ? 'OK' : c.level === 'info' ? 'Note' : c.level === 'warn' ? 'Check' : 'ERROR', c.text]),
    ],
  };
  const saleSheet = {
    name: 'Sales invoices', freeze: 1, cols: [18, 12, 13, 10, 22, 8, 8, 15, 12, 12, 12, 15, 6, 16],
    rows: [h('Invoice no', 'Order', 'Order date', 'Channel', 'State', 'State code', 'Rate %', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Invoice value', 'Qty', 'Unicommerce invoice date'),
      ...report.docs.sales.map(x => [x.number || '', x.order, d(x.date), CHANNEL_LABEL[x.channel] || x.channel, x.state || '', x.stateCode || '', x.ratePct, m(x.taxable), m(x.igst), m(x.cgst), m(x.sgst), m(x.total), x.qty || '', x.invoiceDate ? d(x.invoiceDate) : ''])],
  };
  const feeSheet = {
    name: 'Fee invoices (ERP)', freeze: 1, cols: [13, 18, 12, 10, 22, 8, 8, 15, 12, 12, 12, 15, 34],
    rows: [h('Date', 'Number', 'Order', 'Channel', 'State', 'State code', 'Rate %', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Invoice value', 'What for'),
      ...report.docs.fees.map(x => [d(x.date), x.number || 'not numbered yet', x.order, CHANNEL_LABEL[x.channel] || x.channel, x.state || '', x.stateCode || '', x.ratePct, m(x.taxable), m(x.igst), m(x.cgst), m(x.sgst), m(x.total), x.reason])],
  };
  const returnSheet = {
    name: 'Credit notes', freeze: 1, cols: [13, 18, 24, 12, 13, 10, 22, 8, 8, 15, 12, 12, 12, 15, 6, 36],
    rows: [h('Credit note date', 'Number', 'Issued by', 'Order', 'Order date', 'Channel', 'State', 'State code', 'Rate %', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Credit note value', 'Qty', 'What for'),
      ...report.docs.returns.map(x => [d(x.date), x.number || '', issuer(x), x.order, x.orderDate ? d(x.orderDate) : '', CHANNEL_LABEL[x.channel] || x.channel, x.state || '', x.stateCode || '', x.ratePct, m(x.taxable), m(x.igst), m(x.cgst), m(x.sgst), m(x.total), x.qty || '', x.reason])],
  };
  const waitSheet = {
    name: 'Not invoiced yet', freeze: 1, cols: [14, 13, 10, 22, 90],
    rows: [h('Order', 'Order date', 'Channel', 'State', 'Why'), ...report.waiting.map(x => [x.order, d(x.date), CHANNEL_LABEL[x.channel] || x.channel, x.state || '', x.reason])],
  };
  return [summary, stateSheet(report, 'all'), hsnSheet(report), documentsSheet(report), stateSheet(report, 'myntra'), stateSheet(report, 'shopify'), saleSheet, feeSheet, returnSheet, waitSheet];
}

export const gstFileName = (report) => `GST-sales-${report.month}.xlsx`;
