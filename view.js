// شاشة العرض على الكمبيوتر/جهاز العرض: قراءة فقط، في الذاكرة فقط، لا تخزين لأي بيانات.
import CONFIG from './config.js';
import { ViewerLink, FrameCollector, renderQR, splitFrames, iceServersFrom, wakeLock } from './live.js';
import {
  WEEKS, FIN_MAX, toArabicDigits, fmt, weekTotal, periodScore, formative, finalTotal,
  studentSummary, getItems, getFin, getWeekMeta, progress, weekRemaining, arCompare, round2,
} from './grades-core.js';

const params = new URLSearchParams(location.search);
const E2E = params.has('e2e');

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ar = (n) => toArabicDigits(n);
// التاريخ: ISO (YYYY-MM-DD) يُعرض بصيغة عربية مقروءة، وغير ذلك كما هو بأرقام عربية
const dateFmts = {};
function fmtDate(s, short = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return ar(String(s || ''));
  const key = short ? 's' : 'l';
  try {
    dateFmts[key] ||= new Intl.DateTimeFormat('ar-KW-u-nu-arab', short ? { day: 'numeric', month: 'short' } : { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return dateFmts[key].format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  } catch { return ar(s); }
}

const WEEK_MAX = CONFIG.criteria.length * CONFIG.itemMax; // 20
const FORM_MAX = WEEK_MAX * 2; // 40
const TOTAL_MAX = FORM_MAX + FIN_MAX.reduce((a, b) => a + b, 0); // 100
const FRAME_MAX = 480; // أقصى طول لإطار QR الواحد على الشاشة الكبيرة

// ---------- أيقونات (SVG مضمّن) ----------
const svg = (p, extra = '') => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${p}</svg>`;
const I = {
  paste: svg('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 13h6M9 17h4"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
  refresh: svg('<path d="M20 11a8 8 0 0 0-14.9-3.9L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.9L20 15"/><path d="M20 20v-5h-5"/>'),
  full: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exitFull: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  unlink: svg('<path d="M9 15l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0"/><path d="M15 9l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0"/><path d="M4 4l16 16"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  award: svg('<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>'),
  pie: svg('<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
  avg: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  check: svg('<path d="M20 6L9 17l-5-5"/>'),
  sortUp: svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 'width="14" height="14"'),
  sortDown: svg('<path d="M12 5v14M5 12l7 7 7-7"/>', 'width="14" height="14"'),
};

// ---------- الحالة (في الذاكرة فقط) ----------
const ui = {
  screen: 'pair', // pair | live | solo
  connState: 'idle',
  view: 'summary', // summary | week | fin
  week: 1,
  sort: { key: 'num', dir: 1 },
  zoom: 1,
  theme: null, // null = حسب النظام
  drawerIdx: null,
  blank: false,
  ended: false,
};
let model = null; // {hello, names, data, scope, hideNames}
let hello = null;
let link = null;
let offerCode = '';
let frames = [];
let frameIdx = 0;
let frameTimer = 0;
let offerSeq = 0;

// ---------- أدوات ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, CONFIG.toastMs || 2600);
}
const btnHtml = (icon, label) => `${icon}<span>${esc(label)}</span>`;

function criteriaLabels() {
  const c = hello && Array.isArray(hello.criteria) && hello.criteria.length === CONFIG.criteria.length ? hello.criteria : CONFIG.criteria.map((x) => x.label);
  return c.map((s) => String(s || ''));
}
function finalsMeta() {
  const f = hello && Array.isArray(hello.finals) && hello.finals.length === FIN_MAX.length ? hello.finals : CONFIG.finals;
  return f.map((x, i) => ({ label: String(x?.label || CONFIG.finals[i].label), max: Number(x?.max) || FIN_MAX[i] }));
}

// ---------- المظهر وملء الشاشة والتكبير ----------
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
function effectiveTheme() { return ui.theme || (mqDark.matches ? 'dark' : 'light'); }
function applyTheme() {
  if (ui.theme) document.documentElement.dataset.theme = ui.theme;
  else delete document.documentElement.dataset.theme;
  const dark = effectiveTheme() === 'dark';
  $('btn-theme').innerHTML = btnHtml(dark ? I.sun : I.moon, dark ? 'فاتح' : 'داكن');
  $('btn-theme').setAttribute('aria-label', dark ? 'التبديل إلى المظهر الفاتح' : 'التبديل إلى المظهر الداكن');
  if (offerCode) drawFrame();
}
mqDark.addEventListener?.('change', applyTheme);

function isFull() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function updateFullBtn() {
  const f = isFull();
  $('btn-full').innerHTML = btnHtml(f ? I.exitFull : I.full, f ? 'خروج من ملء الشاشة' : 'ملء الشاشة');
  $('btn-full').setAttribute('aria-label', f ? 'خروج من ملء الشاشة' : 'ملء الشاشة');
}
async function toggleFull() {
  try {
    if (isFull()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else {
      const el = document.documentElement;
      await (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    }
  } catch { toast('تعذر تفعيل ملء الشاشة في هذا المتصفح.'); }
}
document.addEventListener('fullscreenchange', updateFullBtn);
document.addEventListener('webkitfullscreenchange', updateFullBtn);

function setZoom(z) {
  ui.zoom = Math.min(2.2, Math.max(0.8, round2(z)));
  document.documentElement.style.setProperty('--zoom', String(ui.zoom));
  $('zoom-val').textContent = ar(Math.round(ui.zoom * 100)) + '٪';
}

// ---------- الاقتران ----------
function setPairStatus(text, kind = '') {
  $('pair-status-text').textContent = text;
  $('pair-status').dataset.kind = kind;
}
const RELAY_TEXT = {
  waiting: ['بانتظار الجوال…', 'wait'],
  received: ['تم استلام الرد، جارٍ الاتصال…', 'busy'],
  unreachable: ['تعذّر الوصول للوسيط — استعمل اللصق اليدوي', 'error'],
  expired: ['انتهت صلاحية الرمز. اضغط «رمز جديد».', 'error'],
};
function onRelay(s) {
  if (ui.screen !== 'pair' || !offerCode) return;
  const t = RELAY_TEXT[s];
  if (!t) return;
  setPairStatus(t[0], t[1]);
  if (s === 'unreachable') { // أظهر خيار اللصق اليدوي
    $('help').open = true;
    try { document.querySelector('.manual').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* */ }
  }
}

function drawFrame() {
  if (!frames.length) return;
  const dark = effectiveTheme() === 'dark';
  // رمز داكن على خلفية فاتحة دائمًا (أسهل للكاميرات)، مع لون أهدأ قليلًا في الوضع الداكن
  renderQR($('qr-canvas'), frames[frameIdx], { size: 420, dark: dark ? '#0b0f17' : '#111827', light: '#ffffff' });
  const f = $('qr-frame');
  if (frames.length > 1) {
    f.hidden = false;
    f.textContent = `الجزء ${ar(frameIdx + 1)} من ${ar(frames.length)}`;
  } else f.hidden = true;
}

function showOffer(code) {
  offerCode = code;
  frames = splitFrames(code, FRAME_MAX);
  frameIdx = 0;
  clearInterval(frameTimer);
  drawFrame();
  $('qr-loading').hidden = true;
  $('qr-box').classList.remove('loading');
  if (frames.length > 1) {
    frameTimer = setInterval(() => { frameIdx = (frameIdx + 1) % frames.length; drawFrame(); }, 900);
  }
  if (link && link.room) onRelay(link.relayState === 'off' ? 'waiting' : link.relayState);
  else {
    // متصفح لا يدعم التشفير/الوسيط: اللصق اليدوي فقط
    setPairStatus('امسح الرمز بالجوال، ثم الصق رمز الرد يدويًا', 'wait');
    $('help').open = true;
  }
}

function makeLink() {
  const iceServers = E2E ? [] : iceServersFrom({});
  const l = new ViewerLink({
    iceServers,
    onState: (s) => { if (l === link) onConnState(s); },
    onMessage: (m) => { if (l === link) onMessage(m); },
    onRelay: (s) => { if (l === link) onRelay(s); },
  });
  l.onError = () => { if (l === link) { ui.waitError = 'render'; renderEmptyWaiting(); } };
  return l;
}

// بعد الاتصال: إن لم تصل البيانات نطلبها من الجوال كل ثانيتين، وبعد ١٢ ثانية نعرض رسالة واضحة
let dataTimer = 0;
function startDataWatch() {
  clearInterval(dataTimer);
  const started = Date.now();
  ui.waitError = null;
  dataTimer = setInterval(() => {
    if (!link || model || mirror || ui.connState !== 'connected') { clearInterval(dataTimer); return; }
    link.requestData();
    if (Date.now() - started > 12000 && !ui.waitError) { ui.waitError = 'timeout'; renderEmptyWaiting(); }
  }, 2000);
}

async function newOffer() {
  const seq = ++offerSeq;
  clearInterval(frameTimer);
  offerCode = ''; frames = [];
  $('qr-loading').hidden = false;
  $('qr-box').classList.add('loading');
  setPairStatus('جارٍ تجهيز رمز جديد…');
  if (link) link.stop();
  link = makeLink();
  if (E2E) window.__e2e.link = link;
  try {
    const code = await link.createOffer();
    if (seq !== offerSeq) return;
    showOffer(code);
  } catch (e) {
    if (seq !== offerSeq) return;
    $('qr-loading').hidden = true;
    setPairStatus(e && e.message ? e.message : 'تعذر تجهيز رمز الاتصال.', 'error');
  }
}

async function acceptAnswer(code) {
  if (!link) throw new Error('أنشئ رمزًا جديدًا أولًا.');
  await link.acceptAnswer(code);
  setPairStatus('جارٍ الاتصال بالجوال…', 'busy');
}

// ---------- حالة الاتصال ----------
const CONN_TEXT = { connecting: 'جارٍ الاتصال', connected: 'متصل', disconnected: 'انقطع', closed: 'انقطع', idle: '' };
function renderPill() {
  const p = $('conn-pill');
  const s = ui.connState === 'closed' ? 'disconnected' : ui.connState;
  p.dataset.state = s;
  $('conn-text').textContent = CONN_TEXT[ui.connState] || '';
  p.hidden = ui.screen === 'pair' && ui.connState !== 'connecting';
}

function onConnState(s) {
  ui.connState = s;
  if (s === 'connected') {
    wakeLock(true);
    hideBanner();
    setSoftPause(false);
    if (!model) startDataWatch();
    if (ui.screen === 'pair') {
      closeModals();
      clearInterval(frameTimer);
      setScreen(model ? (isSolo() ? 'solo' : 'live') : 'live');
      render();
    }
  } else if (s === 'disconnected' && !ui.ended && (model || mirror) && link && link.room) {
    // الجوال خرج من التطبيق (واتساب مثلًا): نُبقي آخر عرض ونعيد الاتصال تلقائيًا بنفس المفتاح
    autoResume();
  } else if (s === 'disconnected' || s === 'closed') {
    if (ui.screen !== 'pair' || model) {
      showBanner(ui.ended);
    } else if (s === 'disconnected') {
      setPairStatus('تعذر الاتصال. راجع «مشاكل الاتصال؟» ثم أنشئ رمزًا جديدًا.', 'error');
    }
    wakeLock(false);
  }
  renderPill();
}

function showBanner(ended) {
  $('banner-title').textContent = ended ? 'أنهى المعلم المشاركة' : 'انقطع الاتصال بالجوال';
  $('banner-sub').textContent = ended
    ? 'تم مسح البيانات من هذه الشاشة. اضغط «إعادة الاتصال» لعرض صف آخر.'
    : 'تأكد أن الجوال قريب وأن العرض ما زال مفتوحًا فيه، ثم أعد الاتصال.';
  $('conn-banner').hidden = false;
  document.body.classList.add('has-banner');
}
function hideBanner() {
  $('conn-banner').hidden = true;
  document.body.classList.remove('has-banner');
}

// وضع الإدارة: نسخة في الذاكرة فقط من بيانات الجوال (تُمسح عند الإغلاق أو قطع الاتصال)
let mirror = null;      // {classes, grades, settings}
let manageFrame = null; // إطار التطبيق الكامل (index.html?remote)
let presenting = false;

function wipe() {
  model = null; hello = null;
  mirror = null; presenting = false;
  if ($('soft-pause')) setSoftPause(false);
  if (manageFrame) { manageFrame.remove(); manageFrame = null; }
  $('screen-manage').innerHTML = '';
  $('btn-manage-back').hidden = true;
  ui.mode = 'display';
  ui.drawerIdx = null; ui.blank = false;
  closeDrawer();
  $('blank').hidden = true;
  $('grid-wrap').innerHTML = '';
  $('stats').innerHTML = '';
  $('views').innerHTML = '';
  $('toolbar').innerHTML = '';
  $('screen-solo').innerHTML = '';
  $('class-info').hidden = true;
  $('class-label').textContent = '';
  $('class-meta').textContent = '';
  prevCells = null;
}

function backToPairing() {
  wipe();
  ui.ended = false;
  hideBanner();
  ui.connState = 'idle';
  setScreen('pair');
  renderPill();
  newOffer();
}

function setScreen(s) {
  ui.screen = s;
  $('app').dataset.screen = s;
  $('screen-pair').hidden = s !== 'pair';
  $('screen-live').hidden = s !== 'live';
  $('screen-solo').hidden = s !== 'solo';
  $('screen-manage').hidden = s !== 'manage';
  $('btn-manage-back').hidden = !(presenting && s !== 'manage' && s !== 'pair');
  $('app').classList.toggle('managing', s === 'manage');
  const connected = s !== 'pair';
  $('zoom-group').hidden = !connected || ui.ended;
  $('btn-disconnect').hidden = !connected || ui.ended;
  $('screen-live').classList.toggle('ended', ui.ended);
  $('class-info').hidden = !connected || !hello;
  renderPill();
}

// ---------- الرسائل ----------
const isIdx = (i, n) => Number.isInteger(i) && i >= 0 && i < n;
const isWeek = (w) => Number.isInteger(Number(w)) && Number(w) >= 1 && Number(w) <= WEEKS;
const cleanNum = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);
const isSolo = () => model && model.scope && model.scope.kind === 'student';

function sanitizeData(d) {
  const out = { weeks: {}, fin: {}, t: Number(d?.t) || 0 };
  for (const [wk, w] of Object.entries(d?.weeks || {})) {
    if (!isWeek(wk) || !w || typeof w !== 'object') continue;
    const s = {};
    for (const [i, arr] of Object.entries(w.s || {})) {
      if (!/^\d+$/.test(i) || !Array.isArray(arr)) continue;
      s[i] = CONFIG.criteria.map((_, k) => cleanNum(arr[k], CONFIG.itemMax));
    }
    const abs = {};
    for (const [i, on] of Object.entries(w.abs || {})) if (/^\d+$/.test(i) && on === true) abs[i] = true;
    const star = {};
    for (const [i, on] of Object.entries(w.star || {})) if (/^\d+$/.test(i) && on === true) star[i] = true;
    const issue = {};
    for (const [i, on] of Object.entries(w.issue || {})) if (/^\d+$/.test(i) && on === true) issue[i] = true;
    out.weeks[String(Number(wk))] = { date: String(w.date || '').slice(0, 40), lesson: String(w.lesson || '').slice(0, 200), s, abs, star, issue };
  }
  for (const [i, arr] of Object.entries(d?.fin || {})) {
    if (!/^\d+$/.test(i) || !Array.isArray(arr)) continue;
    out.fin[i] = FIN_MAX.map((m, k) => cleanNum(arr[k], m));
  }
  return out;
}

function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'state': {
      if (ui.mode !== 'manage') return;
      mirror = { classes: Array.isArray(m.classes) ? m.classes : [], grades: m.grades && typeof m.grades === 'object' ? m.grades : {}, settings: m.settings || {}, lastBackupAt: m.lastBackupAt || null };
      openManage();
      toFrame(m);
      break;
    }
    case 'put-classes': case 'put-grades': case 'del-grades': case 'put-settings': {
      if (ui.mode !== 'manage' || !mirror) return;
      applyMirror(m);
      toFrame(m);
      if (presenting && m.type === 'put-grades') toFrame({ type: 'represent' });
      break;
    }
    case 'hello': {
      ui.mode = m.mode === 'manage' ? 'manage' : 'display';
      hello = {
        teacher: String(m.teacher || '').slice(0, 120),
        subject: String(m.subject || '').slice(0, 120),
        classLabel: String(m.classLabel || '').slice(0, 120),
        criteria: Array.isArray(m.criteria) ? m.criteria.map((x) => String(x || '').slice(0, 40)) : null,
        finals: Array.isArray(m.finals) ? m.finals.map((x) => ({ label: String(x?.label || '').slice(0, 40), max: Number(x?.max) || 0 })) : null,
      };
      renderHeader();
      if (model) render();
      break;
    }
    case 'snapshot': {
      const names = Array.isArray(m.names) ? m.names.slice(0, 200).map((x) => String(x ?? '').slice(0, 120)) : [];
      const scope = m.scope && m.scope.kind === 'student' && isIdx(Number(m.scope.idx), names.length)
        ? { kind: 'student', idx: Number(m.scope.idx) } : { kind: 'class' };
      const changedClass = !model || model.names.length !== names.length || model.scope.kind !== scope.kind || model.scope.idx !== scope.idx;
      model = { names, data: sanitizeData(m.data), scope, hideNames: !!m.hideNames };
      if (changedClass) { prevCells = null; closeDrawer(); }
      if (ui.screen !== 'pair' || ui.connState === 'connected') {
        setScreen(isSolo() ? 'solo' : 'live');
      }
      render(!changedClass);
      break;
    }
    case 'patch': {
      if (!model) return;
      if (applyPatch(m)) render(true);
      break;
    }
    case 'blank': {
      ui.blank = !!m.on;
      $('blank').hidden = !ui.blank;
      break;
    }
    case 'bye': {
      ui.ended = true;
      wipe();
      setScreen('live');
      ui.connState = 'closed';
      renderPill();
      renderEnded();
      showBanner(true);
      wakeLock(false);
      break;
    }
    default:
  }
}

function applyPatch(m) {
  const d = model.data;
  const n = model.names.length;
  const idx = Number(m.idx);
  if (isSolo() && m.kind !== 'meta' && idx !== model.scope.idx) return false;
  if (m.kind === 'items') {
    if (!isWeek(m.week) || !isIdx(idx, n) || !Array.isArray(m.values)) return false;
    const wk = String(Number(m.week));
    d.weeks[wk] ||= { date: '', lesson: '', s: {} };
    d.weeks[wk].s ||= {};
    d.weeks[wk].s[idx] = CONFIG.criteria.map((_, k) => cleanNum(m.values[k], CONFIG.itemMax));
    d.weeks[wk].abs ||= {};
    if (m.absent === true) d.weeks[wk].abs[idx] = true; else delete d.weeks[wk].abs[idx];
    d.weeks[wk].star ||= {};
    if (m.star === true) d.weeks[wk].star[idx] = true; else delete d.weeks[wk].star[idx];
    d.weeks[wk].issue ||= {};
    if (m.issue === true) d.weeks[wk].issue[idx] = true; else delete d.weeks[wk].issue[idx];
    return true;
  }
  if (m.kind === 'fin') {
    if (!isIdx(idx, n) || !Array.isArray(m.values)) return false;
    d.fin[idx] = FIN_MAX.map((mx, k) => cleanNum(m.values[k], mx));
    return true;
  }
  if (m.kind === 'meta') {
    if (!isWeek(m.week)) return false;
    const wk = String(Number(m.week));
    d.weeks[wk] ||= { date: '', lesson: '', s: {} };
    if (m.date != null) d.weeks[wk].date = String(m.date).slice(0, 40);
    if (m.lesson != null) d.weeks[wk].lesson = String(m.lesson).slice(0, 200);
    return true;
  }
  return false;
}

// ---------- العرض ----------
function renderHeader() {
  if (!hello) { $('class-info').hidden = true; return; }
  $('class-label').textContent = hello.classLabel ? `الصف ${hello.classLabel}` : 'الصف';
  $('class-meta').textContent = [hello.teacher, hello.subject].filter(Boolean).join(' · ');
  $('class-info').hidden = ui.screen === 'pair';
}

const cell = (v, max, extra = '') => {
  const full = typeof v === 'number' && v >= max;
  const cls = v == null ? 'num missing' : full ? 'num full' : 'num';
  return `<td class="${cls}${extra}">${fmt(v)}</td>`;
};

function rowsOrder() {
  const n = model.names.length;
  const idxs = Array.from({ length: n }, (_, i) => i);
  const { key, dir } = ui.sort;
  if (key === 'name') idxs.sort((a, b) => dir * arCompare(model.names[a], model.names[b]) || a - b);
  else if (key === 'total') {
    const val = (i) => sortValue(i);
    idxs.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return a - b;
      if (va == null) return 1; // الفارغ في الأسفل دائمًا
      if (vb == null) return -1;
      return dir * (vb - va) || a - b; // dir=1: الأعلى أولًا
    });
  } else if (dir < 0) idxs.reverse();
  return idxs;
}
function sortValue(i) {
  const d = model.data;
  if (ui.view === 'week') return weekTotal(d, ui.week, i);
  return finalTotal(d, i) ?? (formative(d, i) != null ? formative(d, i) : null);
}

function sortHeader(key, label, extraCls = '') {
  const active = ui.sort.key === key;
  const icon = active ? (ui.sort.dir === 1 ? (key === 'total' ? I.sortDown : I.sortUp) : (key === 'total' ? I.sortUp : I.sortDown)) : '';
  return `<button class="th-sort${active ? ' active' : ''}${extraCls}" type="button" data-sort="${key}">${label}${icon}</button>`;
}

function headSub(top, sub) { return `<span class="th-top">${top}</span>${sub ? `<span class="th-sub">${sub}</span>` : ''}`; }

function renderGrid() {
  const d = model.data;
  const n = model.names.length;
  const order = rowsOrder();
  const crit = criteriaLabels();
  const fins = finalsMeta();
  let head = '';
  let body = '';
  const numTh = `<th class="col-num sticky-a" scope="col">${sortHeader('num', 'م')}</th>`;
  const nameTh = `<th class="col-name sticky-b" scope="col">${sortHeader('name', 'الاسم')}</th>`;
  const stars = (i) => {
    if (ui.view === 'week') return (issueAt(d, ui.week, i) ? '<span class="issue-badge" title="تنبيه">❗</span>' : '') + (starAt(d, ui.week, i) ? '<span class="star-badge" title="نجمة تميّز">⭐</span>' : '');
    let n = 0; for (let w = 1; w <= WEEKS; w++) if (starAt(d, w, i)) n++;
    let k = 0; for (let w = 1; w <= WEEKS; w++) if (issueAt(d, w, i)) k++;
    return (k ? '<span class="issue-badge" title="تنبيه">❗</span>' : '') + (n ? `<span class="star-badge" title="نجوم التميّز">⭐${n > 1 ? `<small>${ar(n)}</small>` : ''}</span>` : '');
  };
  const nameCell = (i) => `<td class="col-num sticky-a">${ar(i + 1)}</td><th class="col-name sticky-b" scope="row"><span class="name">${esc(model.names[i]) || '<span class="muted">—</span>'}</span>${stars(i)}</th>`;

  if (ui.view === 'summary') {
    let wk = '';
    for (let w = 1; w <= WEEKS; w++) wk += `<th scope="col" class="c-week">${headSub('أسبوع', ar(w))}</th>`;
    head = `<tr>${numTh}${nameTh}${wk}
      <th scope="col" class="c-sep">${headSub('الفترة ١', '/' + ar(WEEK_MAX))}</th>
      <th scope="col">${headSub('الفترة ٢', '/' + ar(WEEK_MAX))}</th>
      <th scope="col" class="c-strong">${headSub('البنائي', '/' + ar(FORM_MAX))}</th>
      ${fins.map((f, k) => `<th scope="col"${k === 0 ? ' class="c-sep"' : ''}>${headSub(esc(shortFinal(f.label)), '/' + ar(f.max))}</th>`).join('')}
      <th scope="col" class="c-total">${sortHeader('total', headSub('المجموع', '/' + ar(TOTAL_MAX)))}</th></tr>`;
    for (const i of order) {
      const s = studentSummary(d, i);
      body += `<tr data-idx="${i}">${nameCell(i)}${s.weeks.map((v, w) => (absentAt(d, w + 1, i) ? absCell('w' + (w + 1)) : cell(v, WEEK_MAX, '" data-k="w' + (w + 1)))).join('')}
        ${cell(s.p1, WEEK_MAX, ' c-sep" data-k="p1')}${cell(s.p2, WEEK_MAX, '" data-k="p2')}${cell(s.formative, FORM_MAX, ' c-strong" data-k="fo')}
        ${s.fin.map((v, k) => cell(v, FIN_MAX[k], (k === 0 ? ' c-sep' : '') + '" data-k="f' + k)).join('')}
        ${totalCell(s.total, 'tt')}</tr>`;
    }
  } else if (ui.view === 'week') {
    const w = ui.week;
    head = `<tr>${numTh}${nameTh}${crit.map((c) => `<th scope="col" class="c-crit">${headSub(esc(c), '/' + ar(CONFIG.itemMax))}</th>`).join('')}
      <th scope="col" class="c-total">${sortHeader('total', headSub('المجموع', '/' + ar(WEEK_MAX)))}</th></tr>`;
    for (const i of order) {
      const items = getItems(d, w, i);
      const t = weekTotal(d, w, i);
      body += absentAt(d, w, i)
        ? `<tr data-idx="${i}" class="row-absent">${nameCell(i)}<td class="c-absent" colspan="${items.length}" data-k="ab">غائب</td>${totalCell(t, 'wt', WEEK_MAX)}</tr>`
        : `<tr data-idx="${i}">${nameCell(i)}${items.map((v, k) => cell(v, CONFIG.itemMax, ' c-crit" data-k="i' + k)).join('')}${totalCell(t, 'wt', WEEK_MAX)}</tr>`;
    }
  } else {
    head = `<tr>${numTh}${nameTh}
      <th scope="col">${headSub('الفترة ١', '/' + ar(WEEK_MAX))}</th>
      <th scope="col">${headSub('الفترة ٢', '/' + ar(WEEK_MAX))}</th>
      <th scope="col" class="c-strong">${headSub('التقويم البنائي', '/' + ar(FORM_MAX))}</th>
      ${fins.map((f, k) => `<th scope="col"${k === 0 ? ' class="c-sep"' : ''}>${headSub(esc(f.label), '/' + ar(f.max))}</th>`).join('')}
      <th scope="col" class="c-total">${sortHeader('total', headSub('المجموع النهائي', '/' + ar(TOTAL_MAX)))}</th></tr>`;
    for (const i of order) {
      const fin = getFin(d, i);
      body += `<tr data-idx="${i}">${nameCell(i)}${cell(periodScore(d, i, 1), WEEK_MAX, '" data-k="p1')}${cell(periodScore(d, i, 2), WEEK_MAX, '" data-k="p2')}
        ${cell(formative(d, i), FORM_MAX, ' c-strong" data-k="fo')}${fin.map((v, k) => cell(v, FIN_MAX[k], (k === 0 ? ' c-sep' : '') + '" data-k="f' + k)).join('')}${totalCell(finalTotal(d, i), 'tt')}</tr>`;
    }
  }
  if (!n) body = `<tr><td class="empty-row" colspan="30">لا يوجد طلاب في هذا الصف بعد.</td></tr>`;
  return `<table class="grid view-${ui.view}" aria-rowcount="${n}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function issueAt(d, w, i) { return !!(d.weeks[String(w)] && d.weeks[String(w)].issue && d.weeks[String(w)].issue[i]); }
function starAt(d, w, i) { return !!(d.weeks[String(w)] && d.weeks[String(w)].star && d.weeks[String(w)].star[i]); }
// ===== الرجوع التلقائي =====
function setSoftPause(on) {
  ui.paused = on;
  $('soft-pause').hidden = !on;
  $('screen-manage').classList.toggle('paused', on);
}
async function autoResume() {
  const old = link;
  const room = old && old.room;
  if (!room) return;
  setSoftPause(true);
  link = makeLink();
  if (E2E && window.__e2e) window.__e2e.link = link;
  try { old.stopRelay && old.stopRelay(); old.closeQuiet ? old.closeQuiet() : old.stop(); } catch { /* */ }
  try {
    await link.createOffer({ room, publish: true });
  } catch {
    setSoftPause(false);
    showBanner(false);
  }
}

// ===== وضع الإدارة: التطبيق الكامل داخل إطار، والجوال هو مصدر البيانات =====
function openManage() {
  if (!manageFrame) {
    manageFrame = document.createElement('iframe');
    manageFrame.src = 'index.html?remote=1';
    manageFrame.title = 'إدارة التطبيق';
    manageFrame.className = 'manage-frame';
    $('screen-manage').innerHTML = '';
    $('screen-manage').appendChild(manageFrame);
  }
  if (!presenting) setScreen('manage');
}
function toFrame(msg) {
  if (manageFrame && manageFrame.contentWindow) manageFrame.contentWindow.postMessage({ gfu: 'phone', msg }, location.origin);
}
function applyMirror(m) {
  if (!mirror) return;
  if (m.type === 'put-classes' && Array.isArray(m.classes)) mirror.classes = m.classes;
  if (m.type === 'put-grades' && m.id) mirror.grades[m.id] = m.data;
  if (m.type === 'del-grades' && m.id) delete mirror.grades[m.id];
  if (m.type === 'put-settings' && m.settings) mirror.settings = { ...mirror.settings, ...m.settings };
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !manageFrame || e.source !== manageFrame.contentWindow) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.gfu === 'ready') { if (mirror) toFrame({ type: 'state', ...mirror }); return; }
  if (d.gfu === 'op' && d.msg && link) { applyMirror(d.msg); link.sendOp(d.msg); return; }
  if (d.gfu === 'present') {
    // عرض للطلاب من وضع الإدارة: بيانات العرض فقط (بلا ملاحظات)
    presenting = true;
    const names = Array.isArray(d.names) ? d.names.map((x) => String(x ?? '').slice(0, 120)) : [];
    model = { names, data: sanitizeData(d.data), scope: { kind: 'class' }, hideNames: !!d.hideNames };
    hello = { ...(hello || {}), classLabel: String(d.label || '').slice(0, 120) };
    prevCells = null; closeDrawer();
    renderHeader();
    setScreen('live');
    render(true);
    return;
  }
});
function backToManage() {
  presenting = false;
  model = null;
  setScreen('manage');
}

