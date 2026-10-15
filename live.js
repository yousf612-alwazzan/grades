// العرض الحي: اتصال مباشر بين الجوال والكمبيوتر عبر WebRTC DataChannel.
// الإشارة: رمز العرض (offer) يُنقل برمز QR من شاشة الكمبيوتر إلى الجوال. رمز الرد (answer) يعود للكمبيوتر
// عبر «وسيط المصافحة» (ntfy.sh) مشفّرًا بـ AES-GCM بمفتاح عشوائي لا يوجد إلا داخل QR — أو بالنسخ واللصق احتياطًا.
// الوسيط لا يرى إلا نصًا مشفّرًا لرد الاتصال؛ الدرجات والأسماء لا تمر عبره أبدًا (تمر مباشرة عبر قناة WebRTC).
// الكمبيوتر (view.html) = صاحب العرض (offerer)، والجوال = المجيب (answerer) وهو مصدر البيانات الوحيد.
// أمان: الجوال يتجاهل كل رسالة واردة عدا ping/pong (القراءة فقط مفروضة من جهة الجوال).
import CONFIG from './config.js';

export const PROTO = 1;

const HEARTBEAT_MS = 5000;
const DEAD_MS = 12000;
const GATHER_MS = 3000;       // أقصى انتظار لجمع مسارات الشبكة
const GATHER_SETTLE_MS = 900;  // بعد أول مسار نكتفي بانتظار قصير (شبكة المدرسة/نقطة الاتصال تكفيها المسارات المحلية)
const CHUNK = 12000;           // حجم آمن لكل رسالة على كل الأجهزة (بعضها يرفض الرسائل الكبيرة بصمت)
const MAX_CANDS = 4;
const BAD_CODE = 'رمز الاتصال غير صالح أو ناقص. أعد المسح أو انسخ الرمز كاملًا مرة أخرى.';

// ---------- وسيط المصافحة (رد الاتصال فقط، مشفّرًا) ----------
export const RELAY = 'https://ntfy.sh';
const RELAY_TIMEOUT_MS = 10 * 60 * 1000; // صلاحية رمز العرض للوسيط
const RELAY_POSTS = 3; // محاولات إرسال الرد من الجوال
const RELAY_FAILS = 3; // إخفاقات متتالية قبل إبلاغ «تعذّر الوصول للوسيط»
const RELAY_MSG = 'g1.'; // بادئة صيغة الرسالة المشفّرة

// ---------- تحميل المكتبات المضمّنة (سكربتات كلاسيكية تضع متغيرات عامة) ----------
const vendorUrl = (f) => new URL(`./vendor/${f}`, import.meta.url).href;
const loading = {};
function loadScript(file, globalName) {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!loading[file]) {
    loading[file] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = vendorUrl(file);
      s.async = true;
      s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error('تعذر تحميل مكتبة ' + file)));
      s.onerror = () => { delete loading[file]; reject(new Error('تعذر تحميل مكتبة ' + file)); };
      (document.head || document.documentElement).appendChild(s);
    });
  }
  return loading[file];
}
// fflate و qrcode صغيران ويحتاجهما decodeSignal و renderQR المتزامنان، فنحمّلهما مع الوحدة.
await Promise.all([loadScript('fflate.min.js', 'fflate'), loadScript('qrcode.js', 'qrcode')]).catch(() => {});

// ---------- base64 / base64url ----------
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const toUrl = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromUrl(u) {
  let b = u.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return b;
}

// ---------- ضغط الإشارة ----------
const MDNS_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
function packAddr(ip) {
  const m = MDNS_RE.exec(ip || '');
  if (!m) return ip;
  const hex = m.slice(1).join('');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return '~' + toUrl(bytesToB64(bytes));
}
function unpackAddr(a) {
  if (typeof a !== 'string' || !a) throw new Error(BAD_CODE);
  if (a[0] !== '~') return a;
  const b = b64ToBytes(fromUrl(a.slice(1)));
  if (b.length !== 16) throw new Error(BAD_CODE);
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
}

const TYPE_CODE = { host: 'h', srflx: 's', prflx: 'p', relay: 'r' };
const CODE_TYPE = { h: 'host', s: 'srflx', p: 'prflx', r: 'relay' };

