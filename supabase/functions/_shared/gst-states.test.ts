// Run: node --test supabase/functions/_shared/gst-states.test.ts
// The state on every voucher decides IGST or CGST+SGST and the state-wise B2C return: it must come out right however
// Shopify or Unicommerce spells it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GST_STATES, resolveState } from './gst-states.ts';

test('every state and union territory is there once, with the GST code the portal uses', () => {
  assert.equal(GST_STATES.length, 36);
  assert.equal(new Set(GST_STATES.map(s => s.code)).size, 36);
  assert.equal(new Set(GST_STATES.map(s => s.name)).size, 36);
  const code = (name: string) => GST_STATES.find(s => s.name === name)?.code;
  assert.equal(code('Delhi'), '07');
  assert.equal(code('Uttar Pradesh'), '09');
  assert.equal(code('Maharashtra'), '27');
  assert.equal(code('Karnataka'), '29');
  assert.equal(code('Tamil Nadu'), '33');
  assert.equal(code('Telangana'), '36');
  assert.equal(code('Andhra Pradesh'), '37');
  assert.equal(code('Ladakh'), '38');
  assert.equal(code('Dadra and Nagar Haveli and Daman and Diu'), '26');
});

test('Unicommerce: a short code and a full name, as seen on real orders', () => {
  for (const [state, stateName, expect] of [['DL', 'Delhi', '07'], ['AP', 'Andhra Pradesh', '37'], ['GJ', 'Gujarat', '24'], ['MH', 'Maharashtra', '27'],
    ['KA', 'Karnataka', '29'], ['TR', 'Tripura', '16'], ['KL', 'Kerala', '32'], ['HR', 'Haryana', '06'], ['TN', 'Tamil Nadu', '33'], ['NL', 'Nagaland', '13'], ['UP', 'Uttar Pradesh', '09']]) {
    assert.equal(resolveState({ name: stateName, code: state })?.code, expect, stateName);
    assert.equal(resolveState({ code: state })?.code, expect, `${state} alone`);
    assert.equal(resolveState({ name: stateName })?.code, expect, `${stateName} alone`);
  }
});

test('the codes the systems disagree on, and the old or loose names', () => {
  assert.equal(resolveState({ code: 'TS' })?.name, 'Telangana');
  assert.equal(resolveState({ code: 'TG' })?.name, 'Telangana');
  assert.equal(resolveState({ code: 'OR' })?.name, 'Odisha');
  assert.equal(resolveState({ code: 'OD' })?.name, 'Odisha');
  assert.equal(resolveState({ code: 'UK' })?.name, 'Uttarakhand');
  assert.equal(resolveState({ code: 'UT' })?.name, 'Uttarakhand');
  assert.equal(resolveState({ code: 'CT' })?.name, 'Chhattisgarh');
  assert.equal(resolveState({ code: 'CG' })?.name, 'Chhattisgarh');
  assert.equal(resolveState({ code: 'DD' })?.code, '26');
  assert.equal(resolveState({ code: 'DN' })?.code, '26');
  assert.equal(resolveState({ code: 'PY' })?.name, 'Puducherry');
  for (const name of ['Orissa', 'odisha', 'ODISHA ']) assert.equal(resolveState({ name })?.name, 'Odisha', name);
  assert.equal(resolveState({ name: 'Uttaranchal' })?.name, 'Uttarakhand');
  assert.equal(resolveState({ name: 'Pondicherry' })?.name, 'Puducherry');
  assert.equal(resolveState({ name: 'New Delhi' })?.name, 'Delhi');
  assert.equal(resolveState({ name: 'NCT of Delhi' })?.name, 'Delhi');
  assert.equal(resolveState({ name: 'Chattisgarh' })?.name, 'Chhattisgarh');
  assert.equal(resolveState({ name: 'Tamilnadu' })?.name, 'Tamil Nadu');
  assert.equal(resolveState({ name: 'Jammu & Kashmir' })?.code, '01');
  assert.equal(resolveState({ name: 'Jammu and Kashmir' })?.code, '01');
  assert.equal(resolveState({ name: 'Andaman & Nicobar Islands' })?.code, '35');
  assert.equal(resolveState({ name: 'Andaman and Nicobar' })?.code, '35');
  assert.equal(resolveState({ name: 'Daman and Diu' })?.code, '26');
  assert.equal(resolveState({ name: 'Dadra and Nagar Haveli' })?.code, '26');
  assert.equal(resolveState({ name: 'Dadra & Nagar Haveli and Daman & Diu' })?.code, '26');
  assert.equal(resolveState({ code: '07' })?.name, 'Delhi');
  assert.equal(resolveState({ code: '7' })?.name, 'Delhi');
  assert.equal(resolveState({ code: '27' })?.name, 'Maharashtra');
});

test('the name wins over a code that disagrees, and anything unknown is null (never a guess)', () => {
  assert.equal(resolveState({ name: 'Karnataka', code: 'MH' })?.name, 'Karnataka');
  assert.equal(resolveState({ name: 'Narnia', code: 'MH' })?.name, 'Maharashtra');       // an unknown name falls back to the code
  assert.equal(resolveState({ name: 'Narnia', code: 'ZZ' }), null);
  assert.equal(resolveState({ name: '', code: '' }), null);
  assert.equal(resolveState({}), null);
  assert.equal(resolveState({ name: null, code: null }), null);
  assert.equal(resolveState({ code: 'IN' }), null);          // the country, not a state
  assert.equal(resolveState({ name: 'India' }), null);
});
