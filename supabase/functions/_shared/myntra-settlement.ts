// Myntra's payouts as lines the order ledger can book. Pure: no network, no database.
//
// Myntra pays about every other day, one NEFT per payout, net of its fees, TCS and TDS, and takes back what customers returned
// out of the same transfers. Two of its reports carry the money, per order line:
//   the monthly SETTLED report (.xlsx, sheets forward_settled / reverse_settled): by the month the money was PAID, so it holds every
//     line of a month's payouts whatever month the order was placed in; generated after month end;
//   the PAYMENT DETAILS report (.csv): by the month the order was PLACED (at most 31 days per file), up to about two days old,
//     settled and not yet settled lines together; cannot be scheduled.
// Both are read into the same SettlementLine: one stream (prepaid or postpaid) of one order line in one payout, forward (paid to us)
// or reverse (taken back from us).
//
// What a line is made of, which both reports obey to the paisa (checked on every line, a line that does not add up refuses the file):
//   forward   paid  =  product - commission - fixed fee - TCS - TDS
//   reverse   taken =  product - commission + return fee - TCS - TDS     (the fixed fee is not given back; commission, TCS and TDS are)
// Commission and the two fees are GST-inclusive in the reports; the ledger splits the GST off (18%) and claims it as input.
//
// Nothing here knows about Tally or the ledger beyond the shape of a fact (MyntraSettlement, defined in ledger.ts).

import { parseCsv } from './gokwik-report.ts';
import type { MyntraSettlement } from './ledger.ts';

