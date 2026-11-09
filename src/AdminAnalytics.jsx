import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { RefreshCw, Download, Users, Clock, BookCheck, Activity, Search } from 'lucide-react';
import { downloadCsv, toCsv, downloadText } from './csv.js';

const hours = (sec) => (sec / 3600);
const fmtH = (sec) => { const h = hours(sec); return h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1); };
const fmtMin = (sec) => (sec ? `${Math.round(sec / 60)} min` : '—');
const pct = (x) => `${Math.round(x * 100)}%`;
const dateStamp = () => new Date().toISOString().slice(0, 10);

function Bars({ data, valueKey, color, format }) {
  const max = Math.max(1, ...data.map((d) => d[valueKey]));
  return (
    <div>
      <div className="flex items-end gap-[3px] h-32">
        {data.map((d) => (
          <div key={d.date} title={`${d.date}: ${format(d[valueKey])}`} className="flex-1 flex flex-col justify-end h-full">
            <div className={`${color} rounded-t-sm min-h-[2px]`} style={{ height: `${Math.max(2, (d[valueKey] / max) * 100)}%`, opacity: d[valueKey] ? 1 : 0.25 }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-slate-500 font-mono mt-1"><span>{data[0]?.date.slice(5)}</span><span>{data[data.length - 1]?.date.slice(5)}</span></div>
    </div>
  );
}

export default function AdminAnalytics({ api, books, flash }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState('readers');
  const [cat, setCat] = useState('All');
  const [q, setQ] = useState('');
  const [show, setShow] = useState(20);
  const [rebuild, setRebuild] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try { setData(await api('analytics')); } catch (e) { setErr(e.message); }
    setLoading(false);
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => Object.fromEntries(books.map((b) => [b.id, b])), [books]);
  const rows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.books).filter(([, s]) => s.readers > 0 || s.views > 0 || s.finished > 0).map(([id, s]) => {
      const b = byId[id];
      return {
        id, title: b ? b.title : `(book no longer in Drive: ${id.slice(0, 8)})`, category: b ? b.category : 'Unknown', ...s,
        completion: s.readers ? Math.max(0, s.finished) / s.readers : 0,
        avgFinish: s.finished > 0 ? s.fsec / s.finished : 0,
        quizAvg: s.qcount > 0 ? s.qsum / s.qcount : null,
        approval: s.subm > 0 ? (s.subm - s.rej) / s.subm : null,
      };
    });
  }, [data, byId]);
  const categories = useMemo(() => ['All', ...[...new Set(rows.map((r) => r.category))].sort()], [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const f = rows.filter((r) => (cat === 'All' || r.category === cat) && (!needle || r.title.toLowerCase().includes(needle)));
    const val = { readers: (r) => r.readers, views: (r) => r.views, completion: (r) => r.completion, hours: (r) => r.seconds, quiz: (r) => (r.quizAvg ?? -1), finish: (r) => r.avgFinish };
    return f.sort((a, b) => (val[sort](b) - val[sort](a)) || b.readers - a.readers);
  }, [rows, cat, q, sort]);

  const cats = useMemo(() => {
    const m = {};
    rows.forEach((r) => {
      const c = (m[r.category] = m[r.category] || { category: r.category, books: 0, readers: 0, views: 0, seconds: 0, finished: 0, fsec: 0, qsum: 0, qcount: 0 });
      c.books++; c.readers += r.readers; c.views += r.views; c.seconds += r.seconds; c.finished += Math.max(0, r.finished); c.fsec += r.fsec; c.qsum += r.qsum; c.qcount += r.qcount;
    });
    return Object.values(m).map((c) => ({ ...c, completion: c.readers ? c.finished / c.readers : 0, avgFinish: c.finished ? c.fsec / c.finished : 0, quizAvg: c.qcount ? c.qsum / c.qcount : null })).sort((a, b) => b.readers - a.readers);
  }, [rows]);

  const totals = useMemo(() => {
    const readers = rows.reduce((a, r) => a + r.readers, 0), finished = rows.reduce((a, r) => a + Math.max(0, r.finished), 0);
    return { readers, finished, completion: readers ? finished / readers : 0 };
  }, [rows]);

  const runRebuild = async () => {
    if (!window.confirm('Recount every student\'s reading from their saved progress? This takes a moment and fixes the book totals (daily charts only start from the day analytics was installed).')) return;
    try {
      let offset = 0, r;
      do {
        setRebuild(`Recounting students… ${Math.min(offset, 9999)}`);
        r = await api('rebuildStats', { offset }); offset = r.next;
        setRebuild(`Recounting students… ${Math.min(offset, r.total)} / ${r.total}`);
      } while (!r.done);
      setRebuild(null); flash?.('Analytics recounted.'); load();
    } catch (e) { setRebuild(null); flash?.(e.message); }
  };

  // ----- exports (CSV opens in Excel) -----
  const exportBooks = () => downloadCsv(`book-analytics-${dateStamp()}.csv`,
    ['Title', 'Category', 'Readers', 'Views', 'Hours read', 'Completed', 'Completion rate %', 'Avg time to finish (min)', 'Quiz submissions', 'Quiz rejected', 'Avg quiz score (0-10)', 'Answers rated'],
    shown.map((r) => [r.title, r.category, r.readers, r.views, +(r.seconds / 3600).toFixed(2), Math.max(0, r.finished), Math.round(r.completion * 100), r.avgFinish ? Math.round(r.avgFinish / 60) : '', r.subm, r.rej, r.quizAvg == null ? '' : +r.quizAvg.toFixed(1), r.qcount]));
  const exportCats = () => downloadCsv(`category-analytics-${dateStamp()}.csv`,
    ['Category', 'Books read', 'Readers', 'Views', 'Hours read', 'Completed', 'Completion rate %', 'Avg time to finish (min)', 'Avg quiz score (0-10)'],
    cats.map((c) => [c.category, c.books, c.readers, c.views, +(c.seconds / 3600).toFixed(2), c.finished, Math.round(c.completion * 100), c.avgFinish ? Math.round(c.avgFinish / 60) : '', c.quizAvg == null ? '' : +c.quizAvg.toFixed(1)]));
  const exportEngagement = () => {
    const summary = toCsv(['Metric', 'Value'], [['Report date', dateStamp()], ['Active readers today (DAU)', data.dau], ['Active readers last 7 days (WAU)', data.wau], ['Active readers last 30 days (MAU)', data.mau], ['Total hours read', +(data.totalSeconds / 3600).toFixed(1)], ['Registered students', data.students], ['Overall completion rate %', Math.round(totals.completion * 100)], ['Tracking since', data.trackingSince || '']]);
    const daily = toCsv(['Date', 'Active readers', 'Hours read'], data.days.map((d) => [d.date, d.active, +(d.seconds / 3600).toFixed(2)]));
    downloadText(`engagement-${dateStamp()}.csv`, summary + '\r\n\r\n' + daily);
  };
  const exportBoard = async () => {
    try {
      const { leaderboard } = await api('exportLeaderboard');
      downloadCsv(`leaderboard-${dateStamp()}.csv`, ['Rank', 'Name', 'Email', 'Cohort', 'Books in progress', 'Books finished', 'Quiz points', 'Total points', 'Hours read'],
        leaderboard.map((r) => [r.rank, r.name, r.email, r.cohort, r.inProgress, r.finished, r.quizPts, r.points, +(r.seconds / 3600).toFixed(2)]));
    } catch (e) { flash?.(e.message); }
  };
  const exportStudents = async () => {
    try {
      const d = await api('admin');
      downloadCsv(`students-${dateStamp()}.csv`, ['Name', 'Email', 'Cohort', 'Registered', 'Last login', 'Logins', 'Hours read', 'Books in progress', 'Books finished', 'Points'],
        d.students.map((s) => [s.name, s.email, s.cohort || '', s.registeredAt, s.lastLogin ? s.lastLogin.slice(0, 10) : '', s.loginCount, +(s.seconds / 3600).toFixed(2), s.inProgress, s.finished, s.points]));
    } catch (e) { flash?.(e.message); }
  };

  const card = (Icon, label, value, sub, color = 'text-slate-100') => (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-1 shadow-lg">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-400"><Icon className="w-4 h-4 text-amber-400" />{label}</div>
      <div className={`text-3xl font-extrabold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
  const th = 'py-3 px-3 whitespace-nowrap';
  const btn = 'px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold inline-flex items-center gap-1.5';

  if (err) return <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm">Could not load analytics: {err} <button onClick={load} className="underline font-bold ml-2">Retry</button></div>;
  if (!data) return <div className="p-8 text-center text-slate-400 text-sm flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4 animate-spin text-amber-400" /> Loading analytics...</div>;

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-slate-100 font-serif flex items-center gap-2"><Activity className="w-6 h-6 text-amber-400" /> Analytics & Usage Reports</h2>
          <p className="text-slate-400 text-sm">Reading activity across the whole platform{data.trackingSince ? ` • daily tracking since ${data.trackingSince}` : ''}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={load} className={btn}><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh</button>
          <button onClick={runRebuild} disabled={!!rebuild} className={btn}>{rebuild || 'Recount from student records'}</button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {card(Users, 'Active today (DAU)', data.dau)}
        {card(Users, 'Active 7 days (WAU)', data.wau)}
        {card(Users, 'Active 30 days', data.mau)}
        {card(Clock, 'Hours read', fmtH(data.totalSeconds), 'all time')}
        {card(BookCheck, 'Completion rate', pct(totals.completion), `${totals.finished} of ${totals.readers} reads`, 'text-emerald-400')}
        {card(Users, 'Students', data.students)}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-lg">
          <h3 className="font-bold text-slate-100 text-sm">Active readers per day (last 30 days)</h3>
          <Bars data={data.days} valueKey="active" color="bg-blue-500" format={(v) => `${v} readers`} />
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-lg">
          <h3 className="font-bold text-slate-100 text-sm">Hours read per day (last 30 days)</h3>
          <Bars data={data.days} valueKey="seconds" color="bg-amber-500" format={(v) => `${(v / 3600).toFixed(1)} h`} />
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-bold text-slate-100 text-lg font-serif">By subject / category</h3>
          <button onClick={exportCats} className={btn}><Download className="w-3.5 h-3.5" /> CSV</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[11px] uppercase"><tr>
              <th className={th}>Category</th><th className={th}>Books read</th><th className={th}>Readers</th><th className={th}>Hours</th><th className={th}>Completion</th><th className={th}>Avg time to finish</th><th className={th}>Avg quiz score</th></tr></thead>
            <tbody className="divide-y divide-slate-800">
              {cats.map((c) => (
                <tr key={c.category} className="hover:bg-slate-800/50">
                  <td className="py-3 px-3 font-bold text-slate-100">{c.category}</td><td className="px-3 font-mono">{c.books}</td><td className="px-3 font-mono">{c.readers}</td>
                  <td className="px-3 font-mono">{fmtH(c.seconds)}</td><td className="px-3 font-mono text-emerald-400">{pct(c.completion)}</td><td className="px-3 font-mono">{fmtMin(c.avgFinish)}</td>
                  <td className="px-3 font-mono">{c.quizAvg == null ? '—' : `${c.quizAvg.toFixed(1)} / 10`}</td>
                </tr>
              ))}
              {!cats.length && <tr><td colSpan={7} className="p-6 text-center text-slate-500">No reading recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="font-bold text-slate-100 text-lg font-serif">Book analytics</h3>
          <div className="flex flex-wrap gap-2">
            <div className="relative"><Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => { setQ(e.target.value); setShow(20); }} placeholder="Search book..." className="pl-8 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-500 text-xs w-44 focus:outline-none focus:ring-2 focus:ring-amber-500" /></div>
            <select value={cat} onChange={(e) => { setCat(e.target.value); setShow(20); }} className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-300 text-xs">{categories.map((c) => <option key={c}>{c}</option>)}</select>
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-300 text-xs">
              <option value="readers">Most readers</option><option value="views">Most views</option><option value="completion">Highest completion rate</option><option value="hours">Most hours read</option><option value="quiz">Highest quiz score</option><option value="finish">Longest time to finish</option></select>
            <button onClick={exportBooks} className={btn}><Download className="w-3.5 h-3.5" /> CSV</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[11px] uppercase"><tr>
              <th className={th}>#</th><th className={th}>Book</th><th className={th}>Category</th><th className={th}>Readers</th><th className={th}>Views</th><th className={th}>Hours</th><th className={th}>Completed</th><th className={th}>Completion</th><th className={th}>Avg finish</th><th className={th}>Quiz approved</th><th className={th}>Avg quiz</th></tr></thead>
            <tbody className="divide-y divide-slate-800">
              {shown.slice(0, show).map((r, i) => (
                <tr key={r.id} className="hover:bg-slate-800/50">
                  <td className="py-3 px-3 font-mono text-slate-500">{i + 1}</td><td className="px-3 font-bold text-slate-100 max-w-[260px] truncate" title={r.title}>{r.title}</td>
                  <td className="px-3 text-slate-400">{r.category}</td><td className="px-3 font-mono">{r.readers}</td><td className="px-3 font-mono text-blue-300">{r.views}</td>
                  <td className="px-3 font-mono">{fmtH(r.seconds)}</td><td className="px-3 font-mono">{Math.max(0, r.finished)}</td><td className="px-3 font-mono text-emerald-400">{pct(r.completion)}</td>
                  <td className="px-3 font-mono">{fmtMin(r.avgFinish)}</td><td className="px-3 font-mono">{r.approval == null ? '—' : pct(r.approval)}</td>
                  <td className="px-3 font-mono">{r.quizAvg == null ? '—' : `${r.quizAvg.toFixed(1)}/10`}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={11} className="p-6 text-center text-slate-500">No books match. If students have already read before analytics was installed, press "Recount from student records".</td></tr>}
            </tbody>
          </table>
        </div>
        {shown.length > show && <div className="text-center"><button onClick={() => setShow((n) => n + 20)} className={btn}>Show more ({shown.length - show} remaining)</button></div>}
        <p className="text-[11px] text-slate-500">Avg quiz = the 0–10 score library staff give when they review a student's answers (open a student profile in the Admin Dashboard). "Quiz approved" = answers not rejected by staff.</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-lg">
        <h3 className="font-bold text-slate-100 text-lg font-serif flex items-center gap-2"><Download className="w-5 h-5 text-amber-400" /> Export for library reports (CSV, opens in Excel)</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={exportEngagement} className={btn}><Download className="w-3.5 h-3.5" /> Engagement summary (DAU / WAU / hours)</button>
          <button onClick={exportBooks} className={btn}><Download className="w-3.5 h-3.5" /> Book analytics</button>
          <button onClick={exportCats} className={btn}><Download className="w-3.5 h-3.5" /> Category analytics</button>
          <button onClick={exportBoard} className={btn}><Download className="w-3.5 h-3.5" /> Leaderboard rankings</button>
          <button onClick={exportStudents} className={btn}><Download className="w-3.5 h-3.5" /> All students</button>
        </div>
      </div>
    </div>
  );
}
