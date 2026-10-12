// Velocity's wallet, as the books need it. Pure rules, no network, no database.
//
// Velocity (White Wizard Technologies) works like a prepaid account: the seller tops up a wallet (UPI), every charge
// (freight, COD charge, RTO, delivery-failure messages, weight differences) is taken from the wallet GST-inclusive
// as it happens, and after month end Velocity sends ONE tax invoice for the month. So the wallet is an advance, and the
// invoice (not the top-up) is the expense. Two documents come in here:
//   - the dashboard's "Ledger Report" CSV: Transaction Type, Amount, Balance, Tracking Number, Notes, Created At
//     (Created At is in the same timezone as the invoice month: IST; checked against a month's 293 delivery-failure
//     messages, which equal the invoice's VAS line to the paisa)
//   - the monthly tax invoice PDF (text): VAS and freight lines plus IGST
//
// Every file is checked before anything is stored: the running balance must follow from the amounts, and an invoice
// must add up. The reconciliation helpers below compare top-ups with bank lines and a month's charges with its invoice.

import { parseCsv } from './gokwik-report.ts';

export const GST_FACTOR = 1.18;

export type WalletKind =
  | 'shipping' | 'cod_charge' | 'rto' | 'ndr_automation' | 'weight_discrepancy'          // debits: what Velocity charges
  | 'cod_reversal' | 'shipping_reversal' | 'financial_note'                              // credits: charges given back
  | 'recharge'                                                                           // credit: the seller's top-up
  | 'other';

export type WalletLine = {
  key: string;                 // unique per line: time, type, amount, parcel, note and the balance after it
  txn_at: string;              // 'YYYY-MM-DD HH:MM:SS', IST
  txn_date: string;
  direction: 'debit' | 'credit';
  amount: number;              // GST-inclusive, always positive
  balance: number;             // wallet balance after this line
  awb: string | null;
  notes: string;
  kind: WalletKind;
  ex_gst: number | null;       // amount before GST for charges and reversals; null for top-ups and financial notes
};
export type Check = { id: string; ok: boolean; detail: string };
export type LedgerParse = { lines: WalletLine[]; period_from: string | null; period_to: string | null; opening: number | null; closing: number | null; checks: Check[] };

const r2 = (n: number) => Math.round(n * 100) / 100;
export const exGst = (amount: number) => r2(amount / GST_FACTOR);
const inr = (n: number) => `₹${n.toFixed(2)}`;

/** What a ledger line is, from the note Velocity writes on it. */
export function kindOf(notes: string): WalletKind {
  const n = notes.trim();
  if (/^wallet recharge$/i.test(n)) return 'recharge';
  if (/^shipping charges$/i.test(n)) return 'shipping';
  if (/^cod charges$/i.test(n)) return 'cod_charge';
  if (/^rto charges$/i.test(n)) return 'rto';
  if (/^automation\b/i.test(n)) return 'ndr_automation';
  if (/^weight discrepancy/i.test(n)) return 'weight_discrepancy';
  if (/^cod charges reversed$/i.test(n)) return 'cod_reversal';
  if (/^shipping charges reversed$/i.test(n)) return 'shipping_reversal';
  if (/financial note/i.test(n)) return 'financial_note';
  return 'other';
}

const CHARGE_KINDS = new Set<WalletKind>(['shipping', 'cod_charge', 'rto', 'ndr_automation', 'weight_discrepancy']);
const REVERSAL_KINDS = new Set<WalletKind>(['cod_reversal', 'shipping_reversal']);

