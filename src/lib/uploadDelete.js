// Taking an upload back: the wording of the confirmation ("what will happen") and of the result. Pure, no network.
// The numbers come from the dry run of finance-import / velocity-import (migration 026); nothing here decides anything.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const range = (a, b) => (a && b && a !== b ? `${dmy(a)} to ${dmy(b)}` : dmy(a || b));
const count = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString('en-IN')} ${Number(n) === 1 ? one : many}`;
const names = (list) => (list ?? []).map(x => x.filename || 'another upload').join(' and ');

/** What the person is told before confirming. { title, lines (what goes), cautions (what to know) }. */
export function describeDeletion(plan) {
  if (!plan) return { title: '', lines: [], cautions: [] };
  const lines = [], cautions = [];
  const label = plan.label || 'this upload';
  const moved = Number(plan.moved_to_other_upload || 0);
  const movedLine = (noun) => moved > 0
    ? `${count(moved, noun)} ${moved === 1 ? 'is' : 'are'} also in ${names(plan.moved_to)}, so ${moved === 1 ? 'it stays' : 'they stay'} there.` : null;

  switch (plan.kind) {
    case 'statement':
      lines.push(plan.removed > 0
        ? `Removes ${count(plan.removed, 'line')} dated ${range(plan.period_from, plan.period_to)} from ${plan.account}.`
        : 'Removes no lines: every line in it is also in another upload and stays.');
      if (movedLine('line')) lines.push(movedLine('line'));
      if (plan.filed_by_hand > 0) cautions.push(`${count(plan.filed_by_hand, 'removed line')} ${plan.filed_by_hand === 1 ? 'was' : 'were'} filed by you. That filing is lost.`);
      if (plan.topup_payments > 0) cautions.push(`${count(plan.topup_payments, 'removed payment')} funded a Velocity top-up. ${plan.topup_payments === 1 ? 'That top-up' : 'Those top-ups'} will show as “not in the bank statement”.`);
      if (plan.removed > 0) cautions.push('The matching is re-run straight away. Uploading the same file again brings the lines back, but not your filing.');
      break;
    case 'velocity_ledger':
      lines.push(plan.removed > 0
        ? `Removes ${count(plan.removed, 'ledger line')} for ${range(plan.period_from, plan.period_to)}${plan.topups > 0 ? `, including ${count(plan.topups, 'top-up')} totalling ${inr(plan.topup_amount)}` : ''}.`
        : 'Removes no lines: every line in it is also in another report and stays.');
      if (movedLine('line')) lines.push(movedLine('line'));
      if (plan.bank_lines_reverting > 0) cautions.push(`${count(plan.bank_lines_reverting, 'bank payment')} these top-ups proved go back to “suggested”.`);
      if (plan.bank_lines_staying > 0) cautions.push(`${count(plan.bank_lines_staying, 'bank payment')} you confirmed by hand ${plan.bank_lines_staying === 1 ? 'stays as you filed it' : 'stay as you filed them'}.`);
      if (plan.removed > 0) cautions.push('The month’s balances and invoice check are worked out again from what is left, and a neighbouring report may then show as “missing”.');
      break;
    case 'velocity_invoice':
      lines.push(`Removes invoice ${label} (${inr(plan.total)} with GST${plan.period_from ? `, for ${range(plan.period_from, plan.period_to)}` : ''}).`);
      cautions.push('The check of that month’s charges against an invoice disappears until you upload it again.');
      break;
    case 'gokwik_report':
      lines.push(`Removes ${count(plan.removed, 'payment')} settled ${range(plan.period_from, plan.period_to)}: ${inr(plan.to_bank)} paid to the bank in ${count(plan.payouts, 'payout')}.`);
      if (plan.bank_lines_reverting > 0) cautions.push(`${count(plan.bank_lines_reverting, 'bank credit')} these payouts proved go back to “suggested”.`);
      if (plan.bank_lines_staying > 0) cautions.push(`${count(plan.bank_lines_staying, 'bank credit')} you confirmed by hand ${plan.bank_lines_staying === 1 ? 'stays as you filed it' : 'stay as you filed them'}.`);
      cautions.push('If another GoKwik report you uploaded also had some of these payments, upload that report again to bring them back.');
      break;
    default:
      lines.push(`Removes ${label}.`);
  }
  return { title: `Delete ${label}?`, lines, cautions };
}

/** One line for the toast after a real delete. */
export function deletedMessage(result) {
  if (!result) return 'Deleted';
  const noun = result.kind === 'gokwik_report' ? 'payment' : result.kind === 'velocity_invoice' ? 'invoice' : 'line';
  const parts = [`Deleted ${result.label}`];
  if (result.kind !== 'velocity_invoice') parts.push(`${count(result.removed, noun)} removed${result.moved_to_other_upload > 0 ? `, ${result.moved_to_other_upload} kept in another upload` : ''}`);
  const err = result.matching_error;
  return `${parts.join(': ')}.${err ? ` Re-matching failed (${err}): press “Re-run matching”.` : ''}`;
}

/** The label a log row shows for a kind. */
export const KIND_LABEL = { statement: 'Bank / card statement', velocity_ledger: 'Velocity ledger report', velocity_invoice: 'Velocity invoice', gokwik_report: 'GoKwik report' };
