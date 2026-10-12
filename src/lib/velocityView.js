// Pure helpers for the Velocity wallet screen: no React, no network, tested with `node --test`.

export const KIND_LABEL = {
  shipping: 'Shipping charges',
  cod_charge: 'COD charges',
  rto: 'RTO charges',
  weight_discrepancy: 'Weight differences',
  ndr_automation: 'Delivery-failure messages (VAS)',
  cod_reversal: 'COD charges reversed',
  shipping_reversal: 'Shipping charges reversed',
  financial_note: 'Lost-shipment credits',
  recharge: 'Wallet top-ups',
  other: 'Other',
};
const DEBIT_ORDER = ['shipping', 'cod_charge', 'rto', 'weight_discrepancy', 'ndr_automation', 'other'];
const CREDIT_ORDER = ['recharge', 'cod_reversal', 'shipping_reversal', 'financial_note', 'other'];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-09" → "Sep 2026" */
export const monthLabel = (m) => { const x = /^(\d{4})-(\d{2})$/.exec(String(m ?? '')); return x ? `${MONTH_NAMES[Number(x[2]) - 1]} ${x[1]}` : String(m ?? ''); };

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/** A month's kinds ({ 'debit:shipping': {n, amount, ex_gst}, ... }) as two ordered lists with labels. */
export function splitKinds(kinds) {
  const pick = (direction, order) => order
    .map(kind => ({ kind, label: KIND_LABEL[kind], ...(kinds?.[`${direction}:${kind}`] ?? null) }))
    .filter(r => r.n);
  return { debits: pick('debit', DEBIT_ORDER), credits: pick('credit', CREDIT_ORDER) };
}

/** Where a wallet top-up stands against the bank. */
export function topupStatus(t) {
  if (t.bank_line_id) return 'matched';
  return t.bank_statement_covers ? 'not_in_bank' : 'no_statement';
}
export const TOPUP_STATUS_TEXT = {
  matched: 'In the bank statement',
  not_in_bank: 'Not in the bank statement: paid from another account?',
  no_statement: 'No bank statement uploaded for this date yet',
};

/** Top-ups of one month, counted by status. */
export function topupCounts(topups, month) {
  const out = { total: 0, amount: 0, matched: 0, not_in_bank: 0, no_statement: 0 };
  for (const t of topups ?? []) {
    if (String(t.date).slice(0, 7) !== month) continue;
    out.total++; out.amount = r2(out.amount + t.amount); out[topupStatus(t)]++;
  }
  return out;
}

/**
 * What to tell the owner about a month's charges against its invoice (amounts before GST).
 * The delivery-failure messages (VAS) should match to the paisa; the freight line is matched by the closest way of netting credits.
 */
export function invoiceVerdict(against) {
  if (!against?.has_ledger) return { vas: null, freight: null, headline: 'No ledger lines cover this invoice period yet: upload the Velocity ledger report for it.', tone: 'neutral' };
  const vas = against.vas ? (Math.abs(against.vas.diff) < 0.015
    ? { level: 'exact', text: `Delivery-failure messages match to the paisa (${against.vas.invoice.toFixed(2)})` }
    : { level: 'off', text: `Delivery-failure messages: invoice ${against.vas.invoice.toFixed(2)}, ledger ${against.vas.ledger.toFixed(2)}` }) : null;
  let freight = null;
  if (against.freight) {
    const d = against.freight.closest.diff, pct = Math.abs(d) / against.freight.invoice * 100;
    freight = pct < 0.015 ? { level: 'exact', text: 'Freight matches to the paisa', pct }
      : pct <= 0.5 ? { level: 'close', text: `Freight is within ${pct.toFixed(2)}% (${Math.abs(d).toFixed(2)} before GST) of the ledger: ${against.freight.closest.label}`, pct }
      : { level: 'off', text: `Freight differs from the ledger by ${Math.abs(d).toFixed(2)} before GST (${pct.toFixed(1)}%) on the closest way of counting`, pct };
  }
  const levels = [vas?.level, freight?.level].filter(Boolean);
  const tone = levels.includes('off') ? 'warn' : levels.includes('close') ? 'close' : levels.length ? 'ok' : 'neutral';
  return { vas, freight, tone, headline: tone === 'ok' ? 'The invoice agrees with the ledger.' : tone === 'close' ? 'The invoice agrees with the ledger within a small difference.' : tone === 'warn' ? 'The invoice does not agree with the ledger: check it with Velocity.' : '' };
}
