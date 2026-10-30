// api/portal.mjs  -- Vercel serverless function (project ROOT, next to package.json)
// Storage: Upstash Redis (Vercel -> Storage -> Upstash for Redis)
// Env vars: AUTH_SECRET, ADMIN_SETUP_CODE (+ Redis vars added automatically by Vercel)
import crypto from 'node:crypto';

// ---------- Rules (change here) ----------
const DOMAIN = 'camtech.edu.kh';
const ADMINS = ['camtech.library@camtech.edu.kh', 'sp6026010074@camtech.edu.kh'];
const READING_PTS_PER_MIN = 1;       // reading: 1 point per active minute...
const READING_PTS_MAX = 100;         // ...up to 100 per book
const DONE_PTS = 1000;               // finishing a book (needs min time + 10 answers)
const QUIZ_PTS = 1000;               // 10 valid answers (100 each)
const MIN_READ_SECONDS = 30 * 60;    // minimum active reading time before "Finish" unlocks
const DAY_CAP_SECONDS = 3 * 3600;    // max countable time per book per day
const MIN_ANSWER_CHARS = 80;         // per answer (works for Khmer too: no word-splitting)
const QUESTION_COUNT = 10;
const BEAT_MIN = 40, BEAT_MAX = 90;  // accepted seconds between 60s heartbeats

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const SECRET = process.env.AUTH_SECRET;