export function parseWalletLedger(text: string): LedgerParse {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('the file is empty');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const ix = (name: string) => head.indexOf(name);
  for (const need of ['transaction type', 'amount', 'balance', 'notes', 'created at']) {
    if (ix(need) < 0) throw new Error(`this does not look like a Velocity ledger report: no "${need}" column`);
  }
  const awbCol = ix('tracking number');

  const lines: WalletLine[] = [];
  const bad: number[] = [];
  rows.slice(1).forEach((r, i) => {
    const type = String(r[ix('transaction type')] ?? '').trim().toLowerCase();
    const amount = Number(String(r[ix('amount')] ?? '').replace(/,/g, ''));
    const balance = Number(String(r[ix('balance')] ?? '').replace(/,/g, ''));
    const at = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(r[ix('created at')] ?? '').trim());
    if ((type !== 'debit' && type !== 'credit') || !Number.isFinite(amount) || !Number.isFinite(balance) || !at || amount < 0) { bad.push(i + 2); return; }
    const notes = String(r[ix('notes')] ?? '').replace(/\s+/g, ' ').trim();
    const awb = awbCol >= 0 ? String(r[awbCol] ?? '').trim() || null : null;
    const kind = kindOf(notes);
    const txn_at = `${at[1]} ${at[2]}`;
    lines.push({
      key: `${txn_at}|${type}|${amount.toFixed(2)}|${awb ?? ''}|${notes}|${balance.toFixed(2)}`,
      txn_at, txn_date: at[1], direction: type, amount: r2(amount), balance: r2(balance), awb, notes, kind,
      ex_gst: CHARGE_KINDS.has(kind) || REVERSAL_KINDS.has(kind) ? exGst(amount) : null,
    });
  });

  const checks: Check[] = [];
  checks.push({ id: 'rows_readable', ok: bad.length === 0, detail: bad.length ? `${bad.length} row(s) could not be read (file line ${bad.slice(0, 5).join(', ')})` : `all ${lines.length} rows read` });
  if (!lines.length) throw new Error('no ledger lines found in the file');

  const keys = new Set(lines.map(l => l.key));
  checks.push({ id: 'unique_lines', ok: keys.size === lines.length, detail: keys.size === lines.length ? 'no line appears twice' : `${lines.length - keys.size} line(s) appear twice in the file` });

  const bal = balanceCheck(lines);
  checks.push(bal.check);
  const other = lines.filter(l => l.kind === 'other');
  checks.push({ id: 'known_notes', ok: other.length === 0, detail: other.length ? `${other.length} line(s) with a note not seen before: ${[...new Set(other.map(l => l.notes))].slice(0, 3).join('; ')}` : 'every note is a known kind' });

  const dates = lines.map(l => l.txn_date).sort();
  return { lines, period_from: dates[0], period_to: dates[dates.length - 1], opening: bal.opening, closing: bal.closing, checks };
}

/**
 * The balance after the last line minus the balance before the first must equal the sum of everything in between.
 * Lines that happened in the same second come in no reliable order, so the two ends are matched by value: the closing
 * balance is the balance of one of the last-second lines, the opening one of the first-second lines, and exactly one
 * pair is consistent with the total movement. A missing or altered line breaks this.
 */
export function balanceCheck(lines: WalletLine[]): { check: Check; opening: number | null; closing: number | null } {
  const sorted = [...lines].sort((a, b) => a.txn_at.localeCompare(b.txn_at));
  const signed = (l: WalletLine) => (l.direction === 'credit' ? l.amount : -l.amount);
  const net = r2(sorted.reduce((s, l) => s + signed(l), 0));
  const firstAt = sorted[0].txn_at, lastAt = sorted[sorted.length - 1].txn_at;
  const first = sorted.filter(l => l.txn_at === firstAt), last = sorted.filter(l => l.txn_at === lastAt);
  const netFirst = r2(first.reduce((s, l) => s + signed(l), 0));
  for (const close of last) {
    const opening = r2(close.balance - net);
    const afterFirst = r2(opening + netFirst);
    if (first.some(l => Math.abs(l.balance - afterFirst) <= 0.011)) {
      return { check: { id: 'running_balance', ok: true, detail: `opening ${inr(opening)} plus the ${lines.length} lines gives the closing ${inr(close.balance)}` }, opening, closing: close.balance };
    }
  }
  return { check: { id: 'running_balance', ok: false, detail: 'the balance column does not follow from the amounts: the file is missing lines or was changed' }, opening: null, closing: null };
}

