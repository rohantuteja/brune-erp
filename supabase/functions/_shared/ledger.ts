// Order ledger: the double-entry record of one Shopify order, from sale to
// return, built so that THE ORDER NETS TO ZERO whatever the other systems do.
// Pure rules, no network: callers feed in facts read from Shopify, Unicommerce,
// Velocity, GoKwik and Return Prime. Design: docs/accounting-ledger.md.
//
// The control account ("Customer (order control)") is debited for everything
// the customer owes (sale invoice, store credit issued, retained fees) and
// credited for everything that settles it (payment, courier collection, store
// credit used, credit notes). A finished order sums to zero.
//
// Unicommerce's return invoice can be short (a COD return-to-origin reverses the
// goods but not the COD charge) or, after a change on their side, too big; for
// orders from before 29 Sep it doesn't exist at all. The ledger compares what
// each document says with what the order requires and issues the difference
// itself ('erp' vouchers), so Tally always receives balanced orders. An order
// that still doesn't net to zero, or whose store credit differs from the
// customer's entitlement (a double credit), is an exception and is not exported.
//
// Amounts are rupees, tax-inclusive unless a field says otherwise. Dates are
// IST, YYYY-MM-DD. `cutoff` (accounting_start_date) splits the entries: those
// before it belong to months already closed in Tally and are never exported.

export const CUSTOMER = 'Customer (order control)';
// A Myntra order is owed by Myntra, not by the end customer: its control account is a receivable from Myntra.
export const MYNTRA = 'Myntra receivable (order control)';

export type Facts = {
  order: string;                  // Shopify order number; for a Myntra order, its Unicommerce invoice number
  channel?: 'shopify' | 'myntra'; // where the order came from (default shopify)
  channelRef?: string;            // Myntra: the Unicommerce order code
  rate: number;                   // GST rate, 0.05 for garments up to ₹2,500
  igst: boolean;                  // inter-state: IGST; otherwise CGST + SGST
  goods: number;                  // goods on the sale invoice, after discounts, tax-inclusive
  codFee: number;                 // COD charge on the sale invoice, tax-inclusive (0 if none)
  saleDate: string;               // the day the sale is booked: the Shopify order date (IST)
  invoiceDate?: string;           // the Unicommerce sale invoice's own date (absent when no invoice exists); the sale is NOT booked on it
  saleDoc?: string;               // Unicommerce sale invoice number
  delivered?: { date: string; amount: number; estimated?: boolean };   // courier collected this COD amount (estimated: the date is a guess)
  rtoOnTheWay?: { state: 'initiated' | 'in_transit'; since?: string };   // the courier is bringing the parcel back (not there yet)
  remitted?: { date: string; amount: number; utr: string }; // the courier paid that COD money into the bank (UTR)
  payments?: Array<{ date: string; amount: number; ref: string }>;   // prepaid money settled by the gateway
  storeCreditUsed?: Array<{ date: string; amount: number }>;         // store credit spent at checkout
  approved?: Array<{ kind: 'goodwill_credit'; amount: number; reason: string; by: string }>;   // decisions a person made (ledger_adjustments)
  returns?: Array<{
    kind: 'rto' | 'customer';
    date: string;                 // when the return invoice / credit note is dated
    goodsReturned: number;        // goods value coming back, tax-inclusive
    uc?: { doc: string; goods: number; codFee: number };   // Unicommerce's return invoice; absent = none exists
    storeCredit?: Array<{ date: string; amount: number; ref: string }>;   // credits issued (negative = taken back)
    returnFee?: number;           // return fee kept from the customer (₹99)
    cashRefund?: { date: string; amount: number };
    pending?: boolean;            // the parcel is not back yet: no credit note exists or is due; store credit is still checked
    refundedOn?: string;          // when the customer was refunded (shows how long a pending return has been waiting)
  }>;
};

