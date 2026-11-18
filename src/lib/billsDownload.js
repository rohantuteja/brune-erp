// "Download all bills of a month": the original PDF of every bill of the month, in one zip with an index of what is in it.
// The PDFs sit in a private bucket; the page asks the bills function for a short-lived link to each (the same way it opens one bill's original) and fetches it.
// Nothing is changed: it only reads.
import { zip } from './zipWrite.js';
import { billsOfMonth, pdfNames, indexCsv } from './billsView.js';

/**
 * @param bills     every bill (the month is picked here)       month  'YYYY-MM'
 * @param getUrl    async (bill) => a link to the PDF, or null  fetchBytes  async (url) => Uint8Array
 * @param onProgress (done, total) => void
 * @returns { bytes (the zip), counts: { bills, pdfs, noPdf, failed }, failed: [{ bill, why }], name }
 */
export async function buildMonthZip({ bills, month, getUrl, fetchBytes, onProgress = () => {}, concurrency = 3, now = new Date() }) {
  const { list } = billsOfMonth(bills, month);
  const names = pdfNames(list);
  const withPdf = list.filter(b => b.file_path);
  const got = new Map(), missing = new Map(), failed = [];
  let done = 0, next = 0;
  const worker = async () => {
    while (next < withPdf.length) {
      const b = withPdf[next++];
      try {
        const url = await getUrl(b);
        if (!url) throw new Error('no link to the PDF');
        const bytes = await fetchBytes(url);
        if (!bytes || !bytes.length) throw new Error('the PDF came back empty');
        got.set(b.id, bytes);
      } catch (err) { missing.set(b.id, `not downloaded: ${err.message}`); failed.push({ bill: b, why: err.message }); }
      onProgress(++done, withPdf.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(withPdf.length, 1)) }, worker));
  for (const b of list) if (!got.has(b.id) && b.file_path && !missing.has(b.id)) missing.set(b.id, 'not downloaded');
  const files = [['index.csv', indexCsv(list, names, missing)], ...list.filter(b => got.has(b.id)).map(b => [names.get(b.id), got.get(b.id)])];
  return { bytes: zip(files, now), name: `Bills-${month}.zip`, failed, counts: { bills: list.length, pdfs: got.size, noPdf: list.length - withPdf.length, failed: failed.length } };
}

/** Hands the zip to the browser as a download. */
export function saveZip(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