// ---------- Redis (REST) ----------
async function redis(...cmd) {
  const res = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const hgetall = async (key) => {
  const flat = (await redis('HGETALL', key)) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
};

// ---------- Auth ----------
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (d) => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');
const makeToken = (email) => { const p = b64(JSON.stringify({ email, exp: Date.now() + 30 * 86400000 })); return `${p}.${sign(p)}`; };
function readToken(req) {
  const [p, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!p || !sig) return null;
  const good = sign(p);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url').toString()); return d.exp > Date.now() ? d.email : null; } catch { return null; }
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const isAdminEmail = (e) => ADMINS.includes(e);
const publicUser = (u) => ({ name: u.name, email: u.email, role: isAdminEmail(u.email) ? 'admin' : 'student', registeredAt: u.registeredAt });

// ---------- Scoring ----------
// per book: reading (<=100) + done (1000) + quiz (1000). Re-reading never adds more.
const bookPoints = (p) => {
  const seconds = p.seconds || 0;
  const reading = Math.min(READING_PTS_MAX, Math.floor(seconds / 60) * READING_PTS_PER_MIN);
  const done = p.isFinished ? DONE_PTS : 0;
  const quiz = p.isFinished && p.quiz && !p.quiz.revoked ? p.quiz.points || 0 : 0;
  return { reading, done, quiz };
};
function calcScore(user, progress) {
  const s = { name: user.name, email: user.email, inProgress: 0, finished: 0, readingPts: 0, donePts: 0, quizPts: 0, seconds: 0, points: 0 };
  for (const raw of Object.values(progress)) {
    const p = JSON.parse(raw);
    const b = bookPoints(p);
    s.readingPts += b.reading; s.donePts += b.done; s.quizPts += b.quiz; s.seconds += Math.floor(p.seconds || 0);
    if (p.isFinished) s.finished++; else if ((p.seconds || 0) >= 60) s.inProgress++;
  }
  s.points = s.readingPts + s.donePts + s.quizPts;
  return s;
}
async function refreshScore(user) {
  if (isAdminEmail(user.email)) return;
  await redis('HSET', 'scores', user.email, JSON.stringify(calcScore(user, await hgetall(`progress:${user.email}`))));
}
// Names of other students are masked (S••• C•••); admins and the student themself see the full name.
const maskName = (n) => n.trim().split(/\s+/).map((w) => w[0] + '•'.repeat(Math.min(3, w.length - 1))).join(' ');
async function leaderboard(me, asAdmin) {
  const all = Object.values(await hgetall('scores')).map((x) => JSON.parse(x)).filter((x) => x.points > 0);
  all.sort((a, b) => b.points - a.points || b.finished - a.finished || b.seconds - a.seconds || a.name.localeCompare(b.name));
  let last = null, rank = 0;
  return all.map((s, i) => {
    if (s.points !== last) { rank = i + 1; last = s.points; }   // equal points share a rank
    const mine = s.email === me;
    return {
      rank, name: asAdmin || mine ? s.name : maskName(s.name), inProgress: s.inProgress, finished: s.finished,
      quizPts: s.quizPts, points: s.points, seconds: s.seconds, isMe: mine,
    };
  });
}
const log = (email, action, bookTitle) =>
  redis('LPUSH', 'logs', JSON.stringify({ email, action, bookTitle, ts: Date.now() })).then(() => redis('LTRIM', 'logs', 0, 199));

// ---------- Answer checks (language independent) ----------
const norm = (t) => t.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const grams = (t) => { const s = norm(t), g = new Set(); for (let i = 0; i <= s.length - 4; i++) g.add(s.slice(i, i + 4)); return g; };
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!REDIS_URL || !REDIS_TOKEN || !SECRET) return res.status(500).json({ error: 'Server not configured (Redis or AUTH_SECRET missing)' });
  const fail = (code, error) => res.status(code).json({ error });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { action } = body;

    if (action === 'register') {
      const email = String(body.email || '').toLowerCase().trim();
      const name = String(body.name || '').trim().slice(0, 60) || email.split('@')[0];
      const pw = String(body.password || '');
      if (!email.endsWith('@' + DOMAIN) || email.length > 100) return fail(400, `Only @${DOMAIN} emails can register.`);
      if (pw.length < 6) return fail(400, 'Password must be at least 6 characters.');
      if (isAdminEmail(email) && (!process.env.ADMIN_SETUP_CODE || body.adminCode !== process.env.ADMIN_SETUP_CODE))
        return fail(403, 'This is an admin email. Enter the correct admin setup code.');
      if (await redis('HGET', 'users', email)) return fail(409, 'Account already exists. Please sign in.');
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { name, email, salt, hash: hashPw(pw, salt), registeredAt: new Date().toISOString().slice(0, 10) };
      await redis('HSET', 'users', email, JSON.stringify(user));
      await refreshScore(user);
      await log(email, 'Registered account', 'Account Setup');
      return res.json({ token: makeToken(email), user: publicUser(user) });
    }
    if (action === 'login') {
      const email = String(body.email || '').toLowerCase().trim();
      const raw = await redis('HGET', 'users', email);
      if (!raw) return fail(401, 'Account not found. Please register first.');
      const user = JSON.parse(raw);
      const a = Buffer.from(hashPw(String(body.password || ''), user.salt)), b = Buffer.from(user.hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(401, 'Wrong password.');
      await log(email, 'Signed in', 'Portal Session');
      return res.json({ token: makeToken(email), user: publicUser(user) });
    }

    // ----- session required below -----
    const me = readToken(req);
    if (!me) return fail(401, 'Please sign in.');
    const rawMe = await redis('HGET', 'users', me);
    if (!rawMe) return fail(401, 'Account no longer exists.');
    const user = JSON.parse(rawMe);
    const admin = isAdminEmail(me);
    const getProg = async (email, bookId) => { const r = await redis('HGET', `progress:${email}`, bookId); return r ? JSON.parse(r) : null; };
    const bookIdOf = () => String(body.bookId || '').slice(0, 100);

    if (action === 'init') {
      const [views, prog, lb] = await Promise.all([hgetall('views'), hgetall(`progress:${me}`), leaderboard(me, admin)]);
      const progress = {}, viewsNum = {};
      for (const [k, v] of Object.entries(prog)) progress[k] = JSON.parse(v);
      for (const [k, v] of Object.entries(views)) viewsNum[k] = Number(v);
      return res.json({ user: publicUser(user), views: viewsNum, progress, leaderboard: lb });
    }

    if (action === 'open') {
      const bookId = bookIdOf(); if (!bookId) return fail(400, 'bookId required');
      const views = await redis('HINCRBY', 'views', bookId, 1);       // every open = +1 view
      const p = (await getProg(me, bookId)) || { seconds: 0, isFinished: false, opens: 0 };
      p.opens = (p.opens || 0) + 1; p.lastBeat = Date.now(); p.lastRead = new Date().toISOString();
      await redis('HSET', `progress:${me}`, bookId, JSON.stringify(p));
      await log(me, 'Opened book', String(body.title || bookId).slice(0, 120));
      return res.json({ views, progress: p });
    }

    // Client sends one heartbeat per 60s while the reader is visible and the student confirmed "still reading".
    if (action === 'heartbeat') {
      const bookId = bookIdOf();
      const p = await getProg(me, bookId);
      if (!p) return fail(400, 'Open the book first.');
      if (p.isFinished) return res.json({ seconds: p.seconds || 0 });
      const now = Date.now();
      const gap = (now - (p.lastBeat || 0)) / 1000;
      if (gap < BEAT_MIN) return res.json({ seconds: p.seconds || 0 });  // too fast: ignored
      const day = new Date().toISOString().slice(0, 10);
      if (p.dayKey !== day) { p.dayKey = day; p.daySeconds = 0; }
      const before = Math.floor((p.seconds || 0) / 300);
      if (p.lastBeat && gap <= BEAT_MAX && p.daySeconds < DAY_CAP_SECONDS) {
        p.seconds = (p.seconds || 0) + gap; p.daySeconds += gap;
      }
      p.lastBeat = now; p.lastRead = new Date().toISOString();
      await redis('HSET', `progress:${me}`, bookId, JSON.stringify(p));
      if (Math.floor((p.seconds || 0) / 300) !== before) await refreshScore(user);   // leaderboard updates every ~5 min of reading
      return res.json({ seconds: Math.floor(p.seconds || 0) });
    }

    // Remember the real page the student reached (sent by the in-site PDF reader), so Resume opens there.
    if (action === 'page') {
      const bookId = bookIdOf();
      const p = await getProg(me, bookId);
      if (!p) return fail(400, 'Open the book first.');
      const total = Math.floor(Number(body.total)), page = Math.floor(Number(body.page));
      if (!(total >= 1 && total <= 20000 && page >= 1 && page <= total)) return fail(400, 'Invalid page.');
      p.page = page; p.totalPages = total; p.lastRead = new Date().toISOString();
      await redis('HSET', `progress:${me}`, bookId, JSON.stringify(p));
      return res.json({ progress: p });
    }

    // Finish a book = submit the 10 written answers (needs minimum reading time).
    if (action === 'finish') {
      const bookId = bookIdOf();
      const p = await getProg(me, bookId);
      if (!p) return fail(400, 'Open the book first.');
      if (p.isFinished) return fail(409, 'You already completed this book.');
      if ((p.seconds || 0) < MIN_READ_SECONDS)
        return fail(400, `Read at least ${MIN_READ_SECONDS / 60} minutes first (you have ${Math.floor((p.seconds || 0) / 60)} min).`);
      const answers = Array.isArray(body.answers) ? body.answers.map((a) => String(a || '').trim().slice(0, 2000)) : [];
      if (answers.length !== QUESTION_COUNT) return fail(400, `Please answer all ${QUESTION_COUNT} questions.`);
      for (let i = 0; i < answers.length; i++)
        if (answers[i].length < MIN_ANSWER_CHARS || grams(answers[i]).size < 20)
          return fail(400, `Answer ${i + 1} is too short. Write at least ${MIN_ANSWER_CHARS} characters in your own words.`);
      // duplicate check: against other answers in this form and against this student's answers on other books
      const mine = answers.map(grams);
      for (let i = 0; i < mine.length; i++)
        for (let j = i + 1; j < mine.length; j++)
          if (jaccard(mine[i], mine[j]) > 0.7) return fail(400, `Answers ${i + 1} and ${j + 1} are too similar. Write each one differently.`);
      const old = [];
      for (const [k, raw] of Object.entries(await hgetall(`progress:${me}`))) {
        if (k === bookId) continue;
        const q = JSON.parse(raw).quiz;
        if (q?.answers) old.push(...q.answers.map(grams));
      }
      for (let i = 0; i < mine.length; i++)
        for (const o of old.slice(-300))
          if (jaccard(mine[i], o) > 0.7) return fail(400, `Answer ${i + 1} is almost the same as an answer you wrote for another book. Use your own words for this book.`);
      p.isFinished = true; p.finishedAt = new Date().toISOString(); p.lastRead = p.finishedAt;
      p.quiz = { answers, submittedAt: p.finishedAt, points: QUIZ_PTS, revoked: false };
      await redis('HSET', `progress:${me}`, bookId, JSON.stringify(p));
      await refreshScore(user);
      await log(me, 'Finished book + submitted answers', String(body.title || bookId).slice(0, 120));
      return res.json({ progress: p, leaderboard: await leaderboard(me, admin) });
    }

    if (action === 'leaderboard') return res.json({ leaderboard: await leaderboard(me, admin) });

    // ----- admin only (enforced here on the server) -----
    if (action === 'admin') {
      if (!admin) return fail(403, 'Admins only.');
      const [users, scores, logs, views] = await Promise.all([hgetall('users'), hgetall('scores'), redis('LRANGE', 'logs', 0, 49), hgetall('views')]);
      const students = Object.values(users).map((u) => JSON.parse(u)).filter((u) => !isAdminEmail(u.email)).map((u) => {
        const s = scores[u.email] ? JSON.parse(scores[u.email]) : { inProgress: 0, finished: 0, points: 0, seconds: 0 };
        return { name: u.name, email: u.email, registeredAt: u.registeredAt, inProgress: s.inProgress, finished: s.finished, points: s.points, seconds: s.seconds };
      });
      return res.json({ students, logs: logs.map((l) => JSON.parse(l)), totalViews: Object.values(views).reduce((a, v) => a + Number(v), 0), adminCount: Object.keys(users).filter(isAdminEmail).length });
    }
    if (action === 'student') {
      if (!admin) return fail(403, 'Admins only.');
      const email = String(body.email || '').toLowerCase();
      const raw = await redis('HGET', 'users', email);
      if (!raw) return fail(404, 'Not found');
      const progress = {};
      for (const [k, v] of Object.entries(await hgetall(`progress:${email}`))) progress[k] = JSON.parse(v);
      return res.json({ student: publicUser(JSON.parse(raw)), progress });
    }
    // Admin rejects low-quality answers: book becomes "not finished", done + quiz points removed, student can redo it.
    if (action === 'revoke') {
      if (!admin) return fail(403, 'Admins only.');
      const email = String(body.email || '').toLowerCase();
      const bookId = bookIdOf();
      const rawU = await redis('HGET', 'users', email);
      const p = await getProg(email, bookId);
      if (!rawU || !p) return fail(404, 'Not found');
      p.isFinished = false;
      p.quiz = { ...(p.quiz || {}), revoked: true, points: 0 };
      await redis('HSET', `progress:${email}`, bookId, JSON.stringify(p));
      await refreshScore(JSON.parse(rawU));
      await log(email, `Answers rejected by ${me}`, String(body.title || bookId).slice(0, 120));
      return res.json({ ok: true });
    }

    return fail(400, 'Unknown action');
  } catch (e) {
    return fail(500, e.message || 'Server error');
  }
}
