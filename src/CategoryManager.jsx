import React, { useMemo, useState } from 'react';
import { X, Plus, Trash2, ArrowUp, ArrowDown, Check, AlertCircle, Undo2, Tag } from 'lucide-react';

const inputCls = 'w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500';

// Add / rename / remove / reorder the category buttons shown in the catalog.
export default function CategoryManager({ config, books, onSave, onClose }) {
  const [rows, setRows] = useState(() => config.list.map((n, i) => ({ key: `r${i}`, orig: n, name: n, removed: false, moveKey: '' })));
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const counts = useMemo(() => { const m = {}; books.forEach((b) => { m[b.category] = (m[b.category] || 0) + 1; }); return m; }, [books]);
  const active = rows.filter((r) => !r.removed);
  const patch = (key, p) => setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const countOf = (r) => (r.orig ? counts[r.orig] || 0 : 0);

  const move = (key, dir) => setRows((cur) => {
    const list = cur.slice(); const i = list.findIndex((r) => r.key === key);
    let j = i + dir; while (list[j] && list[j].removed) j += dir;
    if (!list[j]) return cur;
    [list[i], list[j]] = [list[j], list[i]]; return list;
  });
  const add = () => {
    const n = newName.trim();
    if (!n) return;
    if (n.length > 40) { setError('A category name can have at most 40 characters.'); return; }
    if (active.some((r) => r.name.trim().toLowerCase() === n.toLowerCase())) { setError(`"${n}" already exists.`); return; }
    setRows((cur) => [...cur, { key: `n${Date.now()}`, orig: null, name: n, removed: false, moveKey: '' }]);
    setNewName(''); setError('');
  };
  const remove = (r) => {
    if (active.length <= 1) { setError('Keep at least one category.'); return; }
    const target = active.find((x) => x.key !== r.key);
    patch(r.key, { removed: true, moveKey: target.key }); setError('');
  };

  const save = async () => {
    setError('');
    const names = active.map((r) => r.name.trim());
    if (names.some((n) => !n)) return setError('A category name cannot be empty.');
    if (names.some((n) => n.length > 40)) return setError('A category name can have at most 40 characters.');
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return setError('Two categories have the same name.');
    if (!names.length) return setError('Keep at least one category.');
    const alias = { ...config.alias };
    rows.forEach((r) => { if (r.orig && !r.removed && r.name.trim() !== r.orig) alias[r.orig] = r.name.trim(); });             // renamed
    rows.forEach((r) => {                                                                                                          // removed: books move
      if (r.orig && r.removed) { const t = rows.find((x) => x.key === r.moveKey && !x.removed) || active[0]; alias[r.orig] = t.name.trim(); }
    });
    names.forEach((n) => { delete alias[n]; });                                                                                    // a listed name is never an alias
    const resolve = (n, d = 0) => (alias[n] && d < 8 ? resolve(alias[n], d + 1) : n);
    const out = {};
    Object.keys(alias).forEach((k) => { const t = resolve(k); if (t !== k && names.includes(t)) out[k] = t; });
    setBusy(true);
    try { await onSave({ list: names, alias: out }); onClose(); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[65] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-xl w-full space-y-4 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-5 right-5 text-slate-400 hover:text-slate-100"><X className="w-5 h-5" /></button>
        <div><h3 className="text-lg font-bold text-slate-100 font-serif flex items-center gap-2"><Tag className="w-5 h-5 text-amber-400" /> Manage categories</h3>
          <p className="text-[11px] text-slate-400 mt-1">These are the buttons under the search bar. Rename a category, add a new one, change the order, or remove one (its books move to another category).</p></div>

        <div className="space-y-2">
          {rows.map((r, idx) => r.removed ? (
            <div key={r.key} className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2"><span className="text-sm text-slate-400 line-through">{r.orig}</span>
                <button onClick={() => patch(r.key, { removed: false })} className="text-xs text-slate-300 hover:text-amber-400 flex items-center gap-1"><Undo2 className="w-3.5 h-3.5" /> Undo</button></div>
              <div className="flex items-center gap-2 text-xs text-slate-300 flex-wrap">
                {countOf(r)} book(s) move to
                <select value={r.moveKey} onChange={(e) => patch(r.key, { moveKey: e.target.value })} className="px-2 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 text-xs">
                  {active.map((x) => <option key={x.key} value={x.key}>{x.name || '(unnamed)'}</option>)}</select>
              </div>
            </div>
          ) : (
            <div key={r.key} className="flex items-center gap-2">
              <div className="flex flex-col">
                <button onClick={() => move(r.key, -1)} disabled={idx === 0} className="text-slate-500 hover:text-amber-400 disabled:opacity-30"><ArrowUp className="w-3.5 h-3.5" /></button>
                <button onClick={() => move(r.key, 1)} className="text-slate-500 hover:text-amber-400"><ArrowDown className="w-3.5 h-3.5" /></button>
              </div>
              <input className={inputCls} value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} />
              <span className="shrink-0 text-[11px] font-mono text-slate-400 w-20 text-right">{r.orig ? `${countOf(r)} ${countOf(r) === 1 ? 'book' : 'books'}` : 'new'}</span>
              <button onClick={() => remove(r)} title="Remove this category" className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-1">
          <input className={inputCls} placeholder="New category name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
          <button onClick={add} className="px-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap"><Plus className="w-4 h-4" /> Add</button>
        </div>
        <p className="text-[10px] text-slate-500">New books are sorted into a category automatically by their file name. A book can always be moved with its own Edit button.</p>

        {error && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /> {error}</div>}
        <div className="flex gap-2">
          <button onClick={save} disabled={busy} className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-[#020617] font-bold text-sm flex items-center justify-center gap-2"><Check className="w-4 h-4" /> {busy ? 'Saving...' : 'Save categories'}</button>
          <button onClick={onClose} className="px-5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold">Cancel</button>
        </div>
      </div>
    </div>
  );
}
