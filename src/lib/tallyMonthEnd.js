// The month-end journals the accountant books by hand every month (his September Day Book: #100 and #300931 the GST ledgers into `GST Credit Ledger UP`, #300927 rent, #300928 salary,
// #300929 directors' salary), made by the ERP from what it already holds so the books need nobody's hand (owner, 19 Nov 2026: "end to end accounting").
//
//   GST output   Dr IGST OUTPUT UP / CGST Output UP / SGST Output UP (what the month's sales and returns left on them) / Cr GST Credit Ledger UP, rounded to the rupee, the paise on ROUND OFF.
//   GST input    Dr GST Credit Ledger UP / Cr IGST Input UP / CGST Input UP / SGST Input UP (what the month's bills, payouts and corrections left on them), the same way.
//   Directors    Dr Director Salary / Cr each director's payable: ₹50,000 each, every month of his year (his Trial Balance: ₹3,00,000 each over the six months).
//   Staff salary Dr Salary Expenses / Cr Salary Payable: the month's salary is paid in the first days of the NEXT month (September's ₹1,36,124 was paid on 3-10 October, to the rupee),
//                so the amount is what the bank statement shows paid to Salary Payable in the first 15 days of the next month, or a figure the owner gives.
//   Rent         Dr Rent Sector 63 Noida / Cr Rent Payable: the monthly rent, which the owner gives (his September journal was ₹18,000; October's payment to the landlord was ₹30,724).
// The GST journals are worked out from the vouchers of the month themselves (`accountTotals`), so the ledgers they clear end the month at zero in Tally.
// Pure functions, tested without a database.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const shift = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export const MONTH_END = {
  gstCredit: 'GST Credit Ledger UP', roundOff: 'ROUND OFF',
  outputs: ['IGST OUTPUT UP', 'CGST Output UP', 'SGST Output UP'],
  inputs: ['IGST Input  UP', 'CGST Input UP', 'SGST Input UP'],
  directors: { expense: 'Director Salary', payables: [{ account: 'Director Salary Payable- Rohan Tuteja', amount: 50000 }, { account: 'Director Salary Payable- Adrija Halder', amount: 50000 }] },
  salary: { expense: 'Salary Expenses', payable: 'Salary Payable', bucket: 'Salary Payable', windowDays: 15 },
  rent: { expense: 'Rent Sector 63 Noida', payable: 'Rent Payable' },
};

const journal = (id, source, date, number, memo, lines) => {
  const debit = r2(lines.reduce((s, l) => s + l.debit, 0)), credit = r2(lines.reduce((s, l) => s + l.credit, 0));
  return { id, type: 'journal', source, date, number, memo, billRefs: [], lines, debit, credit, balanced: Math.abs(debit - credit) < 0.005 };
};

/** A set of lines on one side and the credit ledger on the other, rounded to the rupee: the paise go to ROUND OFF on whichever side is short. */
function gstSide(rows, creditLedgerIsDebit) {
  const total = r2(rows.reduce((s, r) => s + r.amount, 0)), whole = Math.round(total), diff = r2(whole - total);
  const lines = rows.map(r => creditLedgerIsDebit ? { account: r.account, debit: 0, credit: r.amount } : { account: r.account, debit: r.amount, credit: 0 });
  lines.push(creditLedgerIsDebit ? { account: MONTH_END.gstCredit, debit: whole, credit: 0 } : { account: MONTH_END.gstCredit, debit: 0, credit: whole });
  const dr = lines.reduce((s, l) => s + l.debit, 0), cr = lines.reduce((s, l) => s + l.credit, 0), gap = r2(dr - cr);
  if (Math.abs(gap) > 0.004) lines.push(gap > 0 ? { account: MONTH_END.roundOff, debit: 0, credit: gap } : { account: MONTH_END.roundOff, debit: -gap, credit: 0 });
  return { lines, total, whole, diff };
}

/**
 * @param { from, next, totals }  totals: { account: { debit, credit } } of every voucher in the file (order ledger + bills + bank + card)
 * @param salaryNext   the bank payments to Salary Payable in the first 15 days of the next month [{ txn_date, debit }]
 * @param salaryOverride { 'YYYY-MM': amount }   rentMonthly  number   directors  [{ account, amount }] (default: the table above)
 * @returns { journals, missing: [text], notes: [text] }
 */