export type SettlementLine = {
  utr: string;                     // the transfer's reference as Myntra writes it, e.g. NFT-/XUTR/DEUTH026303A2EWNX
  settled_on: string | null;       // the date the report gives for the transfer (the ledger books the BANK's date)
  invoice: string;                 // Unicommerce sale invoice number, I0927RE...: the order's name in the ledger
  line_id: string;                 // Myntra's order line id: one invoice can hold several items
  order_ref: string;               // Myntra's seller order id (the Unicommerce order code)
  stream: 'prepaid' | 'postpaid';  // paid online / paid at the door: each has its own transfer
  dir: 'forward' | 'reverse';
  product: number;                 // what the seller is owed for this stream of the item, GST-inclusive
  commission: number;              // GST-inclusive commission charged (forward) or given back (reverse), >= 0
  fee: number;                     // GST-inclusive: forward = the fixed fee, reverse = the return fee, >= 0
  tcs: number;                     // tax collected at source, >= 0
  tds: number;                     // tax deducted at source, >= 0
  net: number;                     // money in the transfer: forward +, reverse - (taken back)
};
export type Check = { id: string; ok: boolean; detail: string };
export type ParsedSettlement = { kind: 'settled_report' | 'payment_details'; lines: SettlementLine[]; checks: Check[] };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Text cells in the monthly report carry stray quotes and backslashes ("\"I0927RE000000047\"" for an invoice, "" for nothing). */
const clean = (s: unknown) => String(s ?? '').replace(/["\\]/g, '').trim();
const empty = (s: string) => s === '' || /^null$/i.test(s);
const num = (s: unknown) => { const t = clean(s).replace(/,/g, ''); if (empty(t)) return 0; const n = Number(t); return Number.isFinite(n) ? n : 0; };
const day = (s: unknown) => /^(\d{4}-\d{2}-\d{2})/.exec(clean(s))?.[1] ?? null;
const STREAMS = ['prepaid', 'postpaid'] as const;

/** How far a line is from adding up (0 = exactly). */
export function gap(l: Pick<SettlementLine, 'dir' | 'product' | 'commission' | 'fee' | 'tcs' | 'tds' | 'net'>): number {
  return l.dir === 'forward'
    ? l.product - l.commission - l.fee - l.tcs - l.tds - l.net
    : -(l.product - l.commission + l.fee - l.tcs - l.tds) - l.net;
}
const TOLERANCE = 0.02;

function verdict(lines: SettlementLine[], unknown: string[]): Check[] {
  const bad = lines.filter(l => Math.abs(gap(l)) > TOLERANCE);
  return [
    { id: 'lines', ok: lines.length > 0, detail: lines.length ? `${lines.length} payout lines (${lines.filter(l => l.dir === 'forward').length} paid, ${lines.filter(l => l.dir === 'reverse').length} taken back)` : 'no settled lines found in the file' },
    { id: 'adds_up', ok: bad.length === 0, detail: bad.length ? `${bad.length} line${bad.length === 1 ? '' : 's'} do not add up (paid = product - commission - fees - TCS - TDS), e.g. ${bad.slice(0, 3).map(l => `${l.invoice} off by ${r2(gap(l)).toFixed(2)}`).join(', ')}` : 'every line adds up' },
    { id: 'known_charges', ok: unknown.length === 0, detail: unknown.length ? `the file has charges the ledger has no account for: ${[...new Set(unknown)].slice(0, 6).join(', ')}` : 'only the fixed fee, return fee, commission, TCS and TDS' },
  ];
}

// ── The monthly settled report (.xlsx) ───────────────────────────────────────────────────────────────────────────────
// Three header rows (group, stream, column name); the data starts under the one that names the columns. A line is one stream of one
// row with a UTR and a settled amount; the same invoice can appear in both sheets (paid, then taken back).
const SETTLED_EXTRAS = ['Pick_and_Pack_Fees', 'Tech_Enablement_Charges', 'Royalty_charges', 'SJIT_Incentive', 'Commission_Discount'];

export function parseSettledReport(sheets: Map<string, string[][]>): ParsedSettlement {
  const find = (re: RegExp) => [...sheets.entries()].find(([name]) => re.test(name));
  const forward = find(/forward.*settled/i), reverse = find(/reverse.*settled/i);
  if (!forward && !reverse) throw new Error("this does not look like Myntra's monthly settlement report: it has no forward_settled or reverse_settled sheet");
  const lines: SettlementLine[] = [];
  const unknown: string[] = [];
  for (const [dir, sheet] of [['forward', forward], ['reverse', reverse]] as const) {
    if (!sheet) continue;
    const rows = sheet[1];
    const hi = rows.findIndex(r => r.includes('order_release_id') && r.includes('invoice_number'));
    if (hi < 0) throw new Error(`the ${sheet[0]} sheet has no row naming the columns (order_release_id, invoice_number, ...)`);
    const head = rows[hi];
    const col = (name: string) => head.indexOf(name);
    for (const need of ['invoice_number', 'order_line_id']) if (col(need) < 0) throw new Error(`the ${sheet[0]} sheet has no "${need}" column`);
    const feeColumn = dir === 'forward' ? 'Logistics_Cost_Forward_incl_Tax' : 'Logistics_Cost_Reverse_incl_Tax';
    const extraColumns = [...SETTLED_EXTRAS, dir === 'forward' ? 'Forward_additional_charges' : 'Reverse_additional_charges'];
    for (const row of rows.slice(hi + 1)) {
      const get = (name: string) => { const i = col(name); return i < 0 ? '' : row[i] ?? ''; };
      const invoice = clean(get('invoice_number'));
      if (!invoice) continue;
      for (const [s, S] of [['prepaid', 'Prepaid'], ['postpaid', 'Postpaid']] as const) {
        const utr = clean(get(`UTR_Number_${S}`));
        const net = num(get(`Settled_Amount_${S}`));
        if (empty(utr) || net === 0) continue;
        for (const x of extraColumns) if (Math.abs(num(get(`${x}_${S}`))) > 0.005) unknown.push(`${x} (${invoice})`);
        const commission = num(get(`Commission_Amount_incl_GST_${S}`));
        lines.push({
          utr, settled_on: day(get(`settlement_date_${s}_payment`)), invoice, line_id: clean(get('order_line_id')), order_ref: clean(get('seller_order_id')),
          stream: s, dir, product: r3(num(get(`Seller_Product_Amount_${S}`))),
          commission: r3(dir === 'forward' ? -commission : commission) + 0, fee: r3(num(get(`${feeColumn}_${S}`))),
          tcs: r3(num(get(`tcs_amount_${S}`))), tds: r3(num(get(`tds_amount_${S}`))), net: r3(net),
        });
      }
    }
  }
  return { kind: 'settled_report', lines, checks: verdict(lines, unknown) };
}

// ── The payment details report (.csv) ────────────────────────────────────────────────────────────────────────────────
// One row per order line, both directions side by side. A forward line is a stream with a forward UTR; a reverse line a stream with a
// reverse UTR. The report gives the commission and the TCS/TDS once (they reverse in full on a return) and not the return fee, which is
// what is left of the amount taken back: taken = product - commission + return fee - TCS - TDS.
export function parsePaymentDetails(text: string): ParsedSettlement {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('the file is empty');
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  for (const need of ['invoice number', 'order line id', 'prepaid forward utr number', 'postpaid payment eligible reverse']) {
    if (col(need) < 0) throw new Error(`this does not look like Myntra's payment details report: no "${need}" column`);
  }
  const lines: SettlementLine[] = [];
  const unknown: string[] = [];
  const implausible: string[] = [];
  for (const row of rows.slice(1)) {
    const get = (name: string) => { const i = col(name); return i < 0 ? '' : row[i] ?? ''; };
    const invoice = clean(get('invoice number'));
    if (!invoice) continue;
    for (const s of STREAMS) {
      for (const x of ['tech enablement charges', 'pick and pack fees', 'forward additional charges', 'reverse additional charges', 'collection cost', 'total logistic charge', 'payment gateway fee', 'sjit incentive amount', 'commission discount', 'fixed cost reversal']) {
        if (Math.abs(num(get(`${s} ${x}`))) > 0.005) unknown.push(`${s} ${x} (${invoice})`);
      }
      const tcs = num(get(`${s} tcs amount`)), tds = num(get(`${s} tds amount`));
      const product = num(get(`${s} seller product amount`));
      const commission = Math.max(0, num(get(`${s} total commission plus tcs tds`)) - tcs - tds);
      const base = { invoice, line_id: clean(get('order line id')), order_ref: clean(get('seller order id')), stream: s } as const;
      const fwdUtr = clean(get(`${s} forward utr number`)), fwdNet = num(get(`${s} payment eligible forward`));
      if (!empty(fwdUtr) && fwdNet !== 0) {
        lines.push({ ...base, utr: fwdUtr, settled_on: day(get(`${s} forward settlement date`)), dir: 'forward', product: r3(product), commission: r3(commission),
          fee: r3(num(get(`${s} fixed cost`)) * 1.18), tcs: r3(tcs), tds: r3(tds), net: r3(fwdNet) });
      }
      const revUtr = clean(get(`${s} reverse utr number`)), revNet = num(get(`${s} payment eligible reverse`));
      if (!empty(revUtr) && revNet !== 0) {
        const fee = revNet - product + commission + tcs + tds;           // what Myntra charged for the return, GST-inclusive
        if (fee < -TOLERANCE || fee > 500) implausible.push(`${invoice} (return fee would be ${r2(fee).toFixed(2)})`);
        lines.push({ ...base, utr: revUtr, settled_on: day(get(`${s} reverse settlement date`)), dir: 'reverse', product: r3(product), commission: r3(commission),
          fee: r3(Math.max(0, fee)), tcs: r3(tcs), tds: r3(tds), net: r3(-revNet) });
      }
    }
  }
  const checks = verdict(lines, unknown);
  if (implausible.length) checks.push({ id: 'return_fee', ok: false, detail: `the amount taken back does not leave a sensible return fee for: ${implausible.slice(0, 3).join(', ')}` });
  return { kind: 'payment_details', lines, checks };
}

/** Which of the two reports a file is, from its bytes: .xlsx files start with PK. */
export const isXlsx = (bytes: Uint8Array) => bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;

// ── Payouts, and the bank ────────────────────────────────────────────────────────────────────────────────────────────
export type Payout = { utr: string; settled_on: string | null; net: number; lines: number; forward: number; reverse: number; orders: number };
export type BankCredit = { id: number; txn_date: string; credit: number; remarks: string };
export type PayoutTie = { state: 'tied' | 'differs' | 'not_in_bank'; bank?: BankCredit; diff?: number };

const squash = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
/** The part of a UTR the bank statement repeats: "NFT-/XUTR/DEUTH026303A2EWNX" appears as "...DEUTH026303A2EWN-MYNTRA DESIGNS..." (16 characters). */
export const utrKey = (utr: string) => squash(utr.split('/').pop() ?? utr).slice(0, 16);

export function payoutsOf(lines: Array<Pick<SettlementLine, 'utr' | 'settled_on' | 'net' | 'dir' | 'invoice'>>): Payout[] {
  const by = new Map<string, Array<(typeof lines)[number]>>();
  for (const l of lines) by.set(l.utr, [...(by.get(l.utr) ?? []), l]);
  return [...by.entries()].map(([utr, ls]) => ({
    utr, settled_on: ls.map(l => l.settled_on).filter(Boolean).sort()[0] ?? null, net: r2(ls.reduce((s, l) => s + l.net, 0)), lines: ls.length,
    forward: ls.filter(l => l.dir === 'forward').length, reverse: ls.filter(l => l.dir === 'reverse').length, orders: new Set(ls.map(l => l.invoice)).size,
  })).sort((a, b) => (a.settled_on ?? '').localeCompare(b.settled_on ?? '') || a.utr.localeCompare(b.utr));
}

/** The bank credit that carries this payout: its narration holds the UTR, and the amount must be the payout's total to the paisa. */
export function tieToBank(p: Pick<Payout, 'utr' | 'net'>, banks: BankCredit[]): PayoutTie {
  const key = utrKey(p.utr);
  if (key.length < 12) return { state: 'not_in_bank' };
  const bank = banks.find(b => squash(b.remarks).includes(key));
  if (!bank) return { state: 'not_in_bank' };
  const diff = r2(bank.credit - p.net);
  return { state: Math.abs(diff) <= 0.011 ? 'tied' : 'differs', bank, diff };
}

/** Cents each line carries of the bank credit. The lines' exact amounts have three decimals; rounding each one would drift from the
 *  credit by a paisa or two, so the running total is rounded instead and each line takes the difference. They add up to `bankCredit`. */
export function allocateShares(lines: Array<Pick<SettlementLine, 'invoice' | 'line_id' | 'stream' | 'dir' | 'net'>>, bankCredit: number): number[] {
  const order = lines.map((_, i) => i).sort((a, b) => {
    const x = lines[a], y = lines[b];
    return x.invoice.localeCompare(y.invoice) || x.line_id.localeCompare(y.line_id) || x.stream.localeCompare(y.stream) || x.dir.localeCompare(y.dir);
  });
  const cents = (mills: number) => Math.sign(mills) * Math.round(Math.abs(mills) / 10);
  const shares = new Array<number>(lines.length).fill(0);
  let cum = 0, done = 0;
  for (const i of order) {
    cum += Math.round(lines[i].net * 1000);
    const c = cents(cum);
    shares[i] = (c - done) / 100;
    done = c;
  }
  const want = Math.round(bankCredit * 100);
  if (order.length && done !== want) shares[order[order.length - 1]] = r2(shares[order[order.length - 1]] + (want - done) / 100);
  return shares;
}

/** What the ledger needs per order: for every payout that is proved by a bank credit dated on or after `cutoff`, the order's lines in it.
 *  A payout with no bank credit yet, or whose total differs from the credit, books nothing (the file is incomplete, or not the right one). */
export function settlementFacts(lines: SettlementLine[], banks: BankCredit[], cutoff: string): { facts: Map<string, MyntraSettlement[]>; payouts: Array<Payout & PayoutTie> } {
  const facts = new Map<string, MyntraSettlement[]>();
  const byUtr = new Map<string, SettlementLine[]>();
  for (const l of lines) byUtr.set(l.utr, [...(byUtr.get(l.utr) ?? []), l]);
  const payouts: Array<Payout & PayoutTie> = [];
  for (const p of payoutsOf(lines)) {
    const tie = tieToBank(p, banks);
    payouts.push({ ...p, ...tie });
    if (tie.state !== 'tied' || !tie.bank || tie.bank.txn_date < cutoff) continue;
    const ls = byUtr.get(p.utr)!;
    const shares = allocateShares(ls, tie.bank.credit);
    const perOrder = new Map<string, MyntraSettlement['lines']>();
    ls.forEach((l, i) => perOrder.set(l.invoice, [...(perOrder.get(l.invoice) ?? []), { dir: l.dir, product: l.product, commission: l.commission, fee: l.fee, tcs: l.tcs, tds: l.tds, share: shares[i] }]));
    for (const [invoice, ol] of perOrder) facts.set(invoice, [...(facts.get(invoice) ?? []), { utr: p.utr, date: tie.bank.txn_date, lines: ol }]);
  }
  return { facts, payouts };
}

/** A short, order-independent description of an order's payouts, to tell whether what the ledger holds is what the reports now prove
 *  (the stored facts are jsonb, which does not keep key order, so they cannot be compared as text). */
export function settlementFingerprint(settlements: MyntraSettlement[] | null | undefined): string {
  return [...(settlements ?? [])].sort((a, b) => a.utr.localeCompare(b.utr))
    .map(m => `${m.utr}@${m.date}:${m.lines.map(l => `${l.dir}${l.share}/${l.product}/${l.commission}/${l.fee}/${l.tcs}/${l.tds}`).sort().join(',')}`).join(';');
}
