// المزامنة السحابية المشفّرة (لنسخة الآيفون والموقع فقط — تطبيق أندرويد لا يستعملها).
// كل مستند (الصفوف، الإعدادات، درجات كل صف) يُشفَّر على الجهاز بـ AES-GCM بمفتاح مشتق من كلمة سر المعلم
// (PBKDF2) قبل إرساله؛ الخادم يخزّن نصًا مشفّرًا فقط ولا يعرف كلمة السر ولا أي اسم أو درجة.
// المزامنة: كل تعديل يُرسل خلال أقل من ثانية، والأجهزة الأخرى تُبلَّغ فورًا (WebSocket) فتجلب الجديد.
// التعارض (تعديل نفس الصف من جهازين في نفس اللحظة): دمج ثلاثي على مستوى كل خانة.
import CONFIG from './config.js';

export const CLOUD = String(CONFIG.cloudUrl || '').replace(/\/+$/, '');
const KDF_ITER = 210_000;
const MSG = 'g1.';
const te = new TextEncoder();
const td = new TextDecoder();
const toB64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const USER_RE = /^[a-z0-9_.-]{3,32}$/;
export const normUser = (u) => String(u || '').trim().toLowerCase();

/** من كلمة السر: «إثبات» يُرسل للخادم + مفتاح تشفير لا يغادر الجهاز (جزءان مستقلان من PBKDF2-SHA256). */
export async function deriveKeys(user, password, iter = KDF_ITER) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('gfu-cloud-v1:' + normUser(user)), iterations: iter }, base, 512));
  return { proof: toB64u(bits.subarray(0, 32)), rawKey: bits.slice(32) };
}
export const importKey = (raw, extractable = false) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);

export async function encryptDoc(key, k, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(k) }, key, te.encode(JSON.stringify(obj))));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv); all.set(ct, 12);
  return MSG + toB64u(all);
}
export async function decryptDoc(key, k, s) {
  if (typeof s !== 'string' || !s.startsWith(MSG)) throw new Error('bad doc');
  const all = fromB64u(s.slice(MSG.length));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: te.encode(k) }, key, all.subarray(12));
  return JSON.parse(td.decode(pt));
}

// ---------- دمج ثلاثي ----------
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
export function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/** base = آخر نسخة متفق عليها، local = هذا الجهاز، remote = الخادم. الخانة التي تغيّرت في جهة واحدة تُؤخذ منها؛ وإن تغيّرت في الجهتين يفوز هذا الجهاز. */
export function merge3(base, local, remote) {
  if (same(local, base)) return remote;
  if (same(remote, base) || same(local, remote)) return local;
  if (isObj(local) && isObj(remote)) {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const m = merge3(isObj(base) ? base[k] : undefined, local[k], remote[k]);
      if (m !== undefined) out[k] = m;
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(remote) && Array.isArray(base) && local.length === remote.length && base.length === local.length && local.every((x) => x === null || typeof x !== 'object')) {
    return local.map((x, i) => merge3(base[i], x, remote[i])); // بنود الدرجات الأربعة: كل بند وحده
  }
  return local;
}
/** قائمة الصفوف: تُدمج بالمعرّف (id) — صف أُضيف في أي جهاز يبقى، وصف حُذف في جهاز يُحذف. */
export function mergeClasses(base, local, remote) {
  const map = (list) => Object.fromEntries((Array.isArray(list) ? list : []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const m = merge3(map(base), map(local), map(remote));
  const order = [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])].map((c) => c && c.id);
  return [...new Set(order)].filter((id) => id && m[id]).map((id) => m[id]);
}
export const mergeDoc = (k, base, local, remote) => (k === 'classes' ? mergeClasses(base, local, remote) : merge3(base, local, remote));

// ---------- الجلسة ----------
const SESSION = 'gfu-cloud';
export function readSession() {
  try {
    const eph = sessionStorage.getItem(SESSION);
    if (eph) return { ...JSON.parse(eph), eph: true };
  } catch { /* */ }
  try {
    const s = localStorage.getItem(SESSION);
    if (s) return { ...JSON.parse(s), eph: false };
  } catch { /* */ }
  return null;
}
function writeSession(s) {
  const { eph, ...rest } = s;
  try { (eph ? sessionStorage : localStorage).setItem(SESSION, JSON.stringify(rest)); } catch { /* */ }
}
export function clearSession() {
  try { sessionStorage.removeItem(SESSION); } catch { /* */ }
  try { localStorage.removeItem(SESSION); } catch { /* */ }
}

