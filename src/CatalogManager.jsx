import React, { useMemo, useState } from 'react';
import { Pencil, Search, Star, GraduationCap, Tag, X, Check, AlertCircle, UserCheck } from 'lucide-react';

const inputCls = 'w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500';
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Edit one book's title / author / category / tags / featured / required-for-cohorts. Drive files are never touched.
export function BookEditor({ book, categories, cohorts, professors = [], api, onClose, onSaved }) {
  const o = book.orig || { title: book.title, author: book.author, category: book.category };
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [category, setCategory] = useState(book.category);
  const [tags, setTags] = useState((book.tags || []).join(', '));
  const [featured, setFeatured] = useState(!!book.featured);
  const [required, setRequired] = useState((book.required || []).join(', '));
  const [advisors, setAdvisors] = useState((book.metaAdvisors || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (meta) => {
    setBusy(true); setError('');
    try {
      const d = await api('setMeta', { bookId: book.id, title: o.title, meta });
      onSaved(book.id, d.meta); onClose();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const submit = (e) => {
    e.preventDefault();
    save({
      title: title.trim() && title.trim() !== o.title ? title.trim() : '',
      author: author.trim() && author.trim() !== o.author ? author.trim() : '',
      category: category.trim() && category.trim() !== o.category ? category.trim() : '',
      tags: split(tags), featured, required: split(required), advisors: split(advisors),
    });
  };
  const label = 'text-xs font-semibold text-slate-300';
  return (
    <div className="fixed inset-0 z-[65] bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-xl w-full space-y-4 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button type="button" onClick={onClose} className="absolute top-5 right-5 text-slate-400 hover:text-slate-100"><X className="w-5 h-5" /></button>
        <div><h3 className="text-lg font-bold text-slate-100 font-serif flex items-center gap-2"><Pencil className="w-5 h-5 text-amber-400" /> Edit book details</h3>
          <p className="text-[11px] text-slate-400 mt-1">Changes are saved in the portal and shown to everyone. The file in Google Drive is not changed.</p></div>
        <label className="block space-y-1"><span className={label}>Title</span><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
          {title !== o.title && <span className="text-[10px] text-slate-500">Drive name: {o.title}</span>}</label>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block space-y-1"><span className={label}>Author</span><input className={inputCls} value={author} onChange={(e) => setAuthor(e.target.value)} /></label>
          <label className="block space-y-1"><span className={label}>Category</span>
            <input className={inputCls} list="cat-options" value={category} onChange={(e) => setCategory(e.target.value)} />
            <datalist id="cat-options">{categories.map((c) => <option key={c} value={c} />)}</datalist></label>
        </div>
        <label className="block space-y-1"><span className={label}>Custom tags <span className="font-normal text-slate-500">(comma separated, e.g. Python, Beginner)</span></span>
          <input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3">
          <label className="block space-y-1"><span className={`${label} flex items-center gap-1.5`}><UserCheck className="w-4 h-4 text-amber-400" /> CamTech Advisor — recommended by <span className="font-normal text-slate-500">(professor names, comma separated)</span></span>
            <input className={inputCls} list="prof-options" placeholder="e.g. Dr. Sok Dara, Prof. Lim" value={advisors} onChange={(e) => setAdvisors(e.target.value)} />
            <datalist id="prof-options">{professors.map((c) => <option key={c} value={c} />)}</datalist>
            {book.zone === 'advisor' && <span className="block text-[10px] text-slate-500">This file is stored in the CamTech Advisor folder{book.folderProf ? ` › ${book.folderProf}` : ''}, so it is already listed under that professor.</span>}</label>
          <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer"><input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} className="accent-amber-500 w-4 h-4" />
            <Star className="w-4 h-4 text-amber-400" /> <b>Featured</b> — pin to the top of the catalog</label>
          <label className="block space-y-1"><span className={`${label} flex items-center gap-1.5`}><GraduationCap className="w-4 h-4 text-blue-400" /> Course Required for cohorts <span className="font-normal text-slate-500">(comma separated; ALL = every student)</span></span>
            <input className={inputCls} list="cohort-options" placeholder="e.g. CS-Y1, IT-Y2 or ALL" value={required} onChange={(e) => setRequired(e.target.value)} />
            <datalist id="cohort-options">{['ALL', ...cohorts].map((c) => <option key={c} value={c} />)}</datalist></label>
          <p className="text-[10px] text-slate-500">Students set their cohort when they register or in their account settings; you can also set it on the student's profile. Matching students see a "Required" badge.</p>
        </div>
        {error && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /> {error}</div>}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={busy} className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-[#020617] font-bold text-sm flex items-center justify-center gap-2"><Check className="w-4 h-4" /> {busy ? 'Saving...' : 'Save changes'}</button>
          {book.edited && <button type="button" disabled={busy} onClick={() => window.confirm('Remove all edits and use the Google Drive values again?') && save({})} className="px-4 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold">Reset to Drive</button>}
        </div>
      </form>
    </div>
  );
}

export default function CatalogManager({ books, categories, cohorts, professors = [], api, onSaved, flash }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [flag, setFlag] = useState('all');
  const [show, setShow] = useState(50);
  const [edit, setEdit] = useState(null);

  const counts = useMemo(() => ({ edited: books.filter((b) => b.edited).length, featured: books.filter((b) => b.featured).length, required: books.filter((b) => (b.required || []).length).length, advisor: books.filter((b) => (b.advisors || []).length).length }), [books]);
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return books.filter((b) => {
      const hay = `${b.title} ${b.author} ${(b.tags || []).join(' ')} ${(b.advisors || []).join(' ')}`.toLowerCase();
      return (!words.length || words.every((w) => hay.includes(w)))
        && (cat === 'All' || b.category === cat)
        && (flag === 'all' || (flag === 'edited' && b.edited) || (flag === 'featured' && b.featured) || (flag === 'required' && (b.required || []).length) || (flag === 'advisor' && (b.advisors || []).length));
    });
  }, [books, q, cat, flag]);

  const th = 'py-3 px-3 whitespace-nowrap';
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100 font-serif flex items-center gap-2"><Pencil className="w-6 h-6 text-amber-400" /> Catalog Manager</h2>
        <p className="text-slate-400 text-sm">Fix titles, authors and categories, add tags, pin featured books and mark course-required reading — no need to re-upload to Google Drive.</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl">
        {[['Edited', counts.edited, 'text-amber-400'], ['Featured', counts.featured, 'text-amber-400'], ['Required reading', counts.required, 'text-blue-400'], ['CamTech Advisor', counts.advisor, 'text-amber-400']].map(([l, v, c]) => (
          <div key={l} className="bg-slate-900 border border-slate-800 rounded-2xl p-4"><div className="text-[10px] uppercase font-bold text-slate-400">{l}</div><div className={`text-2xl font-extrabold font-mono ${c}`}>{v}</div></div>))}
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-lg">
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[200px]"><Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShow(50); }} placeholder="Search title, author or tag..." className="w-full pl-9 pr-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" /></div>
          <select value={cat} onChange={(e) => { setCat(e.target.value); setShow(50); }} className="px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-300 text-sm"><option>All</option>{categories.map((c) => <option key={c}>{c}</option>)}</select>
          <select value={flag} onChange={(e) => { setFlag(e.target.value); setShow(50); }} className="px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-300 text-sm">
            <option value="all">All books</option><option value="edited">Edited only</option><option value="featured">Featured only</option><option value="required">Required reading only</option><option value="advisor">CamTech Advisor only</option></select>
        </div>
        <p className="text-[11px] text-slate-500">{list.length} book(s)</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[11px] uppercase"><tr><th className={th}>Title</th><th className={th}>Author</th><th className={th}>Category</th><th className={th}>Collection</th><th className={th}>Tags</th><th className={th}>Status</th><th className={`${th} text-right`}>Action</th></tr></thead>
            <tbody className="divide-y divide-slate-800">
              {list.slice(0, show).map((b) => (
                <tr key={b.id} className="hover:bg-slate-800/50">
                  <td className="py-3 px-3 font-bold text-slate-100 max-w-[280px] truncate" title={b.title}>{b.title}</td>
                  <td className="px-3 text-slate-400 max-w-[160px] truncate">{b.author}</td><td className="px-3 text-slate-300">{b.category}</td>
                  <td className="px-3"><div className="flex flex-wrap gap-1">
                    {b.zone !== 'advisor' && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">STEM</span>}
                    {(b.advisors || []).length > 0 && <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[10px] font-semibold" title={b.advisors.join(', ')}>Advisor: {b.advisors.join(', ')}</span>}</div></td>
                  <td className="px-3"><div className="flex flex-wrap gap-1">{(b.tags || []).map((t) => <span key={t} className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px] inline-flex items-center gap-1"><Tag className="w-2.5 h-2.5" />{t}</span>)}</div></td>
                  <td className="px-3"><div className="flex flex-wrap gap-1">
                    {b.featured && <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-bold">FEATURED</span>}
                    {(b.required || []).length > 0 && <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[10px] font-bold" title={b.required.join(', ')}>REQUIRED: {b.required.join(', ')}</span>}
                    {b.edited && <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">edited</span>}</div></td>
                  <td className="px-3 text-right"><button onClick={() => setEdit(b)} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-[#020617] font-bold text-xs inline-flex items-center gap-1"><Pencil className="w-3 h-3" /> Edit</button></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={7} className="p-6 text-center text-slate-500">No books match.</td></tr>}
            </tbody>
          </table>
        </div>
        {list.length > show && <div className="text-center"><button onClick={() => setShow((n) => n + 50)} className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold">Show more ({list.length - show} remaining)</button></div>}
      </div>
      {edit && <BookEditor book={edit} categories={categories} cohorts={cohorts} professors={professors} api={api} onClose={() => setEdit(null)} onSaved={(id, meta) => { onSaved(id, meta); flash?.('Book details saved.'); }} />}
    </div>
  );
}