// ── Top-ups against the bank ─────────────────────────────────────────────────────────────────
/** The payee Velocity's top-ups go to on the bank statement (four Cashfree handles seen: shipfast.cf, cf.shipfast, a masked "…t.cf", a masked "…fast@cashfre"). */
export const VELOCITY_HANDLE = /shipfast|\.cf@|velocity|fast@cashf/i;

export type TopUp = { key: string; at: string; date: string; amount: number };
// `filed`: a person filed this bank line under the Velocity wallet recharge bucket, so it counts whatever the payee looks like.
export type BankDebit = { id: number; date: string; amount: number; remarks: string; filed?: boolean };

const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Each wallet top-up against the bank payment that funded it: same amount, within a day, to a Velocity handle or filed there by a person; one bank line serves one top-up. */
export function matchTopUps(topups: TopUp[], bank: BankDebit[], tolDays = 1): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const t of [...topups].sort((a, b) => a.at.localeCompare(b.at))) {
    const hit = bank
      .filter(b => !used.has(b.id) && Math.abs(b.amount - t.amount) <= 0.011 && (b.filed || VELOCITY_HANDLE.test(b.remarks)) && Math.abs(dayNum(b.date) - dayNum(t.date)) <= tolDays)
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(t.date)) - Math.abs(dayNum(b.date) - dayNum(t.date)))[0];
    if (hit) { out.set(t.key, hit.id); used.add(hit.id); }
  }
  return out;
}

// ── The monthly tax invoice ──────────────────────────────────────────────────────────────────
export type VelocityInvoice = {
  invoice_no: string; invoice_date: string; period_from: string | null; period_to: string | null;
  supplier_gstin: string | null; bill_to_gstin: string | null;
  lines: Array<{ sac: string; description: string; amount: number }>;
  taxes: Array<{ name: string; rate: number; amount: number }>;
  subtotal: number; tax: number; total: number; checks: Check[];
};

const ddmmyyyy = (s: string) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const money = (s: string) => Number(s.replace(/,/g, ''));

export function parseVelocityInvoice(text: string): VelocityInvoice {
  const t = text.replace(/\s+/g, ' ');
  if (!/White Wizard Technolog/i.test(t) || !/TAX\s*INVOICE/i.test(t)) throw new Error('this does not look like a Velocity (White Wizard Technologies) tax invoice');
  const no = /Invoice No\.?:?\s*([A-Z0-9][A-Z0-9/\-]*)/i.exec(t)?.[1];
  const date = ddmmyyyy(/Invoice Date:?\s*(\d{2}\/\d{2}\/\d{4})/i.exec(t)?.[1] ?? '');
  if (!no || !date) throw new Error('could not read the invoice number and date');
  const per = /Invoice Period:?\s*(\d{2}\/\d{2}\/\d{4})\s*to\s*(\d{2}\/\d{2}\/\d{4})/i.exec(t);
  const gstins = [...t.matchAll(/GSTIN:?\s*([0-9]{2}[A-Z0-9]{13})/g)].map(m => m[1]);

  const lines = [...t.matchAll(/\b(99\d{4})\s+([A-Za-z][A-Za-z0-9 &/().-]*?)\s*₹\s*([\d,]+\.\d{2})/g)].map(m => ({ sac: m[1], description: m[2].trim(), amount: money(m[3]) }));
  const taxes = [...t.matchAll(/\b(IGST|CGST|SGST|UTGST)\s*\((\d+(?:\.\d+)?)%\)\s*₹\s*([\d,]+\.\d{2})/g)].map(m => ({ name: m[1], rate: Number(m[2]), amount: money(m[3]) }));
  const total = /Grand Total Value\s*₹\s*([\d,]+\.\d{2})/i.exec(t)?.[1];
  if (!lines.length || !total) throw new Error('could not read the invoice lines and total');

  const subtotal = r2(lines.reduce((s, l) => s + l.amount, 0)), tax = r2(taxes.reduce((s, x) => s + x.amount, 0));
  const checks: Check[] = [];
  checks.push({ id: 'adds_up', ok: Math.abs(subtotal + tax - money(total)) <= 0.011, detail: `lines ${inr(subtotal)} + GST ${inr(tax)} = ${inr(r2(subtotal + tax))}, invoice total ${inr(money(total))}` });
  const rate = taxes.reduce((s, x) => s + x.rate, 0);
  checks.push({ id: 'gst_rate', ok: taxes.length > 0 && Math.abs(subtotal * rate / 100 - tax) <= 0.02, detail: `${rate}% of ${inr(subtotal)} is ${inr(r2(subtotal * rate / 100))}, invoice GST ${inr(tax)}` });
  return {
    invoice_no: no, invoice_date: date, period_from: per ? ddmmyyyy(per[1]) : null, period_to: per ? ddmmyyyy(per[2]) : null,
    supplier_gstin: gstins[0] ?? null, bill_to_gstin: gstins[1] ?? null, lines, taxes, subtotal, tax, total: money(total), checks,
  };
}