async function api(path, { method = 'GET', body, token, timeout = 20000 } = {}) {
  // مهلة لكل طلب: شبكة المدرسة الضعيفة قد تُعلّق الطلب بلا رد — نلغيه ونعيد المحاولة لاحقًا
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeout) : 0;
  let res;
  try {
    res = await fetch(CLOUD + path, {
      method, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac ? ac.signal : undefined,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = await res.json(); } catch { /* */ }
  return { status: res.status, j: j || {} };
}

/** دخول أو تسجيل أول مرة (invite). remember=false: جلسة لهذا التبويب فقط ولا يُحفظ شيء على الجهاز. */
export async function signIn({ user, password, invite = '', remember = true }) {
  if (!CLOUD) throw new Error('off');
  const u = normUser(user);
  if (!USER_RE.test(u)) throw codeErr('bad-user');
  const { proof, rawKey } = await deriveKeys(u, password);
  let r;
  try {
    r = invite
      ? await api('/api/register', { method: 'POST', body: { u, invite, a: proof } })
      : await api('/api/login', { method: 'POST', body: { u, a: proof } });
  } catch { throw codeErr('offline'); }
  if (r.status === 429) throw codeErr('locked');
  if (r.status !== 200 || !r.j.token) throw codeErr(invite ? 'bad-invite' : 'wrong');
  const session = { u, token: r.j.token, eph: !remember, mustChange: !!r.j.mustChange, t: Date.now() };
  if (remember) { try { localStorage.setItem('gfu-cloud-last', u); } catch { /* */ } }
  // المفتاح: في جلسة مؤقتة يبقى في هذا التبويب فقط؛ في الجوال يُحفظ في IndexedDB كمفتاح غير قابل للاستخراج
  if (!remember) session.k = toB64u(rawKey);
  writeSession(session);
  return { session, key: await importKey(rawKey), rawKey };
}
function codeErr(code) { const e = new Error(code); e.code = code; return e; }
/** قوائم صفوف المدرسة (للمعلم المسجّل فقط). null إن لم تُرفع أو تعذّر الاتصال. */
export async function fetchRoster(session) {
  try {
    const r = await api('/api/roster', { token: session.token });
    return r.status === 200 ? r.j : null;
  } catch { return null; }
}
export async function fetchTimetable(session) {
  try {
    const r = await api('/api/timetable', { token: session.token });
    return r.status === 200 ? r.j : null;
  } catch { return null; }
}
export function lastUser() { try { return localStorage.getItem('gfu-cloud-last') || ''; } catch { return ''; } }

/** تغيير كلمة السر و/أو اسم المستخدم: يعيد تشفير كل المستندات بالمفتاح الجديد ويرسلها مرة واحدة.
 *  الأجهزة الأخرى تخرج ويُطلب منها الدخول بالبيانات الجديدة. يحتاج إنترنت. */
export async function changeAccount(sync, { user2, password }) {
  const s = sync.s;
  const u2 = normUser(user2 || s.u);
  if (!USER_RE.test(u2)) throw codeErr('bad-user');
  if (!(await sync.settle())) throw codeErr('offline');
  const { proof, rawKey } = await deriveKeys(u2, password);
  const key = await importKey(rawKey);
  const docs = [];
  for (const k of sync.host.keys()) { const v = sync.host.get(k); if (v !== null && v !== undefined) docs.push({ k, d: await encryptDoc(key, k, v) }); }
  let r;
  try { r = await api('/api/account', { method: 'POST', token: s.token, timeout: 60000, body: { ...(u2 !== s.u ? { u2 } : {}), a: proof, docs } }); } catch { throw codeErr('offline'); }
  if (r.status === 409) throw codeErr('taken');
  if (r.status === 401) throw codeErr('auth');
  if (r.status !== 200 || !r.j.token) throw codeErr('failed');
  sync.stop();
  const session = { u: r.j.u, token: r.j.token, eph: !!s.eph, mustChange: false, t: s.t || Date.now() };
  if (s.eph) session.k = toB64u(rawKey);
  else { try { localStorage.setItem('gfu-cloud-last', r.j.u); } catch { /* */ } }
  writeSession(session);
  return { session, key };
}

// ---------- محرك المزامنة ----------
// host: { keys(), get(k), apply(k, data), loadMeta(), saveMeta(m), onState(s), onAuthLost() }
export class CloudSync {
  constructor(session, key, host) {
    this.s = session; this.key = key; this.host = host;
    this.meta = { seq: 0, docs: {} }; // docs[k] = {v, base}
    this.dirty = new Set();
    this.state = 'idle';
    this.timer = 0; this.busy = false; this.ws = null; this.wsTry = 0; this.stopped = false; this.pullAgain = false;
    this.lastOk = 0;
  }

  setState(s) { if (this.state !== s) { this.state = s; try { this.host.onState(s); } catch { /* */ } } }

  async start() {
    this.meta = (await this.host.loadMeta()) || { seq: 0, docs: {} };
    // ما تغيّر محليًا منذ آخر مزامنة (حتى لو أُغلق التطبيق قبل الإرسال)
    for (const k of this.host.keys()) if (!same(this.host.get(k), this.meta.docs[k] ? this.meta.docs[k].base : undefined)) this.dirty.add(k);
    for (const k of Object.keys(this.meta.docs)) if (!this.host.keys().includes(k) && this.meta.docs[k].base !== null) this.dirty.add(k);
    await this.pull();
    this.connect();
    this.flushSoon(50);
    this.onVis = () => { if (document.visibilityState === 'visible') { this.pull(); if (!this.ws) this.connect(); } };
    this.onOnline = () => { this.pull(); this.flushSoon(50); if (!this.ws) this.connect(); };
    document.addEventListener('visibilitychange', this.onVis);
    window.addEventListener('online', this.onOnline);
    this.poll = setInterval(() => { if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState !== 1)) this.pull(); }, 15000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearInterval(this.poll);
    if (this.onVis) document.removeEventListener('visibilitychange', this.onVis);
    if (this.onOnline) window.removeEventListener('online', this.onOnline);
    try { this.ws && this.ws.close(); } catch { /* */ }
    this.ws = null;
  }

  connect() {
    if (this.stopped || typeof WebSocket !== 'function') return;
    try { if (this.ws) this.ws.close(); } catch { /* */ }
    let ws;
    try { ws = new WebSocket(CLOUD.replace(/^http/, 'ws') + '/api/ws?t=' + encodeURIComponent(this.s.token)); } catch { return; }
    this.ws = ws;
    ws.onopen = () => { this.wsTry = 0; };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m && Number(m.seq) > this.meta.seq) this.pull(); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped || document.visibilityState !== 'visible') return; // يرجع عند فتح التطبيق
      this.wsTry++;
      setTimeout(() => { if (!this.ws && !this.stopped) this.connect(); }, Math.min(30000, 1000 * 2 ** Math.min(this.wsTry, 5)));
    };
  }

  /** تعديل محلي: يُرسل بعد لحظة (تُجمع التعديلات المتتالية). */
  touch(k) { this.dirty.add(k); this.flushSoon(); }
  flushSoon(ms = 600) { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), ms); }

  async saveMeta() { try { await this.host.saveMeta(this.meta); } catch { /* */ } }

  async flush() {
    if (this.stopped) return;
    if (this.busy) { this.flushSoon(300); return; }
    if (!this.dirty.size) { if (this.state !== 'offline') this.setState('ok'); return; }
    this.busy = true;
    this.setState('syncing');
    let failed = false;
    try {
      for (const k of [...this.dirty]) {
        const ok = await this.pushDoc(k);
        if (ok === 'auth') return;
        if (!ok) { failed = true; break; }
      }
    } finally { this.busy = false; }
    await this.saveMeta();
    if (failed) { this.setState('offline'); this.flushSoon(5000); }
    else if (this.dirty.size) this.flushSoon(50);
    else { this.lastOk = Date.now(); this.setState('ok'); }
  }

  async pushDoc(k) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const local = this.host.keys().includes(k) ? this.host.get(k) : null;
      const known = this.meta.docs[k] || { v: 0, base: undefined };
      if (known.v === 0 && local === null) { this.dirty.delete(k); return true; } // لم يُرفع أصلًا
      let r;
      try {
        r = await api('/api/doc', { method: 'PUT', token: this.s.token, body: { k, base: known.v, d: local === null ? null : await encryptDoc(this.key, k, local) } });
      } catch { return false; }
      if (r.status === 401) { this.authLost(); return 'auth'; }
      if (r.status === 200) {
        this.meta.docs[k] = { v: r.j.v, base: local };
        if (!same(this.host.get(k), local)) return true; // تغيّر أثناء الإرسال: يبقى dirty
        this.dirty.delete(k);
        return true;
      }
      if (r.status === 409) {
        let remote = null;
        try { remote = r.j.d === null ? null : await decryptDoc(this.key, k, r.j.d); } catch { remote = null; }
        const merged = remote === null ? local : mergeDoc(k, known.base, local, remote);
        this.meta.docs[k] = { v: r.j.v, base: remote };
        if (!same(merged, local)) await this.host.apply(k, merged);
        continue;
      }
      return false;
    }
    return false;
  }

  /** يجلب ما تغيّر في الخادم ويطبّقه (مع الدمج إن كان هنا تعديل لم يُرسل بعد). */
  async pull() {
    if (this.stopped) return;
    if (this.pulling) { this.pullAgain = true; return; }
    this.pulling = true;
    try {
      let r;
      try { r = await api('/api/docs?since=' + this.meta.seq, { token: this.s.token }); } catch { this.setState('offline'); return; }
      if (r.status === 401) { this.authLost(); return; }
      if (r.status !== 200) { this.setState('offline'); return; }
      for (const doc of r.j.docs || []) {
        const known = this.meta.docs[doc.k] || { v: 0, base: undefined };
        if (doc.v <= known.v) continue;
        let remote;
        try { remote = doc.d === null ? null : await decryptDoc(this.key, doc.k, doc.d); } catch { continue; } // ليس بمفتاحنا
        // دائمًا دمج ثلاثي: أي تعديل هنا لم يُرسل بعد (حتى لو لم يُحفظ) لا يضيع
        const local = this.host.keys().includes(doc.k) ? this.host.get(doc.k) : null;
        const result = local === null || remote === null ? remote : mergeDoc(doc.k, known.base, local, remote);
        this.meta.docs[doc.k] = { v: doc.v, base: remote };
        if (!same(result, local)) await this.host.apply(doc.k, result);
        if (same(result, remote)) this.dirty.delete(doc.k); else this.dirty.add(doc.k);
      }
      this.meta.seq = Math.max(this.meta.seq, Number(r.j.seq) || 0);
      await this.saveMeta();
      this.lastOk = Date.now();
      if (this.dirty.size) this.flushSoon(50); else if (!this.busy) this.setState('ok');
    } finally {
      this.pulling = false;
      if (this.pullAgain) { this.pullAgain = false; this.pull(); }
    }
  }

  /** ينتظر حتى يُرفع كل تعديل ويُجلب كل جديد (قبل تغيير كلمة السر مثلًا). true = متزامن تمامًا. */
  async settle(ms = 20000) {
    const t0 = Date.now();
    let pulled = false;
    while (Date.now() - t0 < ms && !this.stopped) {
      if (this.busy || this.pulling) { await sleep(150); continue; }
      if (this.dirty.size) { await this.flush(); if (this.state === 'offline') return false; continue; }
      if (!pulled) { await this.pull(); pulled = true; continue; }
      return this.state !== 'offline';
    }
    return false;
  }

  authLost() { this.stop(); this.setState('auth'); try { this.host.onAuthLost(); } catch { /* */ } }

  async logout() {
    this.stop();
    try { await api('/api/logout', { method: 'POST', token: this.s.token, body: {} }); } catch { /* */ }
  }
}

export async function waitFor(fn, ms = 10000) { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(50); return fn(); }
