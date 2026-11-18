// A small .xlsx reader for the browser (no dependency): every worksheet by its name, as rows of strings (empty cells are '').
// An .xlsx is a zip of XML parts. Inflating uses the browser's DecompressionStream (Node 18+ has it too, which is how it is tested).
// The same logic reads bank statements on the server side (supabase/functions/_shared/statements.ts); this copy is for the pages that
// read a file the user picks, so the file never has to leave the browser.

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const entries = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (name.startsWith('xl/') && (name.endsWith('.xml') || name.endsWith('.rels'))) out.set(name, method === 0 ? raw : await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const xmlText = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function sharedStrings(parts) {
  const shared = [];
  const ss = parts.get('xl/sharedStrings.xml');
  if (ss) for (const si of new TextDecoder().decode(ss).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(xmlText([...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  return shared;
}

function sheetRows(xml, shared) {
  const rows = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      let val;
      if (type === 's') val = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1])] ?? '';
      else if (type === 'inlineStr') val = xmlText([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      else val = xmlText(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      cells[colIndex(ref)] = val;
    }
    rows.push(Array.from(cells, v => v ?? ''));
  }
  return rows;
}

/** Every worksheet of an .xlsx file by its name, as rows of strings (empty cells are ''). */
export async function xlsxSheets(bytes) {
  const parts = await unzip(bytes);
  const dec = new TextDecoder();
  const book = parts.get('xl/workbook.xml'), rels = parts.get('xl/_rels/workbook.xml.rels');
  if (!book || !rels) throw new Error('no workbook in the file');
  const target = new Map();
  for (const r of dec.decode(rels).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(r[1])?.[1], to = /\bTarget="([^"]*)"/.exec(r[1])?.[1];
    if (id && to) target.set(id, to);
  }
  const shared = sharedStrings(parts);
  const out = new Map();
  for (const sh of dec.decode(book).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(sh[1])?.[1], rid = /\br:id="([^"]*)"/.exec(sh[1])?.[1];
    const to = rid ? target.get(rid) : undefined;
    if (!name || !to) continue;
    const xml = parts.get(to.startsWith('/') ? to.slice(1) : `xl/${to}`);
    if (xml) out.set(xmlText(name), sheetRows(dec.decode(xml), shared));
  }
  return out;
}