// ── A month's charges against its invoice ────────────────────────────────────────────────────
export type InvoiceCheck = {
  vas: { invoice: number; ledger: number; diff: number } | null;
  freight: { invoice: number; closest: { label: string; ledger: number; diff: number }; variants: Array<{ label: string; ledger: number; diff: number }> } | null;
  gross_debits_ex_gst: number; credits_ex_gst: number;
};

/**
 * Compare the ledger with the invoice, before GST. Velocity's invoice is not simply "everything debited": it gives back some
 * credits and not others, so every combination is shown and the closest named. `lines` are the ledger lines dated in the invoice period.
 */
export function invoiceCheck(lines: Array<Pick<WalletLine, 'direction' | 'kind' | 'amount' | 'ex_gst'>>, inv: Pick<VelocityInvoice, 'lines'>): InvoiceCheck {
  const sum = (pick: (l: typeof lines[number]) => boolean) => r2(lines.filter(pick).reduce((s, l) => s + (l.ex_gst ?? 0), 0));
  const vasInv = inv.lines.filter(l => /\bVAS\b/i.test(l.description)).reduce((s, l) => s + l.amount, 0);
  const frInv = inv.lines.filter(l => !/\bVAS\b/i.test(l.description)).reduce((s, l) => s + l.amount, 0);
  const vasLedger = sum(l => l.kind === 'ndr_automation');
  const gross = sum(l => l.direction === 'debit' && (l.kind === 'shipping' || l.kind === 'cod_charge' || l.kind === 'rto' || l.kind === 'weight_discrepancy'));
  const credit = (kind: WalletKind) => r2(lines.filter(l => l.kind === kind).reduce((s, l) => s + (kind === 'financial_note' ? exGst(l.amount) : l.ex_gst ?? 0), 0));
  const cr = { cod_reversal: credit('cod_reversal'), shipping_reversal: credit('shipping_reversal'), financial_note: credit('financial_note') };
  const names: Array<[keyof typeof cr, string]> = [['shipping_reversal', 'shipping-charge reversals'], ['cod_reversal', 'COD-charge reversals'], ['financial_note', 'lost-shipment credits']];
  const variants: Array<{ label: string; ledger: number; diff: number }> = [];
  for (let m = 0; m < 8; m++) {
    const taken = names.filter((_, i) => m >> i & 1);
    const ledger = r2(gross - taken.reduce((s, [k]) => s + cr[k], 0));
    variants.push({ label: taken.length ? `all charges, less ${taken.map(([, n]) => n).join(' and ')}` : 'all charges, no credits taken off', ledger, diff: r2(ledger - frInv) });
  }
  variants.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
  return {
    vas: inv.lines.some(l => /\bVAS\b/i.test(l.description)) || vasLedger ? { invoice: r2(vasInv), ledger: vasLedger, diff: r2(vasLedger - vasInv) } : null,
    freight: frInv ? { invoice: r2(frInv), closest: variants[0], variants } : null,
    gross_debits_ex_gst: gross, credits_ex_gst: r2(cr.cod_reversal + cr.shipping_reversal + cr.financial_note),
  };
}
