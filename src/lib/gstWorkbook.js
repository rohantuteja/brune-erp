// The Excel file behind Analytics → GST: the same figures as the screen, one sheet per thing an accountant looks up.
//   Summary · Shopify by state · Myntra by state · Sales invoices · Fee invoices (ERP) · Credit notes · Not invoiced yet
import { CHANNEL_LABEL, MYNTRA_GSTIN, stateTable } from './gstReport.js';

const h = (...cols) => cols.map(v => ({ v, s: 'h' }));
const m = (v) => ({ v, s: 'm' });
const t = (v) => ({ v, s: 't' });
const d = (v) => ({ v, s: 'd' });
const note = (v) => ({ v, s: 'note' });
const issuer = (x) => x.issuedBy === 'unicommerce' ? 'Unicommerce' : x.number ? 'ERP' : 'ERP (not numbered yet)';
const tax = (b) => Math.round((b.igst + b.cgst + b.sgst) * 100) / 100;

function stateSheet(report, channel) {
  const { rows, total } = stateTable(report, channel);
  const title = channel === 'myntra'
    ? `Myntra: supplies through the e-commerce operator (GSTIN ${MYNTRA_GSTIN}), ${report.label}, by state and rate`
    : `Shopify: supplies to customers, ${report.label}, by state and rate`;
  const body = rows.map(r => [r.state, r.stateCode, r.ratePct, m(r.sales.taxable), m(r.fees.taxable), m(r.returns.taxable), m(r.net.taxable), m(r.net.igst), m(r.net.cgst), m(r.net.sgst), m(tax(r.net)), r.sales.docs, r.returns.docs]);
  const totalRow = [{ v: 'Total', s: 'tt' }, { v: '', s: 'tt' }, { v: '', s: 'tt' }, t(total.sales.taxable), t(total.fees.taxable), t(total.returns.taxable), t(total.net.taxable), t(total.net.igst), t(total.net.cgst), t(total.net.sgst), t(tax(total.net)), { v: total.sales.docs, s: 'tt' }, { v: total.returns.docs, s: 'tt' }];
  return {
    name: channel === 'myntra' ? 'Myntra by state' : 'Shopify by state', freeze: 3, cols: [24, 11, 8, 16, 16, 16, 18, 14, 14, 14, 14, 11, 12],
    rows: [[{ v: title, s: 'title' }], [note('Net taxable value = sales + fee invoices - credit notes. Sales count in the month the order was placed; credit notes in the month they are dated. Tax columns are net of credit notes.')],
      h('State', 'State code', 'Rate %', 'Sales (taxable value)', 'Fee invoices (taxable)', 'Credit notes (taxable)', 'Net taxable value', 'Net IGST', 'Net CGST', 'Net SGST', 'Net tax', 'Sales invoices', 'Credit notes'), ...body, totalRow],
  };
}

export function buildGstSheets(report) {
  const T = report.totals;
  const line = (label, x) => [label, m(x.sales.taxable), m(x.fees.taxable), m(x.returns.taxable), m(x.net.taxable), m(x.net.igst), m(x.net.cgst), m(x.net.sgst), m(tax(x.net))];
  const ucNotes = report.docs.returns.filter(x => x.issuedBy === 'unicommerce').length;
  const summary = {
    name: 'Summary', cols: [34, 16, 18, 16, 18, 14, 14, 14, 14],
    rows: [
      [{ v: `GST sales: ${report.label}`, s: 'title' }],
      [note('Worked out from the order ledger (Shopify and Myntra orders, Unicommerce invoices and credit notes, and the invoices and credit notes the ERP issues itself).')],
      [note('A sale counts in the month the ORDER was placed, whether or not it has been paid. A return reduces the month its credit note is dated.')],
      [],
      h('Taxable value and tax', 'Sales', 'Fee invoices (ERP)', 'Credit notes', 'Net taxable value', 'Net IGST', 'Net CGST', 'Net SGST', 'Net tax'),
      line('Shopify', T.shopify), line('Myntra', T.myntra), [{ v: 'Total', s: 'tt' }, t(T.all.sales.taxable), t(T.all.fees.taxable), t(T.all.returns.taxable), t(T.all.net.taxable), t(T.all.net.igst), t(T.all.net.cgst), t(T.all.net.sgst), t(tax(T.all.net))],
      [],
      [{ v: 'Documents', s: 'b' }],
      ['Sales invoices (Unicommerce)', T.all.sales.docs], ['Fee invoices (issued by the ERP)', T.all.fees.docs],
      ['Credit notes from Unicommerce', ucNotes], ['Credit notes issued by the ERP', report.docs.returns.length - ucNotes],
      ['Orders placed this month, not invoiced yet', report.waiting.length],
      [],
      [{ v: 'Checks', s: 'b' }],
      ...report.checks.map(c => [c.level === 'ok' ? 'OK' : c.level === 'info' ? 'Note' : c.level === 'warn' ? 'Check' : 'ERROR', c.text]),
      [],
      [note(`Myntra's supplies are reported under the e-commerce operator, Myntra Designs (GSTIN ${MYNTRA_GSTIN}).`)],
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
  return [summary, stateSheet(report, 'shopify'), stateSheet(report, 'myntra'), saleSheet, feeSheet, returnSheet, waitSheet];
}

export const gstFileName = (report) => `GST-sales-${report.month}.xlsx`;
