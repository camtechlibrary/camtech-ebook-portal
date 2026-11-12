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
const publicUser = (u) => ({ name: u.name, email: u.email, role: isAdminEmail(u.email) ? 'admin' : 'student', registeredAt: u.registeredAt, mustChange: !!u.mustChange, cohort: u.cohort || '' });

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
  const s = { name: user.name, email: user.email, inProgress: 0, finished: 0, readingPts: 0, donePts: 0, quizPts: 0, seconds: 0, points: 0, qualified: false };
  for (const raw of Object.values(progress)) {
    const p = JSON.parse(raw);
    const b = bookPoints(p);
    s.readingPts += b.reading; s.donePts += b.done; s.quizPts += b.quiz; s.seconds += Math.floor(p.seconds || 0);
    if ((p.seconds || 0) >= MIN_READ_SECONDS) s.qualified = true;                 // 30 min on one book unlocks the leaderboard
    if (p.isFinished) s.finished++; else if ((p.seconds || 0) >= MIN_READ_SECONDS) s.inProgress++;
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
  const all = Object.values(await hgetall('scores')).map((x) => JSON.parse(x)).filter((x) => x.qualified && x.points > 0);
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

// ---------- Analytics counters (Redis hashes st:*, daily, active:<day> sets) ----------
const localDay = (t = Date.now()) => new Date(t + 7 * 3600 * 1000).toISOString().slice(0, 10);   // Phnom Penh day (UTC+7)
const ST = ['readers', 'finished', 'seconds', 'fsec', 'subm', 'rej', 'qsum', 'qcount'];
const stInc = (field, bookId, n) => (n ? redis('HINCRBY', `st:${field}`, bookId, n) : Promise.resolve());
async function touchActive(email) {
  const key = `active:${localDay()}`;
  if ((await redis('SADD', key, email)) === 1) await redis('EXPIRE', key, 60 * 60 * 24 * 100);
}
async function pipeline(cmds) {
  if (!cmds.length) return [];
  const res = await fetch(`${REDIS_URL}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(cmds) });
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error('Redis pipeline failed');
  return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}
const cleanCohort = (x) => String(x || '').trim().toUpperCase().replace(/\s+/g, '-').slice(0, 30);
const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
const evt = (type, bookId, title, detail) => JSON.stringify({ ts: Date.now(), type, bookId, title, detail });

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
      const user = { name, email, salt, hash: hashPw(pw, salt), registeredAt: new Date().toISOString().slice(0, 10), cohort: cleanCohort(body.cohort) };
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
      user.lastLogin = new Date().toISOString(); user.loginCount = (user.loginCount || 0) + 1;
      await redis('HSET', 'users', email, JSON.stringify(user));
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
      const [views, prog, lb, metaRaw] = await Promise.all([hgetall('views'), hgetall(`progress:${me}`), leaderboard(me, admin), hgetall('meta')]);
      const progress = {}, viewsNum = {}, meta = {};
      for (const [k, v] of Object.entries(metaRaw)) { try { meta[k] = JSON.parse(v); } catch {} }
      for (const [k, v] of Object.entries(prog)) progress[k] = JSON.parse(v);
      for (const [k, v] of Object.entries(views)) viewsNum[k] = Number(v);
      return res.json({ user: publicUser(user), views: viewsNum, progress, leaderboard: lb, meta });
    }

    if (action === 'open') {
      const bookId = bookIdOf(); if (!bookId) return fail(400, 'bookId required');
      const views = await redis('HINCRBY', 'views', bookId, 1);       // every open = +1 view
      const p = (await getProg(me, bookId)) || { seconds: 0, isFinished: false, opens: 0 };
      const firstOpen = (p.opens || 0) === 0;
      p.opens = (p.opens || 0) + 1; p.lastBeat = Date.now(); p.lastRead = new Date().toISOString();
      const dayNow = localDay();
      const newDay = p.activeDay !== dayNow; p.activeDay = dayNow;
      await redis('HSET', `progress:${me}`, bookId, JSON.stringify(p));
      if (firstOpen) await stInc('readers', bookId, 1);
      if (newDay) await touchActive(me);
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
      let added = 0;
      if (p.lastBeat && gap <= BEAT_MAX && p.daySeconds < DAY_CAP_SECONDS) {
        p.seconds = (p.seconds || 0) + gap; p.daySeconds += gap; added = Math.round(gap);
      }
      p.lastBeat = now; p.lastRead = new Date().toISOString();
      const dayNow = localDay();
      const newDay = p.activeDay !== dayNow; p.activeDay = dayNow;
      await redis('HSET', `progress:${me}`, bookId, JSON.stringify(p));
      if (newDay) await touchActive(me);
      if (added) { await stInc('seconds', bookId, added); await redis('HINCRBY', 'daily', dayNow, added); }
      const crossed30 = (p.seconds || 0) >= MIN_READ_SECONDS && (p.seconds || 0) - gap < MIN_READ_SECONDS;
      if (crossed30 || Math.floor((p.seconds || 0) / 300) !== before) await refreshScore(user);   // leaderboard updates every ~5 min and at 30 min
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
      await stInc('finished', bookId, 1); await stInc('fsec', bookId, Math.round(p.seconds || 0)); await stInc('subm', bookId, 1);
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
        return { name: u.name, email: u.email, cohort: u.cohort || '', registeredAt: u.registeredAt, lastLogin: u.lastLogin || '', loginCount: u.loginCount || 0, inProgress: s.inProgress, finished: s.finished, points: s.points, seconds: s.seconds };
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
      const su = JSON.parse(raw);
      return res.json({ student: { ...publicUser(su), lastLogin: su.lastLogin || '', loginCount: su.loginCount || 0 }, progress });
    }
    // Admin rejects low-quality answers: book becomes "not finished", done + quiz points removed, student can redo it.
    if (action === 'revoke') {
      if (!admin) return fail(403, 'Admins only.');
      const email = String(body.email || '').toLowerCase();
      const bookId = bookIdOf();
      const rawU = await redis('HGET', 'users', email);
      const p = await getProg(email, bookId);
      if (!rawU || !p) return fail(404, 'Not found');
      const wasFinished = !!p.isFinished;
      const oldScore = typeof p.quiz?.score === 'number' ? p.quiz.score : null;
      p.isFinished = false;
      p.quiz = { ...(p.quiz || {}), revoked: true, points: 0 };
      delete p.quiz.score;
      await redis('HSET', `progress:${email}`, bookId, JSON.stringify(p));
      if (wasFinished) {
        await stInc('finished', bookId, -1); await stInc('fsec', bookId, -Math.round(p.seconds || 0)); await stInc('rej', bookId, 1);
        if (oldScore != null) { await stInc('qsum', bookId, -oldScore); await stInc('qcount', bookId, -1); }
      }
      await refreshScore(JSON.parse(rawU));
      await log(email, `Answers rejected by ${me}`, String(body.title || bookId).slice(0, 120));
      return res.json({ ok: true });
    }

    // ----- passwords: stored only as hashes, so nobody (not even admins) can read them. Admin can issue a temporary one. -----
    if (action === 'resetPassword') {
      if (!admin) return fail(403, 'Admins only.');
      const email = String(body.email || '').toLowerCase();
      if (email === me) return fail(400, 'Use Change password for your own account.');
      const rawU = await redis('HGET', 'users', email);
      if (!rawU) return fail(404, 'Student not found.');
      const u = JSON.parse(rawU);
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const temp = Array.from({ length: 10 }, () => chars[crypto.randomInt(chars.length)]).join('');
      u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(temp, u.salt); u.mustChange = true;
      await redis('HSET', 'users', email, JSON.stringify(u));
      await log(email, `Temporary password issued by ${me}`, 'Account Support');
      return res.json({ tempPassword: temp });
    }
    if (action === 'changePassword') {
      const next = String(body.newPassword || '');
      if (next.length < 6) return fail(400, 'New password must be at least 6 characters.');
      if (!user.mustChange) {
        const a = Buffer.from(hashPw(String(body.currentPassword || ''), user.salt)), b = Buffer.from(user.hash);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return fail(401, 'Current password is wrong.');
      }
      user.salt = crypto.randomBytes(16).toString('hex'); user.hash = hashPw(next, user.salt); user.mustChange = false;
      await redis('HSET', 'users', me, JSON.stringify(user));
      return res.json({ user: publicUser(user) });
    }

    // ----- book covers generated by the admin tool (stored as small JPEGs, shared by everyone) -----
    if (action === 'covers') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 120).map((x) => String(x).slice(0, 100));
      if (!ids.length) return res.json({ covers: {} });
      const vals = await redis('HMGET', 'covers', ...ids);
      const covers = {};
      ids.forEach((id, i) => { if (vals[i] && vals[i] !== 'none') covers[id] = vals[i]; });
      return res.json({ covers });
    }
    if (action === 'coverStatus') {
      if (!admin) return fail(403, 'Admins only.');
      return res.json({ ids: (await redis('HKEYS', 'covers')) || [] });
    }
    if (action === 'setCover') {
      if (!admin) return fail(403, 'Admins only.');
      const bookId = bookIdOf();
      const img = String(body.image || '');
      if (!bookId) return fail(400, 'bookId required');
      if (img !== 'none' && !(img.startsWith('data:image/jpeg;base64,') && img.length < 80000)) return fail(400, 'Invalid image.');
      await redis('HSET', 'covers', bookId, img);
      return res.json({ ok: true });
    }
    if (action === 'resetCovers') {
      if (!admin) return fail(403, 'Admins only.');
      await redis('DEL', 'covers');
      return res.json({ ok: true });
    }

    // ----- cohort (class group) used for "Required reading" -----
    if (action === 'setCohort') {
      user.cohort = cleanCohort(body.cohort);
      await redis('HSET', 'users', me, JSON.stringify(user));
      return res.json({ user: publicUser(user) });
    }
    if (action === 'setStudentCohort') {
      if (!admin) return fail(403, 'Admins only.');
      const email = String(body.email || '').toLowerCase();
      const rawU = await redis('HGET', 'users', email);
      if (!rawU) return fail(404, 'Student not found.');
      const u = JSON.parse(rawU); u.cohort = cleanCohort(body.cohort);
      await redis('HSET', 'users', email, JSON.stringify(u));
      return res.json({ cohort: u.cohort });
    }

    // ----- catalogue editor: title / author / category / tags / featured / required-for-cohorts (stored here, Drive is untouched) -----
    if (action === 'setMeta') {
      if (!admin) return fail(403, 'Admins only.');
      const bookId = bookIdOf(); if (!bookId) return fail(400, 'bookId required');
      const m = body.meta || {}, clean = {};
      if (str(m.title, 200)) clean.title = str(m.title, 200);
      if (str(m.author, 120)) clean.author = str(m.author, 120);
      if (str(m.category, 40)) clean.category = str(m.category, 40);
      const tags = [...new Set((Array.isArray(m.tags) ? m.tags : []).map((t) => str(t, 30)).filter(Boolean))].slice(0, 10);
      if (tags.length) clean.tags = tags;
      if (m.featured) clean.featured = true;
      const required = [...new Set((Array.isArray(m.required) ? m.required : []).map(cleanCohort).filter(Boolean))].slice(0, 20);
      if (required.length) clean.required = required;
      const advisors = [...new Set((Array.isArray(m.advisors) ? m.advisors : []).map((t) => str(t, 60)).filter(Boolean))].slice(0, 10);
      if (advisors.length) clean.advisors = advisors;
      if (Object.keys(clean).length) await redis('HSET', 'meta', bookId, JSON.stringify(clean));
      else await redis('HDEL', 'meta', bookId);
      await log(me, 'Edited catalogue details', str(body.title, 120) || bookId);
      return res.json({ meta: Object.keys(clean).length ? clean : null });
    }

    // ----- quiz rating (0-10) by library staff, used for "average quiz score" -----
    if (action === 'rateQuiz') {
      if (!admin) return fail(403, 'Admins only.');
      const email = String(body.email || '').toLowerCase(), bookId = bookIdOf(), score = Number(body.score);
      if (!Number.isInteger(score) || score < 0 || score > 10) return fail(400, 'Score must be a whole number from 0 to 10.');
      const p = await getProg(email, bookId);
      if (!p || !p.isFinished || !p.quiz || p.quiz.revoked) return fail(400, 'There are no active answers to rate.');
      const old = typeof p.quiz.score === 'number' ? p.quiz.score : null;
      p.quiz.score = score; p.quiz.ratedBy = me;
      await redis('HSET', `progress:${email}`, bookId, JSON.stringify(p));
      await stInc('qsum', bookId, score - (old || 0));
      if (old == null) await stInc('qcount', bookId, 1);
      return res.json({ ok: true, score });
    }

    // ----- analytics (admin) -----
    if (action === 'analytics') {
      if (!admin) return fail(403, 'Admins only.');
      const days = Array.from({ length: 30 }, (_, i) => localDay(Date.now() - (29 - i) * 86400000));
      const [hashes, dayCounts, emails] = await Promise.all([
        Promise.all([...ST.map((f) => hgetall(`st:${f}`)), hgetall('views'), hgetall('daily')]),
        Promise.all(days.map((d) => redis('SCARD', `active:${d}`))),
        redis('HKEYS', 'users'),
      ]);
      const union = async (n) => {
        const tmp = `tmp:u${n}:${crypto.randomBytes(4).toString('hex')}`;
        await redis('SUNIONSTORE', tmp, ...days.slice(-n).map((d) => `active:${d}`));
        const c = await redis('SCARD', tmp); await redis('EXPIRE', tmp, 60);
        return c;
      };
      const [wau, mau] = await Promise.all([union(7), union(30)]);
      const byField = {}; ST.forEach((f, i) => { byField[f] = hashes[i]; });
      const views = hashes[ST.length], daily = hashes[ST.length + 1];
      const ids = new Set([...Object.keys(views), ...ST.flatMap((f) => Object.keys(byField[f]))]);
      const books = {};
      ids.forEach((id) => {
        const o = { views: Number(views[id] || 0) };
        ST.forEach((f) => { o[f] = Number(byField[f][id] || 0); });
        books[id] = o;
      });
      const dayKeys = Object.keys(daily).sort();
      return res.json({
        days: days.map((d, i) => ({ date: d, active: Number(dayCounts[i] || 0), seconds: Number(daily[d] || 0) })),
        dau: Number(dayCounts[29] || 0), wau: Number(wau || 0), mau: Number(mau || 0),
        totalSeconds: Object.values(byField.seconds).reduce((a, v) => a + Number(v), 0),
        trackingSince: dayKeys[0] || '',
        students: (emails || []).filter((e) => !isAdminEmail(e)).length,
        books,
      });
    }
    // Rebuild the per-book counters from every student's saved progress (run once after installing analytics; works in chunks).
    if (action === 'rebuildStats') {
      if (!admin) return fail(403, 'Admins only.');
      const offset = Math.max(0, parseInt(body.offset, 10) || 0), CH = 40;
      const emails = ((await redis('HKEYS', 'users')) || []).filter((e) => !isAdminEmail(e)).sort();
      if (offset === 0) await redis('DEL', ...ST.map((f) => `st:${f}`));
      const progs = await Promise.all(emails.slice(offset, offset + CH).map((e) => hgetall(`progress:${e}`)));
      const acc = {};
      const add = (f, id, n) => { if (!n) return; acc[f] = acc[f] || {}; acc[f][id] = (acc[f][id] || 0) + n; };
      progs.forEach((prog) => {
        for (const [id, raw] of Object.entries(prog)) {
          const p = JSON.parse(raw), secs = Math.round(p.seconds || 0);
          if ((p.opens || 0) > 0 || secs > 0) add('readers', id, 1);
          add('seconds', id, secs);
          if (p.isFinished) { add('finished', id, 1); add('fsec', id, secs); }
          if (p.quiz && p.quiz.answers) add('subm', id, 1);
          if (p.quiz && p.quiz.revoked) add('rej', id, 1);
          if (p.isFinished && p.quiz && !p.quiz.revoked && typeof p.quiz.score === 'number') { add('qsum', id, p.quiz.score); add('qcount', id, 1); }
        }
      });
      const cmds = [];
      Object.keys(acc).forEach((f) => Object.entries(acc[f]).forEach(([id, n]) => cmds.push(['HINCRBY', `st:${f}`, id, n])));
      await pipeline(cmds);
      return res.json({ done: offset + CH >= emails.length, next: offset + CH, total: emails.length });
    }
    // Leaderboard with e-mail + cohort, for CSV/Excel export
    if (action === 'exportLeaderboard') {
      if (!admin) return fail(403, 'Admins only.');
      const [scoresRaw, usersRaw] = await Promise.all([hgetall('scores'), hgetall('users')]);
      const cohortOf = {}; Object.values(usersRaw).forEach((u) => { const x = JSON.parse(u); cohortOf[x.email] = x.cohort || ''; });
      const all = Object.values(scoresRaw).map((x) => JSON.parse(x)).filter((x) => x.qualified && x.points > 0);
      all.sort((a, b) => b.points - a.points || b.finished - a.finished || b.seconds - a.seconds || a.name.localeCompare(b.name));
      let last = null, rank = 0;
      return res.json({ leaderboard: all.map((x, i) => {
        if (x.points !== last) { rank = i + 1; last = x.points; }
        return { rank, name: x.name, email: x.email, cohort: cohortOf[x.email] || '', inProgress: x.inProgress, finished: x.finished, quizPts: x.quizPts, points: x.points, seconds: x.seconds };
      }) });
    }

    // ----- a book uploaded from the portal into Google Drive -----
    if (action === 'logUpload') {
      if (!admin) return fail(403, 'Admins only.');
      const id = str(body.bookId, 100), title = str(body.title, 120), where = str(body.destination, 120);
      if (!id) return fail(400, 'bookId required');
      const snapRaw = await redis('GET', 'sync:snapshot');
      const cmds = [['LPUSH', 'synclog', evt('new', id, title, `Uploaded from the portal by ${me} → ${where}`)], ['LTRIM', 'synclog', 0, 499]];
      if (snapRaw) { const snap = JSON.parse(snapRaw); snap[id] = title.slice(0, 80); cmds.push(['SET', 'sync:snapshot', JSON.stringify(snap)]); }
      await pipeline(cmds);
      await log(me, 'Uploaded book', title || id);
      return res.json({ ok: true });
    }

    // ----- Drive sync status, new/removed books, and problem files -----
    if (action === 'syncReport') {
      if (!admin) return fail(403, 'Admins only.');
      const books = Array.isArray(body.books) ? body.books.slice(0, 20000) : [];
      const skipped = Array.isArray(body.skipped) ? body.skipped.slice(0, 500) : [];
      const errors = (Array.isArray(body.errors) ? body.errors : []).map((e) => str(e, 300)).slice(0, 20);
      const cur = {}; books.forEach((b) => { if (Array.isArray(b) && b[0]) cur[str(b[0], 100)] = str(b[1], 80); });
      const curIds = Object.keys(cur);
      const prevRaw = await redis('GET', 'sync:snapshot');
      const prev = prevRaw ? JSON.parse(prevRaw) : null;
      const events = []; const cmds = []; let newIds = [], removedIds = [];
      if (!curIds.length) {
        if (errors.length) errors.forEach((e) => events.push(evt('error', '', 'Drive scan failed', e)));
        else events.push(evt('error', '', 'Drive scan found no books', ''));
      } else {
        if (prev) {
          newIds = curIds.filter((id) => !(id in prev));
          if (!errors.length) removedIds = Object.keys(prev).filter((id) => !(id in cur));
        } else events.push(evt('baseline', '', `First scan saved: ${curIds.length} books`, ''));
        newIds.slice(0, 100).forEach((id) => events.push(evt('new', id, cur[id], 'New book found in Google Drive')));
        if (newIds.length > 100) events.push(evt('new', '', `${newIds.length - 100} more new books`, ''));
        removedIds.slice(0, 100).forEach((id) => events.push(evt('removed', id, prev[id], 'No longer found in Google Drive')));
        if (removedIds.length > 100) events.push(evt('removed', '', `${removedIds.length - 100} more books removed`, ''));
        errors.forEach((e) => events.push(evt('error', '', 'Some folders could not be read', e)));
        cmds.push(['SET', 'sync:snapshot', JSON.stringify(errors.length && prev ? { ...prev, ...cur } : cur)]);
      }
      const issuesNow = await hgetall('issues');
      const skipIds = new Set();
      skipped.forEach((x) => {
        const id = str(x.id, 100); if (!id) return;
        skipIds.add(id);
        const old = issuesNow[id] ? JSON.parse(issuesNow[id]) : null;
        if (!old || old.type !== 'skipped') events.push(evt('skipped', id, str(x.title, 120), str(x.reason, 200)));
        cmds.push(['HSET', 'issues', id, JSON.stringify({ type: 'skipped', title: str(x.title, 120), reason: str(x.reason, 200), ts: Date.now() })]);
      });
      for (const [id, raw] of Object.entries(issuesNow)) {
        const it = JSON.parse(raw);
        if ((it.type === 'skipped' && curIds.length && !skipIds.has(id)) || removedIds.includes(id)) cmds.push(['HDEL', 'issues', id]);
      }
      const last = { ts: Date.now(), total: curIds.length, newCount: newIds.length, removedCount: removedIds.length, skippedCount: skipped.length, errorCount: errors.length };
      cmds.push(['SET', 'sync:last', JSON.stringify(last)]);
      events.forEach((e) => cmds.push(['LPUSH', 'synclog', e]));
      cmds.push(['LTRIM', 'synclog', 0, 499]);
      await pipeline(cmds);
      return res.json({ last, newCount: newIds.length, removedCount: removedIds.length });
    }
    if (action === 'syncStatus') {
      if (!admin) return fail(403, 'Admins only.');
      const [last, logs, issues] = await Promise.all([redis('GET', 'sync:last'), redis('LRANGE', 'synclog', 0, 199), hgetall('issues')]);
      return res.json({
        last: last ? JSON.parse(last) : null,
        log: (logs || []).map((l) => JSON.parse(l)),
        issues: Object.entries(issues).map(([id, r]) => ({ id, ...JSON.parse(r) })).sort((a, b) => b.ts - a.ts),
      });
    }
    // Problems found by the admin tools (unreadable file, broken link) - and the ones that are fixed now
    if (action === 'reportIssues') {
      if (!admin) return fail(403, 'Admins only.');
      const list = (Array.isArray(body.issues) ? body.issues : []).slice(0, 300);
      const resolve = (Array.isArray(body.resolve) ? body.resolve : []).slice(0, 1000).map((x) => str(x, 100));
      const issuesNow = await hgetall('issues');
      const cmds = [];
      list.forEach((x) => {
        const id = str(x.id, 100); if (!id) return;
        const type = ['parse', 'broken', 'skipped'].includes(x.type) ? x.type : 'parse';
        const old = issuesNow[id] ? JSON.parse(issuesNow[id]) : null;
        if (!old || old.type !== type) cmds.push(['LPUSH', 'synclog', evt(type, id, str(x.title, 120), str(x.reason, 200))]);
        cmds.push(['HSET', 'issues', id, JSON.stringify({ type, title: str(x.title, 120), reason: str(x.reason, 200), ts: Date.now() })]);
      });
      let fixed = 0;
      resolve.forEach((id) => { if (issuesNow[id]) { fixed++; cmds.push(['HDEL', 'issues', id]); } });
      if (fixed) cmds.push(['LPUSH', 'synclog', evt('sync', '', `${fixed} problem(s) fixed`, '')]);
      cmds.push(['LTRIM', 'synclog', 0, 499]);
      await pipeline(cmds);
      return res.json({ ok: true });
    }
    if (action === 'clearIssues') {
      if (!admin) return fail(403, 'Admins only.');
      const ids = Array.isArray(body.ids) ? body.ids.map((x) => str(x, 100)) : null;
      if (ids && ids.length) await redis('HDEL', 'issues', ...ids); else await redis('DEL', 'issues');
      return res.json({ ok: true });
    }

    return fail(400, 'Unknown action');
  } catch (e) {
    return fail(500, e.message || 'Server error');
  }
}
