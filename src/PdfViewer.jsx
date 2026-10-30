import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import { Plus, Minus, RefreshCw } from 'lucide-react';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// In-site PDF reader: knows the real page number, restores the last page, renders only pages near the screen.
export default function PdfViewer({ url, startPage = 1, onLive, onSave, onError }) {
  const wrapRef = useRef(null);
  const pagesRef = useRef([]);
  const pdfRef = useRef(null);
  const [numPages, setNumPages] = useState(0);
  const [base, setBase] = useState(null);           // page 1 size at scale 1
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(startPage);
  const [jump, setJump] = useState(String(startPage));
  const [loading, setLoading] = useState(true);

  const currentRef = useRef(startPage);
  const savedRef = useRef(0);
  const timerRef = useRef(null);
  const startedRef = useRef(false);
  const cb = useRef({ onLive, onSave, onError });
  cb.current = { onLive, onSave, onError };
  const totalRef = useRef(0);
  totalRef.current = numPages;

  const flush = () => {
    clearTimeout(timerRef.current);
    if (totalRef.current && currentRef.current !== savedRef.current) {
      savedRef.current = currentRef.current;
      cb.current.onSave?.(currentRef.current, totalRef.current);
    }
  };

  // ---- load document ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const task = pdfjsLib.getDocument({ url, rangeChunkSize: 1 << 20, disableAutoFetch: true });
    task.promise.then(async (pdf) => {
      if (cancelled) { pdf.destroy(); return; }
      pdfRef.current = pdf;
      const p1 = await pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      if (cancelled) return;
      setBase({ w: vp.width, h: vp.height });
      setNumPages(pdf.numPages);
      setLoading(false);
    }).catch((e) => { if (!cancelled) cb.current.onError?.(e); });
    return () => { cancelled = true; try { task.destroy(); } catch {} pdfRef.current = null; };
  }, [url]);

  // ---- width of the reading area ----
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scale = base && width ? Math.min(2.2, Math.max(0.3, (width - 24) / base.w)) * zoom : 0;

  const scrollToPage = (n) => {
    const el = pagesRef.current[n - 1];
    if (el && wrapRef.current) wrapRef.current.scrollTop = el.offsetTop - 8;
  };

  // ---- first scroll to saved page; keep current page when zoom/resize changes ----
  useLayoutEffect(() => {
    if (!numPages || !scale) return;
    const target = startedRef.current ? currentRef.current : Math.min(Math.max(1, startPage), numPages);
    startedRef.current = true;
    scrollToPage(target);
    currentRef.current = target; setCurrent(target); setJump(String(target));
    if (savedRef.current === 0) savedRef.current = target;
    cb.current.onLive?.(target, numPages);
  }, [numPages, scale]);

  // ---- render only pages near the viewport ----
  useEffect(() => {
    if (!numPages || !scale || !pdfRef.current) return;
    const live = new Map();   // page -> { canvas, task }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const render = async (n) => {
      if (live.has(n)) return;
      const holder = pagesRef.current[n - 1];
      const canvas = document.createElement('canvas');
      const entry = { canvas, task: null };
      live.set(n, entry);
      try {
        const page = await pdfRef.current.getPage(n);
        if (!live.has(n)) return;
        const vp = page.getViewport({ scale });
        canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
        holder.style.width = `${vp.width}px`; holder.style.height = `${vp.height}px`;
        entry.task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
        await entry.task.promise;
        if (live.has(n)) holder.appendChild(canvas);
      } catch (e) { /* cancelled renders are normal */ }
    };
    const drop = (n) => {
      const e = live.get(n);
      if (!e) return;
      try { e.task?.cancel(); } catch {}
      e.canvas.remove(); live.delete(n);
    };
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = Number(en.target.dataset.page);
        en.isIntersecting ? render(n) : drop(n);
      }
    }, { root: wrapRef.current, rootMargin: '1500px 0px' });
    pagesRef.current.forEach((el) => el && io.observe(el));
    return () => { io.disconnect(); for (const n of [...live.keys()]) drop(n); };
  }, [numPages, scale]);

  // ---- which page is on screen (real page number) ----
  const onScroll = () => {
    const wrap = wrapRef.current, pages = pagesRef.current;
    if (!wrap || !pages.length) return;
    const y = wrap.scrollTop + wrap.clientHeight * 0.3;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pages[mid].offsetTop <= y) lo = mid; else hi = mid - 1; }
    const n = lo + 1;
    if (n !== currentRef.current) {
      currentRef.current = n; setCurrent(n); setJump(String(n));
      cb.current.onLive?.(n, totalRef.current);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 2500);       // save 2.5 s after the student stops scrolling
    }
  };

  // save when leaving / hiding the tab / closing the reader
  useEffect(() => {
    const hide = () => { if (document.hidden) flush(); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', flush);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', flush); flush(); };
  }, []);

  const go = (e) => {
    e.preventDefault();
    const n = Math.min(numPages, Math.max(1, parseInt(jump, 10) || 1));
    scrollToPage(n);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-slate-950">
      <div className="flex items-center justify-center gap-3 py-2 bg-slate-900 border-b border-slate-800 text-xs text-slate-300">
        <form onSubmit={go} className="flex items-center gap-1.5">
          <span>Page</span>
          <input value={jump} onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))} className="w-14 text-center bg-slate-950 border border-slate-700 rounded-md py-1 text-white font-mono" />
          <span className="font-mono">/ {numPages || '…'}</span>
        </form>
        <span className="text-slate-600">|</span>
        <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.15).toFixed(2)))} className="p-1.5 rounded-md bg-slate-800 hover:bg-slate-700"><Minus className="w-4 h-4" /></button>
        <span className="font-mono w-10 text-center">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2)))} className="p-1.5 rounded-md bg-slate-800 hover:bg-slate-700"><Plus className="w-4 h-4" /></button>
      </div>
      <div ref={wrapRef} onScroll={onScroll} className="flex-1 overflow-y-auto overflow-x-auto relative py-3">
        {loading && <div className="absolute inset-0 flex items-center justify-center text-slate-400 text-sm gap-2"><RefreshCw className="w-4 h-4 animate-spin text-amber-400" /> Opening book...</div>}
        {numPages > 0 && scale > 0 && Array.from({ length: numPages }, (_, i) => (
          <div key={i} data-page={i + 1} ref={(el) => (pagesRef.current[i] = el)}
            className="mx-auto mb-3 bg-white shadow-lg relative" style={{ width: base.w * scale, height: base.h * scale }} />
        ))}
      </div>
    </div>
  );
}