function absentAt(d, w, i) { return !!(d.weeks[String(w)] && d.weeks[String(w)].abs && d.weeks[String(w)].abs[i]); }
function absCell(k) { return `<td class="num c-absent" data-k="${k}" title="غائب">غ</td>`; }

function totalCell(v, k, max = TOTAL_MAX) {
  const cls = v == null ? 'missing' : v >= max ? 'complete full' : 'complete';
  return `<td class="num c-total ${cls}" data-k="${k}"><span class="total-chip">${fmt(v)}</span></td>`;
}

function shortFinal(label) {
  return String(label).replace('المشروع الأول', 'المشروع ١').replace('المشروع الثاني', 'المشروع ٢').replace('الاختبار العملي', 'العملي');
}

function stats() {
  const d = model.data;
  const n = model.names.length;
  const p = progress(d, n);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) { const t = finalTotal(d, i); if (t != null) { sum += t; cnt++; } }
  return { n, ratio: p.ratio, avg: cnt ? sum / cnt : null, complete: cnt };
}

function renderSidebar() {
  const s = stats();
  const pct = Math.round(s.ratio * 100);
  $('stats').innerHTML = `
    <div class="stat"><span class="stat-icon">${I.users}</span><span class="stat-label">عدد الطلاب</span><strong class="stat-val" data-stat="n">${ar(s.n)}</strong></div>
    <div class="stat"><span class="stat-icon">${I.pie}</span><span class="stat-label">نسبة الاكتمال</span><strong class="stat-val" data-stat="ratio">${ar(pct)}٪</strong>
      <span class="meter" aria-hidden="true"><span style="inline-size:${pct}%"></span></span></div>
    <div class="stat"><span class="stat-icon">${I.avg}</span><span class="stat-label">متوسط المجموع</span><strong class="stat-val" data-stat="avg">${fmt(s.avg == null ? null : round2(s.avg))}<small> / ${ar(TOTAL_MAX)}</small></strong></div>
    <div class="stat"><span class="stat-icon">${I.check}</span><span class="stat-label">اكتمل مجموعهم</span><strong class="stat-val" data-stat="done">${ar(s.complete)}<small> من ${ar(s.n)}</small></strong></div>`;

  const d = model.data;
  let weeks = '';
  for (let w = 1; w <= WEEKS; w++) {
    const rem = weekRemaining(d, w, s.n);
    const state = s.n && rem === 0 ? 'done' : rem < s.n ? 'part' : 'none';
    const active = ui.view === 'week' && ui.week === w;
    weeks += `<button type="button" class="wk ${state}${active ? ' active' : ''}" data-week="${w}" aria-pressed="${active}" title="${state === 'done' ? 'مكتمل' : state === 'part' ? `متبقٍ ${ar(rem)}` : 'لم يُرصد'}">${ar(w)}</button>`;
  }
  $('views').innerHTML = `
    <span class="nav-title">طريقة العرض</span>
    <button type="button" class="nav-item${ui.view === 'summary' ? ' active' : ''}" data-view="summary" aria-pressed="${ui.view === 'summary'}">${I.table}<span>الملخص</span></button>
    <div class="nav-item static${ui.view === 'week' ? ' active' : ''}">${I.calendar}<span>أسبوع</span>
      <span class="nav-hint">${ui.view === 'week' ? ar(ui.week) : ''}</span></div>
    <div class="weeks" role="group" aria-label="اختيار الأسبوع">${weeks}</div>
    <button type="button" class="nav-item${ui.view === 'fin' ? ' active' : ''}" data-view="fin" aria-pressed="${ui.view === 'fin'}">${I.award}<span>الدرجات النهائية</span></button>
    <div class="legend">
      <span><i class="lg done"></i>أسبوع مكتمل</span><span><i class="lg part"></i>جزئي</span><span><i class="lg none"></i>لم يُرصد</span>
    </div>`;
}