function parseCandidate(line) {
  // candidate:<foundation> <component> <proto> <priority> <ip> <port> typ <type> [raddr x rport y] [tcptype t] ...
  const parts = line.replace(/^a=/, '').replace(/^candidate:/, '').trim().split(/\s+/);
  if (parts.length < 8 || parts[6] !== 'typ') return null;
  const c = { component: parts[1], proto: parts[2].toLowerCase(), ip: parts[4], port: Number(parts[5]), type: parts[7] };
  for (let i = 8; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'raddr') c.raddr = parts[i + 1];
    else if (parts[i] === 'rport') c.rport = Number(parts[i + 1]);
    else if (parts[i] === 'tcptype') c.tcptype = parts[i + 1];
  }
  if (c.component !== '1' || !TYPE_CODE[c.type] || !(c.port >= 0)) return null;
  if (c.proto === 'tcp' && (c.tcptype === 'active' || c.port === 9)) return null; // tcp active لا يفيد كطرف بعيد
  return c;
}
function candRank(c) {
  const isV6 = c.ip.includes(':');
  const isMdns = /\.local$/i.test(c.ip);
  if (c.proto === 'udp' && c.type === 'host') return isV6 ? 1 : 0; // IPv4 و mDNS أولًا
  if (c.proto === 'udp' && (c.type === 'srflx' || c.type === 'prflx')) return 2;
  if (c.proto === 'udp' && c.type === 'relay') return 3;
  if (isMdns) return 4;
  return 5; // tcp
}
export function pickCandidates(cands) {
  const sorted = cands.map((c, i) => ({ c, i })).sort((a, b) => candRank(a.c) - candRank(b.c) || a.i - b.i).map((x) => x.c);
  // إزالة التكرار
  const seen = new Set();
  const uniq = sorted.filter((c) => { const k = `${c.proto}|${c.ip}|${c.port}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const out = uniq.slice(0, MAX_CANDS);
  // إن وُجد مرحِّل TURN فلا بد أن يبقى (هو الحل حين تمنع الشبكة الاتصال المباشر)
  const relay = uniq.find((c) => c.type === 'relay');
  if (relay && !out.includes(relay)) out[out.length - 1] = relay;
  return out;
}
const compactCand = (c) => {
  const t = [TYPE_CODE[c.type] + (c.proto === 'tcp' ? 't' : ''), packAddr(c.ip), c.port];
  if (c.raddr != null) t.push(packAddr(c.raddr), c.rport ?? 0);
  return t;
};

function parseSdp(sdp) {
  const lines = String(sdp || '').split(/\r?\n/);
  const r = { cands: [] };
  for (const l of lines) {
    if (l.startsWith('a=ice-ufrag:')) r.u ??= l.slice(12).trim();
    else if (l.startsWith('a=ice-pwd:')) r.p ??= l.slice(10).trim();
    else if (l.startsWith('a=fingerprint:')) {
      const [alg, hex] = l.slice(14).trim().split(/\s+/);
      if (alg.toLowerCase() === 'sha-256' && !r.f) r.f = hex;
    } else if (l.startsWith('a=setup:')) r.s ??= l.slice(8).trim();
    else if (l.startsWith('a=mid:')) r.m ??= l.slice(6).trim();
    else if (l.startsWith('a=candidate:')) { const c = parseCandidate(l); if (c) r.cands.push(c); }
  }
  return r;
}

/** يحوّل وصف الجلسة إلى رمز قصير (JSON مضغوط → base64url).
 *  relay (اختياري، لرمز العرض فقط): {key: base64url لمفتاح ٣٢ بايت, topic?} — يُضاف كحقل k (و r إن لم يكن الاسم مشتقًا من المفتاح). */
export async function encodeSignal(desc, { relay } = {}) {
  await loadScript('fflate.min.js', 'fflate');
  if (!desc || !desc.sdp || (desc.type !== 'offer' && desc.type !== 'answer')) throw new Error(BAD_CODE);
  const r = parseSdp(desc.sdp);
  if (!r.u || !r.p || !r.f) throw new Error(BAD_CODE);
  const fp = new Uint8Array(r.f.split(':').map((h) => parseInt(h, 16)));
  const obj = { v: PROTO, t: desc.type === 'offer' ? 'o' : 'a', u: r.u, p: r.p, f: bytesToB64(fp), s: r.s || (desc.type === 'offer' ? 'actpass' : 'active'), c: pickCandidates(r.cands).map(compactCand) };
  if (r.m && r.m !== '0') obj.m = r.m;
  if (relay && relay.key && obj.t === 'o') {
    obj.k = relay.key;
    if (relay.topic && relay.topic !== await relayTopic(relay.key)) obj.r = relay.topic;
  }
  const json = new TextEncoder().encode(JSON.stringify(obj));
  return toUrl(bytesToB64(window.fflate.deflateSync(json, { level: 9 })));
}

function candPriority(c, i) {
  const typePref = { host: 126, prflx: 110, srflx: 100, relay: 0 }[c.type] ?? 0;
  const local = (c.proto === 'tcp' ? 30000 : 65535) - i;
  return typePref * 2 ** 24 + local * 2 ** 8 + 255;
}

/** يعيد بناء SDP صالح (قناة بيانات فقط) من الرمز القصير. يرمي خطأ عربيًا إن كان الرمز تالفًا. */
export function decodeSignal(code) {
  let o;
  try {
    const clean = String(code || '').trim().replace(/\s+/g, '');
    if (!/^[A-Za-z0-9_-]{16,}$/.test(clean)) throw 0;
    const bytes = window.fflate.inflateSync(b64ToBytes(fromUrl(clean)));
    o = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(BAD_CODE);
  }
  if (!o || o.v !== PROTO || (o.t !== 'o' && o.t !== 'a') || typeof o.u !== 'string' || typeof o.p !== 'string' || typeof o.f !== 'string' || !Array.isArray(o.c)) {
    throw new Error(BAD_CODE);
  }
  const safe = (s) => /^[A-Za-z0-9+/=._-]+$/.test(s);
  if (!safe(o.u) || !safe(o.p)) throw new Error(BAD_CODE);
  let fpBytes;
  try { fpBytes = b64ToBytes(o.f); } catch { throw new Error(BAD_CODE); }
  if (fpBytes.length !== 32) throw new Error(BAD_CODE);
  const fp = [...fpBytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const setup = ['actpass', 'active', 'passive'].includes(o.s) ? o.s : (o.t === 'o' ? 'actpass' : 'active');
  const mid = typeof o.m === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(o.m) ? o.m : '0';

  const cands = [];
  o.c.slice(0, 8).forEach((t, i) => {
    if (!Array.isArray(t) || t.length < 3) return;
    const code0 = String(t[0]);
    const type = CODE_TYPE[code0[0]];
    const proto = code0[1] === 't' ? 'tcp' : 'udp';
    const ip = unpackAddr(t[1]);
    const port = Number(t[2]);
    if (!type || !/^[0-9a-fA-F.:-]+$|^[0-9a-f-]+\.local$/i.test(ip) || !(port >= 0 && port < 65536)) return;
    const c = { type, proto, ip, port };
    let line = `a=candidate:${i + 1} 1 ${proto} ${candPriority(c, i)} ${ip} ${port} typ ${type}`;
    if (t.length >= 5) {
      const raddr = unpackAddr(t[3]);
      const rport = Number(t[4]) || 0;
      line += ` raddr ${raddr} rport ${rport}`;
    } else if (type !== 'host') {
      line += ' raddr 0.0.0.0 rport 0';
    }
    if (proto === 'tcp') line += ' tcptype passive';
    line += ' generation 0';
    cands.push(line);
  });

  const sid = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const sdp = [
    'v=0',
    `o=- ${sid} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...cands,
    'a=end-of-candidates',
    `a=ice-ufrag:${o.u}`,
    `a=ice-pwd:${o.p}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
  const out = { type: o.t === 'o' ? 'offer' : 'answer', sdp };
  // معلومات الوسيط (اختيارية): مفتاح ٢٥٦ بت + اسم غرفة اختياري. الرموز القديمة بدونها تبقى صالحة.
  if (out.type === 'offer' && typeof o.k === 'string' && /^[A-Za-z0-9_-]{43}$/.test(o.k)) {
    out.relay = { key: o.k };
    if (typeof o.r === 'string' && /^gfu-[A-Za-z0-9_-]{8,64}$/.test(o.r)) out.relay.topic = o.r;
  }
  return out;
}

// ---------- QR متعدد الإطارات ----------
const FRAME_RE = /^GF(\d{1,3})\/(\d{1,3}):/;

export function splitFrames(code, max = 300) {
  code = String(code);
  if (code.length <= max) return [code];
  let n = Math.ceil(code.length / (max - 8));
  for (;;) {
    const prefixLen = `GF${n}/${n}:`.length;
    const chunk = max - prefixLen;
    const need = Math.ceil(code.length / chunk);
    if (need <= n) { n = need; break; }
    n = need;
  }
  const chunk = Math.ceil(code.length / n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`GF${i + 1}/${n}:` + code.slice(i * chunk, (i + 1) * chunk));
  return out;
}

export class FrameCollector {
  constructor() { this.reset(); }
  reset() { this.total = 0; this.parts = new Map(); }
  push(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const m = FRAME_RE.exec(s);
    if (!m) { this.reset(); this.total = 1; this.parts.set(1, s); return s; }
    const i = Number(m[1]); const n = Number(m[2]);
    if (!(n >= 1 && i >= 1 && i <= n)) return null;
    if (n !== this.total) { this.reset(); this.total = n; }
    if (!this.parts.has(i)) this.parts.set(i, s.slice(m[0].length));
    if (this.parts.size === n) {
      let full = '';
      for (let k = 1; k <= n; k++) full += this.parts.get(k);
      return full;
    }
    return null;
  }
  progress() { return { got: this.parts.size, total: this.total }; }
}

// ---------- رسم QR ----------
export function renderQR(canvas, text, { size = 320, dark = '#000000', light = '#ffffff', ec = 'M' } = {}) {
  const qr = window.qrcode(0, ec);
  qr.addData(String(text), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const total = count + quiet * 2;
  const cell = Math.max(2, Math.floor(size / total));
  const dim = cell * total;
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = dark;
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
    }
  }
}

// ---------- ماسح QR بالكاميرا ----------
/** يقرأ QR من صورة/فيديو. mode: 0 = الصورة كاملة، 1 = وسطها ٦٠٪، 2 = وسطها ٤٠٪ (تكبير لرمز صغير بعيد). */
export function scanImage(src, vw, vh, mode = 0, canvas = document.createElement('canvas')) {
  const frac = mode === 0 ? 1 : mode === 1 ? 0.6 : 0.4;
  const sw = Math.round(vw * frac); const sh = Math.round(vh * frac);
  const sx = Math.round((vw - sw) / 2); const sy = Math.round((vh - sh) / 2);
  const scale = Math.min(1, 960 / Math.max(sw, sh));
  const w = Math.round(sw * scale); const h = Math.round(sh * scale);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const r = window.jsQR(img.data, w, h, { inversionAttempts: mode === 0 ? 'attemptBoth' : 'dontInvert' });
  return r && r.data ? r.data : null;
}

function scanError(code, msg) { const e = new Error(msg); e.code = code; return e; }

export class QrScanner {
  constructor(video, onText) {
    this.video = video;
    this.onText = onText;
    this.stream = null;
    this.timer = 0;
    this.running = false;
    this.detector = null;
    this.canvas = null;
    this.last = '';
    this.lastAt = 0;
  }

  async start(facing = 'environment') {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw scanError('insecure', 'الكاميرا تتطلب فتح الصفحة عبر رابط آمن (https).');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw scanError(window.isSecureContext === false ? 'insecure' : 'notfound', 'لا توجد كاميرا متاحة في هذا المتصفح.');
    }
    this.stop();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') {
        throw scanError('denied', 'لم يُسمح باستخدام الكاميرا. اسمح بالوصول من إعدادات المتصفح ثم أعد المحاولة.');
      }
      throw scanError('notfound', 'لم يتم العثور على كاميرا أو أنها مستخدمة في برنامج آخر.');
    }
    const v = this.video;
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.srcObject = this.stream;
    try { await v.play(); } catch { /* سيبدأ عند توفر الإطارات */ }

    if (typeof window.BarcodeDetector === 'function') {
      try {
        const formats = (await window.BarcodeDetector.getSupportedFormats?.()) || ['qr_code'];
        if (formats.includes('qr_code')) this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { this.detector = null; }
    }
    if (!this.detector) await loadScript('jsQR.js', 'jsQR');
    this.running = true;
    this.loop();
  }

  loop() {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try { await this.tick(); } catch { /* إطار غير صالح */ }
      this.loop();
    }, 90); // ≈ ١٠ محاولات في الثانية
  }

  async tick() {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    let text = null;
    if (this.detector) {
      const codes = await this.detector.detect(v);
      if (codes && codes.length) text = codes[0].rawValue;
    } else if (window.jsQR) {
      // نتناوب بين: الصورة كاملة بدقة جيدة، ووسط الصورة مكبّرًا (رمز جوال بعيد عن كاميرا الكمبيوتر يكون صغيرًا)
      this.mode = ((this.mode || 0) + 1) % 3;
      if (!this.canvas) this.canvas = document.createElement('canvas');
      text = scanImage(v, v.videoWidth, v.videoHeight, this.mode, this.canvas);
    }
    if (text && this.running) {
      const now = Date.now();
      if (text !== this.last || now - this.lastAt > 1000) {
        this.last = text; this.lastAt = now;
        this.onText(text);
      }
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    this.stream = null;
    if (this.video) { try { this.video.pause(); } catch { /* */ } this.video.srcObject = null; }
  }
}

// ---------- وسيط المصافحة: تشفير وإرسال واستقبال ----------
const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle) || null;
export const relaySupported = () => !!(subtle() && typeof fetch === 'function' && typeof AbortController === 'function');
const enc = (s) => new TextEncoder().encode(s);
const sleep = (ms, signal) => new Promise((res) => {
  if (signal && signal.aborted) { res(); return; }
  const done = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); res(); };
  const t = setTimeout(done, ms);
  if (signal) signal.addEventListener('abort', done);
});

/** اسم الغرفة مشتق من المفتاح (SHA-256) حتى لا يكبر QR: 'gfu-' + ٢٤ حرفًا ست عشريًا. لا يكشف المفتاح. */
export async function relayTopic(keyB64) {
  const h = new Uint8Array(await subtle().digest('SHA-256', enc('gfu-topic:' + keyB64)));
  return 'gfu-' + [...h.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** ينشئ غرفة جديدة: مفتاح AES-GCM عشوائي ٢٥٦ بت (base64url) + اسم الغرفة. */
export async function newRelayRoom() {
  const key = toUrl(bytesToB64(crypto.getRandomValues(new Uint8Array(32))));
  return { key, topic: await relayTopic(key) };
}
function importKey(keyB64) {
  const raw = b64ToBytes(fromUrl(String(keyB64 || '')));
  if (raw.length !== 32) throw new Error(BAD_CODE);
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
/** تشفير AES-GCM (IV عشوائي ١٢ بايت، واسم الغرفة كبيانات مصادَقة) → 'g1.' + base64url(iv ‖ ciphertext). */
export async function relayEncrypt(room, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await importKey(room.key);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc(room.topic) }, k, enc(String(text))));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv);
  all.set(ct, 12);
  return RELAY_MSG + toUrl(bytesToB64(all));
}
/** فك التشفير؛ يرمي خطأ إن كانت الرسالة تالفة أو بمفتاح/غرفة أخرى. */
export async function relayDecrypt(room, msg) {
  const s = String(msg || '');
  if (!s.startsWith(RELAY_MSG) || s.length > 4000) throw new Error('bad relay message');
  const all = b64ToBytes(fromUrl(s.slice(RELAY_MSG.length)));
  if (all.length < 12 + 16) throw new Error('bad relay message');
  const k = await importKey(room.key);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: enc(room.topic) }, k, all.subarray(12));
  return new TextDecoder().decode(pt);
}
const relayUrl = (topic) => `${RELAY}/${encodeURIComponent(topic)}`;

/** يرسل نصًا مشفّرًا إلى الغرفة. طلب «بسيط» (نص، بلا ترويسات خاصة) فلا يحتاج CORS preflight. */
async function relayPost(room, text, { tries = RELAY_POSTS, signal } = {}) {
  const body = await relayEncrypt(room, text);
  for (let i = 0; i < tries; i++) {
    if (signal && signal.aborted) return false;
    try {
      const res = await fetch(relayUrl(room.topic), { method: 'POST', body, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
      if (res.ok) return true;
    } catch { /* شبكة */ }
    if (i + 1 < tries) await sleep(800 * (i + 1), signal);
  }
  return false;
}

/** فترة الاستطلاع: سريعة أولًا ثم أبطأ (حد الطلبات المجاني في ntfy.sh ≈ ٦٠ دفعة ثم طلب كل ٥ ث). */
function pollDelay(elapsed) {
  if (elapsed < 20_000) return 900;
  if (elapsed < 45_000) return 1500;
  if (elapsed < 165_000) return 3000;
  return 5000;
}

// ---------- مساعدات WebRTC ----------
function waitGathering(pc, ms = GATHER_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settle = 0;
    const done = () => { clearTimeout(t); clearTimeout(settle); pc.removeEventListener('icegatheringstatechange', on); pc.removeEventListener('icecandidate', cand); resolve(); };
    const on = () => { if (pc.iceGatheringState === 'complete') done(); };
    // أول مسار: ننتظر قليلًا لمسارات أخرى ثم ننطلق بدل انتظار STUN البطيء
    const cand = (e) => { if (e.candidate && !settle) settle = setTimeout(done, GATHER_SETTLE_MS); };
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', on);
    pc.addEventListener('icecandidate', cand);
  });
}

class BaseLink {
  constructor({ iceServers, onState } = {}) {
    this.iceServers = Array.isArray(iceServers) ? iceServers : iceServersFrom({});
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.pc = null;
    this.dc = null;
    this.state = 'idle';
    this.hb = 0;
    this.lastSeen = 0;
    this.stopped = false;
  }

  setState(s) {
    if (this.state === s) return;
    if (this.state === 'closed') return;
    this.state = s;
    try { this.onState(s); } catch { /* */ }
  }

  newPc() {
    if (typeof RTCPeerConnection !== 'function') throw new Error('هذا المتصفح لا يدعم الاتصال المباشر (WebRTC).');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      if (s === 'failed') this.setState('disconnected');
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') this.setState('disconnected');
    });
    this.pc = pc;
    return pc;
  }

  bindChannel(dc) {
    this.dc = dc;
    dc.addEventListener('open', () => {
      this.lastSeen = Date.now();
      this.setState('connected');
      this.startHeartbeat();
    });
    dc.addEventListener('close', () => { this.stopHeartbeat(); if (!this.stopped) this.setState('disconnected'); });
    dc.addEventListener('message', (e) => this.receive(e.data));
  }

  rawSend(obj) {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    try { this.dc.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.hb = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) { this.setState('disconnected'); return; }
      this.rawSend({ v: PROTO, type: 'ping', t: Date.now() });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() { clearInterval(this.hb); this.hb = 0; }

  /** يعالج ping/pong؛ يُرجع الرسالة المحللة أو null. */
  handleControl(raw) {
    let msg;
    try { msg = typeof raw === 'string' && raw.length < 2_000_000 ? JSON.parse(raw) : null; } catch { msg = null; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { msg: null, control: false };
    if (msg.type === 'ping') {
      this.lastSeen = Date.now();
      if (this.state !== 'connected' && this.state !== 'closed') this.setState('connected');
      this.rawSend({ v: PROTO, type: 'pong', t: Number(msg.t) || 0 });
      return { msg, control: true };
    }
    if (msg.type === 'pong') {
      this.lastSeen = Date.now();
      if (this.state !== 'connected' && this.state !== 'closed') this.setState('connected');
      return { msg, control: true };
    }
    if (msg.type === 'want' && typeof this.onWant === 'function') {
      // الكمبيوتر لم تصله البيانات: يطلب الإعادة فقط — لا يستطيع تعديل أي شيء
      this.lastSeen = Date.now();
      try { this.onWant(); } catch { /* */ }
      return { msg, control: true };
    }
    return { msg, control: false };
  }

  closeQuiet() {
    this.stopped = true;
    this.stopHeartbeat();
    try { this.dc && this.dc.close(); } catch { /* */ }
    try { this.pc && this.pc.close(); } catch { /* */ }
    this.dc = null; this.pc = null;
  }

  close() {
    this.stopped = true;
    this.stopHeartbeat();
    try { this.dc && this.dc.close(); } catch { /* */ }
    try { this.pc && this.pc.close(); } catch { /* */ }
    this.dc = null;
    this.pc = null;
    this.setState('closed');
  }
}

/** جهة الجوال: المجيب ومصدر البيانات الوحيد. يتجاهل كل ما يصله عدا ping/pong. */
export class PhoneLink extends BaseLink {
  constructor(opts = {}) {
    super(opts);
    this.droppedCount = 0;
    this.onWant = typeof opts.onWant === 'function' ? opts.onWant : null;
    this.onRelay = typeof opts.onRelay === 'function' ? opts.onRelay : () => {};
    this.relayState = 'none'; // none | sending | sent | failed
    this.relaySent = Promise.resolve(false);
    this.relayAbort = null;
  }

  setRelay(s) {
    this.relayState = s;
    try { this.onRelay(s); } catch { /* */ }
  }

  /** يقبل رمز العرض ويعيد رمز الرد (للنسخ اليدوي احتياطًا). إن احتوى الرمز على غرفة وسيط يُرسل الرد إليها
   *  مشفّرًا في الخلفية: تابع relayState / relaySent (Promise<boolean>) / onRelay('sending'|'sent'|'failed'). */
  async acceptOffer(code) {
    const desc = decodeSignal(code);
    if (desc.type !== 'offer') throw new Error('هذا ليس رمز شاشة العرض. امسح الرمز الظاهر على شاشة الكمبيوتر.');
    this.closeQuiet();
    this.stopped = false;
    this.state = 'idle';
    const pc = this.newPc();
    pc.addEventListener('datachannel', (e) => {
      if (this.dc) { try { e.channel.close(); } catch { /* */ } return; }
      this.bindChannel(e.channel);
    });
    this.setState('connecting');
    await pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
    const local = await pc.createAnswer();
    await pc.setLocalDescription(local);
    await waitGathering(pc);
    const answer = await encodeSignal(pc.localDescription);
    if (this.relayAbort) this.relayAbort.abort();
    this.relayAbort = null;
    this.relayState = 'none';
    this.relaySent = Promise.resolve(false);
    if (desc.relay && relaySupported()) {
      const ac = new AbortController();
      this.relayAbort = ac;
      this.setRelay('sending');
      this.relaySent = (async () => {
        let ok = false;
        try {
          const room = { key: desc.relay.key, topic: desc.relay.topic || await relayTopic(desc.relay.key) };
          ok = await relayPost(room, answer, { signal: ac.signal }); // رمز الرد مشفّرًا فقط — لا درجات ولا أسماء
        } catch { ok = false; }
        if (this.relayAbort === ac) { this.relayAbort = null; this.setRelay(ok ? 'sent' : 'failed'); }
        return ok;
      })();
    }
    return answer;
  }

  receive(raw) {
    const { control } = this.handleControl(raw);
    if (!control) this.droppedCount++; // قراءة فقط: لا نقبل أي بيانات من الكمبيوتر
  }

  send(msg) {
    if (!msg || typeof msg !== 'object') return false;
    const text = JSON.stringify({ ...msg, v: PROTO });
    if (text.length <= CHUNK) return this.rawSend({ ...msg, v: PROTO });
    // رسالة كبيرة (لقطة شعبة كاملة): نقسمها لأجزاء صغيرة يجمعها الكمبيوتر
    const id = Math.random().toString(36).slice(2, 10);
    const n = Math.ceil(text.length / CHUNK);
    let ok = true;
    for (let i = 0; i < n; i++) ok = this.rawSend({ v: PROTO, type: 'part', id, i, n, d: text.slice(i * CHUNK, (i + 1) * CHUNK) }) && ok;
    return ok;
  }

  stop() {
    if (this.relayAbort) { this.relayAbort.abort(); this.relayAbort = null; }
    const sent = this.rawSend({ v: PROTO, type: 'bye' });
    const { dc, pc } = this;
    this.stopped = true;
    this.stopHeartbeat();
    this.dc = null; this.pc = null;
    this.setState('closed');
    // نترك لحظة قصيرة لوصول رسالة الوداع قبل الإغلاق
    const shut = () => { try { dc && dc.close(); } catch { /* */ } try { pc && pc.close(); } catch { /* */ } };
    if (sent) setTimeout(shut, 150); else shut();
  }
}

const VIEW_TYPES = new Set(['hello', 'snapshot', 'patch', 'blank', 'bye']);

/** جهة الكمبيوتر: صاحب العرض، للقراءة فقط (لا يرسل إلا ping/pong). */
export class ViewerLink extends BaseLink {
  constructor(opts = {}) {
    super(opts);
    this.onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : () => {};
    this.onRelay = typeof opts.onRelay === 'function' ? opts.onRelay : () => {};
    this.relayTimeoutMs = Number(opts.relayTimeoutMs) || RELAY_TIMEOUT_MS;
    this.room = null; // {topic, key} — غرفة الوسيط لرمز العرض الحالي
    this.relayState = 'off'; // off | waiting | unreachable | received | expired | stopped
    this.relayAbort = null;
    this.relayWait = null;
  }

  setRelay(s) {
    if (this.relayState === s) return;
    this.relayState = s;
    try { this.onRelay(s); } catch { /* */ }
  }

  stopRelay(state = 'stopped') {
    if (this.relayAbort) { this.relayAbort.abort(); this.relayAbort = null; }
    this.relayWait = null;
    if (this.relayState === 'waiting' || this.relayState === 'unreachable') this.setRelay(state);
  }

  /** ينشئ رمز العرض. افتراضيًا يضع داخله غرفة وسيط (مفتاح عشوائي) ويبدأ انتظار الرد عبر الوسيط تلقائيًا.
   *  {relay:false} = رمز بلا وسيط (لصق يدوي فقط)، {autoRelay:false} = لا يبدأ الانتظار تلقائيًا (استدعِ waitForRelayAnswer). */
  async createOffer({ relay = true, autoRelay = true } = {}) {
    this.stopRelay();
    this.closeQuiet();
    this.stopped = false;
    this.state = 'idle';
    this.room = null;
    this.relayState = 'off';
    const pc = this.newPc();
    this.bindChannel(pc.createDataChannel('grades', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let room = null;
    if (relay && relaySupported()) {
      try { room = await newRelayRoom(); } catch { room = null; }
    }
    await waitGathering(pc);
    const code = await encodeSignal(pc.localDescription, { relay: room });
    if (this.pc !== pc) return code; // أُلغي أثناء التجهيز
    this.room = room;
    if (room && autoRelay) this.waitForRelayAnswer();
    return code;
  }

  /** يستطلع غرفة الوسيط حتى يصل رد صالح فيقبله تلقائيًا (acceptAnswer). يتجاهل كل رسالة لا تُفك بالمفتاح.
   *  يتوقف عند قبول رد، أو stop()/رمز جديد، أو signal، أو انتهاء المهلة (١٠ دقائق)، أو إغلاق الصفحة (pagehide).
   *  يعيد Promise<boolean> (true = قُبل رد من الوسيط). الحالة عبر onRelay/relayState. */
  waitForRelayAnswer({ signal, timeoutMs = this.relayTimeoutMs } = {}) {
    if (!this.room) return Promise.resolve(false);
    if (this.relayWait) return this.relayWait;
    const room = this.room;
    const ac = new AbortController();
    this.relayAbort = ac;
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }); }
    const onHide = () => ac.abort();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
    this.setRelay('waiting');
    const live = () => !ac.signal.aborted && this.room === room && !this.stopped;
    const run = async () => {
      const t0 = Date.now();
      const seen = new Set();
      let since = 'all'; // الغرفة جديدة وعشوائية؛ «all» يتفادى فرق الساعة بين الكمبيوتر والخادم
      let fails = 0;
      while (live()) {
        const elapsed = Date.now() - t0;
        if (elapsed > timeoutMs) { this.setRelay('expired'); return false; }
        if (this.state === 'connected' || (this.pc && this.pc.signalingState !== 'have-local-offer')) return false;
        let wait = pollDelay(elapsed);
        try {
          const res = await fetch(relayUrl(room.topic) + `/json?poll=1&since=${encodeURIComponent(since)}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ac.signal });
          if (res.status === 429) { wait = 15_000; } // تجاوز حد الطلبات: تمهّل
          else if (!res.ok) throw new Error('relay ' + res.status);
          else {
            fails = 0;
            if (this.relayState === 'unreachable') this.setRelay('waiting');
            const text = await res.text();
            for (const line of text.split('\n')) {
              if (!line.trim() || line.length > 8000) continue;
              let ev;
              try { ev = JSON.parse(line); } catch { continue; }
              if (!ev || ev.event !== 'message' || typeof ev.message !== 'string') continue;
              if (typeof ev.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ev.id)) {
                if (seen.has(ev.id)) continue;
                seen.add(ev.id);
                since = ev.id;
              }
              let answer;
              try { answer = await relayDecrypt(room, ev.message); } catch { continue; } // ليست لنا أو تالفة
              if (!live()) return false;
              try {
                if (decodeSignal(answer).type !== 'answer') continue;
              } catch { continue; }
              if (!this.pc || this.pc.signalingState !== 'have-local-offer') return false; // قُبل رد آخر (لصق يدوي)
              this.setRelay('received');
              try {
                await this.acceptAnswer(answer);
                return true;
              } catch {
                if (!this.pc || this.pc.signalingState !== 'have-local-offer') return false;
                this.setRelay('waiting');
              }
            }
          }
        } catch {
          if (ac.signal.aborted) break;
          fails++;
          if (fails >= RELAY_FAILS) { this.setRelay('unreachable'); wait = Math.max(wait, 4000); }
        }
        await sleep(wait, ac.signal);
      }
      return false;
    };
    const p = run().catch(() => false).finally(() => {
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
      if (this.relayAbort === ac) this.relayAbort = null;
      if (this.relayWait === p) this.relayWait = null;
      if (this.relayState === 'waiting' || this.relayState === 'unreachable') this.setRelay('stopped');
    });
    this.relayWait = p;
    return p;
  }

  async acceptAnswer(code) {
    const desc = decodeSignal(code);
    if (desc.type !== 'answer') throw new Error('هذا رمز العرض نفسه وليس رمز الرد. انسخ الرد الظاهر في الجوال.');
    if (!this.pc) throw new Error('انتهت صلاحية رمز العرض. أنشئ رمزًا جديدًا.');
    if (this.pc.signalingState !== 'have-local-offer') throw new Error('تم استخدام هذا الرمز من قبل. أنشئ رمزًا جديدًا.');
    this.setState('connecting');
    await this.pc.setRemoteDescription(desc);
    if (this.relayState !== 'received') this.stopRelay(); // لُصق الرد يدويًا: لا داعي لمتابعة الاستطلاع
  }

  receive(raw) {
    const { msg, control } = this.handleControl(raw);
    if (control || !msg) return;
    this.lastSeen = Date.now();
    if (msg.type === 'part') {
      const id = String(msg.id || ''); const n = Number(msg.n); const i = Number(msg.i);
      if (!id || !(n > 0 && n < 500) || !(i >= 0 && i < n) || typeof msg.d !== 'string') return;
      this.parts ||= new Map();
      const p = this.parts.get(id) || { n, got: new Map() };
      p.got.set(i, msg.d);
      this.parts.set(id, p);
      if (p.got.size < p.n) return;
      this.parts.delete(id);
      let text = '';
      for (let k = 0; k < p.n; k++) text += p.got.get(k);
      let full;
      try { full = JSON.parse(text); } catch { return; }
      if (full && VIEW_TYPES.has(full.type)) this.deliver(full);
      return;
    }
    if (!VIEW_TYPES.has(msg.type)) return;
    this.deliver(msg);
  }

  deliver(msg) {
    try { this.onMessage(msg); } catch (e) { if (typeof this.onError === 'function') this.onError(e); }
  }

  // اطلب من الجوال إعادة إرسال البيانات (لا يحمل أي بيانات)
  requestData() { return this.rawSend({ v: PROTO, type: 'want' }); }

  stop() { this.stopRelay(); this.room = null; this.close(); }
}

