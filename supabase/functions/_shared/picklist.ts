// The pick list for the Myntra labels still to print (myntra-fulfil, action `picklist`).
//
// Unicommerce's own pick list needs a package that has not been dispatched; the ERP dispatches within minutes of invoicing, so the
// list is made here from the items of the packages themselves, in the layout of the one Unicommerce gives for Myntra:
// S.No. | SKU | Item Name | Brand | Qty | Image, plus a "Picked" box to tick. Nothing is changed in Unicommerce.
//
// aggregatePicklist is pure (tested). buildPicklistPdf draws it with pdf-lib, which is passed in so this file imports nothing.

export type PickItem = { package: string; sku: string; name: string; brand: string | null; imageUrl: string | null; status: string };
export type PickRow = { sku: string; name: string; brand: string | null; imageUrl: string | null; qty: number; packages: string[] };
export type Parcel = { package: string; skus: Array<{ sku: string; qty: number }> };

// One row per SKU with the number of units to pick, in SKU order like Unicommerce's list. A cancelled item is not picked.
export function aggregatePicklist(items: PickItem[]): { rows: PickRow[]; parcels: Parcel[]; units: number } {
  const live = items.filter(i => i.status !== 'CANCELLED' && i.sku);
  const bySku = new Map<string, PickRow>();
  for (const i of live) {
    const r = bySku.get(i.sku) ?? { sku: i.sku, name: i.name, brand: i.brand, imageUrl: i.imageUrl, qty: 0, packages: [] };
    r.qty++;
    if (!r.packages.includes(i.package)) r.packages.push(i.package);
    r.imageUrl = r.imageUrl ?? i.imageUrl;
    bySku.set(i.sku, r);
  }
  const byParcel = new Map<string, Map<string, number>>();
  for (const i of live) {
    const m = byParcel.get(i.package) ?? new Map<string, number>();
    m.set(i.sku, (m.get(i.sku) ?? 0) + 1);
    byParcel.set(i.package, m);
  }
  return {
    rows: [...bySku.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    parcels: [...byParcel].map(([pkg, m]) => ({ package: pkg, skus: [...m].map(([sku, qty]) => ({ sku, qty })) })),
    units: live.length,
  };
}

// Wrap text to a width: break at spaces and after hyphens (SKUs are one long word with hyphens).
export function wrapText(text: string, widthOf: (s: string) => number, maxWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const tok of String(text ?? '').split(/(?<=[ -])/)) {
    if (line && widthOf(line + tok) > maxWidth) { out.push(line.trimEnd()); line = tok; } else line += tok;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.length ? out : [''];
}

// "21-10-2026 | 12:21:12" in IST, as Unicommerce prints "Generated at".
export function istStamp(d: Date): string {
  const t = new Date(d.getTime() + 5.5 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()} | ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 36;
const COLS = [
  { key: 'no', title: 'S.No.', w: 34 },
  { key: 'sku', title: 'SKU', w: 150 },
  { key: 'name', title: 'Item Name', w: 150 },
  { key: 'brand', title: 'Brand', w: 46 },
  { key: 'qty', title: 'Qty', w: 30 },
  { key: 'image', title: 'Image', w: 50 },
  { key: 'picked', title: 'Picked', w: 37 },
];
const IMG = 40;          // image box, points
const ROW_MIN = 46;

// images: SKU -> embeddable bytes (png or jpeg) when it could be fetched.
export async function buildPicklistPdf(
  lib: { PDFDocument: any; StandardFonts: any; rgb: any },
  data: { rows: PickRow[]; parcels: Parcel[]; units: number },
  images: Map<string, Uint8Array>,
  now: Date,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = lib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = (f: any, s: number) => (t: string) => f.widthOfTextAtSize(t, s);
  const stamp = istStamp(now);
  const pages: any[] = [];
  let page: any; let y = 0;

  const ascii = (s: string) => String(s ?? '').replace(/[^\x20-\x7e]/g, '?');   // the standard fonts hold plain ASCII only
  const newPage = (first: boolean) => {
    page = doc.addPage([PAGE_W, PAGE_H]); pages.push(page);
    y = PAGE_H - MARGIN;
    if (first) {
      page.drawText('PICK LIST', { x: MARGIN, y: y - 16, size: 18, font: bold });
      page.drawText(`Myntra orders: ${data.parcels.length} parcel${data.parcels.length === 1 ? '' : 's'}, ${data.units} unit${data.units === 1 ? '' : 's'}, ${data.rows.length} SKU${data.rows.length === 1 ? '' : 's'}`, { x: MARGIN, y: y - 34, size: 10, font });
      y -= 48;
    }
    // table header
    const h = 18; let x = MARGIN;
    page.drawRectangle({ x: MARGIN, y: y - h, width: COLS.reduce((a, c) => a + c.w, 0), height: h, color: rgb(0.9, 0.9, 0.9) });
    for (const c of COLS) { page.drawText(c.title, { x: x + 4, y: y - 12.5, size: 9, font: bold }); x += c.w; }
    y -= h;
  };
  newPage(true);

  for (let idx = 0; idx < data.rows.length; idx++) {
    const r = data.rows[idx];
    const sku = wrapText(ascii(r.sku), w(font, 9), COLS[1].w - 8);
    const name = wrapText(ascii(r.name), w(font, 9), COLS[2].w - 8);
    const rowH = Math.max(ROW_MIN, 12 * Math.max(sku.length, name.length) + 10);
    if (y - rowH < MARGIN + 24) newPage(false);
    let x = MARGIN;
    const cell = (i: number) => { const cx = x + 4; x += COLS[i].w; return cx; };
    page.drawText(String(idx + 1), { x: cell(0), y: y - 14, size: 9, font });
    let cx = cell(1); sku.forEach((l, k) => page.drawText(l, { x: cx, y: y - 14 - k * 12, size: 9, font: bold }));
    cx = cell(2); name.forEach((l, k) => page.drawText(l, { x: cx, y: y - 14 - k * 12, size: 9, font }));
    page.drawText(ascii(r.brand ?? ''), { x: cell(3), y: y - 14, size: 9, font });
    page.drawText(String(r.qty), { x: cell(4), y: y - 14, size: 12, font: bold });
    cx = cell(5); void cx;
    const picked = cell(6);
    page.drawRectangle({ x: picked, y: y - 24, width: 14, height: 14, borderColor: rgb(0.2, 0.2, 0.2), borderWidth: 1 });
    page.drawLine({ start: { x: MARGIN, y: y - rowH }, end: { x: MARGIN + COLS.reduce((a, c) => a + c.w, 0), y: y - rowH }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
    const img = images.get(r.sku);
    if (img) await drawImage(page, img, MARGIN + COLS.slice(0, 5).reduce((a, c) => a + c.w, 0) + 5, y - 3 - IMG);
    y -= rowH;
  }

  pages.forEach((pg, i) => {
    pg.drawText(`Generated at: ${stamp}`, { x: MARGIN, y: 20, size: 8, font });
    pg.drawText(`Page ${i + 1} of ${pages.length}`, { x: PAGE_W - MARGIN - 50, y: 20, size: 8, font });
  });

  // a failed image leaves its box empty and never breaks the list
  async function drawImage(pg: any, bytes: Uint8Array, x: number, yTop: number) {
    try {
      const png = bytes[0] === 0x89 && bytes[1] === 0x50;
      const emb = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const s = Math.min(IMG / emb.width, IMG / emb.height);
      pg.drawImage(emb, { x, y: yTop, width: emb.width * s, height: emb.height * s });
    } catch { /* leave the box empty */ }
  }
  return await doc.save();
}