function renderToolbar() {
  let title = '', sub = '';
  if (ui.view === 'summary') { title = 'ملخص الدرجات'; sub = `مجموع كل أسبوع من ${ar(WEEK_MAX)} · الفترات · التقويم البنائي · الدرجات النهائية`; }
  else if (ui.view === 'week') {
    const meta = getWeekMeta(model.data, ui.week);
    title = `الأسبوع ${ar(ui.week)}`;
    sub = [meta.date ? `<span class="tb-chip">${I.calendar}<span data-meta="date">${esc(fmtDate(meta.date))}</span></span>` : '', meta.lesson ? `<span class="tb-lesson" data-meta="lesson">${esc(meta.lesson)}</span>` : ''].filter(Boolean).join('') || '<span class="muted">لم يُحدَّد التاريخ أو الدرس بعد</span>';
  } else { title = 'الدرجات النهائية'; sub = `التقويم البنائي من ${ar(FORM_MAX)} + المشاريع والاختبار العملي = ${ar(TOTAL_MAX)}`; }
  const sorts = [['num', 'الترتيب'], ['name', 'الاسم'], ['total', 'المجموع']];
  $('toolbar').innerHTML = `
    <div class="tb-title"><h1>${title}</h1><div class="tb-sub">${sub}</div></div>
    <div class="seg" role="group" aria-label="ترتيب الصفوف"><span class="seg-label">ترتيب حسب</span>${sorts.map(([k, l]) => `<button type="button" data-sort="${k}" class="${ui.sort.key === k ? 'active' : ''}" aria-pressed="${ui.sort.key === k}">${l}</button>`).join('')}</div>`;
}