export function monthEndJournals({ from, next, totals = {}, salaryNext = [], salaryOverride = {}, rentMonthly = null, directors = MONTH_END.directors.payables }) {
  const month = from.slice(0, 7), last = shift(next, -1), ym = month.replace('-', '').slice(2);
  const out = [], missing = [], notes = [];
  const net = (a, side) => r2(side === 'credit' ? (totals[a]?.credit || 0) - (totals[a]?.debit || 0) : (totals[a]?.debit || 0) - (totals[a]?.credit || 0));

  // GST: what the month's sales left on the output ledgers, and what its purchases left on the input ledgers, set against the credit ledger.
  const outRows = MONTH_END.outputs.map(account => ({ account, amount: net(account, 'credit') })).filter(r => r.amount > 0.004);
  for (const a of MONTH_END.outputs) if (net(a, 'credit') < -0.004) notes.push(`${a} is a debit balance of ${-net(a, 'credit')} this month (returns above sales): left as it is.`);
  if (outRows.length) {
    const s = gstSide(outRows, false);
    out.push(journal(`gstout|${month}`, 'GST output set against the credit ledger', last, `ERP/GS/2627/OUT${ym}`, `Output GST of ${month} (${outRows.map(r => `${r.account} ${r.amount}`).join(', ')}) transferred to ${MONTH_END.gstCredit}`, s.lines));
  }
  const inRows = MONTH_END.inputs.map(account => ({ account, amount: net(account, 'debit') })).filter(r => r.amount > 0.004);
  for (const a of MONTH_END.inputs) if (net(a, 'debit') < -0.004) notes.push(`${a} is a credit balance of ${-net(a, 'debit')} this month: left as it is.`);
  if (inRows.length) {
    const s = gstSide(inRows, true);
    out.push(journal(`gstin|${month}`, 'GST input set against the credit ledger', last, `ERP/GS/2627/INP${ym}`, `Input GST of ${month} (${inRows.map(r => `${r.account} ${r.amount}`).join(', ')}) transferred to ${MONTH_END.gstCredit}`, s.lines));
  }

  // The directors: a fixed ₹50,000 each, as in every month of his year.
  const dsum = r2(directors.reduce((s, d) => s + d.amount, 0));
  out.push(journal(`directors|${month}`, "directors' salary", last, `ERP/SL/2627/DIR${ym}`, `Directors' salary for ${month}`, [{ account: MONTH_END.directors.expense, debit: dsum, credit: 0 }, ...directors.map(d => ({ account: d.account, debit: 0, credit: d.amount }))]));

  // Staff salary: the override, else what the bank paid on the first days of the next month.
  const paid = r2(salaryNext.reduce((s, l) => s + Number(l.debit || 0), 0));
  const over = Number(salaryOverride?.[month]) || 0;
  const salary = over || paid;
  if (salary > 0) out.push(journal(`salary|${month}`, 'staff salary', last, `ERP/SL/2627/SAL${ym}`, over ? `Salary for ${month} (the amount the owner gave)` : `Salary for ${month}: ${salaryNext.length} payment${salaryNext.length === 1 ? '' : 's'} made in the first days of ${next.slice(0, 7)}`,
    [{ account: MONTH_END.salary.expense, debit: salary, credit: 0 }, { account: MONTH_END.salary.payable, debit: 0, credit: salary }]));
  else missing.push(`Salary for ${month}: it is paid in the first days of ${next.slice(0, 7)} (September's was paid on 3-10 October). Upload the bank statement to the 15th of ${next.slice(0, 7)}, or give me the month's salary total.`);

  // Rent: a figure the owner gives.
  const rent = Number(rentMonthly) || 0;
  if (rent > 0) out.push(journal(`rent|${month}`, 'rent', last, `ERP/RN/2627/RNT${ym}`, `Rent for ${month}`, [{ account: MONTH_END.rent.expense, debit: rent, credit: 0 }, { account: MONTH_END.rent.payable, debit: 0, credit: rent }]));
  else missing.push(`Rent for ${month}: the monthly rent of Rent Sector 63 Noida is not set (his September journal was ₹18,000; October's payment to the landlord was ₹30,724).`);
  return { journals: out, missing, notes };
}
