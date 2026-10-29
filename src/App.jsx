import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BookOpen, Search, CheckCircle, Clock, Shield, Grid, List, RefreshCw, Users, Eye,
  LogOut, X, ChevronLeft, Check, Sparkles, HardDrive, BookMarked, AlertCircle,
  Trophy, Medal, Crown, FileText, Timer, Lock
} from 'lucide-react';

// ==========================================
// CONFIG
// ==========================================
const FOLDER_ID = import.meta.env?.VITE_GDRIVE_FOLDER_ID || '15UQ5uulCe7lyz3xQiyZp_5fqHgD59Fa1';
const DRIVE_KEY = import.meta.env?.VITE_GDRIVE_API_KEY || '';
const ALLOWED_DOMAIN = 'camtech.edu.kh';
const ADMIN_EMAILS = ['camtech.library@camtech.edu.kh', 'sp6026010074@camtech.edu.kh'];
const CATEGORIES = ['All', 'Computer Science', 'AI & Data Science', 'Engineering', 'Business', 'GenEd'];
const COLORS = ['from-blue-700 to-indigo-900', 'from-emerald-700 to-teal-900', 'from-amber-600 to-red-800',
  'from-purple-700 to-indigo-950', 'from-slate-800 to-cyan-950', 'from-rose-700 to-pink-900'];
const PAGE_SIZE = 48;

// Must match api/portal.mjs
const MIN_READ_SECONDS = 30 * 60;
const MIN_ANSWER_CHARS = 80;
const HEARTBEAT_MS = 60 * 1000;
const IDLE_PROMPT_MS = 10 * 60 * 1000;

// The same 10 questions for every book
const QUESTIONS = [
  'What is the main topic or central idea of this book?',
  'Who is the intended audience, and who would benefit most from reading it?',
  'What are the three most important things you learned from this book?',
  'Which chapter or section did you find most useful, and why?',
  'What is one idea in the book that you agree with, and why?',
  'What is one idea that you disagree with or question, and why?',
  'How can you apply what you learned to your studies, work or daily life?',
  'How does this book connect to something you learned in class or experienced before?',
  'What was difficult or confusing in this book, and how did you handle it?',
  'Would you recommend this book to a classmate? Explain your opinion.',
];