let prevCells = null;
function snapshotCells(root) {
  const m = new Map();
  root.querySelectorAll('tr[data-idx] [data-k]').forEach((td) => m.set(td.closest('tr').dataset.idx + ':' + td.dataset.k, td.textContent));
  return m;
}
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function render(flash = false) {
  if (!model) { renderEmptyWaiting(); return; }
  renderHeader();
  if (isSolo()) { setScreen('solo'); renderSolo(flash); return; }
  if (ui.screen !== 'live') setScreen('live');
  renderSidebar();
  renderToolbar();
  const wrap = $('grid-wrap');
  const before = flash ? snapshotCells(wrap) : null;
  const scroll = [wrap.scrollTop, wrap.scrollLeft];
  wrap.innerHTML = renderGrid();
  wrap.scrollTop = scroll[0]; wrap.scrollLeft = scroll[1];
  if (before && before.size) flashChanged(wrap, before);
  if (ui.drawerIdx != null) openDrawer(ui.drawerIdx, true);
}

function flashChanged(root, before) {
  root.querySelectorAll('tr[data-idx] [data-k]').forEach((td) => {
    const k = td.closest('tr').dataset.idx + ':' + td.dataset.k;
    if (before.has(k) && before.get(k) !== td.textContent) {
      td.classList.add('flash');
      setTimeout(() => td.classList.remove('flash'), reduceMotion.matches ? 1200 : 1400);
    }
  });
}

