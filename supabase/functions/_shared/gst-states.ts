// The place of supply of a B2C sale is the state the goods go to. Shopify and Unicommerce spell it three ways (a name,
// an ISO-style code that differs between systems, sometimes an old name), and the GST return and Tally both want ONE
// state per voucher. This turns whichever of them we have into the GST state: its two-digit code and its standard name.
//
//   resolveState({ name, code })   → { code: '07', name: 'Delhi' } or null if neither is a known state
//
// The names are the GST portal's. Tally spells a few of them differently ("Jammu & Kashmir", "Andaman & Nicobar
// Islands"): the export maps the GST code to Tally's spelling, so this table stays the GST one.

export type GstState = { code: string; name: string };

// [GST code, standard name, other names it goes by, short codes seen in Shopify / Unicommerce / ISO 3166-2:IN]
const TABLE: Array<[string, string, string[], string[]]> = [
  ['01', 'Jammu and Kashmir', [], ['JK']],
  ['02', 'Himachal Pradesh', [], ['HP']],
  ['03', 'Punjab', [], ['PB']],
  ['04', 'Chandigarh', [], ['CH']],
  ['05', 'Uttarakhand', ['Uttaranchal'], ['UK', 'UT', 'UA']],
  ['06', 'Haryana', [], ['HR']],
  ['07', 'Delhi', ['New Delhi', 'NCT of Delhi', 'National Capital Territory of Delhi'], ['DL']],
  ['08', 'Rajasthan', [], ['RJ']],
  ['09', 'Uttar Pradesh', [], ['UP']],
  ['10', 'Bihar', [], ['BR']],
  ['11', 'Sikkim', [], ['SK']],
  ['12', 'Arunachal Pradesh', [], ['AR']],
  ['13', 'Nagaland', [], ['NL']],
  ['14', 'Manipur', [], ['MN']],
  ['15', 'Mizoram', [], ['MZ']],
  ['16', 'Tripura', [], ['TR']],
  ['17', 'Meghalaya', [], ['ML']],
  ['18', 'Assam', [], ['AS']],
  ['19', 'West Bengal', [], ['WB']],
  ['20', 'Jharkhand', [], ['JH']],
  ['21', 'Odisha', ['Orissa'], ['OD', 'OR']],
  ['22', 'Chhattisgarh', ['Chattisgarh', 'Chhatisgarh'], ['CG', 'CT']],
  ['23', 'Madhya Pradesh', [], ['MP']],
  ['24', 'Gujarat', [], ['GJ']],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu', ['Dadra and Nagar Haveli', 'Daman and Diu', 'Dadra Nagar Haveli'], ['DN', 'DD', 'DH']],
  ['27', 'Maharashtra', [], ['MH']],
  ['29', 'Karnataka', [], ['KA']],
  ['30', 'Goa', [], ['GA']],
  ['31', 'Lakshadweep', [], ['LD']],
  ['32', 'Kerala', [], ['KL']],
  ['33', 'Tamil Nadu', ['Tamilnadu'], ['TN']],
  ['34', 'Puducherry', ['Pondicherry'], ['PY', 'PO']],
  ['35', 'Andaman and Nicobar Islands', ['Andaman and Nicobar', 'Andaman Nicobar'], ['AN']],
  ['36', 'Telangana', ['Telengana'], ['TG', 'TS']],
  ['37', 'Andhra Pradesh', [], ['AP']],
  ['38', 'Ladakh', [], ['LA']],
];

// "Jammu & Kashmir" and "Jammu and Kashmir" and "jammu  kashmir" are one key.
const key = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/\band\b/g, ' ').replace(/[^a-z]/g, '');

const byName = new Map<string, GstState>();
const byShort = new Map<string, GstState>();
const byCode = new Map<string, GstState>();
for (const [code, name, aliases, shorts] of TABLE) {
  const st = { code, name };
  for (const n of [name, ...aliases]) byName.set(key(n), st);
  for (const s of shorts) byShort.set(s, st);
  byCode.set(code, st);
}

export const GST_STATES: GstState[] = TABLE.map(([code, name]) => ({ code, name }));

/** The name wins over the code (a name is spelled out; a short code can differ between systems). null if neither matches. */
export function resolveState(src: { name?: string | null; code?: string | null }): GstState | null {
  const name = String(src.name ?? '').trim();
  if (name) {
    const hit = byName.get(key(name));
    if (hit) return hit;
  }
  const code = String(src.code ?? '').trim().toUpperCase();
  if (code) return byShort.get(code) ?? byCode.get(code.padStart(2, '0')) ?? byName.get(key(code)) ?? null;
  return null;
}
