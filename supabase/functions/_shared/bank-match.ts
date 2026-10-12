// What is each line of a bank or card statement? Pure rules, no network: the finance-import function reads the
// reference data (GoKwik and Velocity payouts, vendor invoices, the owner's rules) and hands it in.
//
// Order of decision, first match wins:
//   1. pairs that cancel out        a payment the bank returned the same day, a charge reversed on the card
//   2. proof from another system    a GoKwik or Velocity payout (amount and date agree), a Meta invoice (number and amount agree)
//   3. the owner's own rules        "this payee is always that bucket", learned from a confirmation
//   4. built-in guesses             the note typed on a UPI payment ("trims", "pcrate"), the card merchant, the narration
//   5. nothing                      the line is left for a person
//
// status: matched (proof, or the owner's own rule)  suggested (a guess to confirm)  needs_review  ignored (no entry needed)
// Lines a person has decided are never touched (the caller leaves them out).

import { VELOCITY_HANDLE, type TopUp } from './velocity-ledger.ts';

export type Line = {
  key: string;                       // unique within the account
  account_kind: 'bank' | 'card';
  txn_date: string;                  // YYYY-MM-DD
  remarks: string;
  debit: number;
  credit: number;
  category?: string | null;          // card: the issuer's category
  section?: string | null;           // card: purchase | fee | credit
};
export type Payout = { source: 'gokwik' | 'velocity'; utr: string; date: string; amount: number; payments: number };
export type VendorInvoice = { vendor: string; invoice_no: string; invoice_date: string; period: string | null; subtotal: number; tax: number; total: number };
export type Rule = { id: number; match_type: 'payee' | 'contains'; pattern: string; bucket: string };
export type Ctx = { payouts: Payout[]; invoices: VendorInvoice[]; rules: Rule[]; topups?: TopUp[] };   // topups: what Velocity's wallet ledger says was added
export type Status = 'matched' | 'suggested' | 'needs_review' | 'ignored';
export type Classification = {
  status: Status; kind: string; bucket: string | null; match_ref: string | null; reason: string; needs_bill: boolean; payee: string | null; rule_id: number | null;
};

export type Bucket = { name: string; kind: 'expense' | 'asset' | 'liability' | 'income' | 'transfer' | 'ignore' | 'review'; needs_bill: boolean; note: string };