function renderEmptyWaiting() {
  if (ui.screen === 'pair') return;
  $('stats').innerHTML = '';
  $('views').innerHTML = '';
  $('toolbar').innerHTML = '';
  $('grid-wrap').innerHTML = ui.ended ? '' : ui.waitError
    ? `<div class="waiting error"><strong>${ui.waitError === 'render' ? 'تعذّر عرض البيانات' : 'لم تصل البيانات من الجوال'}</strong><span>${ui.waitError === 'render' ? 'حدّث صفحة العرض (F5) ثم أعد الاتصال.' : 'تأكد أن شاشة «العرض» مفتوحة في الجوال وأنه على نفس الشبكة، ثم أعد الاتصال.'}</span><button class="btn primary" type="button" id="btn-wait-reconnect">إعادة الاتصال</button></div>`
    : `<div class="waiting"><span class="spinner" aria-hidden="true"></span><strong>تم الاتصال</strong><span>جارٍ استلام الدرجات من الجوال…</span></div>`;
  const wr = document.getElementById('btn-wait-reconnect');
  if (wr) wr.addEventListener('click', () => $('btn-reconnect').click());
}

function renderEnded() {
  $('grid-wrap').innerHTML = `<div class="waiting ended"><span class="ended-icon">${I.unlink}</span><strong>انتهت المشاركة</strong><span>لا توجد أي بيانات محفوظة على هذا الكمبيوتر.</span></div>`;
}