// ==========================================
// HELPERS
// ==========================================
async function api(action, body = {}) {
  const token = localStorage.getItem('camtech_token');
  const res = await fetch('/api/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || 'Request failed'); err.status = res.status; throw err; }
  return data;
}
const timeAgo = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const fmtTime = (sec = 0) => {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
};

function BookCover({ book, className = '' }) {
  const [stage, setStage] = useState(book.thumbnail ? 0 : 1);
  const src = stage === 0 ? book.thumbnail : stage === 1 ? `https://drive.google.com/thumbnail?id=${book.driveFileId}&sz=w500` : null;
  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${book.coverColor} ${className}`}>
      {src ? (
        <img src={src} alt={`Cover of ${book.title}`} loading="lazy" referrerPolicy="no-referrer"
          onError={() => setStage((x) => x + 1)} className="absolute inset-0 w-full h-full object-cover object-top" />
      ) : (
        <div className="absolute inset-0 p-4 flex flex-col justify-end">
          <p className="text-[10px] text-amber-300 font-bold uppercase tracking-wider">{book.category}</p>
          <h3 className="text-white font-bold text-sm line-clamp-3 leading-snug">{book.title}</h3>
        </div>
      )}
    </div>
  );
}

export default function App() {
  // ---------- session ----------
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(!!localStorage.getItem('camtech_token'));
  const isAdmin = user?.role === 'admin';

  // ---------- auth form ----------
  const [authTab, setAuthTab] = useState('login');
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formConfirmPw, setFormConfirmPw] = useState('');
  const [formAdminCode, setFormAdminCode] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // ---------- server data ----------
  const [views, setViews] = useState({});
  const [progress, setProgress] = useState({});   // MY progress only
  const [board, setBoard] = useState([]);
  const [adminData, setAdminData] = useState(null);
  const [inspect, setInspect] = useState(null);

  // ---------- catalog ----------
  const [books, setBooks] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [lastSync, setLastSync] = useState('');
  const [activeTab, setActiveTab] = useState('catalog');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedFormat, setSelectedFormat] = useState('All');
  const [viewMode, setViewMode] = useState('grid');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // ---------- reader + timer ----------
  const [activeBook, setActiveBook] = useState(null);
  const [idlePrompt, setIdlePrompt] = useState(false);
  const confirmRef = useRef(Date.now());
  const [toast, setToast] = useState('');

  // ---------- quiz ----------
  const [quizBook, setQuizBook] = useState(null);
  const [quizAnswers, setQuizAnswers] = useState([]);
  const [quizError, setQuizError] = useState('');
  const [quizBusy, setQuizBusy] = useState(false);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2600); };

  const loadInit = useCallback(async () => {
    const d = await api('init');
    setUser(d.user); setViews(d.views); setProgress(d.progress); setBoard(d.leaderboard);
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('camtech_token')) return;
    loadInit().catch((e) => { if (e.status === 401) localStorage.removeItem('camtech_token'); })
      .finally(() => setBooting(false));
  }, [loadInit]);

  // ---------- Google Drive catalog (all pages + subfolders) ----------
  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true); setCatalogError('');
    if (!DRIVE_KEY) { setCatalogError('Missing VITE_GDRIVE_API_KEY in Vercel environment variables.'); setCatalogLoading(false); return; }
    try {
      const all = [];
      const queue = [FOLDER_ID];
      while (queue.length) {
        const folder = queue.shift();
        let pageToken = '';
        do {
          const params = new URLSearchParams({
            q: `'${folder}' in parents and trashed=false`, pageSize: '1000', key: DRIVE_KEY,
            fields: 'nextPageToken,files(id,name,mimeType,size,thumbnailLink,createdTime)',
          });
          if (pageToken) params.set('pageToken', pageToken);
          const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error?.message || 'Google Drive request failed');
          for (const f of data.files || []) {
            if (f.mimeType === 'application/vnd.google-apps.folder') { queue.push(f.id); continue; }
            if (f.mimeType.startsWith('application/vnd.google-apps')) continue;
            const n = f.name.toLowerCase();
            const isPdf = f.mimeType === 'application/pdf' || n.endsWith('.pdf');
            const isEpub = f.mimeType === 'application/epub+zip' || n.endsWith('.epub');
            let category = 'GenEd';
            if (/\bai\b|data|python|neural|machine|learning/.test(n)) category = 'AI & Data Science';
            else if (/code|cyber|program|system|software|network|computer/.test(n)) category = 'Computer Science';
            else if (/math|calculus|physics|5g|engineering|control/.test(n)) category = 'Engineering';
            else if (/business|finance|law|market|econom|manage/.test(n)) category = 'Business';
            all.push({
              id: f.id, driveFileId: f.id,
              title: f.name.replace(/\.(pdf|epub)$/i, '').replace(/[_.-]+/g, ' ').trim(),
              author: 'CamTech Academic Press', category, format: isPdf ? 'PDF' : isEpub ? 'EPUB' : 'DOC',
              fileSize: f.size ? (Number(f.size) / 1048576).toFixed(1) + ' MB' : '',
              thumbnail: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, '=s600') : '',
              coverColor: COLORS[[...f.id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length],
            });
          }
          pageToken = data.nextPageToken || '';
        } while (pageToken);
      }
      all.sort((a, b) => a.title.localeCompare(b.title));
      setBooks(all);
      setLastSync(new Date().toLocaleTimeString());
    } catch (e) { setCatalogError(e.message); }
    finally { setCatalogLoading(false); }
  }, []);

  useEffect(() => { if (user) loadCatalog(); }, [user?.email, loadCatalog]);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [searchQuery, selectedCategory, selectedFormat]);

  const loadAdmin = useCallback(async () => { setAdminData(await api('admin')); }, []);
  useEffect(() => { if (isAdmin && activeTab === 'admin') loadAdmin().catch(() => {}); }, [isAdmin, activeTab, loadAdmin]);
  useEffect(() => {
    if (activeTab === 'leaderboard') api('leaderboard').then((d) => setBoard(d.leaderboard)).catch(() => {});
  }, [activeTab]);

  // ---------- reading timer: counts only while reader is open, tab visible and student confirmed ----------
  const activeId = activeBook?.id;
  const activeFinished = !!(activeId && progress[activeId]?.isFinished);
  useEffect(() => {
    if (!activeId || activeFinished || idlePrompt || quizBook) return;
    const id = setInterval(async () => {
      if (document.hidden) return;                                   // tab in background: no time
      if (Date.now() - confirmRef.current > IDLE_PROMPT_MS) { setIdlePrompt(true); return; }
      try {
        const d = await api('heartbeat', { bookId: activeId });
        if (typeof d.seconds === 'number') setProgress((p) => ({ ...p, [activeId]: { ...(p[activeId] || {}), seconds: d.seconds } }));
      } catch {}
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [activeId, activeFinished, idlePrompt, quizBook]);

  // ---------- auth ----------
  const submitAuth = async (e) => {
    e.preventDefault(); setAuthError('');
    const email = formEmail.toLowerCase().trim();
    if (!email.endsWith('@' + ALLOWED_DOMAIN)) { setAuthError(`Only @${ALLOWED_DOMAIN} emails are allowed.`); return; }
    if (authTab === 'register') {
      if (formPassword.length < 6) { setAuthError('Password must be at least 6 characters.'); return; }
      if (formPassword !== formConfirmPw) { setAuthError('Passwords do not match.'); return; }
    }
    setAuthBusy(true);
    try {
      const d = await api(authTab, { email, password: formPassword, name: formName, adminCode: formAdminCode });
      localStorage.setItem('camtech_token', d.token);
      await loadInit();
      flash(authTab === 'login' ? 'Welcome back!' : 'Account created. Welcome!');
      setFormPassword(''); setFormConfirmPw(''); setFormAdminCode('');
    } catch (err) { setAuthError(err.message); }
    finally { setAuthBusy(false); }
  };
  const logout = () => {
    localStorage.removeItem('camtech_token');
    setUser(null); setProgress({}); setAdminData(null); setInspect(null); setActiveBook(null); setActiveTab('catalog');
  };

  // ---------- reading / finishing ----------
  const openBook = async (book) => {
    setActiveBook(book); setIdlePrompt(false); confirmRef.current = Date.now();
    try {
      const d = await api('open', { bookId: book.id, title: book.title });   // +1 view every time
      setViews((v) => ({ ...v, [book.id]: d.views }));
      setProgress((p) => ({ ...p, [book.id]: d.progress }));
    } catch {}
  };

  const requestFinish = (book) => {
    const p = progress[book.id];
    if (p?.isFinished) return;
    const secs = p?.seconds || 0;
    if (secs < MIN_READ_SECONDS) {
      flash(`Read ${Math.ceil((MIN_READ_SECONDS - secs) / 60)} more minute(s) to unlock Finish (${fmtTime(secs)} / ${MIN_READ_SECONDS / 60}m).`);
      return;
    }
    setQuizBook(book); setQuizAnswers(Array(QUESTIONS.length).fill('')); setQuizError('');
  };

  const submitQuiz = async (e) => {
    e.preventDefault(); setQuizError('');
    for (let i = 0; i < quizAnswers.length; i++) {
      if (quizAnswers[i].trim().length < MIN_ANSWER_CHARS) { setQuizError(`Answer ${i + 1} needs at least ${MIN_ANSWER_CHARS} characters.`); return; }
    }
    setQuizBusy(true);
    try {
      const d = await api('finish', { bookId: quizBook.id, title: quizBook.title, answers: quizAnswers });
      setProgress((p) => ({ ...p, [quizBook.id]: d.progress }));
      setBoard(d.leaderboard);
      setQuizBook(null); setActiveBook(null);
      flash('Book completed! Points added to the leaderboard.');
    } catch (err) { setQuizError(err.message); }
    finally { setQuizBusy(false); }
  };

  const openStudent = async (email) => { try { setInspect(await api('student', { email })); } catch (e) { flash(e.message); } };
  const revoke = async (email, book) => {
    if (!window.confirm('Reject these answers? The book becomes unfinished and its done + quiz points are removed.')) return;
    try {
      await api('revoke', { email, bookId: book.id, title: book.title });
      setInspect(await api('student', { email })); loadAdmin();
    } catch (e) { flash(e.message); }
  };

  // ---------- derived ----------
  const filteredBooks = useMemo(() => {
    const words = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return books.filter((b) => {
      const t = b.title.toLowerCase();
      return (!words.length || words.every((w) => t.includes(w) || b.category.toLowerCase().includes(w)))
        && (selectedCategory === 'All' || b.category === selectedCategory)
        && (selectedFormat === 'All' || b.format === selectedFormat);
    });
  }, [books, searchQuery, selectedCategory, selectedFormat]);
  const myRank = board.find((r) => r.isMe);

  // ==========================================
  // LOGIN / REGISTER
  // ==========================================
  if (booting) return <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400 text-sm"><RefreshCw className="w-4 h-4 animate-spin mr-2 text-amber-400" /> Loading...</div>;
  if (!user) {
    const needsCode = ADMIN_EMAILS.includes(formEmail.toLowerCase().trim()) && authTab === 'register';
    const inputCls = 'w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500';
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-md w-full space-y-6 shadow-2xl">
          <div className="text-center space-y-2">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-tr from-blue-900 via-indigo-900 to-amber-500 p-0.5">
              <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center"><BookOpen className="w-7 h-7 text-amber-400" /></div>
            </div>
            <h1 className="text-2xl font-extrabold font-serif">CamTech e-Book Portal</h1>
            <p className="text-xs text-slate-400">Sign in with your @{ALLOWED_DOMAIN} school email</p>
          </div>
          <div className="flex bg-slate-950 p-1 rounded-xl border border-slate-800">
            {['login', 'register'].map((t) => (
              <button key={t} onClick={() => { setAuthTab(t); setAuthError(''); }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition ${authTab === t ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'}`}>
                {t === 'login' ? 'Sign In' : 'Register'}
              </button>
            ))}
          </div>
          <form onSubmit={submitAuth} className="space-y-4">
            {authTab === 'register' && <input className={inputCls} required placeholder="Full name" value={formName} onChange={(e) => setFormName(e.target.value)} />}
            <input className={inputCls} type="email" required placeholder={`name@${ALLOWED_DOMAIN}`} value={formEmail} onChange={(e) => setFormEmail(e.target.value)} />
            <input className={inputCls} type="password" required placeholder="Password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} />
            {authTab === 'register' && <input className={inputCls} type="password" required placeholder="Confirm password" value={formConfirmPw} onChange={(e) => setFormConfirmPw(e.target.value)} />}
            {needsCode && <input className={inputCls} type="password" required placeholder="Admin setup code" value={formAdminCode} onChange={(e) => setFormAdminCode(e.target.value)} />}
            {authError && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /> {authError}</div>}
            <button disabled={authBusy} type="submit" className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 font-bold text-sm transition">
              {authBusy ? 'Please wait...' : authTab === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ==========================================
  // MAIN APP
  // ==========================================
  const navBtn = (id, label, Icon, accent = 'bg-blue-600 shadow-blue-600/30') => (
    <button key={id} onClick={() => setActiveTab(id)}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${activeTab === id ? `${accent} text-white shadow-md` : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}>
      <Icon className="w-4 h-4" /> {label}
    </button>
  );
  const rankIcon = (r) => r === 1 ? <Crown className="w-5 h-5 text-amber-400" /> : r <= 3 ? <Medal className={`w-5 h-5 ${r === 2 ? 'text-slate-300' : 'text-orange-400'}`} /> : <span className="font-mono text-slate-400">{r}</span>;
  const myEntries = Object.entries(progress);
  const medalColors = ['text-amber-400', 'text-slate-300', 'text-orange-400'];
  const timeBadge = (sec) => <span className="inline-flex items-center gap-1 text-[10px] font-mono bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full"><Timer className="w-3 h-3" />{fmtTime(sec)} total</span>;

  // reading status line used on cards / shelf
  const ReadStatus = ({ p }) => {
    if (!p) return null;
    const secs = p.seconds || 0;
    if (p.isFinished) return <div className="mt-2 text-[11px] text-emerald-400 font-semibold flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Completed • {fmtTime(secs)} read</div>;
    const ready = secs >= MIN_READ_SECONDS;
    return (
      <div className="mt-2 space-y-1">
        <div className="flex justify-between text-[11px]"><span className="text-slate-400 flex items-center gap-1"><Timer className="w-3 h-3" />{fmtTime(secs)} read</span><span className={ready ? 'text-emerald-400 font-semibold' : 'text-slate-500'}>{ready ? 'Ready to finish' : `${MIN_READ_SECONDS / 60}m to unlock`}</span></div>
        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden"><div className={`h-full ${ready ? 'bg-emerald-500' : 'bg-amber-500'}`} style={{ width: `${Math.min(100, (secs / MIN_READ_SECONDS) * 100)}%` }} /></div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col selection:bg-amber-500 selection:text-slate-950">

      <header className="sticky top-0 z-30 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 shadow-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 cursor-pointer shrink-0" onClick={() => setActiveTab('catalog')}>
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-blue-900 via-indigo-900 to-amber-500 p-0.5 shadow-lg shadow-blue-900/30">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center"><BookOpen className="w-6 h-6 text-amber-400" /></div>
            </div>
            <div>
              <div className="flex items-center gap-2"><span className="font-extrabold text-xl tracking-wider text-white font-serif">CamTech</span><span className="text-xs bg-amber-500/20 text-amber-300 font-semibold px-2 py-0.5 rounded-md border border-amber-500/30">e-Book Portal</span></div>
              <p className="text-xs text-slate-400 hidden sm:block">Cambodia Academy of Digital Technology</p>
            </div>
          </div>
          <nav className="hidden md:flex items-center gap-1 bg-slate-950/60 p-1.5 rounded-xl border border-slate-800/80">
            {navBtn('catalog', `Catalog (${books.length})`, Grid)}
            {navBtn('bookshelf', 'My Bookshelf', BookMarked)}
            {navBtn('leaderboard', 'Leaderboard', Trophy)}
            {isAdmin && navBtn('admin', 'Admin Dashboard', Shield, 'bg-amber-600 shadow-amber-600/30')}
            {isAdmin && navBtn('drive', 'Drive Sync', HardDrive)}
          </nav>
          <div className="flex items-center gap-3 bg-slate-800/60 pl-3 pr-1.5 py-1.5 rounded-xl border border-slate-700/60">
            <div className="text-right hidden sm:block"><div className="text-xs font-semibold text-slate-200">{user.name}</div><div className="text-[11px] text-amber-400 font-mono">{user.email}</div></div>
            <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase ${isAdmin ? 'bg-amber-500 text-slate-950' : 'bg-blue-600 text-white'}`}>{user.role}</span>
            <button onClick={logout} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700/50 rounded-lg transition" title="Sign out"><LogOut className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="md:hidden flex gap-1 overflow-x-auto px-3 pb-3">
          {navBtn('catalog', 'Catalog', Grid)}{navBtn('bookshelf', 'Bookshelf', BookMarked)}{navBtn('leaderboard', 'Leaderboard', Trophy)}
          {isAdmin && navBtn('admin', 'Admin', Shield, 'bg-amber-600')}{isAdmin && navBtn('drive', 'Drive', HardDrive)}
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* ================= CATALOG ================= */}
        {activeTab === 'catalog' && (
          <div className="space-y-8">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-blue-950 via-slate-900 to-indigo-950 border border-slate-800 p-6 sm:p-10 shadow-2xl">
              <div className="max-w-3xl space-y-4">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold"><Sparkles className="w-3.5 h-3.5 text-amber-400" /> Connected to Google Drive Repository</div>
                <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight font-serif">CamTech Digital Library & Textbook Hub</h1>
                <p className="text-slate-300 text-sm sm:text-base">Read, answer the 10 questions, and climb the leaderboard.</p>
                <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
                  <div className="relative w-full">
                    <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search books by title or keyword..."
                      className="w-full pl-12 pr-10 py-3.5 bg-slate-900/90 border border-slate-700/80 rounded-2xl text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm" />
                    {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>}
                  </div>
                  <select value={selectedFormat} onChange={(e) => setSelectedFormat(e.target.value)} className="px-4 py-3.5 bg-slate-900 border border-slate-700 rounded-2xl text-slate-300 text-sm w-full sm:w-auto">
                    <option value="All">All Formats</option><option value="PDF">PDF Only</option><option value="EPUB">EPUB Only</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
              <div className="flex items-center gap-2 overflow-x-auto w-full sm:w-auto pb-2 sm:pb-0">
                {CATEGORIES.map((cat) => (
                  <button key={cat} onClick={() => setSelectedCategory(cat)}
                    className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${selectedCategory === cat ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20' : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800'}`}>{cat}</button>
                ))}
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs text-slate-400">Showing <strong className="text-white">{filteredBooks.length}</strong> books</span>
                <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                  <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-md ${viewMode === 'grid' ? 'bg-slate-800 text-amber-400' : 'text-slate-500'}`}><Grid className="w-4 h-4" /></button>
                  <button onClick={() => setViewMode('table')} className={`p-1.5 rounded-md ${viewMode === 'table' ? 'bg-slate-800 text-amber-400' : 'text-slate-500'}`}><List className="w-4 h-4" /></button>
                </div>
              </div>
            </div>

            {catalogLoading && <div className="p-8 text-center text-slate-400 text-sm flex items-center justify-center gap-2"><RefreshCw className="w-4 h-4 animate-spin text-amber-400" /> Loading library...</div>}
            {catalogError && <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm flex items-center justify-between"><span>Library could not load: {catalogError}</span><button onClick={loadCatalog} className="underline font-bold">Retry</button></div>}

            {!catalogLoading && viewMode === 'grid' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5">
                {filteredBooks.slice(0, visibleCount).map((book) => {
                  const p = progress[book.id];
                  return (
                    <div key={book.id} className="group bg-slate-900 rounded-2xl border border-slate-800 hover:border-slate-700 p-3 flex flex-col transition-all duration-300 hover:shadow-xl hover:-translate-y-1">
                      <div className="relative">
                        <BookCover book={book} className="w-full aspect-[3/4] rounded-xl shadow-inner" />
                        <span className={`absolute top-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase backdrop-blur-sm ${book.format === 'PDF' ? 'bg-rose-500/80 text-white' : 'bg-emerald-500/80 text-white'}`}>{book.format}</span>
                        <span className="absolute top-2 right-2 flex items-center gap-1 bg-black/60 backdrop-blur-sm text-white text-[11px] font-mono px-2 py-0.5 rounded-full"><Eye className="w-3 h-3 text-blue-300" />{views[book.id] || 0}</span>
                        {p?.isFinished && <span className="absolute bottom-2 right-2 bg-emerald-500 text-slate-950 p-1 rounded-full shadow-lg"><CheckCircle className="w-4 h-4" /></span>}
                      </div>
                      <div className="mt-3 flex-1 space-y-1">
                        <h4 className="font-bold text-slate-100 text-sm line-clamp-2 group-hover:text-amber-400 transition-colors">{book.title}</h4>
                        <p className="text-xs text-slate-400 line-clamp-1">{book.author}</p>
                        <p className="text-[11px] text-slate-500">{book.category}{book.fileSize ? ` • ${book.fileSize}` : ''}</p>
                      </div>
                      <ReadStatus p={p} />
                      <div className="mt-3 flex items-center gap-2">
                        <button onClick={() => openBook(book)} className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition"><BookOpen className="w-3.5 h-3.5" /> {p?.isFinished ? 'Re-open' : p ? 'Resume' : 'Read'}</button>
                        {!p?.isFinished && (
                          <button onClick={() => requestFinish(book)} title="Finish book & answer 10 questions" className={`p-2 rounded-xl border transition ${(p?.seconds || 0) >= MIN_READ_SECONDS ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-500'}`}>
                            {(p?.seconds || 0) >= MIN_READ_SECONDS ? <CheckCircle className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!catalogLoading && viewMode === 'table' && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-x-auto shadow-xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 uppercase font-mono text-[11px]"><tr><th className="py-3.5 px-4">Book</th><th className="py-3.5 px-4">Category</th><th className="py-3.5 px-4">Format</th><th className="py-3.5 px-4">Views</th><th className="py-3.5 px-4">Your Time</th><th className="py-3.5 px-4 text-right">Action</th></tr></thead>
                  <tbody className="divide-y divide-slate-800">
                    {filteredBooks.slice(0, visibleCount).map((book) => {
                      const p = progress[book.id];
                      return (
                        <tr key={book.id} className="hover:bg-slate-800/50">
                          <td className="py-3 px-4"><div className="flex items-center gap-3"><BookCover book={book} className="w-9 h-12 rounded shrink-0" /><span className="font-bold text-white">{book.title}</span></div></td>
                          <td className="py-3 px-4 text-slate-400">{book.category}</td><td className="py-3 px-4 font-mono">{book.format}</td>
                          <td className="py-3 px-4 font-mono text-blue-300">{views[book.id] || 0}</td>
                          <td className="py-3 px-4 font-mono text-amber-400">{p ? (p.isFinished ? 'Completed' : fmtTime(p.seconds)) : '—'}</td>
                          <td className="py-3 px-4 text-right"><button onClick={() => openBook(book)} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs">Read</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!catalogLoading && filteredBooks.length > visibleCount && <div className="text-center"><button onClick={() => setVisibleCount((c) => c + PAGE_SIZE)} className="px-6 py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold">Show more ({filteredBooks.length - visibleCount} remaining)</button></div>}
            {!catalogLoading && !catalogError && filteredBooks.length === 0 && <div className="text-center text-slate-500 text-sm py-10">No books match your search.</div>}
          </div>
        )}

        {/* ================= MY BOOKSHELF ================= */}
        {activeTab === 'bookshelf' && (
          <div className="space-y-8">
            <div className="border-b border-slate-800 pb-5"><h2 className="text-2xl font-bold text-white font-serif">My Bookshelf</h2><p className="text-slate-400 text-sm">Only you can see this page.</p></div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {[{ title: 'In-Progress Reading', Icon: Clock, color: 'text-amber-400', fin: false }, { title: 'Completed Books', Icon: CheckCircle, color: 'text-emerald-400', fin: true }].map(({ title, Icon, color, fin }) => {
                const rows = myEntries.filter(([, p]) => !!p.isFinished === fin && (fin || (p.seconds || 0) > 0)).map(([id, p]) => ({ p, book: books.find((b) => b.id === id) })).filter((r) => r.book);
                return (
                  <div key={title} className="space-y-4">
                    <h3 className={`font-bold text-lg flex items-center gap-2 ${color}`}><Icon className="w-5 h-5" /> {title} ({rows.length})</h3>
                    {rows.length === 0 && <div className="bg-slate-900/50 border border-dashed border-slate-800 rounded-2xl p-8 text-center text-slate-500 text-sm">{fin ? 'No completed books yet.' : 'Nothing in progress. Explore the Catalog!'}</div>}
                    {rows.map(({ p, book }) => (
                      <div key={book.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex gap-4">
                        <BookCover book={book} className="w-16 aspect-[3/4] rounded-lg shrink-0" />
                        <div className="flex-1 min-w-0 space-y-1">
                          <h4 className="font-bold text-white text-sm line-clamp-2">{book.title}</h4>
                          <ReadStatus p={p} />
                          <div className="flex gap-2 pt-2">
                            <button onClick={() => openBook(book)} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs">{fin ? 'Re-open' : 'Resume'}</button>
                            {!fin && <button onClick={() => requestFinish(book)} className="px-3 py-1.5 rounded-lg border border-slate-700 hover:border-emerald-500 text-slate-300 hover:text-emerald-400 text-xs font-semibold">Finish & answer</button>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ================= LEADERBOARD ================= */}
        {activeTab === 'leaderboard' && (
          <div className="space-y-8">
            <div className="border-b border-slate-800 pb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold text-white font-serif flex items-center gap-2"><Trophy className="w-6 h-6 text-amber-400" /> Leaderboard Ranking</h2>
                <p className="text-slate-400 text-sm">Reading time (1 pt/min, max 100 per book) + finished book (1,000) + 10 answers (1,000) = total score.</p>
              </div>
              </div>
            {!isAdmin && (
              <div className="bg-slate-900 border border-amber-500/30 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
                {myRank ? (
                  <>
                    <div><div className="text-xs text-slate-400">Your rank</div><div className="text-3xl font-extrabold text-amber-400 font-mono">#{myRank.rank}</div></div>
                    <div className="flex gap-6 text-center font-mono">
                      <div><div className="text-xl font-bold text-white">{myRank.points.toLocaleString()}</div><div className="text-[11px] text-slate-400">points</div></div>
                      <div><div className="text-xl font-bold text-emerald-400">{myRank.finished}</div><div className="text-[11px] text-slate-400">finished</div></div>
                      <div><div className="text-xl font-bold text-white">{myRank.inProgress}</div><div className="text-[11px] text-slate-400">in progress</div></div>
                      <div><div className="text-xl font-bold text-white">{fmtTime(myRank.seconds)}</div><div className="text-[11px] text-slate-400">read time</div></div>
                    </div>
                  </>
                ) : <p className="text-sm text-slate-300">You are not ranked yet. Open a book from the Catalog and read for a few minutes to start earning points.</p>}
              </div>
            )}
            {board.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {board.slice(0, 3).map((r) => (
                  <div key={r.rank} className={`rounded-2xl border p-5 text-center space-y-1 ${r.rank === 1 ? 'bg-amber-500/10 border-amber-500/40' : 'bg-slate-900 border-slate-800'}`}>
                    <div className="flex justify-center"><Medal className={`w-7 h-7 ${medalColors[Math.min(r.rank, 3) - 1]}`} /></div>
                    <div className="font-bold text-white truncate">{r.name}{r.isMe && <span className="text-amber-400 text-xs"> (you)</span>}</div>
                    <div className="text-2xl font-extrabold font-mono text-amber-400">{r.points.toLocaleString()}</div>
                    <div className="text-[11px] text-slate-400">{r.finished} finished • {fmtTime(r.seconds)} read</div>
                  </div>
                ))}
              </div>
            )}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-x-auto shadow-xl">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 uppercase font-mono text-[11px]">
                  <tr><th className="p-3 w-14">Rank</th><th className="p-3">Student</th>{isAdmin && <th className="p-3">Email</th>}<th className="p-3">Books Progress</th><th className="p-3">Books Finished</th><th className="p-3">Reading Pts</th><th className="p-3">Done Pts</th><th className="p-3">Quiz Pts</th><th className="p-3 text-right">Total Points</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {board.map((r) => (
                    <tr key={r.rank} className={r.isMe ? 'bg-amber-500/10' : 'hover:bg-slate-800/50'}>
                      <td className="p-3 font-mono font-bold text-white">#{r.rank}</td>
                      <td className="p-3"><div className="font-bold text-white">{r.name}{r.isMe && <span className="text-amber-400 font-normal"> (you)</span>}</div><div className="mt-1">{timeBadge(r.seconds)}</div></td>
                      {isAdmin && <td className="p-3 font-mono text-amber-400">{r.email}</td>}
                      <td className="p-3 font-mono">{r.inProgress}</td><td className="p-3 font-mono text-emerald-400">{r.finished}</td>
                      <td className="p-3 font-mono">{r.readingPts.toLocaleString()}</td><td className="p-3 font-mono">{r.donePts.toLocaleString()}</td><td className="p-3 font-mono">{r.quizPts.toLocaleString()}</td>
                      <td className="p-3 text-right font-mono font-bold text-amber-400 text-sm">{r.points.toLocaleString()}</td>
                    </tr>
                  ))}
                  {board.length === 0 && <tr><td colSpan={9} className="p-8 text-center text-slate-500">No rankings yet. Students appear here once they start reading.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================= ADMIN ================= */}
        {isAdmin && activeTab === 'admin' && (
          <div className="space-y-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-5">
              <div><h2 className="text-2xl font-bold text-white font-serif flex items-center gap-2"><Shield className="w-6 h-6 text-amber-400" /> Admin Control & Student Inspector</h2><p className="text-slate-400 text-sm">Visible to the 2 library admin accounts only.</p></div>
              <button onClick={() => loadAdmin()} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5" /> Refresh</button>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
              {[['Registered Students', adminData?.students.length ?? '…', 'text-white'], ['Admin Accounts', adminData?.adminCount ?? '…', 'text-amber-400'], ['Total Books', books.length, 'text-white'], ['Total Book Views', adminData?.totalViews ?? '…', 'text-blue-300']].map(([l, v, c]) => (
                <div key={l} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-1 shadow-lg"><span className="text-xs font-semibold uppercase text-slate-400">{l}</span><div className={`text-3xl font-extrabold font-mono ${c}`}>{v}</div></div>
              ))}
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-xl">
              <h3 className="font-bold text-white text-lg font-serif flex items-center gap-2"><Users className="w-5 h-5 text-amber-400" /> Registered Students</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 font-mono text-[11px] uppercase"><tr><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Read time</th><th className="p-3">In progress</th><th className="p-3">Finished</th><th className="p-3">Points</th><th className="p-3 text-right">Action</th></tr></thead>
                  <tbody className="divide-y divide-slate-800">
                    {(adminData?.students || []).map((s) => (
                      <tr key={s.email} className="hover:bg-slate-800/60">
                        <td className="p-3 font-bold text-slate-100">{s.name}</td><td className="p-3 font-mono text-amber-400">{s.email}</td>
                        <td className="p-3 font-mono">{fmtTime(s.seconds)}</td><td className="p-3 font-mono">{s.inProgress}</td><td className="p-3 font-mono text-emerald-400">{s.finished}</td><td className="p-3 font-mono font-bold text-amber-400">{s.points.toLocaleString()}</td>
                        <td className="p-3 text-right"><button onClick={() => openStudent(s.email)} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> View</button></td>
                      </tr>
                    ))}
                    {adminData && adminData.students.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">No students registered yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3 shadow-xl">
              <h3 className="font-bold text-white text-lg font-serif">Live Activity Feed</h3>
              {(adminData?.logs || []).map((l, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs">
                  <div><span className="text-amber-400 font-mono font-bold">{l.email}</span> {l.action}<div className="text-slate-400 text-[11px] italic">"{l.bookTitle}"</div></div>
                  <span className="text-slate-500 font-mono text-[11px] shrink-0">{timeAgo(l.ts)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ================= DRIVE SYNC (admin) ================= */}
        {isAdmin && activeTab === 'drive' && (
          <div className="max-w-3xl mx-auto bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 space-y-6 shadow-xl">
            <div className="flex items-center gap-3 border-b border-slate-800 pb-5">
              <div className="p-3 rounded-2xl bg-blue-600/20 border border-blue-500/30 text-blue-400"><HardDrive className="w-6 h-6" /></div>
              <div><h2 className="text-xl font-bold text-white font-serif">Google Drive Sync</h2><p className="text-slate-400 text-xs">Admin only</p></div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800"><div className="text-slate-400 uppercase font-bold text-[10px]">Books synced</div><div className="text-2xl font-mono font-bold text-white">{books.length}</div></div>
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800"><div className="text-slate-400 uppercase font-bold text-[10px]">Last sync</div><div className="text-2xl font-mono font-bold text-white">{lastSync || '—'}</div></div>
            </div>
            <p className="text-xs text-slate-400 font-mono break-all">Folder: {FOLDER_ID}</p>
            <button onClick={loadCatalog} disabled={catalogLoading} className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm flex items-center justify-center gap-2 transition"><RefreshCw className={`w-4 h-4 ${catalogLoading ? 'animate-spin' : ''}`} /> {catalogLoading ? 'Syncing...' : 'Resync from Drive'}</button>
            {catalogError && <p className="text-rose-400 text-xs">{catalogError}</p>}
          </div>
        )}
      </main>

      {/* ADMIN: STUDENT PROFILE */}
      {isAdmin && inspect && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-2xl w-full space-y-5 shadow-2xl relative max-h-[90vh] overflow-y-auto">
            <button onClick={() => setInspect(null)} className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            <div><h3 className="text-xl font-bold text-white font-serif">{inspect.student.name}</h3><p className="text-amber-400 font-mono text-xs">{inspect.student.email}</p><p className="text-slate-500 text-[11px]">Registered: {inspect.student.registeredAt}</p></div>
            {(() => {
              const vals = Object.values(inspect.progress);
              const fin = vals.filter((x) => x.isFinished).length;
              const secs = vals.reduce((a, x) => a + (x.seconds || 0), 0);
              return (
                <div className="grid grid-cols-3 gap-3">
                  {[['Books Opened', vals.length, 'text-white'], ['Finished', fin, 'text-emerald-400'], ['Total Read Time', fmtTime(secs), 'text-amber-400']].map(([l, v, c]) => (
                    <div key={l} className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-center"><div className="text-slate-400 text-[10px] uppercase font-bold">{l}</div><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></div>
                  ))}
                </div>
              );
            })()}
            {Object.keys(inspect.progress).length === 0 && <div className="p-6 text-center text-slate-500 text-xs bg-slate-950/50 rounded-xl border border-dashed border-slate-800">No reading history yet.</div>}
            {Object.entries(inspect.progress).map(([id, p]) => {
              const b = books.find((x) => x.id === id);
              const book = b || { id, title: `Book ${id}` };
              return (
                <div key={id} className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
                  <div className="flex justify-between gap-3"><h5 className="font-bold text-white text-sm">{book.title}</h5>
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${p.isFinished ? 'bg-emerald-500/20 text-emerald-400' : p.quiz?.revoked ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'}`}>{p.isFinished ? 'Completed' : p.quiz?.revoked ? 'Rejected' : 'In progress'}</span></div>
                  <div className="text-[11px] text-slate-400 flex justify-between"><span>Read time {fmtTime(p.seconds)} • opened {p.opens || 0}×</span><span>{p.lastRead ? new Date(p.lastRead).toLocaleDateString() : ''}</span></div>
                  {p.quiz?.answers && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-amber-400 font-semibold">Read the student's 10 answers</summary>
                      <div className="mt-2 space-y-2">{p.quiz.answers.map((a, i) => <div key={i}><div className="text-slate-500 text-[11px]">{i + 1}. {QUESTIONS[i]}</div><div className="text-slate-200 whitespace-pre-wrap">{a}</div></div>)}</div>
                    </details>
                  )}
                  {p.isFinished && <button onClick={() => revoke(inspect.student.email, book)} className="px-3 py-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white text-xs font-bold">Reject answers (remove points)</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* READER */}
      {activeBook && (
        <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col">
          <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 overflow-hidden">
              <button onClick={() => setActiveBook(null)} className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"><ChevronLeft className="w-5 h-5" /></button>
              <div className="min-w-0"><h3 className="font-bold text-white text-sm line-clamp-1">{activeBook.title}</h3><p className="text-xs text-slate-400">{activeBook.format}{activeBook.fileSize ? ` • ${activeBook.fileSize}` : ''}</p></div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800 text-xs font-mono font-bold text-amber-400"><Timer className="w-4 h-4" />{fmtTime(progress[activeBook.id]?.seconds)} read</div>
              {!activeFinished && <button onClick={() => requestFinish(activeBook)} className={`px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5 ${(progress[activeBook.id]?.seconds || 0) >= MIN_READ_SECONDS ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'}`}>{(progress[activeBook.id]?.seconds || 0) >= MIN_READ_SECONDS ? <CheckCircle className="w-4 h-4" /> : <Lock className="w-4 h-4" />} Finish</button>}
              <button onClick={() => setActiveBook(null)} className="p-2 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
          </div>
          {activeBook.format !== 'PDF' ? (
            <div className="flex-1 flex items-center justify-center"><div className="text-center space-y-4"><p className="text-slate-300 text-sm">This file type cannot be previewed in the browser.</p>
              <a href={`https://drive.google.com/uc?export=download&id=${activeBook.driveFileId}`} className="inline-flex px-5 py-3 rounded-xl bg-amber-500 text-slate-950 font-bold text-sm">Download file</a></div></div>
          ) : (
            <iframe title={activeBook.title} src={`https://drive.google.com/file/d/${activeBook.driveFileId}/preview`} className="flex-1 w-full bg-slate-950 border-0" allow="autoplay" />
          )}
          {idlePrompt && (
            <div className="absolute inset-0 bg-slate-950/85 flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-sm text-center space-y-4">
                <Timer className="w-8 h-8 text-amber-400 mx-auto" />
                <p className="text-white font-bold">Still reading?</p>
                <p className="text-slate-400 text-xs">The timer is paused. Tap continue to keep counting your reading time.</p>
                <button onClick={() => { confirmRef.current = Date.now(); setIdlePrompt(false); }} className="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-sm">Yes, continue reading</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* QUIZ: 10 general questions */}
      {quizBook && (
        <div className="fixed inset-0 z-[55] bg-slate-950/90 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={submitQuiz} className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 max-w-2xl w-full space-y-5 shadow-2xl relative max-h-[92vh] overflow-y-auto">
            <button type="button" onClick={() => setQuizBook(null)} className="absolute top-5 right-5 text-slate-400 hover:text-white"><X className="w-5 h-5" /></button>
            <div><h3 className="text-xl font-bold text-white font-serif">Finish: {quizBook.title}</h3><p className="text-slate-400 text-xs mt-1">Answer in your own words (at least {MIN_ANSWER_CHARS} characters each). Copied or repeated answers are rejected, and the library can review them.</p></div>
            {QUESTIONS.map((q, i) => {
              const len = (quizAnswers[i] || '').trim().length;
              return (
                <div key={i} className="space-y-1.5">
                  <label className="text-sm font-semibold text-slate-200">{i + 1}. {q}</label>
                  <textarea rows={3} value={quizAnswers[i] || ''} onChange={(e) => setQuizAnswers((a) => a.map((x, j) => j === i ? e.target.value : x))}
                    className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-xl text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500" />
                  <div className={`text-[11px] text-right font-mono ${len >= MIN_ANSWER_CHARS ? 'text-emerald-400' : 'text-slate-500'}`}>{len} / {MIN_ANSWER_CHARS}</div>
                </div>
              );
            })}
            {quizError && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" /> {quizError}</div>}
            <button disabled={quizBusy} type="submit" className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-bold text-sm">{quizBusy ? 'Submitting...' : 'Submit answers & finish book (+2,000 pts)'}</button>
          </form>
        </div>
      )}

      {toast && <div className="fixed bottom-6 right-6 z-[70] bg-slate-900 border border-amber-500/40 text-amber-300 px-4 py-3 rounded-xl text-xs font-semibold shadow-2xl flex items-center gap-2 max-w-xs"><Check className="w-4 h-4 shrink-0" /> {toast}</div>}

      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500"><p>© 2026 CamTech University Digital Library • {books.length} books{isAdmin && ` • Active Folder: ${FOLDER_ID.slice(0, 10)}...`}</p></footer>
    </div>
  );
}
