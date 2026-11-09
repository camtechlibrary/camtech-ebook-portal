import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, AlertTriangle, PlusCircle, MinusCircle, LinkIcon, FileWarning, CheckCircle, Info, ExternalLink } from 'lucide-react';

const ago = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'Just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return `${Math.floor(s / 86400)} d ago`;
};
const TYPES = {
  new: { label: 'New book', cls: 'bg-emerald-500/20 text-emerald-400', Icon: PlusCircle },
  removed: { label: 'Removed', cls: 'bg-slate-700/60 text-slate-300', Icon: MinusCircle },
  skipped: { label: 'Skipped file', cls: 'bg-amber-500/20 text-amber-400', Icon: FileWarning },
  parse: { label: 'Could not read', cls: 'bg-rose-500/20 text-rose-400', Icon: FileWarning },
  broken: { label: 'Broken link', cls: 'bg-rose-500/20 text-rose-400', Icon: LinkIcon },
  error: { label: 'Scan error', cls: 'bg-rose-500/20 text-rose-400', Icon: AlertTriangle },
  baseline: { label: 'First scan', cls: 'bg-blue-500/20 text-blue-400', Icon: Info },
  sync: { label: 'Info', cls: 'bg-blue-500/20 text-blue-400', Icon: Info },
};
const PROBLEM = ['skipped', 'parse', 'broken', 'error'];

