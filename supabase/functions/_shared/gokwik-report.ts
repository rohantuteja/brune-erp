// GoKwik's settlement report (rawSettlementReport, or settlement_v2 which carries the same numbers) as rows.
// Pure: no network. One row per payment: what the customer paid, GoKwik's fee and the GST on it, what reached the bank,
// and the bank reference (UTR) and date of the transfer it was part of.

export type GokwikPayment = {
  payment_id: string;
  order_name: string | null;
  txn_date: string | null;          // YYYY-MM-DD
  settlement_date: string | null;
  utr: string | null;
  amount: number;
  fee: number;
  tax: number;
  credit: number;                   // net to the bank: credit less any debit (a refund shows as a debit)
  method: string | null;
  remark: string | null;
  pg_transaction_type: string | null;
};
export type GokwikReport = { rows: GokwikPayment[]; checks: Array<{ id: string; ok: boolean; detail: string }> };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A CSV file as rows of strings: quoted fields, doubled quotes and line breaks inside quotes are handled. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(field); field = ''; if (row.some(c => c !== '')) rows.push(row); row = []; }
    else field += ch;
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

/** "30/9/2026 12:19 PM" (day first) → "2026-09-30"; null when it is not a date. */
export function gokwikDate(s: string | undefined): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const num = (s: string | undefined) => { const n = Number(String(s ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

export function parseGokwikReport(text: string): GokwikReport {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('the file is empty');
  const head = rows[0].map(h => h.trim());
  const ix = (name: string) => head.indexOf(name);
  for (const need of ['Payment Id', 'Amount', 'Credit', 'Settlement UTR', 'Settlement Date']) if (ix(need) < 0) throw new Error(`this does not look like a GoKwik settlement report: no "${need}" column`);
  const get = (r: string[], name: string) => (ix(name) >= 0 ? String(r[ix(name)] ?? '').trim() : '');

  const out: GokwikPayment[] = [];
  for (const r of rows.slice(1)) {
    const id = get(r, 'Payment Id');
    if (!id) continue;
    out.push({
      payment_id: id, order_name: get(r, 'Platform Order Id').replace(/^#/, '') || null, txn_date: gokwikDate(get(r, 'Transaction Date')), settlement_date: gokwikDate(get(r, 'Settlement Date')),
      utr: get(r, 'Settlement UTR') || null, amount: r2(num(get(r, 'Amount'))), fee: r2(num(get(r, 'Fee'))), tax: r2(num(get(r, 'Tax'))),
      credit: r2(num(get(r, 'Credit')) - num(get(r, 'Debit'))), method: get(r, 'Payment Method') || null,
      remark: get(r, 'Remark') || null, pg_transaction_type: get(r, 'PG Transaction Type') || null,
    });
  }

  const checks: GokwikReport['checks'] = [];
  const ids = new Set(out.map(p => p.payment_id));
  checks.push({ id: 'unique_payments', ok: ids.size === out.length, detail: ids.size === out.length ? `${out.length} payments, each once` : `${out.length - ids.size} payment id(s) repeat` });
  const payments = out.filter(p => p.credit > 0 && !p.pg_transaction_type);
  const off = payments.filter(p => Math.abs(r2(p.amount - p.fee - p.tax) - p.credit) > 0.011);
  checks.push({ id: 'amount_less_fees', ok: off.length === 0, detail: off.length ? `${off.length} payment(s) where amount − fee − GST is not what was credited` : 'for every payment, amount − fee − GST equals what was credited' });
  const noUtr = out.filter(p => !p.utr);
  checks.push({ id: 'all_settled', ok: noUtr.length === 0, detail: noUtr.length ? `${noUtr.length} payment(s) have no settlement yet` : 'every payment has a settlement reference' });
  return { rows: out, checks };
}

/** Payments grouped into the bank transfers they came in: one payout per UTR. */
export function payoutsOf(rows: Array<Pick<GokwikPayment, 'utr' | 'settlement_date' | 'credit'>>) {
  const by = new Map<string, { utr: string; date: string; amount: number; payments: number }>();
  for (const p of rows) {
    if (!p.utr || !p.settlement_date) continue;
    const g = by.get(p.utr) ?? { utr: p.utr, date: p.settlement_date, amount: 0, payments: 0 };
    g.amount = r2(g.amount + p.credit); g.payments++;
    by.set(p.utr, g);
  }
  return [...by.values()];
}