export type Entry = {
  date: string; voucher: string; account: string; debit: number; credit: number;
  doc?: string; by: 'unicommerce' | 'erp' | 'shopify' | 'return_prime' | 'courier' | 'gateway';
  memo: string;
};
export type Balancing = { type: 'credit_note_goods' | 'credit_note_cod_fee' | 'retained_cod_fee_invoice' | 'return_fee_invoice'; amount: number; reason: string };
export type Exception = {
  type: 'store_credit_differs' | 'unexplained_residual' | 'awaiting_return' | 'in_transit' | 'rto_on_the_way' | 'refund_due' | 'remittance_overdue' | 'remittance_differs' | 'awaiting_settlement' | 'bad_facts';
  amount: number; reason: string;
};
// awaiting_return, in_transit and awaiting_settlement are normal stages of an order that is not finished yet.
const OPEN_STAGES = new Set<Exception['type']>(['awaiting_return', 'in_transit', 'rto_on_the_way', 'awaiting_settlement']);
export type OrderLedger = {
  entries: Entry[]; exportable: Entry[]; balancing: Balancing[]; exceptions: Exception[];
  net: number;          // whole life; must be 0
  opening: number;      // control balance carried in from before the cutoff
  balanced: boolean;    // net is zero and no exceptions: safe to export
  codOpen: number;      // COD collected by the courier and not yet paid into the bank
  status: 'complete' | 'open' | 'attention';   // open = still travelling, attention = a person must look
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const sumOf = (xs?: Array<{ amount: number }>) => (xs ?? []).reduce((a, x) => a + x.amount, 0);
// Delivered this long ago with no remittance: a courier or cash problem to chase.
const REMITTANCE_OVERDUE_DAYS = 10;
const split = (amount: number, rate: number) => { const taxable = r2(amount / (1 + rate)); return { taxable, tax: r2(amount - taxable) }; };

export function buildOrderLedger(f: Facts, opts: { cutoff: string; today?: string }): OrderLedger {
  const ctrl = f.channel === 'myntra' ? MYNTRA : CUSTOMER;      // the account that must net to zero
  const entries: Entry[] = [];
  const balancing: Balancing[] = [];
  const exceptions: Exception[] = [];

  // One voucher = lines that balance. GST lines follow the order's tax type.
  type Line = [account: string, debit: number, credit: number];
  const voucher = (date: string, kind: string, by: Entry['by'], doc: string | undefined, memo: string, lines: Line[]) => {
    const dr = r2(lines.reduce((s, l) => s + l[1], 0));
    const cr = r2(lines.reduce((s, l) => s + l[2], 0));
    if (Math.abs(dr - cr) > 0.005) throw new Error(`${f.order}: ${kind} voucher is unbalanced (${dr} vs ${cr})`);
    for (const [account, debit, credit] of lines) {
      if (debit || credit) entries.push({ date, voucher: kind, account, debit: r2(debit), credit: r2(credit), doc, by, memo });
    }
  };
  const gst = (tax: number, side: 'debit' | 'credit', kind: 'output'): Line[] => {
    if (!tax) return [];
    const put = (name: string, amt: number): Line => side === 'debit' ? [name, amt, 0] : [name, 0, amt];
    if (f.igst) return [put(`${kind === 'output' ? 'Output' : 'Input'} IGST`, tax)];
    const half = r2(tax / 2);
    return [put('Output CGST', half), put('Output SGST', r2(tax - half))];
  };
  const parts = (goods: number, cod: number) => ({ g: split(goods, f.rate), c: split(cod, f.rate) });
  // The customer got more than they were due and a person approved exactly that extra (a goodwill credit).
  const approvedExtra = (extra: number) => (f.approved ?? []).find(a => a.kind === 'goodwill_credit' && Math.abs(a.amount - extra) <= 0.01);
  const bookGoodwill = (date: string, tag: string, extra: number, a: { reason: string; by: string }) =>
    voucher(date, 'goodwill', 'erp', undefined, `${tag}: extra store credit of ${extra.toFixed(2)} approved by ${a.by}: ${a.reason}`,
      [['Goodwill credits', extra, 0], [ctrl, 0, extra]]);

  if (f.goods < 0 || f.codFee < 0 || !(f.rate >= 0)) {
    return { entries, exportable: [], balancing, exceptions: [{ type: 'bad_facts', amount: 0, reason: 'negative amounts or rate' }], net: 0, opening: 0, balanced: false, codOpen: 0, status: 'attention' };
  }

  // Sale invoice
  {
    const p = parts(f.goods, f.codFee);
    voucher(f.saleDate, 'sale', f.saleDoc ? 'unicommerce' : 'shopify', f.saleDoc, `sale ${f.order}`, [
      [ctrl, r2(f.goods + f.codFee), 0],
      ['Sales', 0, p.g.taxable], ['COD charge income', 0, p.c.taxable],
      ...gst(r2(p.g.tax + p.c.tax), 'credit', 'output'),
    ]);
  }
  // Settlements of what the customer owes
  if (f.delivered) {
    voucher(f.delivered.date, 'delivery', 'courier', undefined, 'COD collected by the courier', [
      ['COD receivable (Velocity)', f.delivered.amount, 0], [ctrl, 0, f.delivered.amount]]);
  }
  if (f.delivered && f.remitted) {
    voucher(f.remitted.date, 'remittance', 'courier', f.remitted.utr, 'COD paid into the bank by the courier (UTR)', [
      ['Bank', f.remitted.amount, 0], ['COD receivable (Velocity)', 0, f.remitted.amount]]);
  }
  for (const p of f.payments ?? []) {
    voucher(p.date, 'payment', 'gateway', p.ref, 'prepaid payment', [['Gateway clearing', p.amount, 0], [ctrl, 0, p.amount]]);
  }
  for (const s of f.storeCreditUsed ?? []) {
    voucher(s.date, 'store_credit_used', 'shopify', undefined, 'store credit spent at checkout', [['Store credit liability', s.amount, 0], [ctrl, 0, s.amount]]);
  }

  // Returns
  for (const [i, ret] of (f.returns ?? []).entries()) {
    const tag = `return ${i + 1} (${ret.kind})`;
    const fullReturn = ret.kind === 'rto';                      // never delivered: the whole sale ends
    const ucGoods = ret.uc?.goods ?? 0;
    const ucCod = ret.uc?.codFee ?? 0;

    // Credit notes and fees are due once the parcel is back (a pending return has none yet).
    if (!ret.pending) {
      if (ret.uc) {
        const p = parts(ucGoods, ucCod);
        voucher(ret.date, 'credit_note', 'unicommerce', ret.uc.doc, `${tag}: Unicommerce return invoice`, [
          ['Sales returns', p.g.taxable, 0], ['COD charge income', p.c.taxable, 0],
          ...gst(r2(p.g.tax + p.c.tax), 'debit', 'output'),
          [ctrl, 0, r2(ucGoods + ucCod)],
        ]);
      }
      // What the order requires of its credit notes, and what is missing or extra.
      const needGoods = ret.goodsReturned;
      if (r2(needGoods - ucGoods) > 0.005) {
        const amt = r2(needGoods - ucGoods);
        const p = split(amt, f.rate);
        balancing.push({ type: 'credit_note_goods', amount: amt, reason: ret.uc ? `Unicommerce's return invoice covers ${ucGoods.toFixed(2)} of ${needGoods.toFixed(2)} goods` : 'no Unicommerce return invoice exists for this order' });
        voucher(ret.date, 'credit_note', 'erp', undefined, `${tag}: credit note for goods`, [
          ['Sales returns', p.taxable, 0], ...gst(p.tax, 'debit', 'output'), [ctrl, 0, amt]]);
      }
      if (fullReturn && r2(f.codFee - ucCod) > 0.005) {
        const amt = r2(f.codFee - ucCod);
        const p = split(amt, f.rate);
        balancing.push({ type: 'credit_note_cod_fee', amount: amt, reason: 'returned to origin: the COD charge was never collected, so it is reversed too' });
        voucher(ret.date, 'credit_note', 'erp', undefined, `${tag}: credit note for the COD charge`, [
          ['COD charge income', p.taxable, 0], ...gst(p.tax, 'debit', 'output'), [ctrl, 0, amt]]);
      }
      if (!fullReturn && ucCod > 0.005) {
        // The customer paid the COD charge and it is kept: bill it back.
        const p = split(ucCod, f.rate);
        balancing.push({ type: 'retained_cod_fee_invoice', amount: ucCod, reason: "the return invoice reversed the COD charge, but the customer paid it and it is kept" });
        voucher(ret.date, 'invoice', 'erp', undefined, `${tag}: retained COD charge`, [
          [ctrl, ucCod, 0], ['COD charge income', 0, p.taxable], ...gst(p.tax, 'credit', 'output')]);
      }
      // Return fee kept from the customer: Unicommerce never invoices it
      if (ret.returnFee && ret.returnFee > 0) {
        const p = split(ret.returnFee, f.rate);
        balancing.push({ type: 'return_fee_invoice', amount: ret.returnFee, reason: 'return fee kept from the customer' });
        voucher(ret.date, 'invoice', 'erp', undefined, `${tag}: return fee`, [
          [ctrl, ret.returnFee, 0], ['Return fee income', 0, p.taxable], ...gst(p.tax, 'credit', 'output')]);
      }
    }
    // Store credit actually issued (and anything taken back)
    let issued = 0;
    for (const c of ret.storeCredit ?? []) {
      issued = r2(issued + c.amount);
      voucher(c.date, 'store_credit', 'return_prime', c.ref, `${tag}: store credit ${c.amount < 0 ? 'taken back' : 'issued'}`,
        c.amount >= 0 ? [[ctrl, c.amount, 0], ['Store credit liability', 0, c.amount]] : [['Store credit liability', -c.amount, 0], [ctrl, 0, -c.amount]]);
    }
    if (ret.cashRefund) {
      voucher(ret.cashRefund.date, 'refund', 'gateway', undefined, `${tag}: cash refund`, [[ctrl, ret.cashRefund.amount, 0], ['Bank', 0, ret.cashRefund.amount]]);
    }
    // A parcel returned to origin pays back everything the customer paid (prepaid money, a part-payment,
    // store credit spent). A person rounds a manual credit, so a difference under a rupee goes to Round off.
    if (ret.kind === 'rto' && (ret.storeCredit?.length || ret.cashRefund)) {
      const entitled = r2(sumOf(f.payments) + sumOf(f.storeCreditUsed));
      const got = r2(issued + (ret.cashRefund?.amount ?? 0));
      const diff = r2(got - entitled);
      const ok = diff > 1.005 ? approvedExtra(diff) : undefined;
      if (ok) {
        bookGoodwill(ret.storeCredit?.[ret.storeCredit.length - 1]?.date ?? ret.date, tag, diff, ok);
      } else if (Math.abs(diff) > 1.005) {
        exceptions.push({ type: 'store_credit_differs', amount: diff,
          reason: `${got.toFixed(2)} was credited or refunded but the customer paid ${entitled.toFixed(2)}, ${Math.abs(diff).toFixed(2)} ${diff > 0 ? 'more' : 'less'}` });
      } else if (Math.abs(diff) > 0.005) {
        const when = ret.storeCredit?.[ret.storeCredit.length - 1]?.date ?? ret.date;
        voucher(when, 'round_off', 'erp', undefined, `${tag}: store credit differs from what was paid by ${Math.abs(diff).toFixed(2)}`,
          diff > 0 ? [['Round off', diff, 0], [ctrl, 0, diff]] : [[ctrl, -diff, 0], ['Round off', 0, -diff]]);
      }
    }
    // A customer return pays back what was paid for the goods, less the return fee.
    if (ret.kind === 'customer' && (ret.storeCredit?.length || ret.cashRefund)) {
      const entitled = r2(ret.goodsReturned - (ret.returnFee ?? 0));
      const got = r2(issued + (ret.cashRefund?.amount ?? 0));
      const extra = r2(got - entitled);
      const ok = extra > 0.01 ? approvedExtra(extra) : undefined;
      if (ok) {
        bookGoodwill(ret.storeCredit?.[ret.storeCredit.length - 1]?.date ?? ret.date, tag, extra, ok);
      } else if (Math.abs(got - entitled) > 0.01) {
        exceptions.push({ type: 'store_credit_differs', amount: r2(got - entitled),
          reason: `${got.toFixed(2)} was credited or refunded but the customer is entitled to ${entitled.toFixed(2)} (goods ${ret.goodsReturned.toFixed(2)} less fee ${(ret.returnFee ?? 0).toFixed(2)})` });
      }
    }
  }

  // Does the order net to zero?
  const net = r2(entries.filter(e => e.account === ctrl).reduce((s, e) => s + e.debit - e.credit, 0));
  if (Math.abs(net) > 0.01 && !exceptions.length) {
    const waiting = (f.returns ?? []).filter(r => r.pending);
    if (waiting.length) {
      const days = Math.max(0, ...waiting.map(r => r.refundedOn && opts.today ? Math.round((Date.parse(opts.today) - Date.parse(r.refundedOn)) / 86_400_000) : 0));
      exceptions.push({ type: 'awaiting_return', amount: net,
        reason: `waiting for the returned parcel${days >= 1 ? ` (customer refunded ${days} day${days === 1 ? '' : 's'} ago)` : ''}; credit notes are issued once it is back` });
    } else if (net < 0 && (f.returns ?? []).some(r => r.kind === 'rto')) {
      // The parcel came back and the sale is reversed, but nothing was given back to the customer.
      exceptions.push({ type: 'refund_due', amount: net, reason: `the parcel was returned to origin and the sale reversed, but the customer's payment of ${Math.abs(net).toFixed(2)} has not been refunded or credited` });
    } else if (net > 0 && f.rtoOnTheWay && !(f.returns ?? []).length && !f.delivered) {
      // Never delivered and on its way back: nothing will be collected. It ends as a return to origin.
      const days = f.rtoOnTheWay.since && opts.today ? Math.max(0, Math.round((Date.parse(opts.today) - Date.parse(f.rtoOnTheWay.since)) / 86_400_000)) : 0;
      exceptions.push({ type: 'rto_on_the_way', amount: net,
        reason: `returning to origin (${f.rtoOnTheWay.state === 'initiated' ? 'RTO initiated' : 'RTO in transit'}${f.rtoOnTheWay.since ? ` ${days} day${days === 1 ? '' : 's'} ago` : ''}); the sale is reversed when the parcel is back` });
    } else if (net > 0 && f.channel === 'myntra') {
      // Myntra pays about 15 days after delivery, net of its fees, TCS and TDS: until that settlement is matched the sale is owed.
      exceptions.push({ type: 'awaiting_settlement', amount: net, reason: `Myntra owes ${net.toFixed(2)} for this sale: it has not paid yet (Myntra pays about 15 days after delivery, net of its fees, TCS and TDS)` });
    } else if (net > 0 && f.codFee > 0 && !(f.returns ?? []).length && !f.delivered) {
      const days = opts.today ? Math.max(0, Math.round((Date.parse(opts.today) - Date.parse(f.invoiceDate ?? f.saleDate)) / 86_400_000)) : 0;   // counted from the invoice (dispatch), not the order
      exceptions.push({ type: 'in_transit', amount: net, reason: `COD parcel not delivered yet, invoiced ${days} day${days === 1 ? '' : 's'} ago${days > 15 ? ' (long overdue: check with the courier)' : ''}` });
    } else {
      exceptions.push({ type: 'unexplained_residual', amount: net, reason: `the order is ${net > 0 ? 'owed' : 'over-settled'} by ${Math.abs(net).toFixed(2)}: a payment, return or credit is missing` });
    }
  }
  // The courier's money: what it collected must reach the bank, in full, within a few days.
  const codOpen = r2(entries.filter(e => e.account === 'COD receivable (Velocity)').reduce((a, e) => a + e.debit - e.credit, 0));
  if (f.delivered && f.remitted && Math.abs(f.remitted.amount - f.delivered.amount) > 0.01) {
    exceptions.push({ type: 'remittance_differs', amount: r2(f.remitted.amount - f.delivered.amount),
      reason: `Velocity paid ${f.remitted.amount.toFixed(2)} (UTR ${f.remitted.utr}) for COD of ${f.delivered.amount.toFixed(2)}` });
  } else if (f.delivered && !f.delivered.estimated && !f.remitted && opts.today) {
    const days = Math.round((Date.parse(opts.today) - Date.parse(f.delivered.date)) / 86_400_000);
    if (days > REMITTANCE_OVERDUE_DAYS) {
      exceptions.push({ type: 'remittance_overdue', amount: codOpen,
        reason: `delivered ${days} days ago and Velocity has not paid the ${codOpen.toFixed(2)} COD yet` });
    }
  }
  const exportable = entries.filter(e => e.date >= opts.cutoff);
  const opening = r2(entries.filter(e => e.date < opts.cutoff && e.account === ctrl).reduce((s, e) => s + e.debit - e.credit, 0));
  const balanced = Math.abs(net) <= 0.01 && !exceptions.length;
  const status = balanced ? 'complete' : exceptions.every(e => OPEN_STAGES.has(e.type)) ? 'open' : 'attention';
  return { entries, exportable, balancing, exceptions, net, opening, balanced, codOpen, status };
}