// ---------- تفاصيل الطالب ----------
function studentDetail(i, big = false) {
  const d = model.data;
  const s = studentSummary(d, i);
  const crit = criteriaLabels();
  const fins = finalsMeta();
  let rows = '';
  for (let w = 1; w <= WEEKS; w++) {
    const items = getItems(d, w, i);
    const meta = getWeekMeta(d, w);
    rows += `<tr><th scope="row"><span class="wk-n">أسبوع ${ar(w)}</span>${meta.date ? `<span class="wk-d">${esc(fmtDate(meta.date, true))}</span>` : ''}</th>
      ${absentAt(d, w, i) ? `<td class="c-absent" colspan="${items.length}">غائب</td>` : items.map((v, k) => cell(v, CONFIG.itemMax, '" data-k="w' + w + 'i' + k)).join('')}${totalCell(s.weeks[w - 1], 'w' + w + 't', WEEK_MAX)}</tr>`;
  }
  const tile = (label, v, max, k, strong = false) => `<div class="tile${strong ? ' strong' : ''}${v != null && v >= max ? ' full' : ''}" data-k="${k}"><span class="tile-label">${esc(label)}</span><strong>${fmt(v)}</strong><span class="tile-max">من ${ar(max)}</span></div>`;
  const total = s.total;
  return `
    <div class="detail ${big ? 'big' : ''}" data-idx="${i}">
      <div class="detail-head">
        <span class="avatar" aria-hidden="true">${ar(i + 1)}</span>
        <div><h2 id="drawer-title">${esc(model.names[i]) || 'طالب'}</h2>
        <span class="muted">${esc(hello?.classLabel ? 'الصف ' + hello.classLabel : '')}${hello?.subject ? ' · ' + esc(hello.subject) : ''}</span></div>
      </div>
      <div class="total-banner ${total == null ? 'pending' : 'done'}" data-k="tt">
        <span>المجموع النهائي</span>
        <strong>${total == null ? 'لم يكتمل بعد' : `${fmt(total)} <small>من ${ar(TOTAL_MAX)}</small>`}</strong>
      </div>
      <div class="detail-body">
        <section class="detail-weeks">
          <h3>درجات الأسابيع</h3>
          <table class="mini">
            <thead><tr><th scope="col">الأسبوع</th>${crit.map((c) => `<th scope="col">${esc(c)}<span class="th-sub">/${ar(CONFIG.itemMax)}</span></th>`).join('')}<th scope="col">المجموع<span class="th-sub">/${ar(WEEK_MAX)}</span></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </section>
        <section class="detail-side">
          <h3>التقويم البنائي</h3>
          <div class="tiles">${tile('الفترة الأولى', s.p1, WEEK_MAX, 'p1')}${tile('الفترة الثانية', s.p2, WEEK_MAX, 'p2')}${tile('التقويم البنائي', s.formative, FORM_MAX, 'fo', true)}</div>
          <h3>الدرجات النهائية</h3>
          <div class="tiles">${fins.map((f, k) => tile(f.label, s.fin[k], f.max, 'f' + k)).join('')}</div>
        </section>
      </div>
    </div>`;
}

