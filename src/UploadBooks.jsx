import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UploadCloud, FileText, CheckCircle, AlertCircle, X, RefreshCw, Link2, GraduationCap, Star } from 'lucide-react';

const SCOPE = 'https://www.googleapis.com/auth/drive';
const MAX_MB = 300;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const inputCls = 'w-full px-3 py-2.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-100 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500';
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const cleanTitle = (n) => n.replace(/\.(pdf|epub)$/i, '').replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim();
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

let gsiPromise = null;
const loadGsi = () => gsiPromise || (gsiPromise = new Promise((resolve, reject) => {
  if (window.google?.accounts?.oauth2) return resolve();
  const sc = document.createElement('script');
  sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
  sc.onload = () => resolve(); sc.onerror = () => { gsiPromise = null; reject(new Error('Could not load Google sign-in. Check the internet connection.')); };
  document.body.appendChild(sc);
}));

async function driveJson(token, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Google Drive error (HTTP ${r.status})`);
  return j;
}
// find a sub-folder by name, or create it
async function ensureFolder(token, parentId, name) {
  const list = await driveJson(token, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${parentId}' in parents and name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  if (list.files?.length) return list.files[0].id;
  const made = await driveJson(token, 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return made.id;
}
function xhrSend(method, url, headers, body, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    Object.entries(headers).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve(x.responseText ? JSON.parse(x.responseText) : {}) : reject(new Error(`Upload failed (HTTP ${x.status}): ${(x.responseText || '').slice(0, 160)}`)));
    x.onerror = () => reject(new Error('Network error while uploading. Check the connection and try again.'));
    x.send(body);
  });
}
// upload one file into a Drive folder (resumable session, one PUT; falls back to multipart if Google hides the session link)
async function uploadFile(token, file, name, parentId, onProgress) {
  const mime = file.type || (/\.epub$/i.test(file.name) ? 'application/epub+zip' : 'application/pdf');
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,mimeType', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(file.size) },
    body: JSON.stringify({ name, mimeType: mime, parents: [parentId] }),
  });
  if (!start.ok) { const j = await start.json().catch(() => ({})); throw new Error(j.error?.message || `Google Drive refused the upload (HTTP ${start.status})`); }
  const session = start.headers.get('Location');
  if (session) return xhrSend('PUT', session, { 'Content-Type': mime }, file, onProgress);
  // fallback: multipart
  const boundary = 'camtech' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType: mime, parents: [parentId] })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, file, `\r\n--${boundary}--`]);
  return xhrSend('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,mimeType',
    { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body, onProgress);
}

export default function UploadBooks({ clientId, rootFolderId, advisorFolderName, driveKey, userEmail, books, categories, professors, cohorts, guessCategory, api, onDone, flash }) {
  const [auth, setAuth] = useState(null);                // { token, expires, email, name }
  const [authErr, setAuthErr] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [dest, setDest] = useState('stem');              // stem | advisor
  const [prof, setProf] = useState('');
  const [items, setItems] = useState([]);                // { id, file, title, author, status, progress, error, fileId }
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [featured, setFeatured] = useState(false);
  const [required, setRequired] = useState('');
  const [running, setRunning] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const stop = useRef(false);

  const tokenOk = auth && auth.expires > Date.now() + 30000;
  const existing = useMemo(() => new Set(books.map((b) => b.title.trim().toLowerCase())), [books]);

  const connect = async () => {
    setAuthErr(''); setConnecting(true);
    try {
      await loadGsi();
      const resp = await new Promise((resolve, reject) => {
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId, scope: SCOPE, hint: userEmail,
          callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
          error_callback: (e) => reject(new Error(e?.message || e?.type || 'Google sign-in was closed')),
        });
        client.requestAccessToken({ prompt: '' });
      });
      const token = resp.access_token;
      const about = await driveJson(token, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)');
      const folder = await driveJson(token, `https://www.googleapis.com/drive/v3/files/${rootFolderId}?fields=id,name,capabilities(canAddChildren)&supportsAllDrives=true`).catch(() => null);
      if (!folder) throw new Error(`${about.user.emailAddress} cannot open the library folder. Sign in with the library account, or share the folder with this account as an Editor.`);
      if (!folder.capabilities?.canAddChildren) throw new Error(`${about.user.emailAddress} can only view the library folder. Share it with this account as an Editor.`);
      setAuth({ token, expires: Date.now() + (Number(resp.expires_in) || 3600) * 1000, email: about.user.emailAddress, name: about.user.displayName });
    } catch (e) { setAuthErr(e.message); }
    setConnecting(false);
  };

  const addFiles = (list) => {
    const added = [];
    for (const f of Array.from(list)) {
      const ok = /\.(pdf|epub)$/i.test(f.name);
      if (!ok) { flash?.(`${f.name}: only PDF and EPUB files can be uploaded.`); continue; }
      if (f.size > MAX_MB * 1048576) { flash?.(`${f.name}: larger than ${MAX_MB} MB.`); continue; }
      if (f.size === 0) { flash?.(`${f.name}: the file is empty.`); continue; }
      added.push({ id: Math.random().toString(36).slice(2), file: f, title: cleanTitle(f.name), author: '', status: 'ready', progress: 0, error: '' });
    }
    setItems((cur) => [...cur, ...added]);
    if (added.length && !category) setCategory(guessCategory(added[0].file.name.toLowerCase()));
  };
  const patch = (id, p) => setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...p } : it)));
  const destLabel = dest === 'advisor' ? `${advisorFolderName} › ${prof.trim() || '…'}` : 'STEM Resources';
  const canUpload = tokenOk && items.some((i) => i.status === 'ready' || i.status === 'error') && !running && (dest === 'stem' || prof.trim());

  const run = async () => {
    stop.current = false; setRunning(true);
    let token = auth.token;
    try {
      let parentId = rootFolderId;
      if (dest === 'advisor') {
        const advId = await ensureFolder(token, rootFolderId, advisorFolderName);
        parentId = await ensureFolder(token, advId, prof.trim());
      }
      let okCount = 0;
      for (const it of items) {
        if (stop.current) break;
        if (it.status !== 'ready' && it.status !== 'error') continue;
        if (auth.expires < Date.now() + 60000) { patch(it.id, { status: 'error', error: 'Google session expired. Press "Connect Google Drive" again, then retry.' }); break; }
        patch(it.id, { status: 'uploading', progress: 0, error: '' });
        try {
          const ext = (it.file.name.match(/\.(pdf|epub)$/i) || [''])[0].toLowerCase();
          const driveName = it.title.trim() ? `${it.title.trim()}${ext}` : it.file.name;
          const res = await uploadFile(token, it.file, driveName, parentId, (p) => patch(it.id, { progress: p }));
          const fileId = res.id;
          patch(it.id, { status: 'finishing', progress: 1, fileId });
          // can students read it? (the library folder is shared, so new files normally inherit that)
          let readable = (await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id&key=${driveKey}`)).ok;
          if (!readable) {
            await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) }).catch(() => {});
            readable = (await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id&key=${driveKey}`)).ok;
          }
          // details chosen here (kept in the portal, same as the Catalog Manager)
          const meta = { category: category.trim(), tags: split(tags), featured, required: split(required) };
          if (dest === 'stem') { /* no professor */ }
          if (it.author.trim()) meta.author = it.author.trim();
          await api('setMeta', { bookId: fileId, title: it.title, meta });
          // a cover made right now from the file on this computer
          try {
            const tools = await import('./coverTools.js');
            const img = ext === '.pdf' ? await tools.pdfCover(URL.createObjectURL(it.file)) : await tools.epubCoverFromBytes(new Uint8Array(await it.file.arrayBuffer()));
            await api('setCover', { bookId: fileId, image: img });
          } catch { /* Drive will make its own thumbnail */ }
          await api('logUpload', { bookId: fileId, title: it.title, destination: destLabel });
          patch(it.id, { status: 'done', error: readable ? '' : 'Uploaded, but students may not be able to open it yet: the file is not shared. Open it in Drive and set "Anyone with the link: Viewer".' });
          okCount++;
        } catch (e) { patch(it.id, { status: 'error', error: e.message }); }
      }
      if (okCount) { flash?.(`${okCount} book(s) uploaded to Google Drive.`); onDone?.(); }
    } catch (e) { flash?.(e.message); setItems((cur) => cur.map((i) => (i.status === 'uploading' ? { ...i, status: 'error', error: e.message } : i))); }
    setRunning(false);
  };

  if (!clientId) return (
    <div className="max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3 shadow-lg">
      <h2 className="text-xl font-bold text-slate-100 font-serif flex items-center gap-2"><UploadCloud className="w-6 h-6 text-amber-400" /> Upload books</h2>
      <p className="text-sm text-slate-300">One-time setup is needed before uploads can go to Google Drive:</p>
      <ol className="list-decimal pl-5 text-xs text-slate-400 space-y-1.5">
        <li>Google Cloud Console → APIs &amp; Services → <b>Credentials</b> → Create credentials → <b>OAuth client ID</b> → Web application.</li>
        <li>Under <b>Authorized JavaScript origins</b> add this website's address (for example https://camtech-ebook-portal.vercel.app).</li>
        <li>OAuth consent screen: choose <b>Internal</b> if offered; otherwise External + Testing, and add the two admin emails as <b>Test users</b>.</li>
        <li>Copy the Client ID into Vercel → Environment Variables as <code className="text-amber-400">VITE_GOOGLE_CLIENT_ID</code>, then redeploy.</li>
      </ol>
    </div>
  );

  const label = 'text-xs font-semibold text-slate-300';
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-100 font-serif flex items-center gap-2"><UploadCloud className="w-6 h-6 text-amber-400" /> Upload books</h2>
        <p className="text-slate-400 text-sm">Add PDF or EPUB books here. They are sent straight to the Google Drive library and appear in the catalog.</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3 shadow-lg">
        <h3 className="font-bold text-slate-100 text-sm flex items-center gap-2"><Link2 className="w-4 h-4 text-amber-400" /> 1. Connect Google Drive</h3>
        {tokenOk ? (
          <div className="flex items-center gap-2 text-xs text-emerald-400"><CheckCircle className="w-4 h-4" /> Connected as <b>{auth.email}</b> — can add files to the library folder.</div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={connect} disabled={connecting} className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-bold text-xs flex items-center gap-2">{connecting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} {auth ? 'Reconnect Google Drive' : 'Connect Google Drive'}</button>
            <span className="text-[11px] text-slate-500">Use the library's Google account (or an account with Editor access to the library folder). The connection lasts about an hour.</span>
          </div>
        )}
        {authErr && <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-start gap-2"><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {authErr}</div>}
      </div>

      <div className={`bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-lg ${tokenOk ? '' : 'opacity-60 pointer-events-none'}`}>
        <h3 className="font-bold text-slate-100 text-sm">2. Where should the books go?</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          {[['stem', 'STEM Resources', 'The main library collection'], ['advisor', 'CamTech Advisor', 'Books recommended by a professor']].map(([id, t, d]) => (
            <label key={id} className={`cursor-pointer rounded-xl border p-3 flex items-start gap-3 ${dest === id ? 'border-amber-500 bg-amber-500/10' : 'border-slate-800 bg-slate-950'}`}>
              <input type="radio" name="dest" checked={dest === id} onChange={() => setDest(id)} className="mt-1 accent-amber-500" />
              <span><span className="block text-sm font-bold text-slate-100">{t}</span><span className="block text-[11px] text-slate-400">{d}</span></span>
            </label>
          ))}
        </div>
        {dest === 'advisor' && (
          <label className="block space-y-1"><span className={label}>Professor name <span className="font-normal text-slate-500">(a folder with this name is created inside “{advisorFolderName}”)</span></span>
            <input className={inputCls} list="prof-list" value={prof} onChange={(e) => setProf(e.target.value)} placeholder="e.g. Dr. Sok Dara" />
            <datalist id="prof-list">{professors.map((p) => <option key={p} value={p} />)}</datalist></label>
        )}

        <h3 className="font-bold text-slate-100 text-sm pt-2">3. Choose the files</h3>
        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()} className={`cursor-pointer border-2 border-dashed rounded-2xl p-8 text-center transition ${drag ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 hover:border-slate-500'}`}>
          <UploadCloud className="w-8 h-8 text-amber-400 mx-auto mb-2" />
          <div className="text-sm text-slate-200 font-semibold">Drop PDF / EPUB files here, or click to choose</div>
          <div className="text-[11px] text-slate-500">Up to {MAX_MB} MB each</div>
          <input ref={fileRef} type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        </div>

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-2">
                <div className="flex items-center gap-2 text-[11px] text-slate-400"><FileText className="w-4 h-4 shrink-0" /><span className="truncate flex-1">{it.file.name}</span><span className="font-mono">{fmtMB(it.file.size)}</span>
                  {(it.status === 'ready' || it.status === 'error') && !running && <button onClick={() => setItems((c) => c.filter((x) => x.id !== it.id))} className="text-slate-500 hover:text-rose-400"><X className="w-4 h-4" /></button>}</div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <input className={inputCls} value={it.title} disabled={it.status === 'uploading' || it.status === 'done'} onChange={(e) => patch(it.id, { title: e.target.value })} placeholder="Title" />
                  <input className={inputCls} value={it.author} disabled={it.status === 'uploading' || it.status === 'done'} onChange={(e) => patch(it.id, { author: e.target.value })} placeholder="Author (optional)" />
                </div>
                {existing.has(it.title.trim().toLowerCase()) && it.status === 'ready' && <div className="text-[11px] text-amber-400 flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> A book with this title is already in the catalog.</div>}
                {(it.status === 'uploading' || it.status === 'finishing') && <div className="space-y-1"><div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden"><div className="h-full bg-amber-500 transition-all" style={{ width: `${Math.round(it.progress * 100)}%` }} /></div><div className="text-[11px] text-slate-400">{it.status === 'finishing' ? 'Finishing…' : `Uploading ${Math.round(it.progress * 100)}%`}</div></div>}
                {it.status === 'done' && <div className="text-[11px] text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Uploaded to {destLabel}</div>}
                {it.error && <div className={`text-[11px] flex items-start gap-1 ${it.status === 'done' ? 'text-amber-400' : 'text-rose-400'}`}><AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {it.error}</div>}
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-3">
          <div className="text-xs font-bold text-slate-200">Details for these books</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block space-y-1"><span className={label}>Category</span><input className={inputCls} list="up-cats" value={category} onChange={(e) => setCategory(e.target.value)} /><datalist id="up-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></label>
            <label className="block space-y-1"><span className={label}>Tags <span className="font-normal text-slate-500">(comma separated)</span></span><input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} /></label>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 items-end">
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer"><input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} className="accent-amber-500 w-4 h-4" /><Star className="w-4 h-4 text-amber-400" /> Featured (pin to top)</label>
            <label className="block space-y-1"><span className={`${label} flex items-center gap-1.5`}><GraduationCap className="w-4 h-4 text-blue-400" /> Required for cohorts <span className="font-normal text-slate-500">(optional)</span></span><input className={inputCls} list="up-cohorts" placeholder="CS-Y1, ALL" value={required} onChange={(e) => setRequired(e.target.value)} /><datalist id="up-cohorts">{['ALL', ...cohorts].map((c) => <option key={c} value={c} />)}</datalist></label>
          </div>
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={run} disabled={!canUpload} className="flex-1 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-[#020617] font-bold text-sm flex items-center justify-center gap-2"><UploadCloud className="w-4 h-4" /> {running ? 'Uploading…' : `Upload ${items.filter((i) => i.status === 'ready' || i.status === 'error').length || ''} book(s) to ${destLabel}`}</button>
          {running && <button onClick={() => { stop.current = true; }} className="px-5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs">Stop after this file</button>}
        </div>
        {dest === 'advisor' && !prof.trim() && <div className="text-[11px] text-amber-400">Enter the professor's name to enable the upload button.</div>}
      </div>
    </div>
  );
}
