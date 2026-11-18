// Accounting → month checklist: everything that has to be true before a month's Tally file is generated, worked out from what the ERP
// already holds. A step is 'done', 'todo' or 'info'; a step that is 'todo' and a blocker keeps the Tally file from being generated. Pure
// functions of the loaded rows, tested without a database.
//
//   Uploads    bank statement, card statement, GoKwik report, Velocity wallet ledger, GSTR-2B
//   Bills      none waiting for review, none still to upload (per GSTR-2B), the month's recurring supplier invoices
//   Clear up   bank and card lines to decide, orders needing attention, orders not invoiced yet, a fresh ledger
//   Tally      every ledger the file uses exists in Tally; the file not yet generated for this month
import { monthBounds, monthLabel } from './gstReport.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dmy = (d) => { if (!d) return ''; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/** The last day of 'YYYY-MM'. */
export const monthEnd = (month) => addDays(monthBounds(month).next, -1);

/** The ledger accounts and bank buckets a month's file would post to that are not in Tally yet (or are waiting for the accountant to create or rename). */
export function missingLedgers({ used = [], tally = [] }) {
  const have = new Map(tally.map(t => [t.name, t.status]));
  const out = [];
  for (const name of [...new Set(used)].sort()) {
    const s = have.get(name);
    if (!s) out.push({ name, why: 'not in the list of Tally ledgers', status: 'unknown' });
    else if (s !== 'in_tally') out.push({ name, why: s === 'will_rename' ? 'to be renamed in Tally' : 'to be created in Tally', status: s });
  }
  return out;
}

const RECURRING = [['Meta', 'invoice for the month, dated the 1st of the next month'], ['Velocity', 'freight invoice for the month, dated the 1st of the next month'], ['GoKwik', 'invoice for the month, dated the 1st of the next month'], ['Easebuzz', 'gateway fee invoice, dated the last day of the month']];

/**
 * @param d {
 *   month, today,
 *   accounts: [{ kind: 'bank' | 'card', name, periodTo }],  gokwikTxnTo, velocityTo, myntraSettledTo,
 *   billsReview, bills (non-void vendor_invoices rows with vendor), toUpload (invoices in 2B with no bill), twoBLoaded,
 *   bankUnresolved, cardUnresolved?,
 *   orders: { total, attention, waitingInvoice, open: { awaiting_payout, awaiting_return, awaiting_settlement, rto_on_the_way, ... } }, attentionAll,
 *   ledgerRun: { finishedAt, held } | null,
 *   missing: [{ name, why }], exportedAt }
 */
