// Gateway fee true-up: the monthly Easebuzz invoice against what the order ledger booked at each GoKwik payout.
//
// The order ledger books the gateway fee and the GST on it at every payout, from GoKwik's settlement report (ledger.ts). Easebuzz's tax
// invoice is the legal document and the GST input that can be claimed is what it says (GSTR-2B). So when the invoice is in, the books
// are trued up to it: this module works out the difference and the one voucher that removes it. Pure rules, no network.
//
//   invoice   taxable value + IGST, as read from the PDF
//   booked    the payout lines in ledger_entries dated within the invoice's month (fee, and the GST on it)
//   report    the same month in GoKwik's settlement report (payments settled in it)
//
// The order ledger is never changed: the adjustment is its own monthly voucher, not a line on any order.

import { GATEWAY, GATEWAY_FEE, GST_INPUT_IGST } from './ledger.ts';

export type Sums = { count: number; fee: number; gst: number };
export type Line = { account: string; debit: number; credit: number };
export type Status = 'opening' | 'wait' | 'agrees' | 'adjust' | 'investigate';
export type TieOut = {
  status: Status;
  period: { from: string; to: string; assumed: boolean };
  invoice: { no: string; date: string; taxable: number; gst: number; total: number };
  report: Sums & { total: number };
  booked: Sums & { total: number };
  diff: { expense: number; gst: number; gateway: number };   // the invoice minus what was booked (for an opening bill: minus the report)
  lines: Line[];                                            // the adjustment voucher; empty when there is nothing to post
  reasons: string[];
};
export type TieOutInput = {
  invoice: { no: string; date: string; taxable: number; gst: number; taxType: string };
  period: { from: string; to: string; assumed: boolean };
  report: Sums;
  booked: Sums;
  opening: boolean;     // the invoice's month starts before the books do: only checked, never posted
};

/** Up to this much (₹) in any one figure is a rounding-type difference; more is investigated by a person before it is posted. */
export const TOLERANCE = 5;

const r2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const withTotal = (s: Sums) => ({ ...s, fee: r2(s.fee), gst: r2(s.gst), total: r2(s.fee + s.gst) });

/** The voucher that moves the books from `booked` to the invoice: expense and input GST by their differences, Easebuzz for the net. */
export function adjustmentLines(diff: { expense: number; gst: number; gateway: number }): Line[] {
  const side = (account: string, amount: number): Line[] => amount === 0 ? [] : amount > 0 ? [{ account, debit: amount, credit: 0 }] : [{ account, debit: 0, credit: -amount }];
  // the expense and the input GST are debited when the invoice is more than was booked; Easebuzz, who is owed the difference, is credited
  const gateway = diff.gateway === 0 ? [] : diff.gateway > 0 ? [{ account: GATEWAY, debit: 0, credit: diff.gateway }] : [{ account: GATEWAY, debit: -diff.gateway, credit: 0 }];
  return [...side(GATEWAY_FEE, diff.expense), ...side(GST_INPUT_IGST, diff.gst), ...gateway];
}

export function tieOut(i: TieOutInput): TieOut {
  const invoice = { ...i.invoice, taxable: r2(i.invoice.taxable), gst: r2(i.invoice.gst), total: r2(i.invoice.taxable + i.invoice.gst) };
  const report = withTotal(i.report), booked = withTotal(i.booked);
  const out = (status: Status, base: Sums, reasons: string[], lines: Line[] = [], diff?: TieOut['diff']): TieOut => {
    const d = diff ?? { expense: r2(invoice.taxable - base.fee), gst: r2(invoice.gst - base.gst), gateway: r2(invoice.total - (base.fee + base.gst)) };
    return { status, period: i.period, invoice, report, booked, diff: d, lines, reasons };
  };

  // A bill dated before the books start is only compared with the GoKwik report (the ledger does not carry that month): never posted.
  if (i.opening) {
    const d = out('opening', report, []).diff;
    const same = Math.abs(d.gateway) < 0.005;
    return out('opening', report, [same
      ? `Dated before the books start: it agrees with the GoKwik report for the month (${money(report.total)})${d.expense || d.gst ? `, the split differs by ${money(Math.abs(d.expense))}` : ''}. Nothing is posted.`
      : `Dated before the books start: compared with the GoKwik report only, and it differs by ${money(Math.abs(d.gateway))}. Nothing is posted.`]);
  }

  if (i.invoice.taxType !== 'IGST') {
    return out('investigate', booked, [`This invoice charges ${i.invoice.taxType}, but the order ledger books the gateway's GST as IGST: a person has to look at it before anything is posted`]);
  }

  // The ledger has not booked all the payouts of the month yet (an order not invoiced yet, or held back): adjusting now would count them twice.
  const gap = { fee: r2(report.fee - booked.fee), gst: r2(report.gst - booked.gst) };
  if (Math.abs(gap.fee) >= 0.005 || Math.abs(gap.gst) >= 0.005) {
    return out('wait', booked, [`The order ledger has booked ${money(booked.total)} of the ${money(report.total)} the GoKwik report shows for this month: ${money(Math.abs(gap.fee + gap.gst))} of ${gap.fee + gap.gst > 0 ? 'payouts are not booked yet (an order not invoiced yet, or held back)' : 'booked fees are not in the report'}. Adjusting now would count them twice: wait until the ledger has caught up`]);
  }

  const diff = { expense: r2(invoice.taxable - booked.fee), gst: r2(invoice.gst - booked.gst), gateway: r2(invoice.total - booked.total) };
  if (Math.abs(diff.expense) < 0.005 && Math.abs(diff.gst) < 0.005) return out('agrees', booked, ['The invoice agrees with what the order ledger booked: nothing to adjust.'], [], { expense: 0, gst: 0, gateway: 0 });

  const lines = adjustmentLines(diff);
  const biggest = Math.max(Math.abs(diff.expense), Math.abs(diff.gst), Math.abs(diff.gateway));
  if (biggest > TOLERANCE) {
    return out('investigate', booked, [`The invoice differs from what was booked by ${money(biggest)}: more than a rounding difference. Fees on the other side of the month-end, refunds and charges that are on the invoice but not in the GoKwik report all do this: check it before posting`], lines, diff);
  }
  return out('adjust', booked, [`To match the invoice (and GSTR-2B), the books need this adjustment: ${diff.expense > 0 ? 'more' : 'less'} expense by ${money(Math.abs(diff.expense))} and ${diff.gst > 0 ? 'more' : 'less'} input GST by ${money(Math.abs(diff.gst))}.`], lines, diff);
}
