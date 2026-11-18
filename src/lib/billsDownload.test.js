import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthZip } from './billsDownload.js';

// A tiny reader for a stored zip: name -> bytes. It follows the central directory, as a real unzip does.
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22; while (dv.getUint32(end, true) !== 0x06054b50) end--;
  const count = dv.getUint16(end + 10, true); let at = dv.getUint32(end + 16, true); const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50);
    const size = dv.getUint32(at + 24, true), nlen = dv.getUint16(at + 28, true), off = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nlen));
    const lnlen = dv.getUint16(off + 26, true), lxlen = dv.getUint16(off + 28, true);
    out.set(name, bytes.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + size));
    at += 46 + nlen;
  }
  return out;
}
const bill = (id, o = {}) => ({ id, status: 'accepted', vendor: 'Meta', invoice_no: `INV${id}`, invoice_date: '2026-10-12', subtotal: 100, tax: 18, total: 118, supplier_gstin: '06AABCF5150G1ZZ', file_path: `bills/${id}.pdf`, ...o });
const pdf = (id) => new TextEncoder().encode(`%PDF-1.4 bill ${id}`);

test('the zip holds the PDF of every bill of the month and an index; other months and voided bills are not in it', async () => {
  const bills = [bill(1), bill(2, { vendor: 'GoKwik' }), bill(3, { invoice_date: '2026-11-01' }), bill(4, { status: 'void' }), bill(5, { file_path: null, vendor: 'Nykaa' })];
  const seen = []; const progress = [];
  const r = await buildMonthZip({ bills, month: '2026-10', getUrl: async (b) => `url/${b.id}`, fetchBytes: async (u) => pdf(u.split('/')[1]), onProgress: (d, t) => progress.push([d, t]) });
  const files = readZip(r.bytes);
  assert.deepEqual([...files.keys()].sort(), ['2026-10-12 GoKwik INV2.pdf', '2026-10-12 Meta INV1.pdf', 'index.csv']);
  assert.equal(new TextDecoder().decode(files.get('2026-10-12 Meta INV1.pdf')), '%PDF-1.4 bill 1');           // the bytes are exactly the PDF
  assert.deepEqual(r.counts, { bills: 3, pdfs: 2, noPdf: 1, failed: 0 }); assert.equal(r.name, 'Bills-2026-10.zip');
  assert.deepEqual(progress.at(-1), [2, 2]);
  const idx = new TextDecoder().decode(files.get('index.csv'));
  assert.match(idx, /Nykaa.*no PDF kept for this bill/); assert.equal(idx.trim().split('\r\n').length, 4);
});

test('a PDF that cannot be fetched is listed in the index and does not stop the rest', async () => {
  const bills = [bill(1), bill(2), bill(3)];
  const r = await buildMonthZip({ bills, month: '2026-10', getUrl: async (b) => (b.id === 2 ? null : `url/${b.id}`), fetchBytes: async (u) => (u.endsWith('/3') ? new Uint8Array() : pdf(u.split('/')[1])) });
  const files = readZip(r.bytes);
  assert.deepEqual([...files.keys()].filter(k => k.endsWith('.pdf')), ['2026-10-12 Meta INV1.pdf']);
  assert.deepEqual(r.counts, { bills: 3, pdfs: 1, noPdf: 0, failed: 2 });
  const idx = new TextDecoder().decode(files.get('index.csv'));
  assert.match(idx, /INV2.*not downloaded: no link to the PDF/); assert.match(idx, /INV3.*not downloaded: the PDF came back empty/);
});

test('a month with no bills makes a zip with only the index', async () => {
  const r = await buildMonthZip({ bills: [bill(1)], month: '2026-09', getUrl: async () => 'u', fetchBytes: async () => pdf(1) });
  assert.deepEqual([...readZip(r.bytes).keys()], ['index.csv']); assert.equal(r.counts.bills, 0);
});
