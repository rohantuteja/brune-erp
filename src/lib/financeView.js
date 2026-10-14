// Pure helpers for the Bank & card screen: no React, no network, tested with `node --test`.

/** A file's bytes as base64, in pieces (one String.fromCharCode over a whole file overflows the stack). */
export function toBase64(bytes) {
  let s = '';
  const PIECE = 0x8000;
  for (let i = 0; i < bytes.length; i += PIECE) s += String.fromCharCode.apply(null, bytes.subarray(i, i + PIECE));
  return btoa(s);
}

/**
 * The dates the screen is looking at. The books before the accounting start date are closed, so by default the screen
 * starts there; "all" shows everything; a typed range wins over both.
 */
export function effectiveRange({ from, to, all }, startDate) {
  if (all) return ['', ''];
  if (from || to) return [from || '', to || ''];
  return [startDate || '', ''];
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** How many lines are in each status, and how much money moved in them. */
export function statusCounts(lines) {
  const out = { needs_review: [0, 0], suggested: [0, 0], matched: [0, 0], ignored: [0, 0] };
  for (const l of lines) {
    const e = out[l.status] ?? (out[l.status] = [0, 0]);
    e[0]++; e[1] = money(e[1] + Number(l.debit) + Number(l.credit));
  }
  return out;
}

/**
 * The lines nobody has decided yet, grouped by who was paid, biggest group first. Filing a group files every line in it
 * and remembers the payee, so a few labels settle most of the queue. `hint` is the bucket most of the group already points at.
 */
export function payeeGroups(lines) {
  const by = new Map();
  for (const l of lines) {
    if (l.decided_at || !l.payee || (l.status !== 'needs_review' && l.status !== 'suggested')) continue;
    const g = by.get(l.payee) ?? { payee: l.payee, ids: [], count: 0, out: 0, in: 0, sample: l.remarks, hints: new Map() };
    g.ids.push(l.id); g.count++; g.out = money(g.out + Number(l.debit)); g.in = money(g.in + Number(l.credit));
    if (l.bucket) g.hints.set(l.bucket, (g.hints.get(l.bucket) ?? 0) + 1);
    by.set(l.payee, g);
  }
  return [...by.values()].map(({ hints, ...g }) => ({ ...g, hint: [...hints.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }))
    .sort((a, b) => b.count - a.count || (b.out + b.in) - (a.out + a.in));
}

/** Totals per bucket (lines with no bucket yet are grouped under null). */
export function bucketTotals(lines) {
  const by = new Map();
  for (const l of lines) {
    const k = l.bucket ?? null;
    const e = by.get(k) ?? { bucket: k, count: 0, out: 0, in: 0 };
    e.count++; e.out = money(e.out + Number(l.debit)); e.in = money(e.in + Number(l.credit));
    by.set(k, e);
  }
  return [...by.values()].sort((a, b) => (b.out + b.in) - (a.out + a.in));
}

/** A statement line's amount with its direction: negative for money out. */
export const signed = (l) => money(Number(l.credit) - Number(l.debit));

/** Who or what put an undecided line under its bucket, in a few words (the reason says the rest). */
const ORIGIN = {
  rule: 'Your payee rule', note: 'From the note you wrote', conflict: 'Your rule and the note disagree', unknown: 'Nothing explains it yet',
  gokwik_payout: 'Proved by a GoKwik payout', velocity_remittance: 'Proved by a Velocity payout', velocity_recharge: 'Velocity wallet top-up', meta_invoice: 'Meta invoice',
  returned_payment: 'Cancelled out: returned', reversed_charge: 'Cancelled out: reversed', card_payment: 'Founder card payment',
  merchant: 'Recognised merchant', bank_charge: 'Bank charge', card_fee: 'Card fee', category: 'Card category', cash_deposit: 'Cash deposit', rtgs_in: 'Large transfer in',
};
export function originOf(l) {
  if (l.kind === 'manual') return `Filed by ${l.decided_by_name || 'you'}`;
  if (l.decided_at) return `Confirmed by ${l.decided_by_name || 'you'}`;
  return ORIGIN[l.kind] || '';
}

/** The note words on these lines, and which of them the note list does not know yet. */
export function noteWordsOf(lines, known) {
  const words = [...new Set(lines.map(l => l.note).filter(Boolean))].sort();
  return { words, unknown: words.filter(w => !known.has(w)) };
}

/** A line of the "this would also move" list: where it is now and where it would go. */
export const moveText = (m) => `${m.from || 'no bucket'} → ${m.to || 'no bucket'}`;
