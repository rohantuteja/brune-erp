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

export type Facts = {
  order: string;                  // Shopify order number
  rate: number;                   // GST rate, 0.05 for garments up to ₹2,500
  igst: boolean;                  // inter-state: IGST; otherwise CGST + SGST
  goods: number;                  // goods on the sale invoice, after discounts, tax-inclusive
  codFee: number;                 // COD charge on the sale invoice, tax-inclusive (0 if none)
  saleDate: string;               // sale invoice date (the order date when no invoice exists)
  saleDoc?: string;               // Unicommerce sale invoice number
  delivered?: { date: string; amount: number };            // courier collected this COD amount
  payments?: Array<{ date: string; amount: number; ref: string }>;   // prepaid money settled by the gateway
  storeCreditUsed?: Array<{ date: string; amount: number }>;         // store credit spent at checkout
  returns?: Array<{
    kind: 'rto' | 'customer';
    date: string;                 // when the return invoice / credit note is dated
    goodsReturned: number;        // goods value coming back, tax-inclusive
    uc?: { doc: string; goods: number; codFee: number };   // Unicommerce's return invoice; absent = none exists
    storeCredit?: Array<{ date: string; amount: number; ref: string }>;   // credits issued (negative = taken back)
    returnFee?: number;           // return fee kept from the customer (₹99)
    cashRefund?: { date: string; amount: number };
  }>;
};