export function buildChecklist(d) {
  const end = monthEnd(d.month);
  const ended = d.today > end;
  const steps = [];
  const add = (section, s) => steps.push({ section, blocker: false, link: null, items: [], ...s });

  // ── 0. The month ──
  add('uploads', ended
    ? { id: 'month', title: `${monthLabel(d.month)} has ended`, status: 'done', detail: `Last day ${dmy(end)}.` }
    : { id: 'month', title: `${monthLabel(d.month)} has not ended yet`, status: 'todo', blocker: true, detail: `Wait until after ${dmy(end)}: a file made now would be missing the rest of the month.` });

  // ── 1. Uploads ──
  const bank = (d.accounts || []).find(a => a.kind === 'bank'), card = (d.accounts || []).find(a => a.kind === 'card');
  // A statement's end date is the date of its LAST TRANSACTION, not the day it was downloaded to: a quiet last day (a holiday) leaves it a day or two short. Up to
  // QUIET_DAYS short is asked about but does not block; more than that is a statement that really stops early.
  const bk = { link: { label: 'Bank & card', tab: 'bank' } };
  const bankGap = bank?.periodTo ? daysBetween(bank.periodTo, end) : null;
  add('uploads', bankGap !== null && bankGap <= 0
    ? { id: 'bank', title: 'Bank statement covers the whole month', status: 'done', detail: `${bank.name}: statements run to ${dmy(bank.periodTo)}.`, ...bk }
    : bankGap !== null && bankGap <= QUIET_DAYS
      ? { id: 'bank', title: `Bank statement's last transaction is ${plural(bankGap, 'day')} before the month end`, status: 'todo', detail: `${bank.name}: the last transaction is on ${dmy(bank.periodTo)}, the month ends ${dmy(end)}. Fine if nothing happened in between (a holiday); if the statement should have gone to the month end, upload a longer one.`, ...bk }
      : { id: 'bank', title: 'Upload the bank statement to the end of the month', status: 'todo', blocker: true, detail: bank?.periodTo ? `${bank.name}: statements stop at ${dmy(bank.periodTo)}, the month ends ${dmy(end)}.` : 'No bank statement has been uploaded.', ...bk });

  const cardEnd = `${d.month}-20`;
  add('uploads', card && card.periodTo >= cardEnd
    ? { id: 'card', title: 'Card statement covers the cycle ending on the 20th', status: 'done', detail: `${card.name}: statements run to ${dmy(card.periodTo)}.`, link: { label: 'Bank & card', tab: 'bank' } }
    : { id: 'card', title: `Upload the card statement for the cycle ending ${dmy(cardEnd)}`, status: 'todo', blocker: true, detail: card?.periodTo ? `${card.name}: statements stop at ${dmy(card.periodTo)}. The card expenses are booked from it.` : 'No card statement has been uploaded.', link: { label: 'Bank & card', tab: 'bank' } });

  // The test is the bank, not the date of the last transaction: a payment made on the last day of the month is paid out (and listed in the report) next month.
  const gk = { link: { label: 'Bank & card', tab: 'bank' } };
  add('uploads', !d.gokwikSettledTo
    ? { id: 'gokwik', title: 'Upload the GoKwik settlement report', status: 'todo', blocker: true, detail: 'No GoKwik report has been uploaded.', ...gk }
    : (d.gokwikUnproven || 0) > 0
      ? { id: 'gokwik', title: `${plural(d.gokwikUnproven, 'Easebuzz credit')} in the bank not matched to a GoKwik payout`, status: 'todo', blocker: true, detail: `The report reaches payouts of ${dmy(d.gokwikSettledTo)}. Download the newer rawSettlementReport so these payouts can be matched to their orders and booked.`, ...gk }
      : { id: 'gokwik', title: 'Every GoKwik payout of the month is in the report', status: 'done', detail: `${(d.gokwikPayouts || 0) ? `${d.gokwikPayouts} Easebuzz credit${d.gokwikPayouts === 1 ? '' : 's'} in the bank, all matched to the report` : 'No Easebuzz credit in the bank this month'} (the report reaches payouts of ${dmy(d.gokwikSettledTo)}). Payments of the last days of the month are paid out, and listed, next month: that is not a gap.`, ...gk });

  const vl = { link: { label: 'Velocity wallet', tab: 'velocity' } };
  const vGap = d.velocityTo ? daysBetween(d.velocityTo, end) : null;
  add('uploads', vGap !== null && vGap <= 0
    ? { id: 'velocity', title: 'Velocity wallet ledger covers the whole month', status: 'done', detail: `Ledger runs to ${dmy(d.velocityTo)}.`, ...vl }
    : vGap !== null && vGap <= QUIET_DAYS
      ? { id: 'velocity', title: `Velocity ledger's last entry is ${plural(vGap, 'day')} before the month end`, status: 'todo', detail: `The last entry is on ${dmy(d.velocityTo)}, the month ends ${dmy(end)}. Fine if nothing happened in the wallet in between (a holiday); otherwise upload a longer ledger.`, ...vl }
      : { id: 'velocity', title: 'Upload the Velocity wallet ledger to the end of the month', status: 'todo', blocker: true, detail: d.velocityTo ? `The stored ledger stops at ${dmy(d.velocityTo)}.` : 'No Velocity ledger has been uploaded.', ...vl });

  add('uploads', d.myntraSettledTo
    ? { id: 'myntra', title: 'Myntra settlement reports', status: 'info', detail: `Loaded to the payout of ${dmy(d.myntraSettledTo)}. Download the newest settled report from the Myntra partner portal if more payouts have reached the bank since.`, link: { label: 'Bank & card', tab: 'bank' } }
    : { id: 'myntra', title: 'Myntra settlement reports', status: 'info', detail: 'None loaded yet.', link: { label: 'Bank & card', tab: 'bank' } });

  add('uploads', d.twoBLoaded
    ? { id: '2b', title: 'GSTR-2B loaded for the month', status: 'done', detail: 'It decides the input credit and the list of bills still to upload.', link: { label: 'GSTR-3B', tab: 'gstr3b' } }
    : { id: '2b', title: 'Load the GSTR-2B for the month', status: 'todo', detail: 'Available from the 14th of the next month. Without it the list of bills still to upload cannot be worked out.', link: { label: 'GSTR-3B', tab: 'gstr3b' } });

  // ── 2. Bills ──
  add('bills', d.billsReview
    ? { id: 'review', title: `${plural(d.billsReview, 'bill')} waiting for your review`, status: 'todo', blocker: true, detail: 'Accept or void each one: a bill in review is not in the books.', link: { label: 'Bills', tab: 'bills' } }
    : { id: 'review', title: 'No bills waiting for review', status: 'done', detail: 'Every uploaded bill is accepted.', link: { label: 'Bills', tab: 'bills' } });

  if (d.twoBLoaded) {
    const n = (d.toUpload || []).length;
    add('bills', n
      ? { id: 'toupload', title: `${plural(n, 'bill')} to upload that suppliers have filed`, status: 'todo', blocker: true, detail: 'In GSTR-2B but not in the ERP, so missing from the books. Upload the invoice, book it from the 2B details, or mark it as one the accountant books.', items: d.toUpload.map(x => `${x.vendor} ${x.no} (${dmy(x.date)}): tax ${Number(x.tax).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`), link: { label: 'GSTR-3B (Bills to upload)', tab: 'gstr3b' } }
      : { id: 'toupload', title: 'Every invoice in GSTR-2B has its bill', status: 'done', detail: 'Nothing to upload.', link: { label: 'GSTR-3B', tab: 'gstr3b' } });
  }

  if ((d.noCopy || []).length) {
    add('bills', { id: 'nocopy', title: `${plural(d.noCopy.length, 'bill')} booked from GSTR-2B ${d.noCopy.length === 1 ? 'has' : 'have'} no invoice copy yet`, status: 'info', detail: 'They are in the books and in the Tally file; the invoice copies are still to be had from the suppliers. Attach each PDF on the Bills page when it arrives.', items: d.noCopy.map(b => `${b.vendor} ${b.no} (${dmy(b.date)})`), link: { label: 'Bills', tab: 'bills' } });
  }

  const next5 = addDays(monthBounds(d.month).next, 4);
  const lacking = RECURRING.filter(([v]) => (d.bills || []).some(b => b.vendor === v || String(b.vendor || '').toLowerCase().startsWith(v.toLowerCase())) && !(d.bills || []).some(b => (b.vendor === v || String(b.vendor || '').toLowerCase().startsWith(v.toLowerCase())) && b.invoice_date >= addDays(end, -1) && b.invoice_date <= next5));
  add('bills', lacking.length
    ? { id: 'recurring', title: `${plural(lacking.length, 'regular supplier invoice')} for the month not uploaded`, status: 'todo', detail: 'Their invoices are dated at the turn of the month; until they are in, the month is booked on estimates or not at all.', items: lacking.map(([v, w]) => `${v}: ${w}`), link: { label: 'Bills', tab: 'bills' } }
    : { id: 'recurring', title: 'Regular supplier invoices for the month are in', status: 'done', detail: 'Meta, Velocity, GoKwik and Easebuzz.', link: { label: 'Bills', tab: 'bills' } });

  // ── Purchase and payment vouchers (tallyBooks.js) ──
  const bb = d.books;
  if (bb) {
    const money = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    add('bills', (bb.problems || []).length
      ? { id: 'billbuild', title: `${plural(bb.problems.length, 'bill')} cannot be made into a voucher`, status: 'todo', blocker: true, detail: 'Fix the supplier on the Bills page (its Tally ledger, or its expense ledger).', items: bb.problems.map(p => p.text), link: { label: 'Bills', tab: 'bills' } }
      : { id: 'billbuild', title: `${plural(bb.purchases || 0, 'purchase voucher')} made from the month's bills`, status: 'done', detail: (bb.notes || []).length ? `${bb.notes.join(' ')}` : 'Fabric bills in kilos or metres become item invoices (KNITTED FABRIC, Shirting Fabric); every other bill is an accounting invoice against its expense ledger.', link: { label: 'Bills', tab: 'bills' } });
    add('clear', (bb.unlinked || []).length
      ? { id: 'suppliers', title: `${plural(bb.unlinked.length, 'bank payment')} to a supplier not linked to the supplier`, status: 'todo', blocker: true, detail: 'A payment to a supplier is posted to the supplier\'s ledger against its bill, so it has to know which supplier. Pick the supplier for each below.', items: bb.unlinked.map(l => `${dmy(l.txn_date)} ${money(l.debit)} ${String(l.payee || l.remarks || '').slice(0, 40)}`) }
      : { id: 'suppliers', title: `${plural(bb.payments || 0, 'payment voucher')} made from the bank statement`, status: 'done', detail: 'Every payment to a supplier is placed against the supplier and its bill (or as an advance); the others go to their ledger.' });
    if ((bb.advances || []).length) add('bills', { id: 'advances', title: `${plural(bb.advances.length, 'advance')} paid before the invoice`, status: 'info', detail: 'Booked as an advance on the supplier; the invoice, when it comes, is settled against it.', items: bb.advances.map(a => `${a.vendor}: ${money(a.left)} on ${dmy(a.date)}`) });
    if ((bb.unpaid || []).length) add('bills', { id: 'unpaid', title: `${plural(bb.unpaid.length, 'bill')} still unpaid at the end of the month (${money(bb.unpaid.reduce((t, u) => t + u.left, 0))})`, status: 'info', detail: 'They stay open on the supplier in Tally until a payment settles them.', items: bb.unpaid.map(u => `${u.vendor} ${u.name}: ${money(u.left)}`) });
    if ((bb.tdsPending || []).length) add('bills', { id: 'tds', title: `Tax deducted at source not applied for ${bb.tdsPending.join(', ')}`, status: 'todo', detail: 'The rate and the Tally ledger for it are still to be given: until then the invoice is booked without the deduction, and the supplier is credited the full amount.', items: [] });
  }

  // ── 3. Clear up ──
  add('clear', d.bankUnresolved
    ? { id: 'lines', title: `${plural(d.bankUnresolved, 'bank or card line')} to decide`, status: 'todo', blocker: true, detail: 'Each needs a bucket (a Tally ledger): they cannot be left out of a file that has to balance.', link: { label: 'Bank & card', tab: 'bank' } }
    : { id: 'lines', title: 'Every bank and card line has a bucket', status: 'done', detail: 'Nothing left to decide for the month.', link: { label: 'Bank & card', tab: 'bank' } });

  const o = d.orders || {};
  add('clear', (d.attentionAll || 0) > 0
    ? { id: 'attention', title: `${plural(d.attentionAll, 'order')} needing attention`, status: 'todo', blocker: true, detail: 'The ledger cannot make these net to zero or lacks a fact (for example the state).', link: { label: 'Ledger', tab: 'ledger' } }
    : { id: 'attention', title: 'No orders need attention', status: 'done', detail: 'Every order the ledger holds is explained.', link: { label: 'Ledger', tab: 'ledger' } });

  add('clear', o.waitingInvoice
    ? { id: 'waiting', title: `${plural(o.waitingInvoice, 'order')} placed this month not invoiced by Unicommerce yet`, status: 'todo', blocker: true, detail: 'Sales are booked on the order date, so these would be missing from the month. Wait for the invoices.', link: { label: 'GST', tab: 'gst' } }
    : { id: 'waiting', title: 'Every order placed this month is invoiced', status: 'done', detail: 'Nothing is waiting for a Unicommerce invoice.', link: { label: 'GST', tab: 'gst' } });

  const fresh = d.ledgerRun?.finishedAt && (Date.parse(d.today + 'T23:59:59Z') - Date.parse(d.ledgerRun.finishedAt)) < 36 * 3600e3;
  add('clear', !d.ledgerRun
    ? { id: 'ledger', title: 'Refresh the order ledger', status: 'todo', detail: 'No refresh has been recorded.', link: { label: 'Ledger', tab: 'ledger' } }
    : (d.ledgerRun.held || 0) > 0
      ? { id: 'ledger', title: `${plural(d.ledgerRun.held, 'order')} held back by an outage`, status: 'todo', blocker: true, detail: 'Velocity or Unicommerce did not answer for these; the next refresh retries them.', link: { label: 'Ledger', tab: 'ledger' } }
      : fresh
        ? { id: 'ledger', title: 'The order ledger is up to date', status: 'done', detail: `Last refresh ${dmy(d.ledgerRun.finishedAt)}.`, link: { label: 'Ledger', tab: 'ledger' } }
        : { id: 'ledger', title: 'Refresh the order ledger before exporting', status: 'todo', detail: `The last refresh was ${dmy(d.ledgerRun.finishedAt)}.`, link: { label: 'Ledger', tab: 'ledger' } });

  const open = o.open || {};
  const bits = [['awaiting_payout', 'waiting for a gateway payout'], ['awaiting_settlement', 'waiting for a Myntra settlement'], ['awaiting_return', 'waiting for a returned parcel'], ['rto_on_the_way', 'returning to origin']].filter(([k]) => open[k]);
  add('clear', { id: 'open', title: 'Open items (they close by themselves)', status: 'info', detail: bits.length ? bits.map(([k, w]) => `${open[k]} ${w}`).join(' · ') + '. Their later entries go into the month they happen in.' : 'None.', link: { label: 'Ledger', tab: 'ledger' } });

  // ── 4. Tally ──
  // GSTR-1 and GSTR-3B are not here: they are filed from Tally once the month's data is in it, so they cannot be a condition for making the file.
  const creates = (d.missing || []).filter(m => m.status === 'will_create');
  const blocking = (d.missing || []).filter(m => m.status !== 'will_create');
  add('tally', !(d.missing || []).length
    ? { id: 'ledgers', title: 'Every ledger the file uses exists in Tally', status: 'done', detail: 'Names checked against the list of Tally ledgers.' }
    : !blocking.length
      ? { id: 'ledgers', title: `${plural(creates.length, 'ledger')} will be created by the file itself`, status: 'info', detail: 'The Tally file begins with these ledgers, so one import creates them and then posts into them. After the first import, say so under "Tally file" so they are not created again.', items: creates.map(m => m.name) }
      : { id: 'ledgers', title: `${plural(blocking.length, 'ledger')} the file uses ${blocking.length === 1 ? 'is' : 'are'} not ready in Tally`, status: 'todo', blocker: true,
        detail: `${blocking.filter(m => m.status === 'will_rename').length ? `${blocking.filter(m => m.status === 'will_rename').length} to be renamed by hand in Tally before the import (the vouchers use the new names). ` : ''}${blocking.filter(m => m.status === 'unknown').length ? `${blocking.filter(m => m.status === 'unknown').length} not in the list of Tally ledgers at all: add them to the list. ` : ''}${creates.length ? `The other ${creates.length} are created by the file itself.` : ''}`.trim(),
        items: blocking.map(m => `${m.name}: ${m.why}`) });
  add('tally', d.exportedAt
    ? { id: 'exported', title: 'A Tally file was already generated for this month', status: 'info', detail: `Generated ${dmy(d.exportedAt)}.` }
    : { id: 'exported', title: 'No Tally file generated for this month yet', status: 'info', detail: 'Generated at the end of this checklist.' });

  const blockers = steps.filter(s => s.blocker && s.status === 'todo');
  const todo = steps.filter(s => s.status === 'todo');
  return { steps, blockers, todo, ready: blockers.length === 0, sections: SECTIONS.map(s => ({ ...s, steps: steps.filter(x => x.section === s.id) })) };
}

/** How many days short of the month end a bank statement or wallet ledger may stop (a holiday with no transaction) before it blocks the file. */
export const QUIET_DAYS = 3;

export const SECTIONS = [
  { id: 'uploads', title: 'Uploads' }, { id: 'bills', title: 'Bills' }, { id: 'clear', title: 'Clear up' }, { id: 'tally', title: 'Tally' },
];