export default function SyncPanel({ api, books, driveKey, scanInfo, syncStamp, flash }) {
  const [status, setStatus] = useState(null);
  const [filter, setFilter] = useState('all');
  const [link, setLink] = useState({ running: false, done: 0, total: 0, broken: 0 });
  const stop = useRef(false);

  const load = useCallback(async () => { try { setStatus(await api('syncStatus')); } catch (e) { flash?.(e.message); } }, [api, flash]);
  useEffect(() => { load(); }, [load, syncStamp]);

  // Check every book's Drive link (metadata only - no download)
  const checkLinks = async () => {
    stop.current = false;
    const known = new Set((status?.issues || []).filter((i) => i.type === 'broken' || i.type === 'parse').map((i) => i.id));
    const list = books.slice();
    setLink({ running: true, done: 0, total: list.length, broken: 0 });
    let i = 0, done = 0, broken = 0, bad = [], good = [];
    const flush = async () => {
      if (!bad.length && !good.length) return;
      const issues = bad.splice(0), resolve = good.splice(0);
      try { await api('reportIssues', { issues, resolve }); } catch {}
    };
    const worker = async () => {
      while (!stop.current) {
        const b = list[i++]; if (!b) break;
        try {
          const r = await fetch(`https://www.googleapis.com/drive/v3/files/${b.driveFileId}?fields=id,trashed,size&supportsAllDrives=true&key=${driveKey}`);
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            bad.push({ id: b.id, title: b.title, type: 'broken', reason: r.status === 404 ? 'File not found or not shared (HTTP 404)' : `Drive error HTTP ${r.status}${j.error?.message ? ': ' + j.error.message.slice(0, 80) : ''}` });
            broken++;
          } else {
            const j = await r.json();
            if (j.trashed) { bad.push({ id: b.id, title: b.title, type: 'broken', reason: 'File is in the Drive trash' }); broken++; }
            else if (j.size === '0') { bad.push({ id: b.id, title: b.title, type: 'parse', reason: 'Empty file (0 bytes)' }); broken++; }
            else if (known.has(b.id)) good.push(b.id);
          }
        } catch (e) { /* network hiccup: skip, do not report */ }
        done++;
        if (done % 25 === 0) { setLink({ running: true, done, total: list.length, broken }); if (bad.length + good.length >= 40) await flush(); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    await flush();
    setLink({ running: false, done, total: list.length, broken });
    flash?.(stop.current ? 'Link check stopped.' : `Link check finished: ${broken} problem(s).`);
    load();
  };
  const clearAll = async () => {
    if (!window.confirm('Clear the list of problem files? They will reappear if they are still a problem the next time you scan or check.')) return;
    try { await api('clearIssues'); load(); } catch (e) { flash?.(e.message); }
  };

  const last = status?.last;
  const issues = status?.issues || [];
  const log = (status?.log || []).filter((e) => filter === 'all' || (filter === 'problems' ? PROBLEM.includes(e.type) : e.type === filter));
  const card = (label, value, sub, color = 'text-slate-100') => (
    <div className="bg-slate-950 p-4 rounded-xl border border-slate-800"><div className="text-slate-400 uppercase font-bold text-[10px]">{label}</div><div className={`text-2xl font-mono font-bold ${color}`}>{value}</div>{sub && <div className="text-[10px] text-slate-500">{sub}</div>}</div>
  );
  const chip = (id, label) => <button key={id} onClick={() => setFilter(id)} className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold ${filter === id ? 'bg-amber-500 text-[#020617]' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>{label}</button>;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6 shadow-xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div><h3 className="text-xl font-bold text-slate-100 font-serif">Sync status & problem log</h3>
          <p className="text-slate-400 text-xs">New books, removed books and problem files found in the Google Drive repository. Updated each time an admin opens the site or presses Resync.</p></div>
        <button onClick={load} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold inline-flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
      </div>

      {scanInfo?.errors?.length > 0 && (
        <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs space-y-1"><div className="font-bold flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> The last scan was incomplete</div>{scanInfo.errors.map((e, i) => <div key={i}>{e}</div>)}</div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {card('Books in catalog', books.length.toLocaleString())}
        {card('Last sync', last ? ago(last.ts) : '—', last ? new Date(last.ts).toLocaleString() : 'not recorded yet')}
        {card('New (last scan)', last ? last.newCount : '—', null, 'text-emerald-400')}
        {card('Removed (last scan)', last ? last.removedCount : '—')}
        {card('Open problems', issues.length, null, issues.length ? 'text-rose-400' : 'text-emerald-400')}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h4 className="font-bold text-slate-100 text-sm flex items-center gap-2"><LinkIcon className="w-4 h-4 text-amber-400" /> Broken link check</h4>
          <div className="flex gap-2">
            {!link.running
              ? <button onClick={checkLinks} disabled={!books.length || !driveKey} className="px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#020617] font-bold text-xs">Check all links now</button>
              : <button onClick={() => { stop.current = true; }} className="px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs">Stop</button>}
            {issues.length > 0 && <button onClick={clearAll} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold">Clear list</button>}
          </div>
        </div>
        <p className="text-[11px] text-slate-500">Asks Google Drive about every book (no file is downloaded) and lists files that are missing, not shared, in the trash or empty. About a minute per 1,000 books.</p>
        {link.total > 0 && (
          <div className="space-y-1"><div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${Math.round((link.done / link.total) * 100)}%` }} /></div>
            <div className="text-[11px] text-slate-400">{link.done} / {link.total} checked • {link.broken} problem(s) found</div></div>)}
      </div>

      <div className="space-y-3">
        <h4 className="font-bold text-slate-100 text-sm flex items-center gap-2"><FileWarning className="w-4 h-4 text-rose-400" /> Problem files ({issues.length})</h4>
        {!issues.length ? <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs flex items-center gap-2"><CheckCircle className="w-4 h-4" /> No problem files recorded.</div> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[11px] uppercase"><tr><th className="p-3">Type</th><th className="p-3">Book / file</th><th className="p-3">Problem</th><th className="p-3">Found</th><th className="p-3 text-right">Open</th></tr></thead>
            <tbody className="divide-y divide-slate-800">{issues.slice(0, 100).map((it) => {
              const t = TYPES[it.type] || TYPES.parse;
              return (<tr key={it.id} className="hover:bg-slate-800/50">
                <td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.cls}`}>{t.label}</span></td>
                <td className="p-3 font-bold text-slate-100 max-w-[280px] truncate" title={it.title}>{it.title || it.id}</td>
                <td className="p-3 text-slate-300">{it.reason}</td><td className="p-3 text-slate-500 whitespace-nowrap">{ago(it.ts)}</td>
                <td className="p-3 text-right"><a href={`https://drive.google.com/file/d/${it.id}/view`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-amber-400 hover:underline"><ExternalLink className="w-3 h-3" /> Drive</a></td></tr>);
            })}</tbody></table>{issues.length > 100 && <p className="text-[11px] text-slate-500 p-2">Showing the 100 newest of {issues.length}.</p>}</div>)}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h4 className="font-bold text-slate-100 text-sm">Activity log</h4>
          <div className="flex flex-wrap gap-1.5">{chip('all', 'All')}{chip('new', 'New books')}{chip('removed', 'Removed')}{chip('problems', 'Problems')}</div>
        </div>
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {log.map((e, i) => {
            const t = TYPES[e.type] || TYPES.sync; const Icon = t.Icon;
            return (<div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs">
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${t.cls.split(' ')[1]}`} />
              <div className="flex-1 min-w-0"><div className="flex items-center gap-2 flex-wrap"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${t.cls}`}>{t.label}</span><span className="font-semibold text-slate-100 break-words">{e.title}</span></div>
                {e.detail && <div className="text-slate-400 mt-0.5 break-words">{e.detail}</div>}</div>
              <span className="text-slate-500 font-mono text-[11px] shrink-0">{ago(e.ts)}</span></div>);
          })}
          {!log.length && <div className="p-6 text-center text-slate-500 text-xs">Nothing logged yet. Press "Resync from Drive" to scan.</div>}
        </div>
      </div>
    </div>
  );
}