export type Entry = {
  date: string; voucher: string; account: string; debit: number; credit: number;
  doc?: string; by: 'unicommerce' | 'erp' | 'shopify' | 'return_prime' | 'courier' | 'gateway';
  memo: string;
};
export type Balancing = { type: 'credit_note_goods' | 'credit_note_cod_fee' | 'retained_cod_fee_invoice' | 'return_fee_invoice'; amount: number; reason: string };
export type Exception = { type: 'store_credit_differs' | 'unexplained_residual' | 'bad_facts'; amount: number; reason: string };
export type OrderLedger = {
  entries: Entry[]; exportable: Entry[]; balancing: Balancing[]; exceptions: Exception[];
  net: number;          // whole life; must be 0
  opening: number;      // control balance carried in from before the cutoff
  balanced: boolean;    // net is zero and no exceptions: safe to export
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const split = (amount: number, rate: number) => { const taxable = r2(amount / (1 + rate)); return { taxable, tax: r2(amount - taxable) }; };

export function buildOrderLedger(f: Facts, opts: { cutoff: string }): OrderLedger {
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

  if (f.goods < 0 || f.codFee < 0 || !(f.rate >= 0)) {
    return { entries, exportable: [], balancing, exceptions: [{ type: 'bad_facts', amount: 0, reason: 'negative amounts or rate' }], net: 0, opening: 0, balanced: false };
  }

  // Sale invoice
  {
    const p = parts(f.goods, f.codFee);
    voucher(f.saleDate, 'sale', f.saleDoc ? 'unicommerce' : 'shopify', f.saleDoc, `sale ${f.order}`, [
      [CUSTOMER, r2(f.goods + f.codFee), 0],
      ['Sales', 0, p.g.taxable], ['COD charge income', 0, p.c.taxable],
      ...gst(r2(p.g.tax + p.c.tax), 'credit', 'output'),
    ]);
  }
  // Settlements of what the customer owes
  if (f.delivered) {
    voucher(f.delivered.date, 'delivery', 'courier', undefined, 'COD collected by the courier', [
      ['COD receivable (Velocity)', f.delivered.amount, 0], [CUSTOMER, 0, f.delivered.amount]]);
  }
  for (const p of f.payments ?? []) {
    voucher(p.date, 'payment', 'gateway', p.ref, 'prepaid payment', [['Gateway clearing', p.amount, 0], [CUSTOMER, 0, p.amount]]);
  }
  for (const s of f.storeCreditUsed ?? []) {
    voucher(s.date, 'store_credit_used', 'shopify', undefined, 'store credit spent at checkout', [['Store credit liability', s.amount, 0], [CUSTOMER, 0, s.amount]]);
  }

  // Returns
  for (const [i, ret] of (f.returns ?? []).entries()) {
    const tag = `return ${i + 1} (${ret.kind})`;
    const fullReturn = ret.kind === 'rto';                      // never delivered: the whole sale ends
    const ucGoods = ret.uc?.goods ?? 0;
    const ucCod = ret.uc?.codFee ?? 0;

    if (ret.uc) {
      const p = parts(ucGoods, ucCod);
      voucher(ret.date, 'credit_note', 'unicommerce', ret.uc.doc, `${tag}: Unicommerce return invoice`, [
        ['Sales returns', p.g.taxable, 0], ['COD charge income', p.c.taxable, 0],
        ...gst(r2(p.g.tax + p.c.tax), 'debit', 'output'),
        [CUSTOMER, 0, r2(ucGoods + ucCod)],
      ]);
    }
    // What the order requires of its credit notes, and what is missing or extra.
    const needGoods = ret.goodsReturned;
    if (r2(needGoods - ucGoods) > 0.005) {
      const amt = r2(needGoods - ucGoods);
      const p = split(amt, f.rate);
      balancing.push({ type: 'credit_note_goods', amount: amt, reason: ret.uc ? `Unicommerce's return invoice covers ${ucGoods.toFixed(2)} of ${needGoods.toFixed(2)} goods` : 'no Unicommerce return invoice exists for this order' });
      voucher(ret.date, 'credit_note', 'erp', undefined, `${tag}: credit note for goods`, [
        ['Sales returns', p.taxable, 0], ...gst(p.tax, 'debit', 'output'), [CUSTOMER, 0, amt]]);
    }
    if (fullReturn && r2(f.codFee - ucCod) > 0.005) {
      const amt = r2(f.codFee - ucCod);
      const p = split(amt, f.rate);
      balancing.push({ type: 'credit_note_cod_fee', amount: amt, reason: 'returned to origin: the COD charge was never collected, so it is reversed too' });
      voucher(ret.date, 'credit_note', 'erp', undefined, `${tag}: credit note for the COD charge`, [
        ['COD charge income', p.taxable, 0], ...gst(p.tax, 'debit', 'output'), [CUSTOMER, 0, amt]]);
    }
    if (!fullReturn && ucCod > 0.005) {
      // The customer paid the COD charge and it is kept: bill it back.
      const p = split(ucCod, f.rate);
      balancing.push({ type: 'retained_cod_fee_invoice', amount: ucCod, reason: "the return invoice reversed the COD charge, but the customer paid it and it is kept" });
      voucher(ret.date, 'invoice', 'erp', undefined, `${tag}: retained COD charge`, [
        [CUSTOMER, ucCod, 0], ['COD charge income', 0, p.taxable], ...gst(p.tax, 'credit', 'output')]);
    }
    // Return fee kept from the customer: Unicommerce never invoices it
    if (ret.returnFee && ret.returnFee > 0) {
      const p = split(ret.returnFee, f.rate);
      balancing.push({ type: 'return_fee_invoice', amount: ret.returnFee, reason: 'return fee kept from the customer' });
      voucher(ret.date, 'invoice', 'erp', undefined, `${tag}: return fee`, [
        [CUSTOMER, ret.returnFee, 0], ['Return fee income', 0, p.taxable], ...gst(p.tax, 'credit', 'output')]);
    }
    // Store credit actually issued (and anything taken back)
    let issued = 0;
    for (const c of ret.storeCredit ?? []) {
      issued = r2(issued + c.amount);
      voucher(c.date, 'store_credit', 'return_prime', c.ref, `${tag}: store credit ${c.amount < 0 ? 'taken back' : 'issued'}`,
        c.amount >= 0 ? [[CUSTOMER, c.amount, 0], ['Store credit liability', 0, c.amount]] : [['Store credit liability', -c.amount, 0], [CUSTOMER, 0, -c.amount]]);
    }
    if (ret.cashRefund) {
      voucher(ret.cashRefund.date, 'refund', 'gateway', undefined, `${tag}: cash refund`, [[CUSTOMER, ret.cashRefund.amount, 0], ['Bank', 0, ret.cashRefund.amount]]);
    }
    // A customer return pays back what was paid for the goods, less the return fee.
    if (ret.kind === 'customer' && (ret.storeCredit?.length || ret.cashRefund)) {
      const entitled = r2(ret.goodsReturned - (ret.returnFee ?? 0));
      const got = r2(issued + (ret.cashRefund?.amount ?? 0));
      if (Math.abs(got - entitled) > 0.01) {
        exceptions.push({ type: 'store_credit_differs', amount: r2(got - entitled),
          reason: `${got.toFixed(2)} was credited or refunded but the customer is entitled to ${entitled.toFixed(2)} (goods ${ret.goodsReturned.toFixed(2)} less fee ${(ret.returnFee ?? 0).toFixed(2)})` });
      }
    }
  }

  // Does the order net to zero?
  const net = r2(entries.filter(e => e.account === CUSTOMER).reduce((s, e) => s + e.debit - e.credit, 0));
  if (Math.abs(net) > 0.01 && !exceptions.length) {
    exceptions.push({ type: 'unexplained_residual', amount: net, reason: `the order is ${net > 0 ? 'owed' : 'over-settled'} by ${Math.abs(net).toFixed(2)}: a payment, return or credit is missing` });
  }
  const exportable = entries.filter(e => e.date >= opts.cutoff);
  const opening = r2(entries.filter(e => e.date < opts.cutoff && e.account === CUSTOMER).reduce((s, e) => s + e.debit - e.credit, 0));
  return { entries, exportable, balancing, exceptions, net, opening, balanced: Math.abs(net) <= 0.01 && !exceptions.length };
}
