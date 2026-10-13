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

import { VELOCITY_HANDLE, VELOCITY_RECHARGE_BUCKET, type TopUp } from './velocity-ledger.ts';

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

// A bucket IS a Tally ledger: its name is the ledger's name, so the Tally file needs no mapping (owner's decision,
// 14 Oct 2026; the list is his tally-names-proposed.xlsx, spelling included: "Consumbale", "Miscelleneous", "Signapore").
// Where one old bucket became several ledgers (salary, rent, software, telephone, travelling) the owner picks the
// right one per payee. Three names are not ledgers: the two that need no entry, and `Purchase Accounts` (a Tally
// group, kept by the owner's decision of 14 Oct 2026 as the bucket for fabric and supplier-bill payments; the
// supplier's own ledger is linked per payee when the Tally file is built).
export const PURCHASE_BUCKET = 'Purchase Accounts';
export const RETURNED_BUCKET = 'Returned or reversed (no entry)';
export const FOUNDER_CARD_BUCKET = 'Founder card payment (no company entry)';
// The ledgers the order ledger posts to as well (ledger.ts): a payout is the same ledger on both sides.
export const GATEWAY_BUCKET = 'Easebuzz Private Limited';                    // GoKwik pays through Easebuzz
export const COD_BUCKET = 'COD receivable (Velocity)';                         // Velocity's COD remittances
export const RAZORPAY_BUCKET = 'Razorpay Payment Private Limited';
export const META_BUCKET = 'Facebook India Online Services Private Limited';
export const MYNTRA_BUCKET = 'Myntra receivable (order control)';              // Myntra's payouts: what it collected for us
export const SUSPENSE_BUCKET = 'Suspense';                                     // parked until a person decides

