// Admin cover generator: makes a small JPEG cover for books that Google Drive has no thumbnail for.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { unzipSync, strFromU8 } from 'fflate';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
const WIDTH = 260;
const noCover = () => new Error('NO_COVER');   // permanent: file has no usable cover

function toJpeg(drawable, w, h) {
  const scale = WIDTH / w;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH; canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(drawable, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.72);
}

// PDF: draw the first page
export async function pdfCover(url) {
  const task = pdfjsLib.getDocument({ url, rangeChunkSize: 1 << 20, disableAutoFetch: true });
  let pdf;
  try { pdf = await task.promise; }
  catch (e) {
    if (e?.name === 'InvalidPDFException') throw new Error('BAD_FILE: Not a valid PDF (damaged file)');
    if (e?.name === 'MissingPDFException') throw new Error('BAD_FILE: File missing (HTTP 404)');
    if (e?.name === 'PasswordException') throw new Error('BAD_FILE: Password-protected PDF');
    throw e;                                  // network / quota problems are not the file's fault
  }
  try {
    const page = await pdf.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: WIDTH / vp0.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally { try { pdf.destroy(); } catch {} }
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function resolve(base, href) {
  const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const part of parts) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return out.join('/');
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// EPUB: find the cover image inside the zip
export async function epubCover(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('NETWORK ' + res.status);
  const data = new Uint8Array(await res.arrayBuffer());
  let files;
  try { files = unzipSync(data, { filter: (f) => /\.(opf|xml|jpe?g|png|gif|webp)$/i.test(f.name) && f.originalSize < 8_000_000 }); }
  catch { throw new Error('BAD_FILE: Not a valid EPUB (cannot open the zip)'); }
  const container = files['META-INF/container.xml'];
  if (!container) throw new Error('BAD_FILE: EPUB is broken (no container.xml)');
  const parser = new DOMParser();
  const opfPath = parser.parseFromString(strFromU8(container), 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !files[opfPath]) throw new Error('BAD_FILE: EPUB is broken (package file missing)');
  const opf = parser.parseFromString(strFromU8(files[opfPath]), 'application/xml');
  const items = [...opf.querySelectorAll('manifest > item')];
  const isImg = (it) => (it.getAttribute('media-type') || '').startsWith('image/');
  let item = items.find((it) => (it.getAttribute('properties') || '').split(/\s+/).includes('cover-image'));
  if (!item) {
    const id = opf.querySelector('metadata meta[name="cover"]')?.getAttribute('content');
    if (id) item = items.find((it) => it.getAttribute('id') === id);
  }
  if (!item || !isImg(item)) item = items.find((it) => isImg(it) && /cover/i.test((it.getAttribute('id') || '') + (it.getAttribute('href') || '')));
  if (!item || !isImg(item)) item = items.find(isImg);
  if (!item) throw noCover();
  const path = resolve(dirOf(opfPath), item.getAttribute('href'));
  const bytes = files[path];
  if (!bytes) throw noCover();
  const ext = path.split('.').pop().toLowerCase();
  const bmp = await createImageBitmap(new Blob([bytes], { type: MIME[ext] || 'image/jpeg' })).catch(() => { throw noCover(); });
  const jpeg = toJpeg(bmp, bmp.width, bmp.height);
  bmp.close?.();
  return jpeg;
}
