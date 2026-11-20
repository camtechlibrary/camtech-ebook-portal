import * as pdfjsLib from 'pdfjs-dist';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export function isCodeOnlyTitle(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  const withoutLabels = t
    .replace(/\b(?:isbn|doi|pdf|epub|vol|volume|ed|edition|no|id|book|doc|part|pt|ch|chapter|v\d+)\b/gi, '')
    .replace(/[^a-zA-Z]/g, '');
  return withoutLabels.length < 3 && /\d{3,}/.test(t);
}

async function lookupExternalTitle(rawName) {
  const raw = String(rawName || '').replace(/\.(pdf|epub)$/i, '');
  const doiMatch =
    raw.match(/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i) ||
    raw.replace(/[\s_]+/g, '/').match(/(10\.\d{4,9}\/[^\s]+)/i);
  if (doiMatch) {
    try {
      const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doiMatch[1])}`);
      if (res.ok) {
        const data = await res.json();
        const t = data?.message?.title?.[0];
        if (t && !isCodeOnlyTitle(t) && t.length > 3) return t.trim();
      }
    } catch {}
  }

  const digits = raw.replace(/[^0-9X]/gi, '');
  const isbnMatch = digits.match(/(97[89]\d{10}|\d{9}[\dX])/i);
  if (isbnMatch) {
    try {
      const isbn = isbnMatch[1];
      const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      if (res.ok) {
        const data = await res.json();
        const t = data?.[`ISBN:${isbn}`]?.title;
        if (t && !isCodeOnlyTitle(t) && t.length > 3) return t.trim();
      }
    } catch {}
  }
  return null;
}

async function extractPdfCoverPageTitle(url) {
  const loadingTask = pdfjsLib.getDocument({ url, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true });
  const pdf = await loadingTask.promise;
  try {
    // 1. Check embedded PDF Title metadata if valid
    const meta = await pdf.getMetadata().catch(() => null);
    const metaTitle = String(meta?.info?.Title || '').trim();
    if (
      metaTitle.length >= 4 &&
      metaTitle.length <= 160 &&
      !isCodeOnlyTitle(metaTitle) &&
      !/^(untitled|microsoft word|adobe|document|book|cover|page|doi|10\.\d+)/i.test(metaTitle)
    ) {
      return metaTitle.replace(/\s+/g, ' ').trim();
    }

    // 2. Read Page 1 (the Cover Page) text items and pick the largest font-size title lines
    const page = await pdf.getPage(1);
    const textContent = await page.getTextContent();
    const skip = /^(https?:\/\/|www\.|isbn|doi|copyright|all rights reserved|springer|elsevier|wiley|palgrave|cambridge university press|oxford university press|pearson|mcgraw|oreilly|o'reilly|apress|packt|manning|crc press|routledge|volume|vol\.|edition|issn|printed in)/i;

    const items = (textContent.items || [])
      .map((it) => {
        const str = String(it.str || '').replace(/\s+/g, ' ').trim();
        const fontSize = Math.abs(it.transform?.[0] || it.height || 0);
        const y = it.transform?.[5] || 0;
        return { str, fontSize, y };
      })
      .filter((it) => it.str.length >= 2 && /[a-zA-Z]{2,}/.test(it.str) && !skip.test(it.str));

    if (!items.length) return null;

    const maxFont = Math.max(...items.map((i) => i.fontSize));
    // Keep prominent cover text (>= 68% of the largest title font on the cover)
    const headlineItems = items.filter((i) => i.fontSize >= maxFont * 0.68);
    // Sort top-to-bottom on the cover page
    headlineItems.sort((a, b) => b.y - a.y);

    const joined = headlineItems
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);

    if (joined.length >= 4 && !isCodeOnlyTitle(joined)) return joined;
  } finally {
    await pdf.destroy().catch(() => {});
  }
  return null;
}

export async function resolveCoverTitle(book, driveKey) {
  const rawName = book.rawFileName || book.orig?.title || book.title;
  const fromApi = await lookupExternalTitle(rawName);
  if (fromApi) return fromApi;

  if (book.format === 'PDF' && book.driveFileId && driveKey) {
    const url = `https://www.googleapis.com/drive/v3/files/${book.driveFileId}?alt=media&key=${driveKey}`;
    const fromCover = await extractPdfCoverPageTitle(url).catch(() => null);
    if (fromCover) return fromCover;
  }
  return null;
}