function openDrawer(i, refresh = false) {
  if (!model || !isIdx(i, model.names.length)) return;
  const dr = $('drawer');
  const before = refresh ? snapshotDetail(dr) : null;
  ui.drawerIdx = i;
  dr.innerHTML = `<button class="btn ghost icon-only drawer-close" type="button" data-close-drawer aria-label="إغلاق">${I.close}</button>${studentDetail(i)}`;
  if (before) flashDetail(dr, before);
  if (dr.hidden) {
    dr.hidden = false;
    $('drawer-backdrop').hidden = false;
    requestAnimationFrame(() => { dr.classList.add('open'); $('drawer-backdrop').classList.add('open'); });
    dr.querySelector('[data-close-drawer]').focus();
  }
}
function closeDrawer() {
  ui.drawerIdx = null;
  const dr = $('drawer');
  dr.classList.remove('open');
  $('drawer-backdrop').classList.remove('open');
  dr.hidden = true;
  $('drawer-backdrop').hidden = true;
  dr.innerHTML = '';
}
function snapshotDetail(root) {
  const m = new Map();
  root.querySelectorAll('[data-k]').forEach((el) => m.set(el.dataset.k, el.textContent));
  return m;
}
function flashDetail(root, before) {
  root.querySelectorAll('[data-k]').forEach((el) => {
    if (before.has(el.dataset.k) && before.get(el.dataset.k) !== el.textContent) {
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1400);
    }
  });
}

function renderSolo(flash) {
  const root = $('screen-solo');
  const before = flash ? snapshotDetail(root) : null;
  root.innerHTML = studentDetail(model.scope.idx, true);
  if (before) flashDetail(root, before);
}

