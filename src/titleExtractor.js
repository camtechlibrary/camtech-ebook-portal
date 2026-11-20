import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
export function isCodeOnlyTitle(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  const clean = t.replace(/\b(?:isbn|doi|pdf|epub|vol|volume|ed|edition|no|id|book|doc|part|pt|ch|chapter|v\d+)\b/gi, '').replace(/[^a-zA-Z]/g, '');
  return clean.length < 3 && /\d{3,}/.test(t);
}
async function lookupExternalTitle(rawName) {
  const raw = String(rawName || '').replace(/\.(pdf|epub)$/i, '').trim();
  const digits = raw.replace(/[^0-9X]/gi, '');
  const isbn = (digits.match(/(97[89]\d{10})/) || raw.match(/(?:^|[^0-9])(\d{9}[\dX])(?:[^0-9]|$)/i) || [])[1];
  let doi = (raw.match(/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i) || [])[1];
  if (!doi) {
    const m = raw.match(/^10[\.\s_-](\d{4,9})[%\/\s_-]+(.+)$/);
    if (m) doi = '10.' + m[1] + '/' + (/^97[89][\s_-]*\d/.test(m[2]) ? m[2].trim().replace(/[\s_]+/g, '-') : m[2].trim().replace(/[\s_]+/g, '/'));
  }
  const urls = [
    doi && 'https://api.crossref.org/works/' + encodeURIComponent(doi),
    isbn && 'https://api.crossref.org/works?filter=isbn:' + isbn + '&rows=1',
    isbn && 'https://openlibrary.org/api/books?bibkeys=ISBN:' + isbn + '&format=json&jscmd=data',
    isbn && 'https://www.googleapis.com/books/v1/volumes?q=isbn:' + isbn
  ].filter(Boolean);
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const d = await r.json();
      const t = d?.message?.title?.[0] || d?.message?.items?.[0]?.title?.[0] || d?.['ISBN:' + isbn]?.title || d?.items?.[0]?.volumeInfo?.title;
      if (t && !isCodeOnlyTitle(t) && t.length > 3) return t.replace(/\s+/g, ' ').trim();
    } catch {}
  }
  return null;
}
async function extractPdfCoverPageTitle(url) {
  const pdfjsLib = await import('pdfjs-dist');
  const w = typeof workerUrl !== 'undefined' ? workerUrl : (typeof pdfWorker !== 'undefined' ? pdfWorker : null);
  if (w && pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = w;
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ url, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true }).promise; }
  catch { pdf = await pdfjsLib.getDocument(url).promise; }
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const mt = String(meta?.info?.Title || '').trim();
    if (mt.length >= 4 && mt.length <= 160 && !isCodeOnlyTitle(mt) && !/^(untitled|microsoft word|adobe|document|book|cover|page|doi|10\.\d+|\d+[-_\s]*\d+)/i.test(mt)) return mt.replace(/\s+/g, ' ').trim();
    const skip = /^(https?:\/\/|www\.|isbn|doi|copyright|all rights reserved|springer|elsevier|wiley|palgrave|cambridge university press|oxford university press|pearson|mcgraw|oreilly|o'reilly|apress|packt|manning|crc press|routledge|volume|vol\.|edition|issn|printed in|library of congress|editorial|preface|contents|table of contents|first published|british library)/i;
    for (let p = 1; p <= Math.min(pdf.numPages || 1, 5); p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = (tc.items || []).map((it) => ({ str: String(it.str || '').replace(/\s+/g, ' ').trim(), fs: Math.abs(it.transform?.[0] || it.height || 0), y: it.transform?.[5] || 0 })).filter((it) => it.str.length >= 2 && /[a-zA-Z]{2,}/.test(it.str) && !skip.test(it.str));
      if (!items.length) continue;
      const maxFs = Math.max(...items.map((i) => i.fs));
      const joined = items.filter((i) => i.fs >= maxFs * 0.65).sort((a, b) => b.y - a.y).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      if (joined.length >= 4 && !isCodeOnlyTitle(joined)) return joined;
    }
  } finally { await pdf.destroy().catch(() => {}); }
  return null;
}
export async function resolveCoverTitle(book, driveKey) {
  const fromApi = await lookupExternalTitle(book.rawFileName || book.orig?.title || book.title);
  if (fromApi) return fromApi;
  if (book.format === 'PDF' && book.driveFileId && driveKey) return await extractPdfCoverPageTitle('https://www.googleapis.com/drive/v3/files/' + book.driveFileId + '?alt=media&key=' + driveKey).catch(() => null);
  return null;
}
