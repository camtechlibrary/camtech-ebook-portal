import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

export function isCodeOnlyTitle(title) {
  const t = String(title || '').trim();
  if (!t) return true;
  const withoutLabels = t
    .replace(/\b(?:isbn|doi|pdf|epub|vol|volume|ed|edition|no|id|book|doc|part|pt|ch|chapter|v\d+)\b/gi, '')
    .replace(/[^a-zA-Z]/g, '');
  return withoutLabels.length < 3 && /\d{3,}/.test(t);
}

async function lookupExternalTitle(rawName) {
  const raw = String(rawName || '').replace(/\.(pdf|epub)$/i, '').trim();
  const digits = raw.replace(/[^0-9X]/gi, '');

  // 1. Extract 13-digit ISBN (978/979...) FIRST so leading "101007" doesn't hijack it
  const isbn13Match = digits.match(/(97[89]\d{10})/);
  const isbn10Match = !isbn13Match ? raw.match(/(?:^|[^0-9])(\d{9}[\dX])(?:[^0-9]|$)/i) : null;
  const isbn = isbn13Match ? isbn13Match[1] : isbn10Match ? isbn10Match[1] : null;

  // 2. Reconstruct DOI (handles "10.1007/978-...", "10_1007_978...", and "10 1007%978 3 030 26686 4")
  let doi = null;
  const standardDoi = raw.match(/(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)/i);
  if (standardDoi) {
    doi = standardDoi[1];
  } else {
    const mangledDoi = raw.match(/^10[\.\s_-](\d{4,9})[%\/\s_-]+(.+)$/);
    if (mangledDoi) {
      const registrant = mangledDoi[1];
      let suffix = mangledDoi[2].trim();
      if (/^97[89][\s_-]*\d/.test(suffix)) {
        // Springer / academic ISBN-DOI format: 10.1007/978-3-030-26686-4
        suffix = suffix.replace(/[\s_]+/g, '-');
      } else {
        suffix = suffix.replace(/[\s_]+/g, '/');
      }
      doi = `10.${registrant}/${suffix}`;
    }
  }

  // Try Crossref (DOI)
  if (doi) {
    try {
      const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (res.ok) {
        const data = await res.json();
        const t = data?.message?.title?.[0];
        if (t && !isCodeOnlyTitle(t) && t.length > 3) return t.replace(/\s+/g, ' ').trim();
      }
    } catch {}
  }

  // Try OpenLibrary (ISBN)
  if (isbn) {
    try {
      const res = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
      if (res.ok) {
        const data = await res.json();
        const t = data?.[`ISBN:${isbn}`]?.title;
        if (t && !isCodeOnlyTitle(t) && t.length > 3) return t.replace(/\s+/g, ' ').trim();
      }
    } catch {}

    // Try Google Books API (ISBN)
    try {
      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
      if (res.ok) {
        const data = await res.json();
        const t = data?.items?.[0]?.volumeInfo?.title;
        if (t && !isCodeOnlyTitle(t) && t.length > 3) return t.replace(/\s+/g, ' ').trim();
      }
    } catch {}
  }

  return null;
}

async function extractPdfCoverPageTitle(url) {
  const pdfjsLib = await import('pdfjs-dist');
  const workerVar = typeof workerUrl !== 'undefined' ? workerUrl : (typeof pdfWorker !== 'undefined' ? pdfWorker : null);
  if (workerVar && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerVar;
  }
  const loadingTask = pdfjsLib.getDocument({ url, rangeChunkSize: 65536, disableAutoFetch: true, disableStream: true });
  const pdf = await loadingTask.promise;
  try {
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
    const headlineItems = items.filter((i) => i.fontSize >= maxFont * 0.68);
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