export const BUCKETS: Bucket[] = [
  { name: 'Marketing Expenses', kind: 'expense', needs_bill: true, note: 'Advertising other than Meta' },
  { name: 'Salary Payable', kind: 'liability', needs_bill: false, note: 'Staff salary: the expense is your month-end journal, each payment settles it' },
  { name: 'Director Salary Payable- Rohan Tuteja', kind: 'liability', needs_bill: false, note: '₹50,000 a month' },
  { name: 'Director Salary Payable- Adrija Halder', kind: 'liability', needs_bill: false, note: '₹50,000 a month' },
  { name: 'Staff Welfare Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Labour Charges', kind: 'expense', needs_bill: false, note: 'Karigar piece-rate, cutting, marker' },
  { name: 'Rent Payable', kind: 'liability', needs_bill: false, note: 'Rent to the Sector 63 landlord: the expense is your month-end journal to Rent Sector 63 Noida' },
  { name: 'Rent - Director Resident', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Software Expenses @ 18%', kind: 'expense', needs_bill: true, note: 'Software with a GST invoice' },
  { name: 'Software Expenses', kind: 'expense', needs_bill: false, note: 'No GST invoice, or foreign (ChatGPT, Claude)' },
  { name: 'Subscription Charges', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Apps Charges', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Payment Gateway Expenses', kind: 'expense', needs_bill: true, note: 'Only fees paid outside a GoKwik payout; payout fees come from the order ledger' },
  { name: 'Shipping Expenses @ 18%', kind: 'expense', needs_bill: true, note: '' },
  { name: 'Fabric and Consumbale', kind: 'expense', needs_bill: false, note: 'Petty fabric, trims, zippers under ₹5,000' },
  { name: 'Packaging Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Travelling Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Car Fuel Expenses', kind: 'expense', needs_bill: false, note: 'Fuel' },
  { name: 'CAR SERVICE EXPENSES', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Repair & Maintenance', kind: 'expense', needs_bill: false, note: '' },
  { name: 'MAINTENANCE-DIR RESIDENCE', kind: 'expense', needs_bill: false, note: '' },
  { name: 'FREIGHT INWARD NON GST', kind: 'expense', needs_bill: false, note: 'Transport and porter' },
  { name: 'Cleaning Expenses Factory', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Electricity Expenses', kind: 'expense', needs_bill: false, note: '' },
  { name: 'Telephone and Internet Expenses GST', kind: 'expense', needs_bill: true, note: 'With a GST bill' },
  { name: 'Telephone & Internet Expenses', kind: 'expense', needs_bill: false, note: 'Without GST' },
  { name: 'Bank Charges', kind: 'expense', needs_bill: false, note: 'Bank and card charges, GST included' },
  { name: 'FINANCE COST', kind: 'expense', needs_bill: false, note: 'Interest and other finance costs' },
  { name: 'Miscelleneous Expenses', kind: 'expense', needs_bill: false, note: 'Spelled as in Tally today' },
  { name: PURCHASE_BUCKET, kind: 'expense', needs_bill: true, note: 'Fabric purchases and supplier bills of ₹5,000 and over: needs the supplier bill, and this payment settles it' },
  { name: GATEWAY_BUCKET, kind: 'transfer', needs_bill: false, note: 'GoKwik payout: the receipt comes from the order ledger, one per payout; the bank line only proves it' },
  { name: COD_BUCKET, kind: 'transfer', needs_bill: false, note: 'Velocity COD remittance: the receipt comes from the order ledger, one per payout; the bank line only proves it' },
  { name: RAZORPAY_BUCKET, kind: 'transfer', needs_bill: false, note: 'Customer receipts through another gateway: the receipt comes from the order ledger' },
  { name: MYNTRA_BUCKET, kind: 'transfer', needs_bill: false, note: "Myntra's payouts: the money Myntra collected for us, paid net of its fees, TCS and TDS; the receipt comes from the order ledger" },
  { name: VELOCITY_RECHARGE_BUCKET, kind: 'asset', needs_bill: false, note: 'Wallet top-up: an advance, used up by freight charges' },
  { name: META_BUCKET, kind: 'liability', needs_bill: false, note: 'Settles the Meta invoice by its number' },
  { name: 'Shopify Commerce Signapore Pte. Ltd.', kind: 'liability', needs_bill: false, note: 'Shopify subscription' },
  { name: 'Goexcelsior Private Limited', kind: 'liability', needs_bill: true, note: 'KwikChat; also the card item that reads GoKwik' },
  { name: RETURNED_BUCKET, kind: 'ignore', needs_bill: false, note: 'A payment the bank returned, or a card charge reversed: nets to zero' },
  { name: FOUNDER_CARD_BUCKET, kind: 'ignore', needs_bill: false, note: 'The founder paying his own card bill' },
  { name: 'CASH AT POS DELHI', kind: 'transfer', needs_bill: false, note: 'Cash deposited (your wholesale vertical): Dr ICICI Bank / Cr this ledger' },
  { name: 'Sewing Machine GST', kind: 'asset', needs_bill: true, note: 'A machine is a fixed asset. Other machines need their own ledger: tell me which' },
  { name: SUSPENSE_BUCKET, kind: 'review', needs_bill: false, note: 'Parked until a person decides (Unsecured Loans From Directors when it is a director)' },
];
const BUCKET_NAMES = new Set(BUCKETS.map(b => b.name));
export const needsBill = (bucket: string | null) => !!bucket && !!BUCKETS.find(b => b.name === bucket)?.needs_bill;

const r2 = (n: number) => Math.round(n * 100) / 100;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

// ── Built-in guesses ─────────────────────────────────────────────────────────────────────────
export const NOTE_BUCKET: Record<string, string> = {
  fabric: PURCHASE_BUCKET, fabricadv: PURCHASE_BUCKET, purchase: PURCHASE_BUCKET,
  trims: 'Fabric and Consumbale', zipper: 'Fabric and Consumbale',
  cutting: 'Labour Charges', pcrate: 'Labour Charges', marker: 'Labour Charges',
  transport: 'FREIGHT INWARD NON GST', cleaning: 'Cleaning Expenses Factory',
  maintenance: 'Repair & Maintenance', servicing: 'Repair & Maintenance',
  machine: 'Sewing Machine GST',
  software: 'Software Expenses @ 18%', kwikchat: 'Goexcelsior Private Limited',
  velocity: VELOCITY_RECHARGE_BUCKET,
  rent: 'Rent Payable', rentneb: 'Rent Payable', ebbill: 'Electricity Expenses',
  salary: 'Salary Payable', fsalary: 'Salary Payable', advance: SUSPENSE_BUCKET,
  card: SUSPENSE_BUCKET,
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

// [pattern, bucket, why, only]: `only` limits a guess to the bank or to the card.
export const MERCHANTS: Array<[RegExp, string, string, ('bank' | 'card')?]> = [
  [/GOOGLE WORKSPACE|GSUITE/i, 'Software Expenses @ 18%', 'Google Workspace subscription'],
  [/ANTHROPIC|OPENAI|CHATGPT|CLAUDE/i, 'Software Expenses', 'foreign software subscription (no GST invoice)'],
  [/GOKWIK/i, 'Goexcelsior Private Limited', 'KwikChat, billed by Goexcelsior Private Limited', 'card'],
  [/GOKWIK/i, 'Payment Gateway Expenses', 'GoKwik charge', 'bank'],
  [/YOUTUBE|GOOGLE PLAY/i, SUSPENSE_BUCKET, 'could be a personal subscription: your September journal leaves YouTube and Google Play out'],
  [/AMAZON/i, 'Subscription Charges', 'Amazon: a business subscription, as in your September journal'],
  [/SHOPIFY/i, 'Shopify Commerce Signapore Pte. Ltd.', 'Shopify subscription'],
  [/UNICOMMERCE|UNIWARE/i, 'Software Expenses @ 18%', 'Unicommerce subscription'],
  [/AIRTEL|JIO\b/i, 'Telephone and Internet Expenses GST', 'telephone / internet'],
  [/RAZORPAY/i, RAZORPAY_BUCKET, 'Razorpay settlement'],
];
const merchantFor = (remarks: string, account: 'bank' | 'card') => MERCHANTS.find(([re, , , only]) => re.test(remarks) && (!only || only === account));

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
    out.set(ret.key, result({ status: 'ignored', kind, bucket: RETURNED_BUCKET, match_ref: other.key, reason: bank ? `The bank returned this on ${ret.txn_date}: it undoes the payment on ${other.txn_date}` : `Reversal of the charge on ${other.txn_date}` }, null));
    out.set(other.key, result({ status: 'ignored', kind, bucket: RETURNED_BUCKET, match_ref: ret.key, reason: bank ? `Paid, then returned by the bank on ${ret.txn_date}: nets to zero, no entry` : `Charge reversed on ${ret.txn_date}: nets to zero, no entry` }, null));
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
      done(result({ status: 'ignored', kind: 'card_payment', bucket: FOUNDER_CARD_BUCKET, reason: "The founder paid his card bill from his own account: no company entry. The purchases on the card are the company's expenses, owed to him until he is repaid" }, null));
      continue;
    }

    // 2. Proof from another system.
    if (l.account_kind === 'bank' && l.credit > 0 && has(l.remarks, /EASEBUZZ/i)) {
      const p = payoutFor('gokwik', l.credit, l.txn_date);
      done(p ? result({ status: 'matched', kind: 'gokwik_payout', bucket: GATEWAY_BUCKET, match_ref: `UTR ${p.utr}`, reason: `GoKwik settled ${p.payments} payment${p.payments === 1 ? '' : 's'} (₹${p.amount.toFixed(2)}) in this transfer` }, null)
        : result({ status: 'suggested', kind: 'gokwik_payout', bucket: GATEWAY_BUCKET, reason: 'An Easebuzz credit (GoKwik\'s payout) with no matching GoKwik settlement yet: upload the GoKwik report that covers it' }, null));
      continue;
    }
    if (l.account_kind === 'bank' && l.credit > 0 && has(l.remarks, /WHITE WIZARD/i)) {
      const p = payoutFor('velocity', l.credit, l.txn_date);
      done(p ? result({ status: 'matched', kind: 'velocity_remittance', bucket: COD_BUCKET, match_ref: `UTR ${p.utr}`, reason: `Velocity paid ${p.payments} COD parcel${p.payments === 1 ? '' : 's'} (₹${p.amount.toFixed(2)}) in this transfer` }, null)
        : result({ status: 'suggested', kind: 'velocity_remittance', bucket: COD_BUCKET, reason: 'A credit from Velocity (White Wizard Technologies) that no COD payout in the ledger accounts for' }, null));
      continue;
    }
    if (l.account_kind === 'bank' && l.debit > 0 && has(l.remarks, /FACEBOOK|META PLATFORMS/i)) {
      const no = (l.remarks.split('/').map(p => p.trim()).filter(p => /^\d{8,}$/.test(p)).pop()) ?? null;
      const inv = no ? ctx.invoices.find(i => i.invoice_no === no) : undefined;
      if (inv && near(inv.total, l.debit)) {
        done(result({ status: 'matched', kind: 'meta_invoice', bucket: META_BUCKET, match_ref: `Invoice ${inv.invoice_no}`, reason: `Pays invoice ${inv.invoice_no}${inv.period ? ` (${inv.period})` : ''}: ₹${inv.subtotal.toFixed(2)} + GST ₹${inv.tax.toFixed(2)}. The full invoice total was paid: no TDS was deducted` }, null));
        continue;
      }
      if (inv && near(r2(inv.total - inv.subtotal * 0.02), l.debit, 0.05)) {
        done(result({ status: 'matched', kind: 'meta_invoice', bucket: META_BUCKET, match_ref: `Invoice ${inv.invoice_no}`, reason: `Pays invoice ${inv.invoice_no} less 2% TDS of ₹${r2(inv.subtotal * 0.02).toFixed(2)}` }, null));
        continue;
      }
      done(result({ status: inv ? 'needs_review' : 'suggested', kind: 'meta_invoice', bucket: META_BUCKET, match_ref: no ? `Invoice ${no}` : null,
        reason: inv ? `Invoice ${inv.invoice_no} is ₹${inv.total.toFixed(2)} but ₹${l.debit.toFixed(2)} was paid` : `A payment to Meta${no ? ` for invoice ${no}` : ''}: upload that invoice so it can be checked` }, null));
      continue;
    }

    if (l.account_kind === 'bank' && l.debit > 0 && VELOCITY_HANDLE.test(l.remarks)) {
      const t = topupFor(l.debit, l.txn_date);
      done(t ? result({ status: 'matched', kind: 'velocity_recharge', bucket: VELOCITY_RECHARGE_BUCKET, match_ref: `Wallet recharge ${t.at}`, reason: `Velocity's wallet ledger shows ₹${t.amount.toFixed(2)} added on ${t.date}: this payment funded it` }, payee)
        : result({ status: 'suggested', kind: 'velocity_recharge', bucket: VELOCITY_RECHARGE_BUCKET, reason: "A payment to a Velocity wallet handle with no matching top-up in Velocity's ledger yet: upload the ledger report that covers it" }, payee));
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
      const m = merchantFor(l.remarks, 'bank');
      if (m && (l.debit > 0 || /RAZORPAY/i.test(l.remarks))) { done(result({ status: 'suggested', kind: 'merchant', bucket: m[1], reason: m[2] }, payee)); continue; }
      if (l.debit > 0 && has(l.remarks, /\bchgs?\b|charges|^GIB\//i)) { done(result({ status: 'suggested', kind: 'bank_charge', bucket: 'Bank Charges', reason: 'Looks like a bank charge (or the GST on one)' }, payee)); continue; }
      if (l.credit > 0 && has(l.remarks, /^CAM\b.*CASH DEP|CASH DEP/i)) { done(result({ status: 'suggested', kind: 'cash_deposit', bucket: 'CASH AT POS DELHI', reason: 'A cash deposit: what was the cash from?' }, payee)); continue; }
      if (l.credit > 0 && /^RTGS/i.test(l.remarks)) { done(result({ status: 'suggested', kind: 'rtgs_in', bucket: SUSPENSE_BUCKET, reason: 'A large transfer in that is not a sale payout' }, payee)); continue; }
    } else {
      if (l.section === 'fee') { done(result({ status: 'suggested', kind: 'card_fee', bucket: 'Bank Charges', reason: 'GST or fee charged by the card issuer' }, payee)); continue; }
      const m = merchantFor(l.remarks, 'card');
      if (m) { done(result({ status: 'suggested', kind: 'merchant', bucket: m[1], reason: m[2] }, payee)); continue; }
      if (l.category === 'Fuel') { done(result({ status: 'suggested', kind: 'category', bucket: 'Car Fuel Expenses', reason: 'Fuel: a business expense' }, payee)); continue; }
    }

    // 5. Nothing matched.
    done(result({ status: 'needs_review', kind: 'unknown', reason: 'No rule or note explains this line' }, payee));
  }
  return out;
}

// Wording for a learned rule in a reason line.
const describeRule = (r: Rule) => (r.match_type === 'payee' ? `payments to ${r.pattern}` : `lines containing "${r.pattern}"`);