export function iceServersFrom(settings = {}) {
  const list = [];
  const stun = (CONFIG.stunServers || []).filter(Boolean);
  if (stun.length) list.push({ urls: stun });
  const url = String(settings?.turnUrl || '').trim();
  if (url) {
    const urls = url.split(/[\s,]+/).filter(Boolean).map((u) => (/^turns?:/i.test(u) ? u : 'turn:' + u));
    const s = { urls };
    if (settings.turnUser) s.username = String(settings.turnUser);
    if (settings.turnPass) s.credential = String(settings.turnPass);
    list.push(s);
  }
  return list;
}

// ---------- منع إطفاء الشاشة ----------
let lockSentinel = null;
let lockWanted = false;
async function acquireLock() {
  if (!lockWanted || lockSentinel || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    lockSentinel = await navigator.wakeLock.request('screen');
    lockSentinel.addEventListener('release', () => { lockSentinel = null; });
  } catch { lockSentinel = null; }
}
function onVisibility() { if (document.visibilityState === 'visible') acquireLock(); }

export async function wakeLock(on) {
  lockWanted = !!on;
  if (typeof document === 'undefined') return;
  if (lockWanted) {
    document.addEventListener('visibilitychange', onVisibility);
    await acquireLock();
  } else {
    document.removeEventListener('visibilitychange', onVisibility);
    const s = lockSentinel; lockSentinel = null;
    if (s) { try { await s.release(); } catch { /* */ } }
  }
}