// ---------- النوافذ ----------
function openModal(id) {
  closeModals();
  const m = $(id);
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add('open'));
}
function closeModals() {
  for (const id of ['modal-paste']) {
    const m = $(id);
    m.classList.remove('open');
    m.hidden = true;
  }
}

function openPaste() {
  openModal('modal-paste');
  $('paste-error').hidden = true;
  const ta = $('paste-input');
  ta.value = '';
  setTimeout(() => ta.focus(), 30);
}

async function submitPaste() {
  const raw = $('paste-input').value;
  const errEl = $('paste-error');
  errEl.hidden = true;
  // يقبل الرمز الكامل أو أجزاء GF ملصوقة متتالية
  let code = raw.trim();
  if (/GF\d+\/\d+:/.test(code)) {
    const c = new FrameCollector();
    code = null;
    for (const part of raw.split(/\s+|(?=GF\d+\/\d+:)/)) { const r = c.push(part); if (r) code = r; }
    if (!code) { errEl.textContent = 'الرمز ناقص: بعض الأجزاء غير موجودة.'; errEl.hidden = false; return; }
  }
  code = (code || '').replace(/\s+/g, '');
  if (!code) { errEl.textContent = 'الصق رمز الرد أولًا.'; errEl.hidden = false; return; }
  const btn = $('paste-submit');
  btn.disabled = true;
  try {
    await acceptAnswer(code);
    closeModals();
  } catch (e) {
    errEl.textContent = e.message || 'رمز غير صالح.';
    errEl.hidden = false;
  } finally { btn.disabled = false; }
}

async function copyOffer() {
  if (!offerCode) return;
  try {
    await navigator.clipboard.writeText(offerCode);
    toast('تم نسخ رمز العرض. أرسله إلى الجوال والصقه في «لصق رمز العرض».');
  } catch {
    // احتياط: تحديد النص يدويًا
    const ta = document.createElement('textarea');
    ta.value = offerCode; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? 'تم نسخ رمز العرض.' : 'تعذر النسخ في هذا المتصفح.');
  }
}

function disconnect() {
  if (link) link.stop();
  link = null;
  backToPairing();
}

// ---------- الأحداث ----------
function bind() {
  $('btn-paste').innerHTML = btnHtml(I.paste, 'لصق الرد يدويًا');
  $('btn-copy').innerHTML = btnHtml(I.copy, 'نسخ رمز العرض');
  $('btn-new').innerHTML = btnHtml(I.refresh, 'رمز جديد');
  $('btn-disconnect').innerHTML = btnHtml(I.unlink, 'قطع الاتصال');
  $('btn-disconnect').setAttribute('aria-label', 'قطع الاتصال');
  document.querySelectorAll('.modal [data-close].icon-only').forEach((b) => { b.innerHTML = I.close; });

  $('btn-paste').addEventListener('click', openPaste);
  $('btn-copy').addEventListener('click', copyOffer);
  $('btn-new').addEventListener('click', () => newOffer());
  $('btn-full').addEventListener('click', toggleFull);
  $('btn-theme').addEventListener('click', () => { ui.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; applyTheme(); });
  $('zoom-in').addEventListener('click', () => setZoom(ui.zoom + 0.1));
  $('zoom-out').addEventListener('click', () => setZoom(ui.zoom - 0.1));
  $('btn-disconnect').addEventListener('click', disconnect);
  $('btn-manage-back').addEventListener('click', backToManage);
  $('btn-soft-end').addEventListener('click', () => { setSoftPause(false); if (link) link.stop(); link = null; backToPairing(); });
  $('btn-reconnect').addEventListener('click', () => { if (link) link.stop(); link = null; backToPairing(); });
  $('paste-submit').addEventListener('click', submitPaste);
  $('paste-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPaste(); } });
  document.querySelectorAll('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); });
  });
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('click', (e) => { if (e.target.closest('[data-close-drawer]')) closeDrawer(); });

  $('views').addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    const w = e.target.closest('[data-week]');
    if (v) { ui.view = v.dataset.view; if (ui.sort.key === 'total') ui.sort.dir = 1; render(); }
    else if (w) { ui.view = 'week'; ui.week = Number(w.dataset.week); render(); }
  });
  const onSort = (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return false;
    const k = b.dataset.sort;
    if (ui.sort.key === k) ui.sort.dir = -ui.sort.dir;
    else ui.sort = { key: k, dir: 1 };
    render();
    return true;
  };
  $('toolbar').addEventListener('click', onSort);
  $('grid-wrap').addEventListener('click', (e) => {
    if (onSort(e)) return;
    const tr = e.target.closest('tr[data-idx]');
    if (tr) openDrawer(Number(tr.dataset.idx));
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) { if (e.key === 'Escape') closeModals(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (!$('drawer').hidden) closeDrawer(); else closeModals(); return; }
    if (e.key === 'f' || e.key === 'F' || e.key === 'ف') { e.preventDefault(); toggleFull(); return; }
    if (ui.screen === 'pair') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(ui.zoom + 0.1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(ui.zoom - 0.1); }
  });

  // الخصوصية: لا شيء يبقى بعد إغلاق الصفحة
  const teardown = () => {
    try { if (link) link.stop(); } catch { /* */ }
    link = null;
    wipe();
    offerCode = ''; frames = [];
    clearInterval(frameTimer);
    wakeLock(false);
  };
  window.addEventListener('pagehide', teardown);
  window.addEventListener('beforeunload', teardown);
}

// ---------- تشغيل ----------
if (E2E) {
  // واجهة اختبار فقط (تظهر حصرًا مع ?e2e): تتيح للاختبار محاولة إرسال رسالة مزوّرة من الكمبيوتر.
  window.__e2e = {
    link: null,
    sendRaw(text) { const dc = this.link && this.link.dc; if (!dc || dc.readyState !== 'open') return false; dc.send(String(text)); return true; },
    state: () => ({ conn: ui.connState, screen: ui.screen }),
    offer: () => offerCode,
  };
}
bind();
applyTheme();
updateFullBtn();
setZoom(1);
setScreen('pair');
newOffer();

// تخزين ملفات الصفحة فقط (بدون أي بيانات) حتى تفتح بدون إنترنت، وتثبيتها من Chrome كتطبيق مستقل
if ('serviceWorker' in navigator && window.isSecureContext && !E2E) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