// Bucket names that exist in the owner's Tally (taken from the July P&L, spelling included) come first. The others
// are bookkeeping buckets the accountant maps to a ledger. Every name here is a place a line can be filed.
export const BUCKETS: Bucket[] = [
  { name: 'Marketing Expenses', kind: 'expense', needs_bill: true, note: 'Advertising other than the Meta invoices' },
  { name: 'Employee Benefit Expenses', kind: 'expense', needs_bill: false, note: 'Salaries, including the founders' },
  { name: 'Labour Charges', kind: 'expense', needs_bill: false, note: 'Karigar piece-rate, cutting and marker work' },
  { name: 'Rent Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Rent Sector 63 Noida', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Software Expenses', kind: 'expense', needs_bill: true, note: 'Subscriptions and software: needs the vendor GST invoice' },
  { name: 'PAYMENT GATEWAY CHARGES', kind: 'expense', needs_bill: true, note: 'GoKwik and gateway fees' },
  { name: 'Shipping Expenses', kind: 'expense', needs_bill: true, note: '' },
  { name: 'Fabric and Consumbale', kind: 'expense', needs_bill: false, note: 'Trims, zippers and consumables (spelling as in Tally)' },
  { name: 'Packaging Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Travelling Expenses', kind: 'expense', needs_bill: false, note: 'Includes fuel' },
  { name: 'Repair & Maintenance', kind: 'expense', needs_bill: false, note: '' },
  { name: 'MAINTENANCE-DIR RESIDENCE', kind: 'expense', needs_bill: false, note: '' },
  { name: 'FREIGHT INWARD NON GST', kind: 'expense', needs_bill: false, note: 'Transport and porter charges' },
  { name: 'Cleaning Expenses Factory', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Electricity Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Telephone & Internet Expenses', kind: 'expense', needs_bill: true, note: '' },
  { name: 'Bank Charges GST', kind: 'expense', needs_bill: false, note: 'Bank and card charges with their GST' },
  { name: 'FINANCE COST', kind: 'expense', needs_bill: false, note: 'Interest' },
  { name: 'Miscellaneous Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Purchase Accounts', kind: 'expense', needs_bill: true, note: 'Fabric purchases: needs the supplier bill' },
  { name: 'GoKwik payout', kind: 'transfer', needs_bill: false, note: 'Clears what GoKwik owes for prepaid orders' },
  { name: 'Velocity COD remittance', kind: 'transfer', needs_bill: false, note: 'Clears the COD cash Velocity collected' },
  { name: 'Velocity wallet recharge', kind: 'asset', needs_bill: false, note: 'Advance with Velocity, used up by freight charges' },
  { name: 'Meta ads (invoice payment)', kind: 'liability', needs_bill: false, note: 'Pays a Meta tax invoice booked as marketing expense and input GST' },
  { name: 'Customer receipts (other gateway)', kind: 'transfer', needs_bill: false, note: 'For example Razorpay' },
  { name: 'Returned or reversed (no entry)', kind: 'ignore', needs_bill: false, note: 'A payment the bank returned, or a card charge reversed: nets to zero' },
  { name: 'Founder card payment (no company entry)', kind: 'ignore', needs_bill: false, note: "The founder paying his own card bill" },
  { name: 'To confirm: personal or business', kind: 'review', needs_bill: false, note: '' },
  { name: 'To confirm: capital or loan', kind: 'review', needs_bill: false, note: 'Money in from an owner, investor or lender' },
  { name: 'To confirm: cash deposit', kind: 'review', needs_bill: false, note: '' },
  { name: 'To confirm: machinery (asset)', kind: 'review', needs_bill: true, note: 'A machine is a fixed asset, not an expense' },
  { name: 'To confirm: employee advance', kind: 'review', needs_bill: false, note: '' },
  { name: 'To confirm: other', kind: 'review', needs_bill: false, note: '' },
];
const BUCKET_NAMES = new Set(BUCKETS.map(b => b.name));
export const needsBill = (bucket: string | null) => !!bucket && !!BUCKETS.find(b => b.name === bucket)?.needs_bill;

const r2 = (n: number) => Math.round(n * 100) / 100;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

// ── Built-in guesses ─────────────────────────────────────────────────────────────────────────
const NOTE_BUCKET: Record<string, string> = {
  fabric: 'Purchase Accounts', fabricadv: 'Purchase Accounts', purchase: 'Purchase Accounts',
  trims: 'Fabric and Consumbale', zipper: 'Fabric and Consumbale',
  cutting: 'Labour Charges', pcrate: 'Labour Charges', marker: 'Labour Charges',
  transport: 'FREIGHT INWARD NON GST', cleaning: 'Cleaning Expenses Factory',
  maintenance: 'Repair & Maintenance', servicing: 'Repair & Maintenance',
  machine: 'To confirm: machinery (asset)',
  software: 'Software Expenses', kwikchat: 'Software Expenses',
  velocity: 'Velocity wallet recharge',
  rent: 'Rent Expenses', rentneb: 'Rent Expenses', ebbill: 'Electricity Expenses',
  salary: 'Employee Benefit Expenses', fsalary: 'Employee Benefit Expenses', advance: 'To confirm: employee advance',
  card: 'To confirm: other',
};
// ── Who was paid, and what the owner wrote ───────────────────────────────────────────────────
const squash = (s: string) => s.replace(/\d+/g, '').replace(/@.*$/, '').replace(/[^a-z]/gi, '').toLowerCase();

/** The transfer type, the owner's note, and a key for the other party (digits and bank handles removed). */
export function parseRemarks(remarks: string): { type: string; note: string; payee: string | null } {
  const parts = remarks.split('/').map(p => p.trim());
  const type = (parts[0] || '').toUpperCase().split(/[-\s]/)[0];
  const clean = (s: string | undefined) => (s && squash(s) ? squash(s) : null);
  const plain = (s: string) => (/^(upi pay|upi|payment from phone|na)$/i.test(s) || /^[#\d]*$/.test(s) ? '' : s.toLowerCase());
  if (type === 'UPI') return { type, note: plain(parts[2] ?? ''), payee: clean(parts[3]) ?? clean(parts[2]) };
  if (type === 'MMT' || type === 'IMPS') return { type, note: plain(parts[3] ?? ''), payee: clean(parts[4]) };
  if (type === 'INF') {
    // The note and the name come in either order ("…/Salary /Asha" or "…/Asha/FSalary"): the known note word is the note.
    const [a, b] = [parts[parts.length - 2] ?? '', parts[parts.length - 1] ?? ''];
    const known = (x: string) => x.replace(/\s+/g, '').toLowerCase() in NOTE_BUCKET;
    return known(b) && !known(a) ? { type, note: plain(b), payee: clean(a) } : { type, note: plain(a), payee: clean(b) };
  }
  return { type, note: '', payee: null };
}

const has = (remarks: string, re: RegExp) => re.test(remarks);

const MERCHANTS: Array<[RegExp, string, string]> = [
  [/GOOGLE WORKSPACE|GSUITE/i, 'Software Expenses', 'Google Workspace subscription'],
  [/ANTHROPIC|OPENAI|CHATGPT|CLAUDE/i, 'Software Expenses', 'foreign software subscription (GST under reverse charge: ask the accountant)'],
  [/GOKWIK/i, 'PAYMENT GATEWAY CHARGES', 'GoKwik charge'],
  [/YOUTUBE|GOOGLE PLAY|AMAZON/i, 'To confirm: personal or business', 'could be a personal subscription'],
  [/SHOPIFY/i, 'Software Expenses', 'Shopify subscription'],
  [/UNICOMMERCE|UNIWARE/i, 'Software Expenses', 'Unicommerce subscription'],
  [/AIRTEL|JIO\b/i, 'Telephone & Internet Expenses', 'telephone / internet'],
  [/RAZORPAY/i, 'Customer receipts (other gateway)', 'Razorpay settlement'],
];

function result(c: Partial<Classification> & Pick<Classification, 'status' | 'kind' | 'reason'>, payee: string | null): Classification {
  const bucket = c.bucket ?? null;
  if (bucket && !BUCKET_NAMES.has(bucket)) throw new Error(`unknown bucket: ${bucket}`);
  return { bucket, match_ref: null, needs_bill: needsBill(bucket), payee, rule_id: null, ...c };
}

export function classify(lines: Line[], ctx: Ctx): Map<string, Classification> {
  const out = new Map<string, Classification>();
  const paired = new Set<string>();

  // 1. Pairs that cancel out. A bank return credit looks back for the payment it undoes; a card reversal for its charge.
  const byDay = [...lines].sort((a, b) => a.txn_date.localeCompare(b.txn_date));
  // A bank credit that says it is a return; a card credit among the purchases (a refund or reversal) that repeats a charge.
  const undoes = (l: Line) => l.credit > 0 && (l.account_kind === 'bank' ? has(l.remarks, /RETURN|REVERS/i) : l.section !== 'credit');
  for (const ret of byDay.filter(undoes)) {
    if (paired.has(ret.key)) continue;
    const other = byDay.find(d => d.debit > 0 && !paired.has(d.key) && near(d.debit, ret.credit)
      && dayNum(ret.txn_date) - dayNum(d.txn_date) >= 0 && dayNum(ret.txn_date) - dayNum(d.txn_date) <= 5
      && (ret.account_kind === 'bank' || d.remarks === ret.remarks));
    if (!other) continue;
    paired.add(ret.key); paired.add(other.key);
    const bank = ret.account_kind === 'bank';
    const kind = bank ? 'returned_payment' : 'reversed_charge';
    out.set(ret.key, result({ status: 'ignored', kind, bucket: 'Returned or reversed (no entry)', match_ref: other.key, reason: bank ? `The bank returned this on ${ret.txn_date}: it undoes the payment on ${other.txn_date}` : `Reversal of the charge on ${other.txn_date}` }, null));
    out.set(other.key, result({ status: 'ignored', kind, bucket: 'Returned or reversed (no entry)', match_ref: ret.key, reason: bank ? `Paid, then returned by the bank on ${ret.txn_date}: nets to zero, no entry` : `Charge reversed on ${ret.txn_date}: nets to zero, no entry` }, null));
  }

  const usedPayout = new Set<string>();
  const payoutFor = (source: Payout['source'], amount: number, date: string) => {
    const hit = ctx.payouts.filter(p => p.source === source && !usedPayout.has(p.utr) && near(p.amount, amount) && Math.abs(dayNum(p.date) - dayNum(date)) <= 3)
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(date)) - Math.abs(dayNum(b.date) - dayNum(date)))[0];
    if (hit) usedPayout.add(hit.utr);
    return hit;
  };

  // A wallet top-up Velocity's ledger shows, and the bank payment that funded it: same amount, within a day; one payment per top-up.
  const usedTopup = new Set<string>();
  const topupFor = (amount: number, date: string) => {
    const hit = (ctx.topups ?? []).filter(t => !usedTopup.has(t.key) && near(t.amount, amount) && Math.abs(dayNum(t.date) - dayNum(date)) <= 1)
      .sort((a, b) => Math.abs(dayNum(a.date) - dayNum(date)) - Math.abs(dayNum(b.date) - dayNum(date)))[0];
    if (hit) usedTopup.add(hit.key);
    return hit;
  };

  for (const l of lines) {
    if (out.has(l.key)) continue;
    const { note, payee } = l.account_kind === 'bank' ? parseRemarks(l.remarks) : { note: '', payee: squash(l.remarks.replace(/\(.*?\)/g, '')).slice(0, 24) || null };
    const done = (c: Classification) => { out.set(l.key, c); };

    // The founder's card: his own payment of the bill needs no company entry; every purchase is a company expense he paid.
    if (l.account_kind === 'card' && l.credit > 0 && /PAYMENT RECEIVED/i.test(l.remarks)) {
      done(result({ status: 'ignored', kind: 'card_payment', bucket: 'Founder card payment (no company entry)', reason: "The founder paid his card bill from his own account: no company entry. The purchases on the card are the company's expenses, owed to him until he is repaid" }, null));
      continue;
    }

    // 2. Proof from another system.
    if (l.account_kind === 'bank' && l.credit > 0 && has(l.remarks, /EASEBUZZ/i)) {
      const p = payoutFor('gokwik', l.credit, l.txn_date);
      done(p ? result({ status: 'matched', kind: 'gokwik_payout', bucket: 'GoKwik payout', match_ref: `UTR ${p.utr}`, reason: `GoKwik settled ${p.payments} payment${p.payments === 1 ? '' : 's'} (₹${p.amount.toFixed(2)}) in this transfer` }, null)
        : result({ status: 'suggested', kind: 'gokwik_payout', bucket: 'GoKwik payout', reason: 'An Easebuzz credit (GoKwik\'s payout) with no matching GoKwik settlement yet: upload the GoKwik report that covers it' }, null));
      continue;
    }
    if (l.account_kind === 'bank' && l.credit > 0 && has(l.remarks, /WHITE WIZARD/i)) {
      const p = payoutFor('velocity', l.credit, l.txn_date);
      done(p ? result({ status: 'matched', kind: 'velocity_remittance', bucket: 'Velocity COD remittance', match_ref: `UTR ${p.utr}`, reason: `Velocity paid ${p.payments} COD parcel${p.payments === 1 ? '' : 's'} (₹${p.amount.toFixed(2)}) in this transfer` }, null)
        : result({ status: 'suggested', kind: 'velocity_remittance', bucket: 'Velocity COD remittance', reason: 'A credit from Velocity (White Wizard Technologies) that no COD payout in the ledger accounts for' }, null));
      continue;
    }
    if (l.account_kind === 'bank' && l.debit > 0 && has(l.remarks, /FACEBOOK|META PLATFORMS/i)) {
      const no = (l.remarks.split('/').map(p => p.trim()).filter(p => /^\d{8,}$/.test(p)).pop()) ?? null;
      const inv = no ? ctx.invoices.find(i => i.invoice_no === no) : undefined;
      if (inv && near(inv.total, l.debit)) {
        done(result({ status: 'matched', kind: 'meta_invoice', bucket: 'Meta ads (invoice payment)', match_ref: `Invoice ${inv.invoice_no}`, reason: `Pays invoice ${inv.invoice_no}${inv.period ? ` (${inv.period})` : ''}: ₹${inv.subtotal.toFixed(2)} + GST ₹${inv.tax.toFixed(2)}. The full invoice total was paid: no TDS was deducted` }, null));
        continue;
      }
      if (inv && near(r2(inv.total - inv.subtotal * 0.02), l.debit, 0.05)) {
        done(result({ status: 'matched', kind: 'meta_invoice', bucket: 'Meta ads (invoice payment)', match_ref: `Invoice ${inv.invoice_no}`, reason: `Pays invoice ${inv.invoice_no} less 2% TDS of ₹${r2(inv.subtotal * 0.02).toFixed(2)}` }, null));
        continue;
      }
      done(result({ status: inv ? 'needs_review' : 'suggested', kind: 'meta_invoice', bucket: 'Meta ads (invoice payment)', match_ref: no ? `Invoice ${no}` : null,
        reason: inv ? `Invoice ${inv.invoice_no} is ₹${inv.total.toFixed(2)} but ₹${l.debit.toFixed(2)} was paid` : `A payment to Meta${no ? ` for invoice ${no}` : ''}: upload that invoice so it can be checked` }, null));
      continue;
    }

    if (l.account_kind === 'bank' && l.debit > 0 && VELOCITY_HANDLE.test(l.remarks)) {
      const t = topupFor(l.debit, l.txn_date);
      done(t ? result({ status: 'matched', kind: 'velocity_recharge', bucket: 'Velocity wallet recharge', match_ref: `Wallet recharge ${t.at}`, reason: `Velocity's wallet ledger shows ₹${t.amount.toFixed(2)} added on ${t.date}: this payment funded it` }, payee)
        : result({ status: 'suggested', kind: 'velocity_recharge', bucket: 'Velocity wallet recharge', reason: "A payment to a Velocity wallet handle with no matching top-up in Velocity's ledger yet: upload the ledger report that covers it" }, payee));
      continue;
    }

    // 3. The owner's own rules.
    const rule = ctx.rules.find(r => (r.match_type === 'payee' ? !!payee && payee === r.pattern : l.remarks.toLowerCase().includes(r.pattern.toLowerCase())) && BUCKET_NAMES.has(r.bucket));
    if (rule) {
      done(result({ status: 'matched', kind: 'rule', bucket: rule.bucket, reason: `Your rule: ${describeRule(rule)} go to ${rule.bucket}`, rule_id: rule.id }, payee));
      continue;
    }

    // 4. Built-in guesses.
    if (l.account_kind === 'bank') {
      const bucket = NOTE_BUCKET[note.replace(/\s+/g, '')];
      if (bucket) { done(result({ status: 'suggested', kind: 'note', bucket, reason: `You wrote "${note.trim()}" on this payment` }, payee)); continue; }
      const m = MERCHANTS.find(([re]) => re.test(l.remarks));
      if (m && (l.debit > 0 || /RAZORPAY/i.test(l.remarks))) { done(result({ status: 'suggested', kind: 'merchant', bucket: m[1], reason: m[2] }, payee)); continue; }
      if (l.debit > 0 && has(l.remarks, /\bchgs?\b|charges|^GIB\//i)) { done(result({ status: 'suggested', kind: 'bank_charge', bucket: 'Bank Charges GST', reason: 'Looks like a bank charge (or the GST on one)' }, payee)); continue; }
      if (l.credit > 0 && has(l.remarks, /^CAM\b.*CASH DEP|CASH DEP/i)) { done(result({ status: 'suggested', kind: 'cash_deposit', bucket: 'To confirm: cash deposit', reason: 'A cash deposit: what was the cash from?' }, payee)); continue; }
      if (l.credit > 0 && /^RTGS/i.test(l.remarks)) { done(result({ status: 'suggested', kind: 'rtgs_in', bucket: 'To confirm: capital or loan', reason: 'A large transfer in that is not a sale payout' }, payee)); continue; }
    } else {
      if (l.section === 'fee') { done(result({ status: 'suggested', kind: 'card_fee', bucket: 'Bank Charges GST', reason: 'GST or fee charged by the card issuer' }, payee)); continue; }
      const m = MERCHANTS.find(([re]) => re.test(l.remarks));
      if (m) { done(result({ status: 'suggested', kind: 'merchant', bucket: m[1], reason: m[2] }, payee)); continue; }
      if (l.category === 'Fuel') { done(result({ status: 'suggested', kind: 'category', bucket: 'Travelling Expenses', reason: 'Fuel: a business expense' }, payee)); continue; }
    }

    // 5. Nothing matched.
    done(result({ status: 'needs_review', kind: 'unknown', reason: 'No rule or note explains this line' }, payee));
  }
  return out;
}

// Wording for a learned rule in a reason line.
const describeRule = (r: Rule) => (r.match_type === 'payee' ? `payments to ${r.pattern}` : `lines containing "${r.pattern}"`);
