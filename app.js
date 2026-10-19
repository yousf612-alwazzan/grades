// متابعة الدرجات — التطبيق الرئيسي (صفحة واحدة SPA)
// البنية: حالة S + موجّه (stack من الشاشات) + دوال رسم لكل شاشة + معالجات أحداث مفوّضة (data-act).
// للتخصيص راجع CLAUDE.md و config.js.
import CONFIG from './config.js';
import { CHANGELOG } from './changelog.js';
import { PLAN_NAME, planFor, gradeOf } from './lesson-plans.js';
import * as cloud from './cloud.js';
import { sanitizeRoster, gradeName, sectionLabel, sortedSections, sortedGrades } from './school.js';
import { DAYS, SCHOOL_DAYS, REMIND_CHOICES, sanitizeSchedule, sortSchedule, nextOccurrence, buildICS, syncNativeReminders, minutesText } from './reminders.js';
import {
  WEEKS, ITEMS, MAX_STUDENTS, parseScore, fmt, emptyClassData, getItems, setItem, getFin, setFin,
  getWeekMeta, setWeekMeta, weekTotal, periodScore, formative, finalTotal, studentSummary,
  studentComplete, weekRemaining, weekComplete, finalsRemaining, firstIncompleteWeek, progress,
  studentCardText, cleanNames, arCompare, remapData, nameKey,
  isAbsent, setAbsent, absenceCount, getNotes, addNote, deleteNote,
  isStar, setStar, starCount, weekIssues, clearWeekIssues,
} from './grades-core.js';
import * as localStore from './store.js';
import { buildTransfer, transferFileName, parseTransfer, applyTransfer, moveStudents } from './transfer.js';
import { platform } from './platform.js';
import { ar, esc, icon, toast, openSheet, closeTopSheet, hasSheet, confirmDialog, keypad, students, cells, names as namesWord } from './ui.js';
import { T, tr, trCrit, lang, rememberLang, translateStatic } from './i18n.js';

// ===================== وضع الإدارة من الكمبيوتر =====================
// REMOTE: هذا التطبيق يعمل داخل صفحة العرض على الكمبيوتر، وبياناته في جوال المعلم (لا شيء يُحفظ هنا).
const REMOTE = new URLSearchParams(location.search).has('remote') && window.parent !== window;

function remoteStore(base) {
  const post = (msg) => window.parent.postMessage({ gfu: 'op', msg }, location.origin);
  let gotState;
  const firstState = new Promise((res) => { gotState = res; });
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    const d = e.data;
    if (d && d.gfu === 'edit' && d.op) { presentEdit(d.op); return; }
    if (d && d.gfu === 'opt') { presentOpt(d.key, d.on); return; }
    if (!d || d.gfu !== 'phone' || !d.msg) return;
    const m = d.msg;
    if (m.type === 'state') { if (!S.booted) gotState(m); else applyPhoneState(m); return; }
    applyPhoneUpdate(m);
  });
  window.parent.postMessage({ gfu: 'ready' }, location.origin);
  return {
    ...base,
    async loadAll() {
      const m = await firstState;
      const grades = {};
      for (const [id, g] of Object.entries(m.grades || {})) grades[id] = base.sanitizeClassData(g);
      return { classes: Array.isArray(m.classes) ? m.classes : [], settings: { ...CONFIG.defaultSettings, ...(m.settings || {}), tourDone: true }, grades, meta: { persist: 'granted', lastBackupAt: m.lastBackupAt || null, schema: 3 } };
    },
    async saveClasses(c) { post({ type: 'put-classes', classes: c }); },
    async saveGrades(id, d) { post({ type: 'put-grades', id, data: d }); },
    async deleteGrades(id) { post({ type: 'del-grades', id }); },
    async saveSettings(st) { post({ type: 'put-settings', settings: pickTeacher(st) }); },
    async setMeta() {}, async getMeta() { return null; },
    async replaceAll() { throw new Error('الاسترجاع يتم من الجوال فقط'); },
    async requestPersist() { return 'granted'; },
  };
}

// على الجوال: كل حفظ يُرسل للكمبيوتر أيضًا إذا كانت الإدارة من الكمبيوتر مفعّلة
function syncingStore(base) {
  return {
    ...base,
    async saveClasses(c) { await base.saveClasses(c); manageSend({ type: 'put-classes', classes: c }); cloudTouch('classes'); },
    async saveGrades(id, d) { await base.saveGrades(id, d); manageSend({ type: 'put-grades', id, data: d }); cloudTouch('g:' + id); },
    async deleteGrades(id) { await base.deleteGrades(id); manageSend({ type: 'del-grades', id }); cloudTouch('g:' + id); },
    async saveSettings(st) { await base.saveSettings(st); manageSend({ type: 'put-settings', settings: pickTeacher(st) }); cloudTouch('settings'); },
    async replaceAll(x) { await base.replaceAll(x); cloudTouch('*'); },
  };
}
const store = REMOTE ? remoteStore(localStore) : syncingStore(localStore);

// الكمبيوتر يستقبل تعديلات الجوال (حين يرصد المعلم من جواله أثناء الإدارة)
function applyPhoneUpdate(m) {
  if (m.type === 'put-classes' && Array.isArray(m.classes)) S.classes = m.classes;
  else if (m.type === 'put-grades' && m.id) S.grades[m.id] = localStore.sanitizeClassData(m.data);
  else if (m.type === 'del-grades' && m.id) delete S.grades[m.id];
  else if (m.type === 'put-settings' && m.settings) Object.assign(S.settings, pickTeacher(m.settings));
  else if (m.type === 'represent') { if (S.ui.presenting) presentClass(S.ui.presenting); return; }
  else if (m.type === 'unpresent') { S.ui.presenting = null; softRender(); return; }
  softRender();
  if (S.ui.presenting && m.type === 'put-grades' && m.id === S.ui.presenting) presentClass(m.id);
}
function applyPhoneState(m) {
  S.classes = Array.isArray(m.classes) ? m.classes : [];
  S.grades = {};
  for (const [id, g] of Object.entries(m.grades || {})) S.grades[id] = localStore.sanitizeClassData(g);
  Object.assign(S.settings, pickTeacher(m.settings || {}));
  softRender();
}
function pickTeacher(st) {
  const o = {};
  for (const k of ['teacher', 'subject', 'year']) if (typeof st[k] === 'string') o[k] = st[k].slice(0, 120);
  for (const k of ['liveShowStars', 'liveShowIssues']) if (typeof st[k] === 'boolean') o[k] = st[k];
  if (st.liveIssueHidden && typeof st.liveIssueHidden === 'object') {
    const h = {};
    for (const [id, arr] of Object.entries(st.liveIssueHidden).slice(0, 100)) {
      if (typeof id === 'string' && id.length < 40 && Array.isArray(arr)) h[id] = arr.filter((i) => Number.isInteger(i) && i >= 0 && i < 500).slice(0, 500);
    }
    o.liveIssueHidden = h;
  }
  return o;
}
// ===================== الحساب والمزامنة المشفّرة (آيفون والموقع فقط) =====================
// أندرويد (تطبيق أصلي) لا يستعمل الحسابات: يبقى على الربط المباشر كما هو.
const CLOUD_ON = !REMOTE && !platform.isNative && !!cloud.CLOUD;
// الآيفون: الدخول إجباري ويبقى محفوظًا. الكمبيوتر: جلسة مؤقتة (لا يُحفظ شيء) تنتهي تلقائيًا بعد ساعة ونصف.
const IOS_WEB = CLOUD_ON && platform.isIOS && !(typeof window !== 'undefined' && window.__gfuNoGate);
const DESK_WEB = CLOUD_ON && !platform.isIOS;
const DESK_SESSION_MS = 90 * 60 * 1000;
// الكمبيوتر بلا حساب = صفحة الربط (QR). البقاء هنا للتطوير والاختبارات فقط (gfu-dev-stay)
const DEV_STAY = (() => { try { return localStorage.getItem('gfu-dev-stay') === '1'; } catch { return false; } })();
const PC_HOME = 'view.html';
function toPcHome() { if (DESK_WEB && !DEV_STAY) { location.replace(PC_HOME); return true; } return false; }
const C = { session: null, sync: null, state: 'off', loading: false, memMeta: null };
function cloudTouch(k) {
  if (!C.sync) return;
  if (k === '*') { for (const x of cloudKeys()) C.sync.touch(x); return; }
  C.sync.touch(k);
}
function cloudKeys() { return ['classes', 'settings', ...S.classes.map((c) => 'g:' + c.id)]; }
function cloudGet(k) {
  if (k === 'classes') return S.classes.map((c) => ({ id: c.id, label: c.label, names: c.names.slice() }));
  if (k === 'settings') return pickTeacher(S.settings);
  const id = k.slice(2);
  return cls(id) && S.grades[id] ? JSON.parse(JSON.stringify(S.grades[id])) : null;
}
// تعديل وصل من الحساب (جهاز آخر): يُحفظ محليًا بلا إعادة إرسال
async function cloudApply(k, data) {
  if (k === 'classes') {
    const clean = (Array.isArray(data) ? data : []).filter((c) => c && typeof c.id === 'string' && c.id.length < 40 && typeof c.label === 'string' && Array.isArray(c.names))
      .slice(0, 100).map((c) => ({ id: c.id, label: c.label.slice(0, 100), names: c.names.slice(0, MAX_STUDENTS).map((x) => String(x ?? '').slice(0, 120)) }));
    const ids = new Set(clean.map((c) => c.id));
    for (const id of Object.keys(S.grades)) if (!ids.has(id)) { delete S.grades[id]; await localStore.deleteGrades(id); }
    for (const c of clean) S.grades[c.id] ||= emptyClassData();
    S.classes = clean;
    await localStore.saveClasses(S.classes);
    manageSend({ type: 'put-classes', classes: S.classes });
  } else if (k === 'settings') {
    if (data && typeof data === 'object') { Object.assign(S.settings, pickTeacher(data)); await localStore.saveSettings(S.settings); manageSend({ type: 'put-settings', settings: pickTeacher(S.settings) }); }
  } else if (k.startsWith('g:')) {
    const id = k.slice(2);
    if (data === null) { if (!cls(id)) { delete S.grades[id]; await localStore.deleteGrades(id); } }
    else { S.grades[id] = localStore.sanitizeClassData(data); await localStore.saveGrades(id, S.grades[id]); manageSend({ type: 'put-grades', id, data: S.grades[id] }); }
  }
  noteChange();
  if (route().name !== 'live') softRender();
}
const CLOUD_TEXT = { syncing: 'جارٍ المزامنة…', ok: 'محفوظ في حسابك', offline: 'بدون إنترنت — تتزامن لاحقًا', auth: 'انتهت الجلسة — سجّل الدخول', idle: 'جارٍ الاتصال…', off: '' };
function cloudChip() {
  if (!C.session) return '';
  const s = C.state;
  return T`<button type="button" class="cloud-chip s-${s}" data-act="nav" data-to="settings" data-cloud-chip title="${esc(tr(CLOUD_TEXT[s] || ''))}">${icon(s === 'offline' || s === 'auth' ? 'cloudOff' : 'cloud')}<span>${tr(CLOUD_TEXT[s] || '')}</span></button>`;
}
function raSyncHTML() {
  const bad = C.state === 'offline' || C.state === 'auth';
  const txt = C.state === 'ok' ? tr('محفوظ') : tr(CLOUD_TEXT[C.state] || '');
  return `${icon(bad ? 'cloudOff' : 'cloud')}<span class="tab-label">${esc(txt)}</span>`;
}
function paintCloud() {
  document.querySelectorAll('[data-ra-sync]').forEach((el) => { el.className = 'ra-sync s-' + C.state; el.innerHTML = raSyncHTML(); });
  document.querySelectorAll('[data-cloud-chip]').forEach((el) => { el.outerHTML = cloudChip(); });
  const st = document.querySelector('[data-cloud-state]');
  if (st) st.textContent = tr(CLOUD_TEXT[C.state] || '');
}
async function startCloud(session, key) {
  C.session = session;
  if (!key) {
    try {
      key = session.eph ? await cloud.importKey(Uint8Array.from(atob(String(session.k || '').replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(session.k || '').length + 3) % 4)), (c) => c.charCodeAt(0)))
        : await localStore.getMeta('cloudKey');
    } catch { key = null; }
  }
  if (!key) { cloud.clearSession(); C.session = null; return; }
  C.sync = new cloud.CloudSync(session, key, {
    keys: cloudKeys,
    get: cloudGet,
    apply: cloudApply,
    loadMeta: async () => (session.eph ? C.memMeta : await localStore.getMeta('cloudSync')),
    saveMeta: async (m) => { if (session.eph) C.memMeta = JSON.parse(JSON.stringify(m)); else await localStore.setMeta('cloudSync', JSON.parse(JSON.stringify(m))); },
    onState: (s) => { C.state = s; paintCloud(); },
    onAuthLost: () => { cloud.clearSession(); C.sync = null; toast(tr('انتهت جلسة الحساب — سجّل الدخول من جديد. درجاتك على هذا الجهاز لم تتأثر.'), { err: true, ms: 8000 }); },
  });
  C.state = 'idle'; paintCloud();
  C.loading = session.eph;
  if (C.loading) render();
  const startP = C.sync.start();
  // كلمة سر مبدئية: نطلب اختيار الاسم وكلمة السر فورًا (الحفظ ينتظر انتهاء المزامنة الأولى بنفسه)
  if (session.mustChange && !C.loading && !hasSheet()) openAccountSheet(true);
  try { await startP; } finally { if (C.loading) { C.loading = false; render(); } }
  loadSchoolRoster().catch(() => {});
  if (session.mustChange && C.sync && !hasSheet() && !document.querySelector('[data-acform]')) openAccountSheet(true);
}
function cloudLeftMs() { return C.session && DESK_WEB ? Math.max(0, (Number(C.session.t) || Date.now()) + DESK_SESSION_MS - Date.now()) : Infinity; }
function fmtLeft(ms) {
  const sec = Math.ceil(ms / 1000);
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const x = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}
let warned5 = false;
setInterval(() => {
  if (!C.session || !DESK_WEB) return;
  const left = cloudLeftMs();
  document.querySelectorAll('[data-cloud-timer]').forEach((el) => { el.textContent = fmtLeft(left); el.classList.toggle('soon', left < 5 * 60 * 1000); });
  if (left < 5 * 60 * 1000 && left > 0 && !warned5) { warned5 = true; toast(tr('باقي ٥ دقائق وتخرج من حسابك تلقائيًا — تعديلاتك محفوظة.'), { ms: 8000 }); }
  if (left <= 0) cloudLogout(true);
}, 1000);
async function cloudLogout(auto = false) {
  const eph = C.session && C.session.eph;
  if (auto) {
    if (C.loggingOut) return;
    C.loggingOut = true;
    try { if (C.sync) { await Promise.race([C.sync.settle(8000), new Promise((r) => setTimeout(r, 9000))]); await C.sync.logout(); } } catch { /* */ }
    cloud.clearSession();
    try { sessionStorage.setItem('gfu-cloud-ended', '1'); } catch { /* */ }
    if (!toPcHome()) location.reload();
    return;
  }
  const ok = await confirmDialog({ title: tr('الخروج من الحساب؟'), text: eph ? tr('تُمسح درجاتك من هذا الكمبيوتر، وتبقى محفوظة في حسابك وجوالك.') : tr('تبقى درجاتك على هذا الجهاز، وتتوقف المزامنة حتى تسجّل الدخول مرة ثانية.'), ok: tr('خروج') });
  if (!ok) return;
  if (C.sync) { await C.sync.flush(); await C.sync.logout(); }
  C.sync = null;
  cloud.clearSession();
  if (eph) { if (!toPcHome()) location.reload(); return; }
  try { await localStore.setMeta('cloudKey', null); await localStore.setMeta('cloudSync', null); } catch { /* */ }
  C.session = null; C.state = 'off';
  render();
  toast(tr('خرجت من الحساب'));
}
function loginFormHTML(err = '', user = cloud.lastUser()) {
  return T`<form class="stack" data-clform autocomplete="on">
      <div class="field"><label for="cl-u">اسم المستخدم</label><input id="cl-u" class="input" dir="ltr" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(user)}" required></div>
      <div class="field"><label for="cl-p">كلمة السر</label><input id="cl-p" class="input" dir="ltr" type="password" name="password" autocomplete="current-password" required></div>
      ${DESK_WEB ? T`<p class="hint">${icon('lock')} على الكمبيوتر لا يُحفظ شيء، وتخرج تلقائيًا بعد ساعة ونصف.</p>` : ''}
      ${err ? `<p class="field-error" role="alert">${esc(err)}</p>` : ''}
      <button type="submit" class="btn primary lg block" data-clgo>دخول</button>
      <button type="button" class="link-btn" data-cl-forgot>نسيت اسم المستخدم أو كلمة السر؟</button>
    </form>`;
}
// يربط نموذج الدخول داخل box ([data-cl]). onDone يُستدعى قبل بدء المزامنة (لإغلاق النافذة مثلًا).
function bindLoginForm(box, onDone = () => {}) {
  box.addEventListener('click', (e) => {
    const f = e.target.closest('[data-cl-forgot]');
    if (!f) return;
    f.outerHTML = T`<div class="alert info">${icon('info')}<div class="grow"><p style="margin:0"><b>اسم المستخدم:</b> مكتوب في جوالك في «الإعدادات ← الحساب والمزامنة»، ويتعبّى هنا تلقائيًا على الجهاز اللي دخلت منه قبل.<br><b>نسيت كلمة السر أو الاسم؟</b> كلّم مسؤول التطبيق: يرجّع حسابك بكلمة السر المبدئية، وتختار كلمة جديدة. درجاتك ما تضيع لأنها محفوظة في جوالك وترتفع من جديد.</p></div></div>`;
  });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (id) => (box.querySelector('#' + id) || {}).value || '';
    const user = q('cl-u'); const pass = q('cl-p');
    const fail = (m) => { box.querySelector('[data-cl]').innerHTML = loginFormHTML(m, user); };
    if (!cloud.USER_RE.test(cloud.normUser(user))) return fail(tr('اسم المستخدم: أحرف إنجليزية صغيرة وأرقام فقط (٣ أحرف على الأقل).'));
    const btn = box.querySelector('[data-clgo]');
    btn.disabled = true; btn.textContent = tr('جارٍ التحقق…');
    try {
      // الآيفون يتذكّر الدخول؛ الكمبيوتر جلسة مؤقتة في هذا التبويب فقط
      const r = await cloud.signIn({ user, password: pass, remember: !DESK_WEB });
      onDone();
      if (DESK_WEB) { location.reload(); return; } // نبدأ من ذاكرة فارغة بلا لمس بيانات هذا الجهاز
      await localStore.setMeta('cloudKey', r.key);
      toast(tr('تم الدخول ✓ — جارٍ مزامنة درجاتك'));
      await startCloud(r.session, r.key);
      render();
    } catch (err) {
      const code = err && err.code;
      fail(code === 'wrong' ? tr('اسم المستخدم أو كلمة السر غير صحيحة.') : code === 'locked' ? tr('محاولات كثيرة خاطئة — انتظر ١٠ دقائق ثم حاول.') : code === 'offline' ? tr('لا يوجد اتصال بالإنترنت.') : tr('تعذّر الدخول. حاول مرة ثانية.'));
    }
  });
}
function openCloudLogin(fromPc = false) {
  let done = false;
  const s = openSheet(T`<h2>${icon('lock')} تسجيل الدخول</h2><p class="hint">درجاتك تُشفَّر بكلمة سرك على جهازك قبل ما تطلع منه — ولا أحد غيرك يقدر يقرأها.</p><div data-cl>${loginFormHTML()}</div>`, {
    label: tr('تسجيل الدخول'),
    onClose: () => { if (fromPc && !done && !C.session) toPcHome(); },
  });
  bindLoginForm(s.sheet, () => { done = true; s.close(); });
}
// الآيفون: شاشة دخول إجبارية قبل استعمال التطبيق
function LoginGate() {
  return T`<div class="gate"><div class="gate-card card">
    <img class="gate-logo" src="icons/icon-192.png" alt="">
    <h1>متابعة الدرجات</h1>
    <p class="hint">سجّل دخولك بحسابك — درجاتك تُحفظ مشفّرة، وتظهر في الكمبيوتر تلقائيًا.</p>
    <div data-cl data-gate>${loginFormHTML()}</div>
  </div></div>`;
}

// ===================== صفوف المدرسة: يختار المعلم شعبه من القائمة الكاملة =====================
// المصدر: الخادم (للمسجّلين) أو ملف المدرسة (أندرويد). يُحفظ على الجهاز للاستعمال بلا إنترنت.
async function loadSchoolRoster() {
  if (!C.session) return null;
  const r = sanitizeRoster(await cloud.fetchRoster(C.session));
  if (!r) return null;
  S.meta.schoolRoster = r;
  await store.setMeta('schoolRoster', r).catch(() => {});
  if (route().name === 'school') softRender();
  return r;
}
// أندرويد: قوائم المدرسة مضمّنة داخل ملف التطبيق (school-roster.json) — لا تُنشر في الموقع
async function loadBundledRoster() {
  if (!platform.isNative) return;
  try {
    const res = await fetch('school-roster.json', { cache: 'no-store' });
    if (!res.ok) return;
    const raw = await res.json();
    const r = sanitizeRoster(raw);
    if (!r) return;
    r.at = Number(raw.at) || 1;
    const cur = S.meta.schoolRoster;
    if (cur && (Number(cur.at) || 0) >= r.at) return;
    S.meta.schoolRoster = r;
    await store.setMeta('schoolRoster', r).catch(() => {});
    if (route().name === 'school') softRender();
  } catch { /* بلا قوائم مضمّنة */ }
}
async function importSchoolFile() {
  const file = await platform.pickFile('.json,application/json');
  if (!file) return;
  let r = null;
  try { r = sanitizeRoster(JSON.parse(await file.text())); } catch { r = null; }
  if (!r) { toast(tr('هذا ليس ملف صفوف المدرسة.'), { err: true, ms: 5000 }); return; }
  r.at = Date.now();
  S.meta.schoolRoster = r;
  await store.setMeta('schoolRoster', r).catch(() => {});
  toast(T`تم ✓ ${ar(Object.values(r.grades).reduce((a, g) => a + Object.keys(g).length, 0))} شعبة`);
  render();
}
function School(p) {
  const r = S.meta.schoolRoster;
  const mine = new Set(S.classes.map((c) => c.label));
  const head = (title, back = true) => appbar({ title, backBtn: back });
  if (!r) {
    const how = platform.isNative || !CLOUD_ON
      ? T`<p>اطلب من مسؤول التطبيق «ملف صفوف المدرسة» (يصلك بالواتساب مثلًا)، ثم استورده هنا مرة واحدة.</p>
        <button type="button" class="btn primary lg block" data-act="school-import">${icon('upload')} استيراد ملف صفوف المدرسة</button>`
      : C.session ? T`<p>جارٍ جلب القوائم من حسابك… إن لم تظهر فالمسؤول لم يرفعها بعد.</p><button type="button" class="btn block" data-act="school-reload">${icon('refresh')} حاول مرة ثانية</button>`
        : T`<p>سجّل الدخول وتظهر لك قوائم صفوف المدرسة كاملة.</p><button type="button" class="btn primary lg block" data-act="cloud-login">${icon('user')} تسجيل الدخول</button>`;
    return T`${head(tr('صفوف المدرسة'))}<div class="wrap stack"><div class="empty card">${ART_USERS}<h2>قوائم المدرسة غير موجودة بعد</h2>${how}
      <button type="button" class="btn ghost block" data-act="new-class-manual">${icon('plus')} إضافة صف يدويًا</button></div></div>`;
  }
  const grades = sortedGrades(r);
  if (!p.grade || !r.grades[p.grade]) {
    // الخطوة ١: الصفوف الأربعة
    const tiles = grades.map((g) => {
      const secs = r.grades[g];
      const nSec = Object.keys(secs).length;
      const have = sortedSections(secs).filter((x) => mine.has(sectionLabel(g, x))).length;
      return T`<button type="button" class="card grade-tile" data-act="school-grade" data-g="${g}"><b>الصف ${gradeName(g)}</b><small>${ar(nSec)} شعبة</small>${have ? T`<span class="gt-mine">${icon('check')} ${ar(have)} عندك</span>` : ''}</button>`;
    }).join('');
    return T`${head(tr('صفوف المدرسة'))}<div class="wrap stack">
      <p class="hint">اختر الصف، ثم حدّد شعبك وتنضاف لصفحة «الصفوف» بأسماء طلابها.</p>
      <div class="grade-tiles">${tiles}</div>
      <button type="button" class="btn ghost block" data-act="new-class-manual">${icon('plus')} شعبة غير موجودة؟ أضفها يدويًا</button>
      ${platform.isNative || !CLOUD_ON ? T`<button type="button" class="link-btn" data-act="school-import">${icon('upload')} تحديث ملف صفوف المدرسة</button>` : ''}
    </div>`;
  }
  // الخطوة ٢: شعب الصف المختار
  const g = p.grade;
  p.pick ||= new Set();
  const rows = sortedSections(r.grades[g]).map((x) => {
    const lab = sectionLabel(g, x); const has = mine.has(lab); const on = has || p.pick.has(x);
    return T`<label class="list-item sec-row ${has ? 'mine' : ''}"><input type="checkbox" class="check" data-sec="${x}" ${on ? 'checked' : ''} ${has ? 'disabled' : ''}><span class="grow"><strong>الشعبة ${ar(x)}</strong><small>${students(r.grades[g][x].length)}${has ? T` · مضافة عندك` : ''}</small></span></label>`;
  }).join('');
  const n = p.pick.size;
  return T`${head(T`الصف ${gradeName(g)}`)}<div class="wrap stack school-secs">
    <p class="hint">حدّد الشعب اللي تدرّسها:</p>
    <div class="list">${rows}</div>
    <div class="sticky-save"><button type="button" class="btn primary lg block" data-act="school-save" ${n ? '' : 'disabled'}>${n ? T`حفظ ${ar(n)} شعبة في صفوفي` : tr('اختر شعبة أو أكثر')}</button></div>
  </div>`;
}
async function saveSchoolPick(p) {
  const r = S.meta.schoolRoster;
  if (!r || !p.grade || !p.pick || !p.pick.size) return;
  const mine = new Set(S.classes.map((c) => c.label));
  let added = 0;
  for (const x of sortedSections(r.grades[p.grade])) {
    if (!p.pick.has(x)) continue;
    const label = sectionLabel(p.grade, x);
    if (mine.has(label)) continue;
    const id = uid();
    S.classes.push({ id, label, names: r.grades[p.grade][x].slice(0, MAX_STUDENTS) });
    S.grades[id] = emptyClassData();
    await store.saveGrades(id, S.grades[id]);
    added++;
  }
  await saveClassesNow();
  toast(T`أُضيفت ${ar(added)} شعبة إلى صفوفك ✓`);
  S.stack = [{ name: 'home', p: {} }];
  render({ scrollTop: true });
}

// أول دخول (أو من الإعدادات): يختار المعلم اسم المستخدم وكلمة السر بنفسه
function openAccountSheet(first = false) {
  if (!C.sync || !C.session) return;
  const s = openSheet('<div data-ac></div>', { label: tr('اسم المستخدم وكلمة السر') });
  const paint = (err = '', vals = {}) => {
    s.sheet.querySelector('[data-ac]').innerHTML = T`<h2>${icon('user')} ${first ? tr('أهلًا! اختر اسمك وكلمة سرك') : tr('اسم المستخدم وكلمة السر')}</h2>
      <p class="hint">${first ? tr('دخلت بكلمة السر المبدئية. اختر الآن اسم مستخدم تتذكره وكلمة سر خاصة فيك — تستعملها في الجوال والكمبيوتر.') : tr('بعد التغيير تخرج الأجهزة الثانية، وتدخل فيها بالاسم وكلمة السر الجديدة.')}</p>
      <form class="stack" data-acform autocomplete="on">
        <div class="field"><label for="ac-u">اسم المستخدم (بالإنجليزي)</label><input id="ac-u" class="input" dir="ltr" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(vals.u ?? C.session.u)}" required><small class="hint">أحرف إنجليزية صغيرة وأرقام و . _ - مثل: ahmad أو t.sara</small></div>
        <div class="field"><label for="ac-p">كلمة السر الجديدة (٦ أحرف أو أرقام على الأقل)</label><input id="ac-p" class="input" dir="ltr" type="password" name="new-password" autocomplete="new-password" required></div>
        <div class="field"><label for="ac-p2">أعد كتابة كلمة السر</label><input id="ac-p2" class="input" dir="ltr" type="password" autocomplete="new-password" required></div>
        ${err ? `<p class="field-error" role="alert">${esc(err)}</p>` : ''}
        <button type="submit" class="btn primary lg block" data-acgo>حفظ</button>
      </form>`;
  };
  paint();
  s.sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (id) => (s.sheet.querySelector('#' + id) || {}).value || '';
    const u2 = cloud.normUser(q('ac-u')); const p1 = q('ac-p');
    if (!cloud.USER_RE.test(u2)) return paint(tr('اسم المستخدم: أحرف إنجليزية صغيرة وأرقام فقط (٣ أحرف على الأقل).'), { u: q('ac-u') });
    if (p1.length < 6) return paint(tr('كلمة السر قصيرة — ٦ أحرف أو أرقام على الأقل.'), { u: q('ac-u') });
    if (p1 !== q('ac-p2')) return paint(tr('كلمتا السر غير متطابقتين.'), { u: q('ac-u') });
    if (p1 === '12345678') return paint(tr('اختر كلمة سر غير الكلمة المبدئية.'), { u: q('ac-u') });
    const btn = s.sheet.querySelector('[data-acgo]');
    btn.disabled = true; btn.textContent = tr('جارٍ الحفظ والتشفير…');
    try {
      const r = await cloud.changeAccount(C.sync, { user2: u2, password: p1 });
      s.close();
      C.sync = null;
      if (r.session.eph) C.memMeta = null;
      else { await localStore.setMeta('cloudKey', r.key); await localStore.setMeta('cloudSync', null); }
      await startCloud(r.session, r.key);
      render();
      toast(T`تم ✓ اسم المستخدم: ${r.session.u}`, { ms: 6000 });
    } catch (err) {
      const code = err && err.code;
      paint(code === 'taken' ? tr('اسم المستخدم هذا مأخوذ — اختر اسمًا آخر.') : code === 'offline' ? tr('يحتاج اتصال بالإنترنت — حاول مرة ثانية.') : code === 'auth' ? tr('انتهت الجلسة — سجّل الدخول من جديد.') : tr('تعذّر الحفظ. حاول مرة ثانية.'), { u: q('ac-u') });
    }
  });
}

// إعادة رسم لا تقطع الكتابة
function softRender() {
  const a = document.activeElement;
  if (a && a.matches && a.matches('input, textarea, select') && main().contains(a)) { S.pendingRender = true; return; }
  render();
}
document.addEventListener('focusout', () => { if (S.pendingRender) { S.pendingRender = false; setTimeout(() => { if (!document.activeElement || !document.activeElement.matches('input, textarea, select')) render(); }, 50); } });

const CRIT = CONFIG.criteria.map((c) => ({ ...c, label: trCrit(c.label), short: trCrit(c.short) }));
const FINS = CONFIG.finals.map((f) => ({ ...f, label: trCrit(f.label), short: f.short ? trCrit(f.short) : f.short }));
const WIDE = window.matchMedia('(min-width: 900px)');
const ASIDE = window.matchMedia('(min-width: 1181px)'); // عرض بطاقة الطالب بجانب الجدول

// ===================== الحالة =====================
const S = {
  classes: [],
  settings: { ...CONFIG.defaultSettings },
  grades: {},
  meta: {},
  stack: [],          // [{name, p}]
  ui: { tab: {}, search: '', missingOnly: false, filter: 'all', fscope: 'week', selected: null, undo: null, sideHidden: deskPref('gfu-side') },
  saving: false,
  dirty: new Set(),
};

const cls = (id) => S.classes.find((c) => c.id === id);
const dataOf = (id) => (S.grades[id] ||= emptyClassData());
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const route = () => S.stack[S.stack.length - 1] || { name: 'home', p: {} };
const ROOTS = ['home', 'reports', 'live', 'tools', 'settings'];

function hasAnyGrades() {
  return S.classes.some((c) => progress(dataOf(c.id), c.names.length).filled > 0);
}
function studentHasGrades(data, idx) {
  for (let w = 1; w <= WEEKS; w++) if (getItems(data, w, idx).some((v) => v != null)) return true;
  return getFin(data, idx).some((v) => v != null);
}
const haptic = (t) => { if (S.settings.haptics) platform.haptic(t); };

// ===================== الحفظ =====================
let saveTimer = null;
// يسجّل أن هناك درجات/تعديلات لم تدخل في نسخة احتياطية بعد
function noteChange() {
  S.sessionChanged = true;
  if (!S.meta.changedSinceBackup) {
    S.meta.changedSinceBackup = new Date().toISOString();
    store.setMeta('changedSinceBackup', S.meta.changedSinceBackup).catch(() => {});
  }
}
function markDirty(classId) {
  noteChange();
  S.dirty.add(classId);
  setSaveState('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, CONFIG.saveDebounceMs);
  setTimeout(syncFilter, 0);
}
async function flushSave() {
  const ids = [...S.dirty];
  S.dirty.clear();
  try {
    for (const id of ids) if (cls(id)) await store.saveGrades(id, dataOf(id));
    setSaveState(S.dirty.size ? 'saving' : 'saved');
  } catch {
    setSaveState('error');
    toast(tr('تعذّر الحفظ. تأكد من وجود مساحة كافية على الجهاز.'), { err: true });
  }
}
function setSaveState(st) {
  S.saving = st;
  document.querySelectorAll('[data-save-state]').forEach((el) => paintSave(el));
}
function paintSave(el) {
  const st = S.saving;
  el.className = 'save-state' + (st === 'saved' ? ' ok' : '');
  el.innerHTML = st === 'saving' ? tr('جارٍ الحفظ…') : st === 'error' ? T`${icon('warn')} لم يُحفظ` : st === 'saved' ? T`${icon('check')} محفوظ` : '';
}
async function saveClassesNow() { noteChange(); await store.saveClasses(S.classes); autoPlans(); }

// ===== خطة توزيع المنهج: عنوان الدرس لكل أسبوع حسب الصف =====
// تملأ الأسابيع الفارغة فقط (أو كلها عند overwrite). ترجع عدد الأسابيع التي عُبّئت.
function fillLessons(c, overwrite = false) {
  const lessons = planFor(c.label);
  if (!lessons) return 0;
  const d = dataOf(c.id);
  let n = 0;
  lessons.forEach((text, i) => {
    const w = i + 1;
    if (w > WEEKS || !text) return;
    const cur = getWeekMeta(d, w).lesson;
    if (cur === text || (cur && !overwrite)) return;
    setWeekMeta(d, w, 'lesson', text);
    n++;
  });
  if (n) markDirty(c.id);
  return n;
}
// تلقائيًا: مرة واحدة لكل صف (الصفوف الجديدة أيضًا) — لا تعيد ما مسحه المعلم بنفسه
function autoPlans() {
  if (REMOTE || !S.booted) return 0;
  const done = new Set(Array.isArray(S.meta.planDone) ? S.meta.planDone : []);
  let n = 0; let changed = false;
  for (const c of S.classes) {
    if (done.has(c.id)) continue;
    done.add(c.id); changed = true;
    n += fillLessons(c, false);
  }
  if (changed) { S.meta.planDone = [...done]; store.setMeta('planDone', S.meta.planDone).catch(() => {}); }
  return n;
}
function openPlanSheet() {
  const rows = S.classes.map((c) => {
    const g = gradeOf(c.label);
    const ok = g && planFor(c.label);
    return `<div class="list-item"><span class="grow"><strong>${esc(c.label)}</strong><small>${ok ? `${tr('خطة الصف')} ${g}` : tr('لا توجد خطة لهذا الصف')}</small></span>${ok ? icon('check') : ''}</div>`;
  }).join('');
  const s = openSheet(T`<h2>عناوين الدروس من خطة المنهج</h2>
    <p>${esc(PLAN_NAME)} — الأسابيع ١ إلى ١٠. يُعرف الصف من اسمه (السادس، السابع، الثامن، التاسع).</p>
    <div class="list">${rows || `<p class="hint" style="padding:12px">${tr('لا توجد صفوف بعد')}</p>`}</div>
    <div class="actions" style="flex-direction:column">
      <button type="button" class="btn primary" data-pl="fill">تعبئة الأسابيع الفارغة</button>
      <button type="button" class="btn danger-ghost" data-pl="over">استبدال كل العناوين بالخطة</button>
    </div>`, { label: tr('خطة المنهج') });
  s.sheet.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pl]');
    if (!b) return;
    const over = b.dataset.pl === 'over';
    if (over && !(await confirmDialog({ title: tr('استبدال كل عناوين الدروس؟'), text: tr('ستُستبدل عناوين الأسابيع ١–١٠ بعناوين الخطة في كل الصفوف التي لها خطة، حتى التي كتبتها بنفسك.'), ok: tr('استبدال') }))) return;
    let n = 0;
    for (const c of S.classes) n += fillLessons(c, over);
    s.close();
    softRender();
    toast(n ? T`عُبّئ عنوان الدرس في ${ar(n)} أسبوع` : tr('كل العناوين معبّأة من قبل'));
  });
}
async function saveSettingsNow() { await store.saveSettings(S.settings); }
window.addEventListener('pagehide', () => { if (S.dirty.size) flushSave(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.dirty.size) flushSave(); });

// ===================== المظهر =====================
function applyTheme() {
  const r = document.documentElement;
  if (S.settings.theme === 'auto') delete r.dataset.theme; else r.dataset.theme = S.settings.theme;
  if (S.settings.textScale === 'large') r.dataset.text = 'large'; else delete r.dataset.text;
}

// ===================== التنقل =====================
function go(name, p = {}, { replace = false } = {}) {
  if (ROOTS.includes(name)) {
    S.stack = [{ name, p }];
    history.replaceState({ depth: 1 }, '');
  } else if (replace && S.stack.length > 1) {
    S.stack[S.stack.length - 1] = { name, p };
    history.replaceState({ depth: S.stack.length }, '');
  } else {
    S.stack.push({ name, p });
    history.pushState({ depth: S.stack.length }, '');
  }
  S.ui.search = '';
  render({ scrollTop: true });
}
function back() {
  if (S.stack.length > 1) { history.back(); return true; }
  return false;
}
window.addEventListener('popstate', () => {
  if (hasSheet()) closeTopSheet();
  if (S.stack.length > 1) {
    const leaving = route();
    if (leaving.name === 'editor' && leaving.p.dirty && !leaving.p.confirmedLeave) {
      // نمنع فقدان التعديلات: نرجع الحالة ونسأل
      history.pushState({ depth: S.stack.length }, '');
      confirmDialog({ title: tr('تجاهل التعديلات؟'), text: tr('لم تحفظ التغييرات على الصف.'), ok: tr('تجاهل'), danger: true }).then((yes) => {
        if (yes) { leaving.p.confirmedLeave = true; history.back(); }
      });
      return;
    }
    S.stack.pop();
    S.ui.search = '';
    render({ scrollTop: true });
    if (leaving.name === 'class' && S.sessionChanged && S.meta.changedSinceBackup) {
      S.sessionChanged = false;
      toast(tr('الدرجات محفوظة على الجهاز. احفظ نسخة احتياطية؟'), { ms: 7000, action: { label: tr('احفظ نسخة'), fn: doBackup } });
    }
  }
});
platform.onBack(() => {
  if (closeTopSheet()) return true;
  return back();
});

// ===================== الرسم =====================
const main = () => document.getElementById('main');

function render({ scrollTop = false } = {}) {
  const r = route();
  if (IOS_WEB && !C.session && r.name !== 'guide') {
    main().className = 'main no-tabbar gate-main';
    document.body.classList.add('no-tabbar');
    document.getElementById('tabbar').classList.add('hide');
    main().innerHTML = LoginGate();
    bindLoginForm(main().querySelector('.gate-card'));
    renderNav();
    return;
  }
  const screens = { school: School, schedule: Schedule, home: Home, reports: Reports, tools: Tools, class: ClassScreen, student: StudentScreen, editor: Editor, settings: Settings, live: Live, transferOut: TransferOut, transferIn: TransferIn, guide: Guide };
  const fn = screens[r.name] || Home;
  const isRoot = ROOTS.includes(r.name);
  main().className = 'main' + (isRoot ? '' : ' no-tabbar') + (r.name === 'class' && WIDE.matches && cls(r.p.id) && cls(r.p.id).names.length ? ' desk-class' : '');
  document.body.classList.toggle('no-tabbar', !isRoot);
  document.getElementById('tabbar').classList.toggle('hide', !isRoot);
  main().innerHTML = shareBarHTML() + `<div class="screen-enter">${fn(r.p)}</div>`;
  renderNav();
  main().querySelectorAll('[data-save-state]').forEach(paintSave);
  if (scrollTop) window.scrollTo(0, 0);
  const after = afterRender[r.name];
  if (after) after(r.p);
}
const afterRender = {};

function shareBarHTML() {
  if (REMOTE || route().name === 'live' || !['connected', 'resuming', 'lost'].includes(L.phase)) return '';
  const txt = L.phase === 'connected' ? tr('الكمبيوتر متصل') : L.phase === 'resuming' ? tr('جارٍ إعادة الاتصال بالكمبيوتر…') : tr('انقطع الاتصال بالكمبيوتر');
  return T`<div class="share-bar ${L.phase}" data-share-bar><span class="dot"></span><button type="button" class="share-txt" data-act="nav" data-to="live">${txt}</button><button type="button" class="share-stop" data-act="live-stop-quick">إيقاف المشاركة</button></div>`;
}
function renderShareBar() {
  const bar = document.querySelector('[data-share-bar]');
  const html = shareBarHTML();
  if (bar) { if (html) bar.outerHTML = html; else bar.remove(); }
  else if (html) main().insertAdjacentHTML('afterbegin', html);
}

// تفضيلات شكل سطح المكتب (إخفاء القائمة/لوحة الأدوات) — لهذا المتصفح فقط
function deskPref(k) { try { return localStorage.getItem(k) === '1'; } catch { return false; } }
function setDeskPref(k, on) { try { localStorage.setItem(k, on ? '1' : '0'); } catch { /* */ } }

function renderNav() {
  const cur = ROOTS.includes(route().name) ? route().name : (S.stack[0] || {}).name;
  const items = [['home', 'users', tr('الصفوف')], ['reports', 'sheet', tr('التقارير')], ['live', 'monitor', REMOTE ? tr('عرض للطلاب') : IOS_WEB ? tr('الكمبيوتر') : tr('العرض')], ['tools', 'bolt', tr('الإدارة')], ['settings', 'gear', tr('الإعدادات')]];
  const btns = items.filter(([n]) => !(DESK_WEB && WIDE.matches && n === 'live')).map(([n, ic, label]) => `<button type="button" class="tab" data-act="nav" data-to="${n}" ${cur === n ? 'aria-current="page"' : ''} title="${esc(label)}"><span class="tab-ico">${icon(ic)}</span><span class="tab-label">${label}</span></button>`).join('');
  document.getElementById('tabbar').innerHTML = btns;
  const mini = deskPref('gfu-rail');
  document.body.classList.toggle('rail-mini', mini);
  // الترتيب: الشعار (وزر إخفاء صغير) ← التنقل (+ لوحة الأدوات في شاشة الصف) ← تحت: حالة الحفظ والحساب ثم رقم الإصدار
  const onClass = route().name === 'class' && WIDE.matches;
  const sideBtn = onClass ? T`<button type="button" class="tab rail-side" data-act="side-toggle" aria-pressed="${!S.ui.sideHidden}" title="${S.ui.sideHidden ? tr('إظهار لوحة الأدوات') : tr('إخفاء لوحة الأدوات')}"><span class="tab-ico">${icon('sidebar')}</span><span class="tab-label">لوحة الأدوات</span></button>` : '';
  document.body.classList.toggle('cloud-desk', !!(DESK_WEB && C.session));
  const user = C.session ? esc(C.session.u) : '';
  const acct = !CLOUD_ON ? '' : C.session
    ? T`<div class="rail-account">
        <div class="ra-sync s-${C.state}" data-ra-sync>${raSyncHTML()}</div>
        <div class="ra-row">
          <button type="button" class="ra-user" data-act="nav" data-to="settings" title="${user}"><span class="ra-avatar">${icon('user')}</span><span class="tab-label" dir="ltr">${user}</span></button>
          ${DESK_WEB ? T`<button type="button" class="ra-logout" data-act="cloud-logout" title="${tr('تسجيل الخروج')}" aria-label="${tr('تسجيل الخروج')}">${icon('logout')}</button>` : ''}
        </div>
      </div>`
    : T`<button type="button" class="tab rail-acct login" data-act="cloud-login" title="${tr('تسجيل الدخول')}"><span class="tab-ico">${icon('user')}</span><span class="tab-label">تسجيل الدخول</span></button>`;
  const foot = REMOTE ? T`<span class="remote-note">${icon('phone')} <span><b>متصل بجوالك</b> — كل التعديلات تُحفظ في جوالك</span></span>`
    : platform.isNative ? T`الإصدار ${ar(CONFIG.version)}` : T`<button type="button" class="ver-check" data-act="update-check" title="${tr('ابحث عن تحديث')}">${icon('refresh')} الإصدار ${ar(CONFIG.version)} · تحديث</button>`;
  document.getElementById('rail').innerHTML = T`<div class="brand"><img src="icons/icon-192.png" alt=""><span>${esc(tr(CONFIG.appName))}</span>
      <button type="button" class="rail-toggle" data-act="rail-toggle" aria-expanded="${!mini}" title="${mini ? tr('إظهار القائمة') : tr('إخفاء القائمة')}" aria-label="${mini ? tr('إظهار القائمة') : tr('إخفاء القائمة')}">${icon(mini ? 'menu' : 'sidebar')}</button></div>
    <nav class="rail-nav">${btns}${sideBtn}</nav>
    <div class="rail-bottom">${acct}<div class="rail-foot">${foot}</div></div>`;
}

function appbar({ title, sub = '', backBtn = true, actions = '', save = false }) {
  const timer = DESK_WEB && C.session ? T`<span class="hdr-timer" title="${tr('تخرج تلقائيًا من حسابك بعد ساعة ونصف من الدخول')}"><span>خروج تلقائي</span><b class="num" data-cloud-timer dir="ltr">${fmtLeft(cloudLeftMs())}</b></span>` : '';
  actions = actions + timer;
  return `<header class="appbar"><div class="appbar-row">
    ${backBtn ? T`<button type="button" class="icon-btn" data-act="back" aria-label="رجوع">${icon('back')}</button>` : ''}
    <h1>${esc(title)}${sub ? `<span class="sub">${sub}</span>` : ''}</h1>
    ${save ? '<span data-save-state></span>' : ''}
    ${actions}
  </div></header>`;
}

window.addEventListener('scroll', () => {
  const bar = document.querySelector('.appbar');
  if (bar) bar.classList.toggle('scrolled', window.scrollY > 4);
}, { passive: true });

// ===================== رسوم الحالات الفارغة =====================
const ART_EMPTY = `<svg class="art" viewBox="0 0 200 150" aria-hidden="true">
  <rect x="38" y="20" width="124" height="110" rx="14" fill="var(--primary-soft)"/>
  <rect x="56" y="38" width="88" height="10" rx="5" fill="var(--primary)" opacity=".85"/>
  <rect x="56" y="60" width="70" height="8" rx="4" fill="var(--border)"/>
  <rect x="56" y="78" width="80" height="8" rx="4" fill="var(--border)"/>
  <rect x="56" y="96" width="56" height="8" rx="4" fill="var(--border)"/>
  <circle cx="150" cy="112" r="22" fill="var(--success)"/>
  <path d="M140 112l7 7 13-14" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const ART_USERS = `<svg class="art" viewBox="0 0 200 150" aria-hidden="true">
  <circle cx="100" cy="58" r="26" fill="var(--primary-soft)"/><circle cx="100" cy="52" r="12" fill="var(--primary)"/>
  <path d="M78 78c4-12 40-12 44 0" fill="var(--primary)"/>
  <circle cx="52" cy="80" r="18" fill="var(--chip)"/><circle cx="148" cy="80" r="18" fill="var(--chip)"/>
  <rect x="40" y="112" width="120" height="12" rx="6" fill="var(--border)"/>
</svg>`;

// =====================================================================
// الشاشة ١ — الرئيسية
// =====================================================================
function Home() {
  const st = S.settings;
  const alerts = [];
  if (!REMOTE && platform.isIOS && !platform.isStandalone) {
    alerts.push(T`<div class="alert warn">${icon('warn')}<div class="grow"><strong>ثبّت التطبيق على الشاشة الرئيسية</strong><p>في وضع المتصفح قد يمسح آيفون البيانات. أضِفه للشاشة الرئيسية لحماية أفضل.</p><button type="button" class="btn sm soft" data-act="go" data-to="guide">اعرض الطريقة</button></div></div>`);
  }
  if (platform.isNative && (!st.teacher || !st.subject)) { // أندرويد فقط — الآيفون والكمبيوتر لا يُسألان
    alerts.push(T`<div class="alert info">${icon('info')}<div class="grow"><strong>أضف اسمك والمادة</strong><p>تظهر في كشف الإكسل وبطاقة الطالب.</p><button type="button" class="btn sm soft" data-act="nav" data-to="settings">إضافة الآن</button></div></div>`);
  }
  const last = S.meta.lastBackupAt ? new Date(S.meta.lastBackupAt) : null;
  const days = last ? (Date.now() - last.getTime()) / 86400000 : Infinity;
  const pending = !!S.meta.changedSinceBackup && hasAnyGrades();
  if (REMOTE) { /* النسخ الاحتياطي من الجوال */ } else if (hasAnyGrades() && days > CONFIG.backupReminderDays) {
    alerts.push(T`<div class="alert warn" data-testid="backup-reminder">${icon('shield')}<div class="grow"><strong>احفظ نسخة احتياطية</strong><p>${last ? T`آخر نسخة قبل ${ar(Math.floor(days))} يومًا.` : tr('لم تحفظ أي نسخة بعد.')} احفظها في «الملفات» أو أرسلها لنفسك.</p><button type="button" class="btn sm soft" data-act="backup">احفظ نسخة الآن</button></div></div>`);
  } else if (pending) {
    alerts.push(T`<div class="alert info" data-testid="backup-nudge">${icon('shield')}<div class="grow"><strong>عندك درجات جديدة بدون نسخة احتياطية</strong><p>ضغطة واحدة تحفظها في iCloud Drive أو ترسلها لنفسك، فلا تضيع لو ضاع الجوال.</p><button type="button" class="btn sm soft" data-act="backup">${icon('download')} احفظ نسخة الآن</button></div></div>`);
  }

  const backupOk = last && !pending && hasAnyGrades()
    ? T`<p class="hint" data-testid="backup-ok" style="color:var(--success);font-weight:700">${icon('checkCircle')} نسختك الاحتياطية محدّثة (${days < 1 ? tr('اليوم') : T`قبل ${ar(Math.floor(days))} يوم`})</p>` : '';
  const helloTitle = st.teacher ? T`أهلًا أ. ${st.teacher}` : tr('أهلًا بك');
  const helloSub = `${st.subject ? esc(st.subject) + ' · ' : ''}${S.classes.length === 1 ? tr('صف واحد') : S.classes.length === 2 ? tr('صفّان') : S.classes.length ? T`${ar(S.classes.length)} صفوف` : tr('لنبدأ')}`;
  const loginBtn = CLOUD_ON && !C.session && !WIDE.matches ? T`<button type="button" class="btn sm soft" data-act="cloud-login">${icon('user')} دخول</button>` : '';
  const addBtn = loginBtn + (WIDE.matches ? '' : cloudChip()); // «أضف صف» صارت بطاقة بين الصفوف
  if (C.loading) {
    return T`${appbar({ title: helloTitle, sub: '', backBtn: false })}<div class="wrap"><div class="live-wait card"><span class="spinner-lg" aria-hidden="true"></span><h3>جارٍ تحميل درجاتك من حسابك…</h3></div></div>`;
  }
  if (CLOUD_ON && !C.session && !S.classes.length) {
    alerts.push(T`<div class="alert info cloud-invite">${icon('cloud')}<div class="grow"><strong>عندك حساب؟</strong><p>سجّل الدخول وتظهر صفوفك ودرجاتك هنا، وأي تعديل يوصل لجوالك تلقائيًا.</p><button type="button" class="btn sm primary" data-act="cloud-login">${icon('user')} تسجيل الدخول</button></div></div>`);
  }

  let body;
  if (!S.classes.length) {
    body = T`<div class="empty card">${ART_EMPTY}<h2>ابدأ بثلاث خطوات</h2>
      <ol class="steps">
        <li><span class="n">${ar(1)}</span><span>أضف صفًا (مثل «العاشر / 3»)</span></li>
        <li><span class="n">${ar(2)}</span><span>الصق أسماء الطلاب أو استوردها من Excel أو PDF</span></li>
        <li><span class="n">${ar(3)}</span><span>ارصد الدرجات ثم صدّر الكشف</span></li>
      </ol>
      <button type="button" class="btn primary lg block" data-act="new-class">${icon('plus')} أضف صفك</button>
      <p class="hint" style="margin-top:12px">لديك نسخة احتياطية؟ <button type="button" class="btn ghost sm" data-act="restore">استرجاع نسخة</button></p></div>`;
  } else {
    body = `<div class="home-grid stack">${S.classes.map(classCard).join('')}${REMOTE && false ? '' : T`<button type="button" class="card add-card" data-act="new-class">${icon('plus')}<span>أضف صفًا</span></button>`}</div>`;
  }

  return T`${appbar({ title: helloTitle, sub: helloSub, backBtn: false, save: true, actions: addBtn })}
  <div class="wrap stack home-wrap">
    ${backupOk}
    ${alerts.join('')}
    ${body}
    <p class="hint version-line num" data-testid="app-version">${platform.isNative || REMOTE ? T`الإصدار ${ar(CONFIG.version)}` : T`<button type="button" class="ver-check" data-act="update-check">${icon('refresh')} الإصدار ${ar(CONFIG.version)} · ابحث عن تحديث</button>`}</p>
  </div>`;
}

// =====================================================================
// تبويب «الأدوات»: إنشاء الصفوف من ملف، النقل والتسليم، النسخ الاحتياطي
// =====================================================================
// ===================== جدول الحصص والتذكير =====================
function remindMinutes() { const n = Number(S.settings.remindBefore); return REMIND_CHOICES.includes(n) ? n : 10; }
function scheduleList() { return sanitizeSchedule(S.settings.schedule).filter((s) => cls(s.classId)); }

function Schedule() {
  const list = scheduleList();
  const mins = remindMinutes();
  const on = S.settings.remindersOn !== false;
  const st = S.ui.remState;
  let status = '';
  if (platform.isNative) {
    if (!on) status = T`<p class="hint">${icon('bell')} التذكير متوقف.</p>`;
    else if (st && st.reason === 'denied') status = T`<div class="alert warn">${icon('warn')}<div class="grow"><strong>الإشعارات غير مسموحة</strong><p>اسمح للتطبيق بالإشعارات من إعدادات الجوال حتى يصلك التنبيه.</p><button type="button" class="btn sm soft" data-act="rem-retry">حاول مرة ثانية</button></div></div>`;
    else if (st && st.ok && st.count) status = T`<p class="hint rem-ok">${icon('checkCircle')} مفعّل — يصلك تنبيه قبل كل حصة بـ ${minutesText(mins)}</p>`;
  }
  // الحصة القادمة
  let next = null;
  for (const s of list) { const at = nextOccurrence(s.day, s.time); if (!next || at < next.at) next = { s, at }; }
  const nextHTML = next ? T`<div class="next-lesson"><small>الحصة القادمة</small><strong>${esc(cls(next.s.classId).label)}</strong><span>${tr(DAYS[next.s.day])} · ${ar(next.s.time)}${next.s.period ? T` · الحصة ${ar(next.s.period)}` : ''}</span></div>` : '';
  // الحصص حسب اليوم
  const days = [...new Set(list.map((s) => s.day))].sort((a, b) => ((a + 7) % 7) - ((b + 7) % 7));
  const groups = days.map((d) => T`<div class="section-title">${tr(DAYS[d])}</div><div class="list">${list.filter((s) => s.day === d).map((s) => T`<div class="list-item slot"><span class="slot-time num">${ar(s.time)}</span><span class="grow"><strong>${esc(cls(s.classId).label)}</strong>${s.period ? T`<small>الحصة ${ar(s.period)}</small>` : ''}</span><button type="button" class="icon-btn" data-act="slot-del" data-sid="${s.id}" aria-label="حذف الحصة">${icon('trash')}</button></div>`).join('')}</div>`).join('');
  const minSeg = `<div class="seg" role="group" aria-label="${tr('قبل الحصة بـ')}">${REMIND_CHOICES.map((n) => `<button type="button" data-act="remind-min" data-v="${n}" aria-pressed="${n === mins}">${minutesText(n)}</button>`).join('')}</div>`;
  const icsBtn = list.length ? T`<button type="button" class="btn ${platform.isNative ? '' : 'primary'} block" data-act="slot-ics">${icon('calendar')} أضف الجدول لتقويم الجوال</button>` : '';
  return T`${appbar({ title: tr('جدول الحصص والتذكير') })}
  <div class="wrap stack">
    ${!S.classes.length ? T`<div class="empty card"><h2>أضف صفًا أولًا</h2><p>بعدها تقدر تضيف أوقات حصصه هنا.</p><button type="button" class="btn primary" data-act="new-class">${icon('plus')} إضافة صف</button></div>` : T`
    <div class="card stack">
      ${platform.isNative ? T`<label class="list-item" style="padding:0;min-height:48px"><span class="grow"><strong>تذكير قبل الحصة</strong><small>إشعار على الجوال حتى لو التطبيق مغلق</small></span><input type="checkbox" class="switch" data-setting-bool="remindersOn" ${on ? 'checked' : ''}></label>` : T`<div class="alert info">${icon('info')}<div class="grow"><strong>التنبيه عن طريق تقويم الجوال</strong><p style="margin:0">بعد إضافة حصصك اضغط «أضف الجدول لتقويم الجوال» ثم «إضافة الكل» — يصلك تنبيه قبل كل حصة كل أسبوع، حتى بدون إنترنت.</p></div></div>`}
      <div class="field"><span class="label">التنبيه قبل الحصة بـ</span>${minSeg}</div>
      ${status}
    </div>
    ${nextHTML}
    ${list.length ? groups : T`<p class="hint" style="text-align:center;padding:12px 0">لا توجد حصص بعد. أضف أوقات حصص صفوفك ليصلك تنبيه قبل كل حصة.</p>`}
    <button type="button" class="btn primary lg block" data-act="slot-add">${icon('plus')} إضافة حصة</button>
    ${icsBtn}
    <p class="hint">${icon('shield')} الجدول والتنبيهات على جهازك فقط — لا شيء يُرسل لأي مكان.</p>`}
  </div>`;
}

// نافذة إضافة حصة: الصف، اليوم، الوقت، رقم الحصة (اختياري)
function openSlotSheet() {
  const last = scheduleList().slice(-1)[0];
  const d = { classId: (S.classes[0] || {}).id, day: last ? last.day : 0, time: last ? last.time : '07:30', period: '' };
  const days = [...SCHOOL_DAYS, 5, 6];
  const paint = () => T`<h2>إضافة حصة</h2>
    <div class="field"><label for="sl-class">الصف</label><select id="sl-class" class="select" data-sl="classId">${S.classes.map((c) => `<option value="${c.id}" ${c.id === d.classId ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
    <div class="field" style="margin-top:12px"><span class="label">اليوم</span><div class="day-grid">${days.map((x) => `<button type="button" class="day-btn ${SCHOOL_DAYS.includes(x) ? '' : 'weekend'}" data-sl-day="${x}" aria-pressed="${x === d.day}">${tr(DAYS[x])}</button>`).join('')}</div></div>
    <div class="row" style="gap:12px;margin-top:12px;align-items:flex-end">
      <div class="field grow"><label for="sl-time">وقت بداية الحصة</label><input id="sl-time" class="input" type="time" data-sl="time" value="${d.time}" required></div>
      <div class="field grow"><label for="sl-period">رقم الحصة</label><select id="sl-period" class="select" data-sl="period"><option value="">—</option>${Array.from({ length: 8 }, (_, i) => `<option value="${i + 1}" ${String(i + 1) === String(d.period) ? 'selected' : ''}>${ar(i + 1)}</option>`).join('')}</select></div>
    </div>
    <div class="actions"><button type="button" class="btn" data-sl-act="cancel">إلغاء</button><button type="button" class="btn primary" data-sl-act="save">حفظ الحصة</button></div>`;
  const s = openSheet('<div data-sl-body></div>', { label: tr('إضافة حصة') });
  const body = s.sheet.querySelector('[data-sl-body]');
  const draw = () => { body.innerHTML = paint(); };
  draw();
  s.sheet.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.sl; if (k) d[k] = e.target.value; });
  s.sheet.addEventListener('input', (e) => { const k = e.target.dataset && e.target.dataset.sl; if (k) d[k] = e.target.value; });
  s.sheet.addEventListener('click', async (e) => {
    const day = e.target.closest('[data-sl-day]');
    if (day) { d.day = Number(day.dataset.slDay); body.querySelectorAll('[data-sl-day]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.slDay) === d.day))); return; }
    const b = e.target.closest('[data-sl-act]');
    if (!b) return;
    if (b.dataset.slAct === 'cancel') return s.close();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(d.time || '')) { toast(tr('اختر وقت الحصة'), { err: true }); return; }
    const list = sanitizeSchedule(S.settings.schedule);
    if (list.some((x) => x.classId === d.classId && x.day === d.day && x.time === d.time)) { toast(tr('هذه الحصة مضافة من قبل'), { err: true }); return; }
    list.push({ id: 'r' + Math.random().toString(36).slice(2, 9), classId: d.classId, day: d.day, time: d.time, period: d.period ? Number(d.period) : null });
    S.settings.schedule = sortSchedule(list);
    await saveSettingsNow();
    s.close();
    toast(tr('أُضيفت الحصة ✓'));
    await syncReminders();
    render();
  });
}

// أندرويد: يعيد جدولة الإشعارات حسب الجدول الحالي
async function syncReminders() {
  if (!platform.isNative || REMOTE) return null;
  const r = await syncNativeReminders(platform.plugin('LocalNotifications'), {
    schedule: scheduleList(), classes: S.classes, minutesBefore: remindMinutes(), enabled: S.settings.remindersOn !== false,
  });
  S.ui.remState = r;
  return r;
}

// ملف التقويم (آيفون/المتصفح، وأندرويد كخيار إضافي)
async function exportScheduleICS() {
  const text = buildICS(scheduleList(), S.classes, remindMinutes());
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const name = tr('جدول-الحصص') + '.ics';
  if (platform.isIOS && !platform.isNative) {
    // آيفون: فتح الملف يعرض «إضافة الكل» لتقويم الجوال
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  await platform.saveFile(name, blob, 'text/calendar');
}

function Tools() {
  const item = (act, ic, t, sub, extra = '') => `<button type="button" class="list-item" data-act="${act}" ${extra}>${icon(ic)}<span class="grow"><strong>${t}</strong><small>${sub}</small></span>${icon('fwd')}</button>`;
  const has = S.classes.length > 0;
  return T`${appbar({ title: tr('الإدارة'), backBtn: false })}
  <div class="wrap stack">
    <div class="section-title">الصفوف</div>
    <div class="list">
      ${item('new-class', 'plus', tr('إضافة صف'), tr('بإدخال الأسماء أو لصقها'))}
      ${item('import-classes', 'upload', tr('إنشاء صفوف من ملف'), tr('كشف Excel أو PDF فيه صف أو أكثر — حتى الممسوح ضوئيًا'))}
    </div>
    ${REMOTE || !S.classes.length ? '' : T`<div class="section-title">خطة المنهج</div>
    <div class="list">
      ${item('plan-sheet', 'calendar', tr('عناوين الدروس من خطة المنهج'), tr('تعبئة عنوان كل أسبوع (١–١٠) حسب الصف'))}
    </div>`}
    ${REMOTE ? '' : T`<div class="section-title">الحصص</div>
    <div class="list">
      ${item('go', 'bell', tr('جدول الحصص والتذكير'), platform.isNative ? tr('تنبيه قبل كل حصة بالوقت الذي تختاره') : tr('أضف حصصك لتقويم الجوال مع تنبيه قبل كل حصة'), 'data-to="schedule"')}
    </div>`}
    <div class="section-title">النقل بين المعلمين</div>
    <div class="list">
      ${has ? item('handover-pick', 'send', tr('تسليم صف كامل لمعلم آخر'), tr('كل الطلاب مع الدرجات والغياب والملاحظات في ملف واحد')) : ''}
      ${has ? item('transfer-pick', 'move', tr('نقل طلاب'), tr('طالب أو أكثر لمعلم آخر أو لصف آخر عندك')) : ''}
      ${has && !REMOTE ? item('delete-pick', 'trash', tr('حذف صف'), tr('اختر الصف — يُحذف مع درجاته، وتقدر تتراجع بعدها')) : ''}
      ${item('go', 'inbox', tr('استقبال صف أو طلاب'), tr('من ملف أرسله معلم آخر'), 'data-to="transferIn"')}
    </div>
    ${REMOTE ? T`<p class="hint">${icon('shield')} النسخ الاحتياطي والاسترجاع وحذف البيانات تتم من الجوال (البيانات محفوظة فيه).</p>` : T`<div class="section-title">النسخ الاحتياطي</div>
    <div class="list">
      <div class="list-item"><span class="grow"><strong>آخر نسخة احتياطية</strong><small class="num">${S.meta.lastBackupAt ? ar(new Date(S.meta.lastBackupAt).toLocaleDateString('en-GB')) : tr('لم تُحفظ بعد')}</small></span>${S.meta.persist === 'granted' ? T`<span class="status-pill ok">${icon('shield')} التخزين محمي</span>` : ''}</div>
      ${item('backup', 'download', tr('حفظ نسخة احتياطية'), tr('كل الصفوف والدرجات في ملف — على الجوال وفي iCloud'))}
      ${item('restore', 'upload', tr('استرجاع نسخة'), tr('من ملف نسخة احتياطية سابق (يستبدل البيانات الحالية)'))}
    </div>`}
    ${REMOTE ? '' : T`<div class="section-title">منطقة الخطر</div>
    <div class="list">
      <button type="button" class="list-item" data-act="wipe">${icon('trash')}<span class="grow"><strong style="color:var(--error)">حذف كل البيانات</strong><small>كل الصفوف والدرجات من هذا الجهاز — احفظ نسخة أولًا</small></span></button>
    </div>`}
  </div>`;
}

// اختيار صف (لتسليمها أو نقل طلاب منها)
function pickClass(title) {
  return new Promise((resolve) => {
    let res = null;
    const s = openSheet(T`<h2>${esc(title)}</h2><div class="list">${S.classes.map((c) => `<button type="button" class="list-item" data-pc="${c.id}">${icon('users')}<span class="grow"><strong>${esc(c.label)}</strong><small>${students(c.names.length)}</small></span>${icon('fwd')}</button>`).join('')}</div>
      <div class="actions"><button type="button" class="btn" data-pc="">إلغاء</button></div>`, { label: title, onClose: () => resolve(res) });
    s.sheet.addEventListener('click', (e) => { const b = e.target.closest('[data-pc]'); if (!b) return; res = b.dataset.pc ? cls(b.dataset.pc) : null; s.close(); });
  });
}

// =====================================================================
// تبويب «التقارير»: كشوف PDF للطباعة وكشف Excel
// =====================================================================
function Reports() {
  if (!S.classes.length) {
    return T`${appbar({ title: tr('التقارير'), backBtn: false })}<div class="wrap"><div class="empty card">${ART_EMPTY}<h2>لا توجد صفوف بعد</h2><p>أضف صفًا وارصد الدرجات، ثم اطبع كشوفه من هنا.</p><button type="button" class="btn primary" data-act="new-class">${icon('plus')} إضافة صف</button></div></div>`;
  }
  if (!S.ui.reportClass || !cls(S.ui.reportClass)) S.ui.reportClass = S.classes[0].id;
  const c = cls(S.ui.reportClass);
  const d = dataOf(c.id);
  const n = c.names.length;
  const pr = progress(d, n);
  const card = (act, ic, t, sub) => `<button type="button" class="report-card" data-act="${act}" data-id="${c.id}">${icon(ic)}<span><strong>${t}</strong><small>${sub}</small></span></button>`;
  return T`${appbar({ title: tr('التقارير'), backBtn: false })}
  <div class="wrap stack">
    <button type="button" class="pick-btn" data-act="report-class-pick" aria-haspopup="dialog"><span class="pick-ico">${icon('users')}</span><span class="grow"><small>الصف</small><strong>${esc(c.label)}</strong><span class="pick-meta">${students(n)} · رصد ${ar(Math.round(pr.ratio * 100))}%</span></span><span class="pick-chev" aria-hidden="true">تغيير</span></button>
    <p class="hint">التقارير تُطبع أو تُحفظ PDF من نافذة الطباعة.</p>
    <div class="report-grid">
      ${card('report-grades', 'sheet', tr('كشف الدرجات'), tr('الأسابيع والفترتان والنهائي — PDF منسّق للطباعة'))}
      ${card('report-attendance', 'calendar', tr('كشف الحضور والغياب'), tr('غياب كل طالب في كل أسبوع — PDF'))}
      ${card('export-xlsx', 'download', tr('كشف Excel الرسمي'), tr('ملف xlsx بأوراق المتابعة والطباعة والرصد'))}
      ${card('report-student', 'users', tr('تقرير طالب'), tr('درجات طالب واحد مع ملاحظاته — PDF'))}
    </div>
  </div>`;
}

// اختيار صف من نافذة سفلية بنفس هوية التطبيق (بدل القائمة المنسدلة)
function pickClassSheet(current, done) {
  const items = S.classes.map((o) => {
    const p = Math.round(progress(dataOf(o.id), o.names.length).ratio * 100);
    return T`<button type="button" role="radio" class="cp" aria-checked="${o.id === current}" data-pick="${o.id}"><span class="cp-dot" aria-hidden="true"></span><span class="grow"><strong>${esc(o.label)}</strong><small>${students(o.names.length)} · رصد ${ar(p)}%</small></span></button>`;
  }).join('');
  const s = openSheet(T`<h2>اختر الصف</h2><div class="class-pick" role="radiogroup" aria-label="الصفوف">${items}</div>`, { label: tr('اختر الصف') });
  s.sheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    s.close();
    done(b.dataset.pick);
  });
}

function classCard(c) {
  const n = c.names.length;
  const d = dataOf(c.id);
  const pr = progress(d, n);
  const pct = Math.round(pr.ratio * 100);
  const fw = n ? firstIncompleteWeek(d, n) : null;
  const where = fw == null ? '' : fw === 'fin' ? (finalsRemaining(d, n) ? tr('الدرجات النهائية') : tr('اكتمل كل شيء ✓')) : T`الأسبوع ${ar(fw)}`;
  // البطاقة كلها تفتح الصف (بلا زر منفصل) — بطاقتان في كل سطر على الجوال
  return T`<article class="card class-card tap" data-act="open-class" data-id="${c.id}" role="button" tabindex="0" aria-label="${esc(c.label)}">
    <h3>${esc(c.label)}</h3>
    <div class="cc-meta">${n ? students(n) : tr('بلا طلاب بعد')}</div>
    <div class="cc-where ${pct === 100 ? 'done' : ''}">${n ? (where || '') : T`${icon('plus')} أضف الطلاب`}</div>
    <div class="cc-foot"><div class="progress ${pct === 100 ? 'done' : ''}" role="progressbar" aria-label="نسبة الرصد" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div><b class="num">${ar(pct)}%</b></div>
  </article>`;
}

// =====================================================================
// الشاشة ٢ — الصف (إدخال الدرجات)
// =====================================================================
function ClassScreen(p) {
  const c = cls(p.id);
  if (!c) return Home();
  const n = c.names.length;
  const d = dataOf(c.id);
  if (p.tab == null) p.tab = S.ui.tab[c.id] ?? (n ? firstIncompleteWeek(d, n) : 1);
  S.ui.tab[c.id] = p.tab;

  const wide = WIDE.matches;
  // على الكمبيوتر: الأزرار ظاهرة. على الجوال: قائمة «⋯» واحدة حتى تبقى الشاشة للرصد فقط
  const tools = wide ? T`<div class="toolbar wrap" style="padding-top:0;padding-bottom:0">
    <button type="button" class="btn sm" data-act="edit-class" data-id="${c.id}">${icon('users')} الطلاب</button>
    <button type="button" class="btn sm" data-act="export-xlsx" data-id="${c.id}">${icon('sheet')} تصدير Excel</button>
    ${REMOTE ? T`<button type="button" class="btn sm primary" data-act="present" data-id="${c.id}">${icon('monitor')} اعرض للطلاب وارصد</button>` : T`<button type="button" class="btn sm" data-act="go-live" data-id="${c.id}">${icon('monitor')} عرض على الكمبيوتر</button>`}
    <button type="button" class="btn sm" data-act="go" data-to="transferOut" data-id="${c.id}">${icon('send')} نقل طلاب</button>
  </div>` : '';
  const menuBtn = wide ? '' : T`<button type="button" class="icon-btn labeled" data-act="class-menu" aria-label="خيارات الصف">${icon('more')}</button>`;
  const weekLabel = p.tab === 'fin' ? tr('الدرجات النهائية') : T`الأسبوع ${ar(p.tab)}`;
  const weekSub = !n ? '' : p.tab === 'fin'
    ? (finalsRemaining(d, n) ? T`باقي ${ar(finalsRemaining(d, n))}` : tr('مكتملة ✓'))
    : (weekComplete(d, p.tab, n) ? tr('مكتمل ✓') : T`باقي ${ar(weekRemaining(d, p.tab, n))} من ${ar(n)}`);
  const weekbar = T`<div class="weekbar">
    <button type="button" class="icon-btn" data-act="week-step" data-dir="-1" aria-label="الأسبوع السابق" ${p.tab === 1 ? 'disabled' : ''}>${icon('prev')}</button>
    <button type="button" class="week-btn" data-act="week-pick" aria-label="اختر الأسبوع"><b>${weekLabel} ▾</b><small id="week-sub">${weekSub}</small></button>
    <button type="button" class="icon-btn" data-act="week-step" data-dir="1" aria-label="الأسبوع التالي" ${p.tab === 'fin' ? 'disabled' : ''}>${icon('next')}</button>
  </div>`;

  const chips = T`<div class="chips" role="tablist" aria-label="الأسابيع">${Array.from({ length: WEEKS }, (_, i) => {
    const w = i + 1;
    const done = n && weekComplete(d, w, n);
    return T`<button type="button" role="tab" class="chip ${done ? 'done' : ''}" aria-selected="${p.tab === w}" data-act="tab" data-tab="${w}">${done ? icon('check') : ''}أسبوع ${ar(w)}</button>`;
  }).join('')}<button type="button" role="tab" class="chip ${n && !finalsRemaining(d, n) ? 'done' : ''}" aria-selected="${p.tab === 'fin'}" data-act="tab" data-tab="fin">${n && !finalsRemaining(d, n) ? icon('check') : ''}الدرجات النهائية</button></div>`;

  let body;
  if (!n) {
    body = T`<div class="wrap"><div class="empty card">${ART_USERS}<h2>لا يوجد طلاب في هذا الصف</h2><p>أضف الأسماء بلصقها أو استوردها من ملف Excel أو PDF.</p>
      <button type="button" class="btn primary lg" data-act="edit-class" data-id="${c.id}">${icon('plus')} أضف الطلاب</button>
      <button type="button" class="btn lg ghost" data-act="go" data-to="transferIn" data-id="${c.id}">${icon('inbox')} استقبال طلاب منقولين</button></div></div>`;
  } else {
    body = wide
      ? `<section id="cls-body" class="desk-body">${n > 30 && !p.painted ? skeleton() : (p.tab === 'fin' ? finTab(c, d) : weekTab(c, d, p.tab))}</section>`
      : `<div class="wrap wide"><section id="cls-body">${n > 30 && !p.painted ? skeleton() : (p.tab === 'fin' ? finTab(c, d) : weekTab(c, d, p.tab))}</section></div>`;
  }

  void tools; void chips;
  // الكمبيوتر: الرأس فيه كل بيانات الصف (والأسابيع في بطاقة «الأسبوع والتاريخ» باللوحة)
  const statusNow = !n ? '' : p.tab === 'fin'
    ? (finalsRemaining(d, n) ? T`<span class="status-pill">${icon('warn')} باقي ${ar(finalsRemaining(d, n))} من ${ar(n)} طالب</span>` : T`<span class="status-pill ok">${icon('checkCircle')} اكتملت الدرجات النهائية</span>`)
    : weekStatusHTML(d, p.tab, n);
  // اللوحة مخفية: الأسابيع تظهر مختصرة في الرأس (لا طريقة أخرى لتغيير الأسبوع)
  const miniWeeks = S.ui.sideHidden ? `<select class="select hdr-week" data-week-select aria-label="${tr('الأسبوع')}">${Array.from({ length: WEEKS }, (_, k) => k + 1).map((x) => `<option value="${x}" ${p.tab === x ? 'selected' : ''}>${T`الأسبوع ${ar(x)}`}</option>`).join('')}<option value="fin" ${p.tab === 'fin' ? 'selected' : ''}>${tr('الدرجات النهائية')}</option></select>` : '';
  const hdr = wide && n ? T`${miniWeeks}<span id="week-status" class="hdr-status">${statusNow}</span>
    <div class="search hdr-search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب أو رقمه" value="${esc(S.ui.search)}" aria-label="بحث"></div>` : '';
  // الكمبيوتر: عنوان درس الأسبوع (من خطة المنهج) يظهر تلقائيًا تحت اسم الصف — للعرض فقط
  const lessonNow = wide && n && typeof p.tab === 'number' ? getWeekMeta(d, p.tab).lesson : '';
  const sub = students(n) + (lessonNow ? T` · <span class="lesson-now" title="عنوان الدرس">${icon('note')} ${esc(lessonNow)}</span>` : '');
  return `<div class="cls-head">${appbar({ title: c.label, sub, save: true, actions: wide ? hdr : menuBtn })}${n && !wide ? weekbar : ''}</div>${body}`;
}
afterRender.class = (p) => {
  if (!p.painted) {
    p.painted = true;
    const c = cls(p.id);
    if (c && c.names.length > 30) requestAnimationFrame(() => { const b = document.getElementById('cls-body'); if (b) { b.innerHTML = p.tab === 'fin' ? finTab(c, dataOf(c.id)) : weekTab(c, dataOf(c.id), p.tab); afterRender.class(p); } });
  }
  const sel = main().querySelector('.chip[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (p.scrollTo != null) {
    const target = main().querySelector(`[data-stu="${p.scrollTo}"]`);
    p.scrollTo = null;
    if (target) setTimeout(() => scrollToStu(target), 60);
  }
};

function skeleton() {
  return `<div class="stack" aria-busy="true">${'<div class="skel" style="height:120px"></div>'.repeat(5)}</div>`;
}

// الكمبيوتر: عمود جانبي ثابت (يسار) — الأسابيع، أدوات الأسبوع، الإجراءات، الملخص
// الكمبيوتر: اختيار الأسبوع + التاريخ في بطاقة واحدة داخل لوحة الأدوات
function weekDateCard(c, d, p) {
  const n = c.names.length;
  const w = p.tab;
  const weeks = Array.from({ length: WEEKS }, (_, j) => {
    const x = j + 1;
    const done = n && weekComplete(d, x, n);
    return T`<button type="button" role="tab" class="chip wk-mini ${done ? 'done' : ''}" aria-selected="${w === x}" data-act="tab" data-tab="${x}" aria-label="الأسبوع ${ar(x)}">${ar(x)}</button>`;
  }).join('');
  const meta = typeof w === 'number' ? getWeekMeta(d, w) : null;
  return T`<div class="side-card wd-card">
    <div class="side-title">الأسبوع والتاريخ</div>
    <div class="wk-mini-grid" role="tablist" aria-label="الأسابيع">${weeks}</div>
    <button type="button" role="tab" class="chip wk-mini fin ${n && !finalsRemaining(d, n) ? 'done' : ''}" aria-selected="${w === 'fin'}" data-act="tab" data-tab="fin">الدرجات النهائية</button>
    ${meta ? T`<div class="row wd-date"><input id="wdate" class="input" data-meta="date" value="${esc(meta.date)}" placeholder="التاريخ: 12/10" aria-label="التاريخ" autocomplete="off"><button type="button" class="btn sm" data-act="today" title="تاريخ اليوم">${icon('calendar')} اليوم</button></div>` : ''}
  </div>`;
}

function deskSide(c, d, inner) {
  if (S.ui.sideHidden) return '';
  const p = route().p || {};
  const act = (a, ic, label, extra = '') => `<button type="button" class="side-act" data-act="${a}" data-id="${c.id}" ${extra}>${icon(ic)}<span>${label}</span></button>`;
  return T`<aside class="cls-side">
    <div class="side-sum" id="side-sum" aria-label="ملخص الصف">${sideSumHTML(c, d)}</div>
    <div class="side-card side-acts">
      ${REMOTE ? act('present', 'monitor', tr('اعرض للطلاب وارصد')) : DESK_WEB ? '' : act('go-live', 'monitor', tr('عرض على الكمبيوتر'))}
      ${act('edit-class', 'users', tr('الطلاب'))}
      ${act('export-xlsx', 'sheet', tr('تصدير Excel'))}
      ${act('go', 'send', tr('نقل طلاب'), 'data-to="transferOut"')}
      ${REMOTE ? '' : act('delete-class-id', 'trash', tr('حذف الصف'), 'data-danger')}
    </div>
    ${inner}

    <div id="aside">${asideHTML(c, d, p)}</div>
  </aside>`;
}

function asideHTML(c, d, p) {
  if (S.ui.selected && S.ui.selected.id === c.id && S.ui.selected.idx < c.names.length) {
    return `<div class="card">${studentCardBody(c, S.ui.selected.idx, { compact: true })}</div>`;
  }
  void d; void p;
  return T`<p class="hint side-hint">${icon('info')} اضغط اسم أي طالب لعرض بطاقته هنا.</p>`;
}
// ملخص الصف: ثلاث خانات صغيرة أعلى اللوحة (ظاهرة دائمًا بلا تمرير)
function sideSumHTML(c, d) {
  const n = c.names.length;
  const totals = c.names.map((_, i) => finalTotal(d, i)).filter((v) => v != null);
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  const pr = progress(d, n);
  return T`<div class="sum-tile"><b class="num">${ar(Math.round(pr.ratio * 100))}%</b><small>نسبة الرصد</small></div>
    <div class="sum-tile"><b class="num">${ar(totals.length)}/${ar(n)}</b><small>اكتمل النهائي</small></div>
    <div class="sum-tile"><b class="num">${fmt(avg)}</b><small>المتوسط</small></div>`;
}
function refreshAside() {
  const r = route();
  if (r.name !== 'class' || !WIDE.matches) return;
  const a = document.getElementById('aside');
  const c = cls(r.p.id);
  if (a && c) a.innerHTML = asideHTML(c, dataOf(c.id), r.p);
  const sm = document.getElementById('side-sum');
  if (sm && c) sm.innerHTML = sideSumHTML(c, dataOf(c.id));
}

// ----- فلتر الطلاب: الناقص، الغائبون، المميّزون، عليهم ملاحظات (هذا الأسبوع أو كل الأسابيع) -----
const FILTER_KEYS = ['all', 'missing', 'absent', 'star', 'notes'];
const STAT_F = ['absent', 'star', 'notes'];
function fLabel(f) { return { all: tr('الكل'), missing: tr('الناقص'), absent: tr('الغائبون'), star: tr('المميّزون'), notes: tr('عليهم ملاحظات') }[f]; }
function setFilter(f) { S.ui.filter = FILTER_KEYS.includes(f) ? f : 'all'; S.ui.missingOnly = S.ui.filter === 'missing'; }
// عدد مرات انطباق الفلتر على الطالب (٠ = لا ينطبق)
function stuStat(d, w, i, f, sc = S.ui.fscope) {
  if (f === 'missing') return studentComplete(d, w, i) ? 0 : 1;
  const weeks = sc === 'all' ? Array.from({ length: WEEKS }, (_, j) => j + 1) : [w];
  if (f === 'absent') return weeks.filter((x) => isAbsent(d, x, i)).length;
  if (f === 'star') return weeks.filter((x) => isStar(d, x, i)).length;
  if (f === 'notes') return getNotes(d, i).filter((nt) => sc === 'all' || nt.w === w).length;
  return 1;
}
const F_ICON = { all: 'users', missing: 'warn', absent: 'xCircle', star: 'star', notes: 'note' };
function filterCount(c, d, w, k) {
  return k === 'missing' ? weekRemaining(d, w, c.names.length) : k === 'all' ? c.names.length : c.names.reduce((s, _, i) => s + (stuStat(d, w, i, k) ? 1 : 0), 0);
}
// الجوال: شريط صغير يظهر فقط حين يكون فلتر مفعّلًا (الاختيار من نافذة «فلتر»)
function filterStrip(c, d, w) {
  const f = S.ui.filter || 'all';
  if (f === 'all') return '';
  const sc = f !== 'missing' && S.ui.fscope === 'all' ? tr('كل الأسابيع') : T`الأسبوع ${ar(w)}`;
  return `<div class="fstrip f-${f}">
    <button type="button" class="fstrip-main" data-act="filter-sheet">${icon(F_ICON[f])}<b>${fLabel(f)}</b><span class="num fc-n">${ar(filterCount(c, d, w, f))}</span><small>${sc}</small></button>
    ${STAT_F.includes(f) ? `<button type="button" class="icon-btn" data-act="filter-share" aria-label="${tr('مشاركة القائمة')}">${icon('send')}</button>` : ''}
    <button type="button" class="icon-btn" data-act="filter" data-f="all" aria-label="${tr('إلغاء الفلتر')}">${icon('x')}</button>
  </div>`;
}
function openFilterSheet(c, w) {
  const d = dataOf(c.id);
  const s = openSheet('<div data-fs></div>', { label: tr('فلتر الطلاب') });
  const paint = () => {
    const f = S.ui.filter || 'all';
    const sc = S.ui.fscope === 'all' ? 'all' : 'week';
    s.sheet.querySelector('[data-fs]').innerHTML = T`<h2>عرض الطلاب</h2>
      <div class="seg fscope" role="group" aria-label="النطاق"><button type="button" data-fsc="week" aria-pressed="${sc === 'week'}">الأسبوع ${ar(w)}</button><button type="button" data-fsc="all" aria-pressed="${sc === 'all'}">كل الأسابيع</button></div>
      <div class="list fs-list">${FILTER_KEYS.map((k) => `<button type="button" class="list-item fs-opt f-${k}" data-fk="${k}" aria-pressed="${f === k}">
        <span class="fs-ic">${icon(F_ICON[k])}</span><span class="grow"><strong>${fLabel(k)}</strong></span>
        <span class="num fc-n">${ar(filterCount(c, d, w, k))}</span>${f === k ? icon('check', 'fs-on') : ''}</button>`).join('')}</div>`;
  };
  paint();
  s.sheet.addEventListener('click', (e) => {
    const sc = e.target.closest('[data-fsc]');
    if (sc) { S.ui.fscope = sc.dataset.fsc === 'all' ? 'all' : 'week'; paint(); rerenderList(); return; }
    const o = e.target.closest('[data-fk]');
    if (!o) return;
    setFilter(o.dataset.fk);
    s.close();
    rerenderList();
  });
}
function filterBar(c, d, w) {
  if (!WIDE.matches) return filterStrip(c, d, w);
  const f = S.ui.filter || 'all';
  const n = c.names.length;
  const cnt = (k) => (k === 'missing' ? weekRemaining(d, w, n) : c.names.reduce((s, _, i) => s + (stuStat(d, w, i, k) ? 1 : 0), 0));
  const chips = FILTER_KEYS.map((k) => {
    const act = k === 'missing' ? 'data-act="missing-toggle"' : `data-act="filter" data-f="${k}"`;
    return `<button type="button" class="fchip f-${k}" ${act} aria-pressed="${f === k}">${k === 'star' ? icon('star') : ''}${fLabel(k)}${k === 'all' ? '' : ` <span class="fc-n num">${ar(cnt(k))}</span>`}</button>`;
  }).join('');
  const sc = S.ui.fscope === 'all' ? 'all' : 'week';
  const extra = STAT_F.includes(f) ? T`<div class="fres">
      <div class="seg fscope" role="group" aria-label="النطاق"><button type="button" data-act="fscope" data-s="week" aria-pressed="${sc === 'week'}">الأسبوع ${ar(w)}</button><button type="button" data-act="fscope" data-s="all" aria-pressed="${sc === 'all'}">كل الأسابيع</button></div>
      <button type="button" class="btn sm" data-act="filter-share">${icon('send')} مشاركة القائمة</button>
    </div>` : '';
  if (!S.ui.sideHidden) return `<div class="side-title">${tr('فلتر الطلاب')}</div><div class="fgrid" role="group" aria-label="${tr('فلتر الطلاب')}">${chips}</div>${extra}`;
  return `<div class="fchips wrap" role="group" aria-label="${tr('فلتر الطلاب')}">${chips}</div>${extra}`;
}
function filterEmpty(f) {
  return { missing: tr('🎉 كل الطلاب مكتملون في هذا الأسبوع'), absent: tr('لا يوجد طلاب غائبون'), star: tr('لا يوجد طلاب مميّزون'), notes: tr('لا توجد ملاحظات') }[f] || tr('لا نتائج');
}
// بعد أي تعديل: تحديث الأعداد، وإخفاء من لم يعد ينطبق عليه الفلتر
function syncFilter() {
  const r = route();
  if (r.name !== 'class' || typeof r.p.tab !== 'number') return;
  const c = cls(r.p.id);
  const bar = document.getElementById('fbar');
  if (!c || !bar) return;
  const d = dataOf(c.id);
  bar.innerHTML = filterBar(c, d, r.p.tab);
  if (STAT_F.includes(S.ui.filter)) main().querySelectorAll('#stu-list [data-stu]').forEach((el) => { if (!stuStat(d, r.p.tab, +el.dataset.stu, S.ui.filter)) el.remove(); });
}
async function shareFilter(c, w) {
  const d = dataOf(c.id);
  const f = S.ui.filter;
  if (!STAT_F.includes(f)) return;
  const sc = S.ui.fscope === 'all' ? 'all' : 'week';
  const meta = getWeekMeta(d, w);
  const title = { absent: tr('الغائبون'), star: tr('المميّزون'), notes: tr('الطلاب الذين عليهم ملاحظات') }[f];
  const when = sc === 'all' ? tr('كل الأسابيع') : T`الأسبوع ${ar(w)}` + (meta.date ? ` (${meta.date})` : '');
  const idx = c.names.map((_, i) => i).filter((i) => stuStat(d, w, i, f, sc) > 0);
  const lines = idx.map((i, k) => {
    const n = stuStat(d, w, i, f, sc);
    let s = `${ar(k + 1)}. ${c.names[i]}`;
    if (sc === 'all' && f === 'absent') s += ' — ' + T`غاب ${ar(n)} أسبوع`;
    if (sc === 'all' && f === 'star') s += ' — ' + T`${ar(n)} نجمة`;
    if (f === 'notes') s += getNotes(d, i).filter((nt) => sc === 'all' || nt.w === w).map((nt) => `\n   - ${nt.issue ? '❗ ' : ''}${nt.text}`).join('');
    return s;
  });
  const head = [`${title} — ${c.label}`, when, S.settings.subject ? T`المادة: ${S.settings.subject}` : ''].filter(Boolean).join('\n');
  const text = `${head}\n\n${lines.length ? lines.join('\n') : filterEmpty(f)}\n\n${T`العدد: ${ar(idx.length)} من ${ar(c.names.length)}`}`;
  const res = await platform.shareText(text, title);
  if (res === 'copied') toast(tr('نُسخت القائمة — الصقها في واتساب'));
  else if (res === 'failed') toast(tr('تعذّرت المشاركة'), { err: true });
}

// ----- تبويب الأسبوع -----
function weekTab(c, d, w) {
  const n = c.names.length;
  const meta = getWeekMeta(d, w);
  const q = S.ui.search.trim();
  const qk = q ? nameKey(q) : '';
  const idxs = c.names.map((_, i) => i).filter((i) => !qk || nameKey(c.names[i]).includes(qk) || String(i + 1) === q);
  const f = S.ui.filter || 'all';
  const visible = idxs.filter((i) => f === 'all' || stuStat(d, w, i, f) > 0);
  const useGrid = WIDE.matches;
  if (!useGrid) {
    // الجوال: شريط إجراءات صغير + صف مختصر لكل طالب
    const metaLine = meta.date || meta.lesson
      ? `<button type="button" class="meta-line" data-act="week-tools">${icon('calendar')} ${esc([meta.date, meta.lesson].filter(Boolean).join(' · '))}</button>`
      : T`<button type="button" class="meta-line muted" data-act="week-tools">${icon('calendar')} أضف التاريخ وعنوان الدرس</button>`;
    const rows = visible.map((i) => stuRow(c, d, w, i)).join('');
    return T`<div class="stack">
      <div class="action-row">
        <button type="button" class="btn success" data-act="fill" data-k="all">${icon('check')} الكل ${ar(CONFIG.itemMax)}</button>
        <button type="button" class="btn ${f !== 'all' ? 'primary' : ''}" data-act="filter-sheet" aria-pressed="${f !== 'all'}">${icon('filter')} فلتر</button>
        <button type="button" class="btn" data-act="week-tools">${icon('edit')} أدوات</button>
      </div>
      ${S.ui.undo && S.ui.undo.classId === c.id && S.ui.undo.week === w ? T`<button type="button" class="btn danger-ghost block" data-act="undo-bulk">${icon('undo')} تراجع عن «${S.ui.undo.label}»</button>` : ''}
      ${metaLine}
      <span id="week-status" hidden>${weekStatusHTML(d, w, n)}</span>
      <div id="fbar" class="fbar">${filterStrip(c, d, w)}</div>
      ${n > 12 ? T`<div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب أو رقمه" value="${esc(q)}" aria-label="بحث"></div>` : ''}
      <div id="stu-list" class="slist">${rows || `<p class="hint" style="text-align:center;padding:24px">${f !== 'all' && !q ? filterEmpty(f) : tr('لا نتائج')}</p>`}</div>
      <p class="hint" style="text-align:center">${icon('info')} اضغط أي مربع لاختيار الدرجة، أو «كامل» لوضع ${ar(CONFIG.itemMax)} في الأربعة.</p>
    </div>`;
  }

  const list = weekGrid(c, d, w, visible);
  const side = T`
    ${weekDateCard(c, d, route().p || { tab: w })}
    ${S.ui.sideHidden ? '' : `<div id="fbar" class="side-card fbar fbar-side">${filterBar(c, d, w)}</div>`}
    <div class="side-card">
      <div class="side-title">تعبئة سريعة <span class="hint">الخانات الفارغة فقط</span></div>
      <div class="fill-tools">
        <button type="button" class="btn sm success all" data-act="fill" data-k="all">${icon('check')} الكل ${ar(CONFIG.itemMax)}</button>
        ${CRIT.map((cr, k) => `<button type="button" class="btn sm" data-act="fill" data-k="${k}">${esc(cr.short)} ${ar(CONFIG.itemMax)}</button>`).join('')}
      </div>
      ${S.ui.undo && S.ui.undo.classId === c.id && S.ui.undo.week === w ? T`<button type="button" class="btn sm danger-ghost block" style="margin-top:8px" data-act="undo-bulk">${icon('undo')} تراجع عن «${S.ui.undo.label}»</button>` : ''}
    </div>`;
  return T`<div class="cls-desk ${S.ui.sideHidden ? 'side-off' : ''}">
    <div class="cls-main">
      <div id="stu-list" class="stu-scroll">${list || `<p class="hint" style="text-align:center;padding:24px">${f === 'missing' && !q ? tr('لا يوجد طلاب ناقصون في هذا الأسبوع') : (f !== 'all' && !q ? filterEmpty(f) : tr('لا نتائج'))}</p>`}</div>
    </div>
    ${deskSide(c, d, side)}
  </div>`;
}

function weekStatusHTML(d, w, n) {
  const rem = weekRemaining(d, w, n);
  return rem ? T`<span class="status-pill">${icon('warn')} باقي ${ar(rem)} من ${ar(n)} طالب</span>` : T`<span class="status-pill ok">${icon('checkCircle')} اكتمل هذا الأسبوع</span>`;
}

function totalBadge(t, max) {
  const full = t != null && t === max;
  return `<span class="stu-total num ${full ? 'full' : ''}" data-total>${t == null ? '—' : fmt(t)} <span class="of">/ ${ar(max)}</span></span>`;
}

// ----- صف الطالب المختصر (الجوال) -----
function stuRow(c, d, w, i) {
  const absent = isAbsent(d, w, i);
  const done = studentComplete(d, w, i);
  const t = weekTotal(d, w, i);
  const notes = getNotes(d, i).length;
  const issues = weekIssues(d, w, i).length;
  const star = isStar(d, w, i);
  return T`<div class="srow ${done ? 'complete' : ''} ${absent ? 'absent' : ''}" data-stu="${i}">
    <span class="srow-num num">${ar(i + 1)}</span>
    <button type="button" class="srow-name" data-act="open-student" data-idx="${i}">${issues ? T`<span class="issue-mark" title="تنبيه هذا الأسبوع" aria-label="تنبيه">!</span>` : ''}${esc(c.names[i])}${star ? T`<span class="name-star" title="نجمة تميّز">${icon('star')}</span>` : ''}</button>
    <span class="srow-total num ${t === CONFIG.itemMax * ITEMS ? 'full' : ''} ${absent ? 'abs' : ''}" data-total>${t == null ? '' : fmt(t)}</span>
    <div class="boxes" data-inputs>${absent ? absentPill() : rowBoxes(w, i, getItems(d, w, i), c.names[i])}</div>
    <span class="srow-act" data-rowact>${absent ? T`<span class="srow-done abs" aria-label="غائب">${icon('xCircle')}</span>` : rowAct(done, i)}</span>
    <span class="row-flags">
      <button type="button" class="flag abs-btn ${absent ? 'on' : ''}" data-act="absent" data-idx="${i}" aria-pressed="${absent}">${absent ? T`${icon('undo')} تسجيل حضور` : T`${icon('x')} غياب`}</button>
      <button type="button" class="flag star-btn ${star ? 'on' : ''}" data-act="star" data-idx="${i}" aria-pressed="${star}" aria-label="نجمة تميّز هذا الأسبوع">${icon('star')} نجمة</button>
      <button type="button" class="flag note-btn" data-act="quick-note" data-idx="${i}" aria-label="ملاحظة أو تنبيه">${icon('note')} ملاحظة${notes ? T`<span class="note-dot" title="ملاحظات">${ar(notes)}</span>` : ''}</button>
    </span>
  </div>`;
}
function absentPill() {
  return T`<span class="absent-pill">غائب — الدرجات أصفار</span>`;
}
function rowAct(done, i) {
  return done ? T`<span class="srow-done" aria-label="مكتمل">${icon('checkCircle')}</span>`
    : T`<button type="button" class="btn-full" data-act="full" data-idx="${i}" aria-label="كامل: ${ar(CONFIG.itemMax)} في كل البنود">كامل</button>`;
}
function rowBoxes(w, i, vals, name) {
  if (S.settings.inputMode === 'fields') {
    return CRIT.map((cr, k) => `<label class="box field"><small>${esc(cr.short)}</small><input class="score-input" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-score="item" data-idx="${i}" data-k="${k}" value="${vals[k] == null ? '' : ar(vals[k])}" placeholder="" aria-label="${esc(cr.label)} — ${esc(name)}"><span class="cell-err" data-err></span></label>`).join('');
  }
  return CRIT.map((cr, k) => `<button type="button" class="box ${vals[k] == null ? '' : 'filled'}" data-act="box" data-idx="${i}" data-k="${k}" aria-label="${esc(cr.label)}: ${vals[k] == null ? tr('فارغ') : ar(vals[k])}"><small>${esc(cr.short)}</small><b class="num">${vals[k] == null ? '' : ar(vals[k])}</b></button>`).join('');
}

// نافذة اختيار الدرجة: سلايدر ٠–٥ بالأنصاص. السحب ثم الترك = حفظ والانتقال للبند التالي
function openPicker(c, w, i, k0) {
  const d = dataOf(c.id);
  let k = k0;
  const max = CONFIG.itemMax;
  const s = openSheet('<div data-picker></div>', { label: tr('اختيار الدرجة') });
  const ints = Array.from({ length: max + 1 }, (_, j) => max - j);          // ٥ ٤ ٣ ٢ ١ ٠
  const halves = Array.from({ length: max }, (_, j) => max - j - 0.5);      // ٤٫٥ … ٠٫٥
  const btn = (v, cur, cls) => `<button type="button" class="pv ${cls} ${cur === v ? 'on' : ''}" data-pv="${v}" aria-pressed="${cur === v}">${ar(v)}</button>`;
  const paint = () => {
    const vals = getItems(d, w, i);
    const cur = vals[k];
    s.sheet.querySelector('[data-picker]').innerHTML = T`
      <div class="picker-head"><span class="srow-num num">${ar(i + 1)}</span><b>${esc(c.names[i])}</b></div>
      <div class="seg picker-tabs" role="tablist">${CRIT.map((cr, j) => `<button type="button" data-pk="${j}" aria-pressed="${j === k}">${esc(cr.short)} <span class="num">${vals[j] == null ? '—' : ar(vals[j])}</span></button>`).join('')}</div>
      <div class="pv-title"><b>${esc(CRIT[k].label)}</b><span class="hint">اضغط الدرجة — تُحفظ وتنتقل للبند التالي</span></div>
      <div class="pv-ints" role="group" aria-label="${esc(CRIT[k].label)}">${ints.map((v) => btn(v, cur, 'int')).join('')}</div>
      <div class="pv-halves" role="group" aria-label="أنصاف">${halves.map((v) => btn(v, cur, 'half')).join('')}</div>
      <div class="actions picker-actions">
        <button type="button" class="btn" data-pv="clear" ${cur == null ? 'disabled' : ''}>مسح</button>
        <button type="button" class="btn primary" data-pv="close">تم</button>
      </div>`;

    const f = s.sheet.querySelector('.pv.on') || s.sheet.querySelector('.pv.int');
    if (f) f.focus({ preventScroll: true });
  };
  const commit = (val) => {
    const { wasDone, nowDone } = changeItem(c, w, i, k, val);
    haptic('light');
    refreshStudent(c, w, i, { rerenderInputs: true });
    if (!wasDone && nowDone) { s.close(); advanceFrom(c, w, i); hideIfMissingOnly(i); return; }
    if (val != null) {
      const vals = getItems(d, w, i);
      const next = [...Array(ITEMS).keys()].map((j) => (k + 1 + j) % ITEMS).find((j) => vals[j] == null);
      if (next != null) k = next;
    }
    paint();
  };
  paint();
  s.sheet.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-pk]');
    if (tab) { k = +tab.dataset.pk; paint(); return; }
    const b = e.target.closest('[data-pv]');
    if (!b) return;
    const v = b.dataset.pv;
    if (v === 'close') return s.close();
    if (v === 'clear') return commit(null);
    commit(+v);
  });
}

function stuCard(c, d, w, i) {
  const vals = getItems(d, w, i);
  const done = studentComplete(d, w, i);
  return T`<article class="card stu ${done ? 'complete' : ''}" data-stu="${i}">
    <div class="stu-head">
      <span class="stu-num num">${ar(i + 1)}</span>
      <button type="button" class="stu-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}</button>
      ${totalBadge(weekTotal(d, w, i), CONFIG.itemMax * ITEMS)}
      <button type="button" class="btn-full" data-act="full" data-idx="${i}" aria-label="كامل: ${ar(CONFIG.itemMax)} في كل البنود">${icon('check')} كامل</button>
    </div>
    <div data-inputs>${S.settings.inputMode === 'fields' ? fieldsRow(w, i, vals) : chipsRows(w, i, vals)}</div>
  </article>`;
}

function chipsRows(w, i, vals) {
  return `<div class="items">${CRIT.map((cr, k) => {
    const v = vals[k];
    const other = v != null && !CONFIG.chipValues.includes(v);
    return T`<div class="item-row"><span class="item-label">${esc(cr.label)}</span><div class="score-chips" role="group" aria-label="${esc(cr.label)}">
      ${CONFIG.chipValues.map((x) => `<button type="button" class="sc" data-act="chip" data-idx="${i}" data-k="${k}" data-v="${x}" aria-pressed="${v === x}">${ar(x)}</button>`).join('')}
      <button type="button" class="sc other" data-act="other" data-idx="${i}" data-k="${k}" aria-pressed="${other}" aria-label="رقم آخر" title="رقم آخر">${other ? ar(v) : tr('أخرى')}</button>
    </div></div>`;
  }).join('')}</div>`;
}

function fieldsRow(w, i, vals) {
  return `<div class="fields-row">${CRIT.map((cr, k) => `<div class="score-field"><label for="f-${i}-${k}">${esc(cr.short)}</label>
    <input id="f-${i}-${k}" class="score-input" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-score="item" data-idx="${i}" data-k="${k}" value="${vals[k] == null ? '' : ar(vals[k])}" placeholder="—">
    <span class="err-msg" data-err></span></div>`).join('')}</div>`;
}

function weekGrid(c, d, w, idxs) {
  const rows = idxs.map((i) => {
    const vals = getItems(d, w, i);
    const t = weekTotal(d, w, i);
    return T`<tr data-stu="${i}" class="${studentComplete(d, w, i) ? 'complete' : ''}">
      <td class="num">${ar(i + 1)}</td>
      <td class="name"><button type="button" class="stu-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}${isStar(d, w, i) ? T`<span class="name-star" title="نجمة تميّز">${icon('star')}</span>` : ''}</button></td>
      ${CRIT.map((cr, k) => `<td><input class="score-input" inputmode="decimal" autocomplete="off" data-score="item" data-idx="${i}" data-k="${k}" value="${vals[k] == null ? '' : ar(vals[k])}" placeholder="—" aria-label="${esc(cr.label)} — ${esc(c.names[i])}"><span class="cell-err" data-err></span></td>`).join('')}
      <td class="total num" data-total>${t == null ? '—' : fmt(t)}</td>
      <td><button type="button" class="btn-full" data-act="full" data-idx="${i}">${icon('check')} كامل</button></td>
      <td><button type="button" class="abs-btn ${isAbsent(d, w, i) ? 'on' : ''}" data-act="absent" data-idx="${i}" aria-pressed="${isAbsent(d, w, i)}">${isAbsent(d, w, i) ? tr('غائب ✓') : tr('غياب')}</button></td>
      <td><button type="button" class="star-btn ${isStar(d, w, i) ? 'on' : ''}" data-act="star" data-idx="${i}" aria-pressed="${isStar(d, w, i)}" aria-label="نجمة تميّز">${icon('star')}</button>${weekIssues(d, w, i).length ? tr('<span class="issue-mark" title="مشكلة هذا الأسبوع">!</span>') : ''}</td>
    </tr>`;
  }).join('');
  return T`<div class="grid-wrap"><table class="grid">
    <thead><tr><th>م</th><th class="name">اسم الطالب</th>${CRIT.map((cr) => `<th>${esc(cr.label)}<br><small>/ ${ar(CONFIG.itemMax)}</small></th>`).join('')}<th>المجموع<br><small>/ ${ar(CONFIG.itemMax * ITEMS)}</small></th><th></th><th>الحضور</th><th>تميّز</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ----- تبويب الدرجات النهائية -----
function finTab(c, d) {
  const n = c.names.length;
  const q = S.ui.search.trim();
  const qk = q ? nameKey(q) : '';
  const idxs = c.names.map((_, i) => i).filter((i) => !qk || nameKey(c.names[i]).includes(qk) || String(i + 1) === q)
    .filter((i) => !S.ui.missingOnly || getFin(d, i).some((v) => v == null));
  const rem = finalsRemaining(d, n);
  const intro = T`<div class="alert info">${icon('info')}<div class="grow"><strong>الدرجات النهائية</strong><p style="margin:0">أدخل ${FINS.map((f) => T`${f.label} (من ${ar(f.max)})`).join(tr('، '))}. يُحسب المجموع من ${ar(100)} عند اكتمال كل الأسابيع والدرجات.</p></div></div>`;
  const status = T`<div class="status-line"><span id="week-status">${rem ? T`<span class="status-pill">${icon('warn')} باقي ${ar(rem)} من ${ar(n)} طالب</span>` : T`<span class="status-pill ok">${icon('checkCircle')} اكتملت الدرجات النهائية</span>`}</span>
    <label class="toggle-line">الناقص فقط <input type="checkbox" class="switch" data-act="missing" ${S.ui.missingOnly ? 'checked' : ''}></label></div>`;
  const search = T`<div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب أو رقمه" value="${esc(q)}" aria-label="بحث"></div>`;
  let list;
  if (WIDE.matches) {
    list = T`<div class="grid-wrap"><table class="grid"><thead><tr><th>م</th><th class="name">اسم الطالب</th><th>الفترة 1<br><small>/ 20</small></th><th>الفترة 2<br><small>/ 20</small></th><th>البنائي<br><small>/ 40</small></th>
      ${FINS.map((f) => `<th>${esc(f.label)}<br><small>/ ${ar(f.max)}</small></th>`).join('')}<th>المجموع<br><small>/ 100</small></th></tr></thead><tbody>
      ${idxs.map((i) => { const fin = getFin(d, i); return `<tr data-stu="${i}"><td class="num">${ar(i + 1)}</td><td class="name"><button type="button" class="stu-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}</button></td>
        <td class="num" data-p1>${fmt(periodScore(d, i, 1))}</td><td class="num" data-p2>${fmt(periodScore(d, i, 2))}</td><td class="num" data-form>${fmt(formative(d, i))}</td>
        ${FINS.map((f, k) => `<td><input class="score-input" inputmode="decimal" autocomplete="off" data-score="fin" data-idx="${i}" data-k="${k}" value="${fin[k] == null ? '' : ar(fin[k])}" placeholder="—" aria-label="${esc(f.label)} — ${esc(c.names[i])}"><span class="cell-err" data-err></span></td>`).join('')}
        <td class="total num" data-total>${fmt(finalTotal(d, i))}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  } else {
    const rows = idxs.map((i) => finRow(c, d, i)).join('');
    return T`<div class="stack">
      <div class="action-row">
        <button type="button" class="btn ${S.ui.missingOnly ? 'primary' : ''}" data-act="missing-toggle" aria-pressed="${S.ui.missingOnly}">الناقص فقط</button>
      </div>
      <span id="week-status" hidden></span>
      <p class="hint">${FINS.map((f) => T`${esc(f.label)} من ${ar(f.max)}`).join(' · ')}. المجموع من ${ar(100)} يظهر عند اكتمال كل شيء.</p>
      ${n > 12 ? search : ''}
      <div id="stu-list" class="slist">${rows || tr('<p class="hint" style="text-align:center;padding:24px">لا نتائج</p>')}</div>
    </div>`;
  }
  void intro; void status;
  const side = T`${weekDateCard(c, d, route().p || { tab: 'fin' })}
    <div class="side-card"><button type="button" class="btn sm block ${S.ui.missingOnly ? 'primary' : ''}" data-act="missing-toggle" aria-pressed="${S.ui.missingOnly}">الناقص فقط</button></div>
    <div class="side-card"><div class="side-title">الدرجات النهائية</div><p class="hint" style="margin:0">${FINS.map((f) => T`${esc(f.label)} من ${ar(f.max)}`).join(tr('، '))}. المجموع من ${ar(100)} يظهر عند اكتمال كل الأسابيع والدرجات.</p></div>`;
  return T`<div class="cls-desk ${S.ui.sideHidden ? 'side-off' : ''}">
    <div class="cls-main">
      <div id="stu-list" class="stu-scroll">${list || tr('<p class="hint" style="text-align:center;padding:24px">لا نتائج</p>')}</div>
    </div>
    ${deskSide(c, d, side)}
  </div>`;
}

function finRow(c, d, i) {
  const fin = getFin(d, i);
  const t = finalTotal(d, i);
  const boxes = S.settings.inputMode === 'fields'
    ? FINS.map((f, k) => `<label class="box field"><small>${esc(f.short || f.label)} /${ar(f.max)}</small><input class="score-input" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-score="fin" data-idx="${i}" data-k="${k}" value="${fin[k] == null ? '' : ar(fin[k])}" placeholder="" aria-label="${esc(f.label)} — ${esc(c.names[i])}"><span class="cell-err" data-err></span></label>`).join('')
    : FINS.map((f, k) => `<button type="button" class="box ${fin[k] == null ? '' : 'filled'}" data-act="fin-box" data-idx="${i}" data-k="${k}" aria-label="${esc(f.label)}: ${fin[k] == null ? tr('فارغ') : ar(fin[k])}"><small>${esc(f.short || f.label)} /${ar(f.max)}</small><b class="num">${fin[k] == null ? '' : ar(fin[k])}</b></button>`).join('');
  return T`<div class="srow fin ${t != null ? 'complete' : ''}" data-stu="${i}">
    <span class="srow-num num">${ar(i + 1)}</span>
    <button type="button" class="srow-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}<small class="muted">البنائي <span data-form>${fmt(formative(d, i))}</span> / ${ar(40)}</small></button>
    <div class="boxes" data-inputs>${boxes}</div>
    <span class="srow-total num ${t != null ? 'full' : ''}" data-total>${t == null ? '' : fmt(t)}</span>
    <span class="srow-act"></span>
  </div>`;
}

function finCard(c, d, i) {
  const fin = getFin(d, i);
  const t = finalTotal(d, i);
  return T`<article class="card stu ${t != null ? 'complete' : ''}" data-stu="${i}">
    <div class="stu-head"><span class="stu-num num">${ar(i + 1)}</span>
      <button type="button" class="stu-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}</button>
      <span class="stu-total num ${t != null ? 'full' : ''}" data-total>${fmt(t)} <span class="of">/ ${ar(100)}</span></span></div>
    <div class="fields-row" style="grid-template-columns:repeat(3,1fr)">${FINS.map((f, k) => `<div class="score-field"><label for="fin-${i}-${k}">${esc(f.label)} <span style="white-space:nowrap">/ ${ar(f.max)}</span></label>
      <input id="fin-${i}-${k}" class="score-input" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-score="fin" data-idx="${i}" data-k="${k}" value="${fin[k] == null ? '' : ar(fin[k])}" placeholder="—"><span class="err-msg" data-err></span></div>`).join('')}</div>
    <div class="fin-sum"><div class="mini-stat"><small>الفترة الأولى</small><b class="num" data-p1>${fmt(periodScore(d, i, 1))}</b></div>
      <div class="mini-stat"><small>الفترة الثانية</small><b class="num" data-p2>${fmt(periodScore(d, i, 2))}</b></div>
      <div class="mini-stat"><small>التقويم البنائي</small><b class="num" data-form>${fmt(formative(d, i))}</b></div></div>
  </article>`;
}

// ----- تحديث جزء من الشاشة بعد تغيير الدرجات (بدون إعادة رسم كاملة) -----
function refreshStudent(c, w, i, { rerenderInputs = false } = {}) {
  const d = dataOf(c.id);
  const n = c.names.length;
  const el = main().querySelector(`[data-stu="${i}"]`);
  if (el && el.classList.contains('srow')) {
    // صف الجوال المختصر
    const isFin = w === 'fin';
    const t = isFin ? finalTotal(d, i) : weekTotal(d, w, i);
    const done = isFin ? t != null : studentComplete(d, w, i);
    const tot = el.querySelector('[data-total]');
    tot.textContent = t == null ? '' : fmt(t);
    tot.classList.toggle('full', isFin ? t != null : t === CONFIG.itemMax * ITEMS);
    el.classList.toggle('complete', done);
    const absent = !isFin && isAbsent(d, w, i);
    el.classList.toggle('absent', absent);
    if (!isFin) el.querySelector('[data-rowact]').innerHTML = absent ? '' : rowAct(done, i);
    if (isFin) { const f = el.querySelector('[data-form]'); if (f) f.textContent = fmt(formative(d, i)); }
    if (rerenderInputs || S.settings.inputMode !== 'fields') {
      if (isFin) { const tmp = document.createElement('div'); tmp.innerHTML = finRow(cls(c.id), d, i); el.querySelector('[data-inputs]').innerHTML = tmp.querySelector('[data-inputs]').innerHTML; }
      else el.querySelector('[data-inputs]').innerHTML = absent ? absentPill() : rowBoxes(w, i, getItems(d, w, i), c.names[i]);
    }
  } else if (el) {
    if (w === 'fin') {
      const t = finalTotal(d, i);
      const tot = el.querySelector('[data-total]');
      if (tot) tot.innerHTML = el.tagName === 'TR' ? fmt(t) : `${fmt(t)} <span class="of">/ ${ar(100)}</span>`;
      if (tot) tot.classList.toggle('full', t != null);
      el.classList.toggle('complete', t != null);
    } else {
      const t = weekTotal(d, w, i);
      const tot = el.querySelector('[data-total]');
      if (tot) {
        if (el.tagName === 'TR') tot.textContent = t == null ? '—' : fmt(t);
        else tot.outerHTML = totalBadge(t, CONFIG.itemMax * ITEMS);
      }
      el.classList.toggle('complete', studentComplete(d, w, i));
      if (rerenderInputs) {
        const vals = getItems(d, w, i);
        if (el.tagName === 'TR') {
          el.querySelectorAll('input[data-score]').forEach((inp) => { const v = vals[+inp.dataset.k]; inp.value = v == null ? '' : ar(v); inp.classList.remove('bad'); });
        } else {
          const box = el.querySelector('[data-inputs]');
          if (box) box.innerHTML = S.settings.inputMode === 'fields' ? fieldsRow(w, i, vals) : chipsRows(w, i, vals);
        }
      }
    }
  }
  const st = document.getElementById('week-status');
  if (st) st.innerHTML = w === 'fin'
    ? (finalsRemaining(d, n) ? T`<span class="status-pill">${icon('warn')} باقي ${ar(finalsRemaining(d, n))} من ${ar(n)} طالب</span>` : T`<span class="status-pill ok">${icon('checkCircle')} اكتملت الدرجات النهائية</span>`)
    : weekStatusHTML(d, w, n);
  const sub = document.getElementById('week-sub');
  if (sub) sub.textContent = w === 'fin'
    ? (finalsRemaining(d, n) ? T`باقي ${ar(finalsRemaining(d, n))}` : tr('مكتملة ✓'))
    : (weekComplete(d, w, n) ? tr('مكتمل ✓') : T`باقي ${ar(weekRemaining(d, w, n))} من ${ar(n)}`);
  refreshChip(c, w);
  if (S.ui.selected && S.ui.selected.idx === i) refreshAside(); else if (!S.ui.selected) refreshAside();
}

// علامة ✓ على شريحة الأسبوع
function refreshChip(c, w) {
  const d = dataOf(c.id); const n = c.names.length;
  const chip = main().querySelector(`.chip[data-tab="${w}"]`);
  if (!chip) return;
  const done = w === 'fin' ? !finalsRemaining(d, n) : weekComplete(d, w, n);
  if (done !== chip.classList.contains('done')) {
    chip.classList.toggle('done', done);
    chip.innerHTML = (done ? icon('check') : '') + (w === 'fin' ? tr('الدرجات النهائية') : T`أسبوع ${ar(w)}`);
  }
}

function scrollToStu(el) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

// بعد إكمال الطالب: انتقل للطالب غير المكتمل التالي
function advanceFrom(c, w, i) {
  if (!S.settings.autoAdvance) return;
  const d = dataOf(c.id);
  const cards = [...main().querySelectorAll('#stu-list [data-stu]')].map((e) => +e.dataset.stu);
  const pos = cards.indexOf(i);
  const next = cards.slice(pos + 1).find((j) => !studentComplete(d, w, j));
  if (next == null) return;
  const el = main().querySelector(`[data-stu="${next}"]`);
  if (el) setTimeout(() => scrollToStu(el), 220);
}

function hideIfMissingOnly(i) {
  if (!S.ui.missingOnly) return;
  const el = main().querySelector(`#stu-list [data-stu="${i}"]`);
  if (el) setTimeout(() => { if (el.classList.contains('complete')) el.remove(); }, 700);
}

// تغيير درجة بند واحد
function changeItem(c, w, i, k, v) {
  const d = dataOf(c.id);
  const wasDone = studentComplete(d, w, i);
  setItem(d, w, i, k, v);
  markDirty(c.id);
  livePatchItems(c.id, w, i);
  return { wasDone, nowDone: studentComplete(d, w, i) };
}

// =====================================================================
// الشاشة ٣ — بطاقة الطالب
// =====================================================================
function studentCardBody(c, i, { compact: small = false, week = null } = {}) {
  const d = dataOf(c.id);
  const compact = small || window.innerWidth < 480; // بدون عمود التاريخ على الشاشات الضيقة
  const sm = studentSummary(d, i);
  const total = sm.total;
  const rows = [];
  for (let w = 1; w <= WEEKS; w++) {
    const it = getItems(d, w, i);
    const meta = getWeekMeta(d, w);
    const abs = isAbsent(d, w, i);
    rows.push(`<tr class="${abs ? 'abs-row' : ''}"><td class="start"><b>${ar(w)}</b></td>${compact ? '' : `<td class="muted">${esc(meta.date) || '—'}</td>`}${abs ? T`<td colspan="${ITEMS}" class="abs-cell">غائب</td>` : it.map((v) => `<td class="num">${fmt(v)}</td>`).join('')}<td class="num"><b>${fmt(sm.weeks[w - 1])}</b></td></tr>`);
    if (w === 5) rows.push(T`<tr class="sum"><td class="start" colspan="${compact ? 5 : 6}">الفترة الأولى (من 20)</td><td class="num">${fmt(sm.p1)}</td></tr>`);
  }
  rows.push(T`<tr class="sum"><td class="start" colspan="${compact ? 5 : 6}">الفترة الثانية (من 20)</td><td class="num">${fmt(sm.p2)}</td></tr>`);
  return T`<div class="stack">
    <div><p class="big-name" ${small ? 'style="font-size:21px"' : ''}>${esc(c.names[i])}</p>
      <div class="meta">${esc(c.label)} — رقم ${ar(i + 1)}${S.settings.subject ? tr('، ') + esc(S.settings.subject) : ''}</div></div>
    <div class="banner ${total != null ? 'ok' : ''}"><span>المجموع النهائي</span>${total != null ? `<b class="num">${fmt(total)} <small>/ ${ar(100)}</small></b>` : tr('<strong>لم يكتمل بعد</strong>')}</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="start">الأسبوع</th>${compact ? '' : tr('<th>التاريخ</th>')}${CRIT.map((cr) => `<th>${esc(cr.short)}</th>`).join('')}<th>المجموع</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div class="card flat"><h3 style="margin-bottom:8px">الدرجات النهائية</h3><div class="kv">
      <div>التقويم البنائي</div><div class="num">${fmt(sm.formative)} / ${ar(40)}</div>
      ${FINS.map((f, k) => `<div>${esc(f.label)}</div><div class="num">${fmt(sm.fin[k])} / ${ar(f.max)}</div>`).join('')}
    </div></div>
    <div class="card flat"><div class="kv"><div>أسابيع الغياب</div><div class="num">${ar(absenceCount(d, i))}</div><div>نجوم التميّز</div><div class="num">${starCount(d, i) ? '⭐ ' + ar(starCount(d, i)) : ar(0)}</div></div></div>
    <div class="card flat stack" data-notes>
      <h3>${icon('edit')} ملاحظات المعلم</h3>
      ${getNotes(d, i).length ? `<ul class="notes">${getNotes(d, i).slice().reverse().map((nt) => T`<li class="${nt.issue ? 'issue' : ''}"><div class="grow"><small class="muted num">${nt.issue ? tr('تنبيه · ') : ''}${nt.w ? T`الأسبوع ${ar(nt.w)} — ` : ''}${ar(new Date(nt.t).toLocaleDateString('en-GB'))}</small><p>${esc(nt.text)}</p></div><button type="button" class="icon-btn" data-act="note-del" data-id="${c.id}" data-idx="${i}" data-t="${esc(nt.t)}" aria-label="حذف الملاحظة">${icon('trash')}</button></li>`).join('')}</ul>` : tr('<p class="hint">لا توجد ملاحظات. الملاحظات تبقى عندك فقط ولا تظهر في بطاقة المشاركة.</p>')}
      <textarea class="textarea" style="min-height:80px" data-note-input="${i}" maxlength="500" placeholder="اكتب ملاحظة عن الطالب (سلوك، مستوى، تواصل مع ولي الأمر…)"></textarea>
      ${week ? T`<label class="toggle-line issue-toggle"><input type="checkbox" class="switch" data-note-issue="${i}" data-week="${week}"> تنبيه: مشكلة في الأسبوع ${ar(week)} (تظهر علامة عند اسمه)</label>` : ''}
      <button type="button" class="btn soft" data-act="note-add" data-id="${c.id}" data-idx="${i}">${icon('plus')} إضافة ملاحظة</button>
    </div>
    <button type="button" class="btn primary block" data-act="share-student" data-id="${c.id}" data-idx="${i}">${icon('share')} مشاركة البطاقة</button>
    <button type="button" class="btn block" data-act="print-student" data-id="${c.id}" data-idx="${i}">${icon('sheet')} طباعة تقرير الطالب (PDF)</button>
    ${small ? T`<button type="button" class="btn ghost block" data-act="close-aside">إغلاق البطاقة</button>` : ''}
  </div>`;
}

function StudentScreen(p) {
  const c = cls(p.id);
  if (!c || p.idx >= c.names.length) return Home();
  const n = c.names.length;
  const nav = T`<button type="button" class="icon-btn" data-act="stu-nav" data-dir="-1" ${p.idx === 0 ? 'disabled' : ''} aria-label="الطالب السابق">${icon('prev')}</button>
    <button type="button" class="icon-btn" data-act="stu-nav" data-dir="1" ${p.idx === n - 1 ? 'disabled' : ''} aria-label="الطالب التالي">${icon('next')}</button>`;
  return `${appbar({ title: tr('بطاقة الطالب'), sub: T`${ar(p.idx + 1)} من ${ar(n)}`, actions: nav })}
    <div class="wrap">${studentCardBody(c, p.idx, { week: p.week || null })}</div>`;
}

// =====================================================================
// الشاشة ٤ — إضافة/تعديل صف (مسودة)
// =====================================================================
function Editor(p) {
  if (!p.draft) {
    const c = p.id ? cls(p.id) : null;
    p.draft = { label: c ? c.label : '', rows: c ? c.names.map((name, i) => ({ name, from: i })) : [] };
    p.dirty = false;
  }
  const dr = p.draft;
  const c = p.id ? cls(p.id) : null;
  const d = c ? dataOf(c.id) : null;
  const n = dr.rows.length;
  const rows = dr.rows.map((r, j) => {
    const has = d && r.from != null && studentHasGrades(d, r.from);
    return T`<div class="name-row" data-row="${j}"><span class="stu-num num">${ar(j + 1)}</span>
      <input class="input grow" data-name-row="${j}" value="${esc(r.name)}" aria-label="اسم الطالب ${ar(j + 1)}">
      ${has ? tr('<span class="tag">له درجات</span>') : ''}
      <button type="button" class="icon-btn" data-act="del-row" data-row="${j}" aria-label="حذف الطالب">${icon('x')}</button></div>`;
  }).join('');
  return T`${appbar({ title: p.id ? tr('تعديل الصف') : tr('أضف صفك'), actions: `<button type="button" class="btn primary sm" data-act="save-class">${p.id ? tr('حفظ') : tr('إنشاء')}</button>` })}
  <div class="wrap stack">
    ${p.id || p.manual ? '' : T`<button type="button" class="card school-pick" data-act="go" data-to="school">${icon('users')}<span class="grow"><strong>اختر من صفوف المدرسة</strong><small>الصف ← الشعب، وتنضاف بأسماء طلابها جاهزة</small></span>${icon('fwd')}</button>
    <div class="section-title">أو أنشئ صفًا بنفسك</div>`}
    <div class="card"><div class="field"><label for="cls-label">اسم الصف</label><input id="cls-label" class="input" data-draft-label value="${esc(dr.label)}" placeholder="مثل: العاشر / 3" autocomplete="off"></div></div>
    <div class="card stack">
      <h3>الطلاب</h3>
      <div class="row wrap-row">
        <button type="button" class="btn primary" data-act="import-file">${icon('upload')} استيراد من ملف</button>
        <button type="button" class="btn" data-act="add-one">${icon('plus')} طالب جديد</button>
      </div>
      ${p.showPaste ? T`<div class="field"><label for="paste">الصق الأسماء (اسم في كل سطر)</label>
        <textarea id="paste" class="textarea" data-paste placeholder="الصق هنا قائمة الأسماء…"></textarea></div>
        <button type="button" class="btn" data-act="add-names">${icon('plus')} إضافة الأسماء</button>`
      : T`<button type="button" class="link-btn" data-act="show-paste">${icon('paste')} لصق قائمة أسماء</button>`}
      <p class="hint">يقبل الاستيراد: Excel (xlsx)، PDF (حتى الممسوح ضوئيًا)، صورة للكشف، CSV، نص. الحد الأقصى ${ar(MAX_STUDENTS)} طالبًا.</p>
      ${p.id ? '' : T`<button type="button" class="link-btn" data-act="import-classes">${icon('sheet')} عندك ملف فيه أكثر من صف؟ أنشئها كلها مرة وحدة</button>`}
      ${p.id ? T`<button type="button" class="btn soft" data-act="go" data-to="transferIn" data-id="${p.id}">${icon('inbox')} استقبال طلاب منقولين من معلم آخر</button>` : ''}
    </div>
    <div class="row" style="justify-content:space-between;margin-top:20px">
      <div class="section-title" style="margin:0">قائمة الطلاب <span class="count-badge num">${ar(n)} / ${ar(MAX_STUDENTS)}</span></div>
      ${n > 1 ? T`<button type="button" class="btn sm" data-act="sort-az">${icon('sort')} ترتيب أبجدي</button>` : ''}
    </div>
    <div class="list" id="name-list">${rows || tr('<p class="hint" style="padding:16px;text-align:center">لا يوجد طلاب بعد.</p>')}</div>
    ${p.id ? T`<div class="section-title">منطقة الخطر</div><button type="button" class="btn danger-ghost block" data-act="delete-class">${icon('trash')} حذف الصف</button>` : ''}
  </div>`;
}

function addNamesToDraft(p, raw) {
  const existing = p.draft.rows.map((r) => r.name);
  const res = cleanNames(raw, existing, MAX_STUDENTS);
  res.names.forEach((name) => p.draft.rows.push({ name, from: null }));
  if (res.names.length) p.dirty = true;
  const parts = [T`أُضيف ${namesWord(res.names.length)}`];
  if (res.dup) parts.push(T`${ar(res.dup)} مكرر`);
  if (res.overLimit) parts.push(T`${ar(res.overLimit)} فوق الحد (${ar(MAX_STUDENTS)})`);
  toast(res.names.length || res.dup || res.overLimit ? parts.join(' · ') : tr('لم نجد أسماء صالحة'), { err: !res.names.length && !res.dup });
  return res;
}

async function saveEditor(p) {
  const label = (p.draft.label || '').trim();
  if (!label) { toast(tr('اكتب اسم الصف أولًا'), { err: true }); document.getElementById('cls-label')?.focus(); return; }
  const rows = p.draft.rows.map((r) => ({ ...r, name: r.name.replace(/\s+/g, ' ').trim() })).filter((r) => r.name);
  if (rows.length > MAX_STUDENTS) { toast(T`الحد الأقصى ${ar(MAX_STUDENTS)} طالبًا`, { err: true }); return; }
  if (p.id) {
    const c = cls(p.id);
    c.label = label;
    c.names = rows.map((r) => r.name);
    S.grades[c.id] = remapData(dataOf(c.id), rows.map((r) => r.from));
    await saveClassesNow();
    await store.saveGrades(c.id, S.grades[c.id]);
    liveResync(c.id);
    toast(tr('حُفظ الصف ✓'));
    p.dirty = false; p.confirmedLeave = true;
    back();
  } else {
    const c = { id: uid(), label, names: rows.map((r) => r.name) };
    S.classes.push(c);
    S.grades[c.id] = emptyClassData();
    await saveClassesNow();
    await store.saveGrades(c.id, S.grades[c.id]);
    toast(tr('أُنشئ الصف ✓'));
    p.dirty = false; p.confirmedLeave = true;
    S.stack.pop();
    S.stack.push({ name: 'class', p: { id: c.id } });
    history.replaceState({ depth: S.stack.length }, '');
    render({ scrollTop: true });
  }
}

async function deleteClass(id, { skipConfirm = false } = {}) {
  const c = cls(id);
  if (!c) return;
  const ok = skipConfirm || await confirmDialog({ title: T`حذف «${c.label}»؟`, text: T`سيُحذف ${students(c.names.length)} وكل درجاتهم من هذا الجهاز.`, ok: tr('حذف الصف'), danger: true });
  if (!ok) return;
  const pos = S.classes.indexOf(c);
  const data = dataOf(id);
  const sched = Array.isArray(S.settings.schedule) ? S.settings.schedule.slice() : [];
  S.classes.splice(pos, 1);
  delete S.grades[id];
  await saveClassesNow();
  await store.deleteGrades(id);
  if (sched.some((x) => x && x.classId === id)) { S.settings.schedule = sched.filter((x) => !x || x.classId !== id); await saveSettingsNow(); syncReminders().catch(() => {}); }
  S.stack = [{ name: 'home', p: {} }];
  history.replaceState({ depth: 1 }, '');
  render({ scrollTop: true });
  toast(T`حُذف «${c.label}»`, {
    ms: CONFIG.undoDeleteMs,
    action: { label: tr('تراجع'), fn: async () => {
      S.classes.splice(Math.min(pos, S.classes.length), 0, c);
      S.grades[id] = data;
      await saveClassesNow();
      await store.saveGrades(id, data);
      if (sched.length !== (S.settings.schedule || []).length) { S.settings.schedule = sched; await saveSettingsNow(); syncReminders().catch(() => {}); }
      render();
      toast(tr('أُعيد الصف ✓'));
    } },
  });
}

// معاينة الأسماء المستوردة من ملف قبل الإضافة
const IMPORT_ACCEPT = '.xlsx,.xls,.csv,.txt,.pdf,.jpg,.jpeg,.png,application/pdf,text/csv,text/plain,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// يختار ملفًا ويقرأ الأسماء منه (مع تقدّم القراءة الضوئية). يرجع null عند الإلغاء أو الخطأ.
async function pickAndReadNames() {
  const file = await platform.pickFile(IMPORT_ACCEPT);
  if (!file) return null;
  let close = toast(tr('جارٍ قراءة الملف…'), { ms: 0 });
  let lastPct = -1;
  const onProgress = (pr) => {
    if (!pr || pr.stage !== 'ocr') return;
    const pct = Math.round(((pr.page - 1 + (pr.ratio || 0)) / (pr.pages || 1)) * 100);
    if (pct === lastPct || pct % 5) return;
    lastPct = pct;
    close();
    close = toast(T`نقرأ الأسماء من الصورة… ${ar(pct)}% (صفحة ${ar(pr.page)} من ${ar(pr.pages)})`, { ms: 0 });
  };
  try {
    const { readNamesFromFile } = await import('./importers.js');
    const res = await readNamesFromFile(file, { onProgress });
    close();
    res.fileLabel = String(file.name || '').replace(/\.[^.]+$/, '');
    return res;
  } catch (e) {
    close();
    toast(e && e.message && /[\u0600-\u06FF]/.test(e.message) ? e.message : tr('تعذّرت قراءة الملف. جرّب حفظه بصيغة xlsx أو انسخ الأسماء والصقها.'), { err: true, ms: 6000 });
    return null;
  }
}

const OCR_NOTE = () => T`<div class="alert warn">${icon('eye')}<div class="grow"><strong>قُرئت الأسماء من صورة</strong><p style="margin:0">القراءة الآلية قد تخطئ في بعض الحروف؛ راجع الأسماء وصحّحها.</p></div></div>`;

// ملف فيه أكثر من صف: يختار المعلم صفًا واحدًا، أو ينشئ كل الصفوف
function chooseGroup(res, { allowCreateAll = true } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const s = openSheet(T`<h2>الملف فيه ${ar(res.groups.length)} صفوف</h2>
      <p>اختر الصف الذي تريد استيراد طلابه${allowCreateAll ? tr('، أو أنشئ كل الصفوف مرة واحدة') : ''}.</p>
      <div class="list">${res.groups.map((g, i) => `<button type="button" class="list-item" data-g="${i}">${icon('users')}<span class="grow"><strong>${esc(g.label)}</strong><small>${students(g.names.length)}</small></span>${icon('fwd')}</button>`).join('')}</div>
      <div class="actions">${allowCreateAll ? T`<button type="button" class="btn primary" data-g="all">${icon('plus')} أنشئ كل الصفوف (${ar(res.groups.length)})</button>` : ''}<button type="button" class="btn" data-g="cancel">إلغاء</button></div>`,
      { label: tr('اختيار الصف'), onClose: () => resolve(result) });
    s.sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      const v = b.dataset.g;
      result = v === 'cancel' ? null : v === 'all' ? 'all' : res.groups[+v];
      s.close();
    });
  });
}

// إنشاء عدة صفوف من ملف واحد (من الرئيسية أو من المحرر)
async function createClassesFromGroups(groups, ocr) {
  return new Promise((resolve) => {
    const s = openSheet(T`<h2>إنشاء ${ar(groups.length)} صفوف</h2>
      <p>عدّل اسم أي صف أو ألغِ تحديده. يمكنك مراجعة أسماء الطلاب لاحقًا من «الطلاب» داخل كل صف.</p>
      ${ocr ? OCR_NOTE() : ''}
      <div class="list">${groups.map((g, i) => T`<div class="pick"><input type="checkbox" data-cg="${i}" checked aria-label="تحديد"><input class="input grow" data-cg-label="${i}" value="${esc(g.label)}" aria-label="اسم الصف"><span class="meta num">${students(cleanNames(g.names, [], MAX_STUDENTS).names.length)}</span></div>`).join('')}</div>
      <div class="actions"><button type="button" class="btn" data-cx="0">إلغاء</button><button type="button" class="btn primary" data-cx="1">إنشاء الصفوف</button></div>`, { wide: true, label: tr('إنشاء الصفوف'), onClose: () => resolve(created) });
    let created = 0;
    s.sheet.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cx]');
      if (!b) return;
      if (b.dataset.cx === '1') {
        for (const x of s.sheet.querySelectorAll('[data-cg]:checked')) {
          const i = +x.dataset.cg;
          const label = s.sheet.querySelector(`[data-cg-label="${i}"]`).value.trim() || groups[i].label;
          const c = { id: uid(), label, names: cleanNames(groups[i].names, [], MAX_STUDENTS).names };
          S.classes.push(c);
          S.grades[c.id] = emptyClassData();
          await store.saveGrades(c.id, S.grades[c.id]);
          created++;
        }
        if (created) await saveClassesNow();
      }
      s.close();
    });
  });
}

async function importClassesFromFile() {
  const res = await pickAndReadNames();
  if (!res) return;
  const ocr = res.ocr || /ocr/.test(res.kind || '');
  const groups = res.groups || [{ label: res.label || res.fileLabel || tr('صف جديد'), names: res.names }];
  const n = await createClassesFromGroups(groups, ocr);
  if (n) {
    S.stack = [{ name: 'home', p: {} }];
    history.replaceState({ depth: 1 }, '');
    render({ scrollTop: true });
    toast(n === 1 ? tr('أُنشئ الصف ✓') : T`أُنشئت ${ar(n)} صفوف ✓`);
  }
}

async function importFileToDraft(p) {
  const res0 = await pickAndReadNames();
  if (!res0) return;
  let res = res0;
  if (res.groups) {
    const g = await chooseGroup(res, { allowCreateAll: !p.id && !p.draft.rows.length });
    if (!g) return;
    if (g === 'all') {
      const n = await createClassesFromGroups(res.groups, res.ocr || /ocr/.test(res.kind || ''));
      if (n) { p.dirty = false; p.confirmedLeave = true; S.stack = [{ name: 'home', p: {} }]; history.replaceState({ depth: 1 }, ''); render({ scrollTop: true }); toast(T`أُنشئت ${ar(n)} صفوف ✓`); }
      return;
    }
    res = { ...res, names: g.names, label: g.label };
  }
  if (res.label && !p.draft.label) { p.draft.label = res.label; const inp = document.getElementById('cls-label'); if (inp) inp.value = res.label; }
  const existing = p.draft.rows.map((r) => r.name);
  const cleaned = cleanNames(res.names, existing, 999);
  if (!cleaned.names.length) {
    toast(cleaned.dup ? T`كل الأسماء موجودة مسبقًا (${ar(cleaned.dup)})` : tr('لم نجد أسماء طلاب في هذا الملف'), { err: !cleaned.dup });
    return;
  }
  const kindName = { xlsx: 'Excel', csv: 'CSV', txt: tr('ملف نصي'), pdf: 'PDF', 'pdf-ocr': 'PDF', 'image-ocr': tr('الصورة') }[res.kind] || tr('الملف');
  const ocr = res.ocr || /ocr/.test(res.kind || '');
  const room = MAX_STUDENTS - p.draft.rows.length;
  const s = openSheet(T`<h2>وجدنا ${namesWord(cleaned.names.length)} في ${kindName}</h2>
    <p>${res.column ? T`من عمود «${esc(res.column)}». ` : ''}ألغِ تحديد أي سطر ليس اسم طالب، ويمكنك تصحيح أي اسم قبل الإضافة.${cleaned.dup ? T` (تجاهلنا ${ar(cleaned.dup)} مكرر)` : ''}</p>
    ${ocr ? T`<div class="alert warn">${icon('eye')}<div class="grow"><strong>قُرئت الأسماء من صورة</strong><p style="margin:0">القراءة الآلية قد تخطئ في بعض الحروف؛ راجع الأسماء وصحّحها هنا أو لاحقًا من قائمة الطلاب.</p></div></div>` : ''}
    ${cleaned.names.length > room ? T`<div class="alert warn">${icon('warn')}<div class="grow">يتسع الفصل لـ ${ar(room)} فقط؛ سيُضاف أول ${ar(room)} محدد.</div></div>` : ''}
    <div class="row" style="justify-content:space-between;margin:8px 0"><span class="count-badge num" data-count></span>
      <span><button type="button" class="btn sm ghost" data-pick-all="1">تحديد الكل</button><button type="button" class="btn sm ghost" data-pick-all="0">إلغاء الكل</button></span></div>
    <div class="list" style="max-height:46vh;overflow:auto">${cleaned.names.map((nm, j) => T`<div class="pick"><input type="checkbox" data-pick="${j}" checked aria-label="تحديد"><input class="input grow" data-pick-name="${j}" value="${esc(nm)}" aria-label="الاسم ${ar(j + 1)}"></div>`).join('')}</div>
    <div class="actions"><button type="button" class="btn" data-x="cancel">إلغاء</button><button type="button" class="btn primary" data-x="ok">إضافة المحدد</button></div>`, { wide: true, label: tr('معاينة الأسماء') });
  const count = () => { s.sheet.querySelector('[data-count]').textContent = T`${ar(s.sheet.querySelectorAll('[data-pick]:checked').length)} محدد`; };
  count();
  s.sheet.addEventListener('change', count);
  s.sheet.addEventListener('click', (e) => {
    const all = e.target.closest('[data-pick-all]');
    if (all) { s.sheet.querySelectorAll('[data-pick]').forEach((x) => { x.checked = all.dataset.pickAll === '1'; }); count(); return; }
    const b = e.target.closest('[data-x]');
    if (!b) return;
    if (b.dataset.x === 'ok') {
      const picked = [...s.sheet.querySelectorAll('[data-pick]:checked')].map((x) => s.sheet.querySelector(`[data-pick-name="${x.dataset.pick}"]`).value);
      s.close();
      addNamesToDraft(p, picked);
      render();
    } else s.close();
  });
}

// =====================================================================
// نقل الطلاب — إرسال (لمعلم آخر أو لصف آخر على نفس الجهاز)
// =====================================================================
function TransferOut(p) {
  const c = cls(p.id);
  if (!c) return Home();
  p.sel ||= new Set();
  const d = dataOf(c.id);
  const q = S.ui.search.trim();
  const qk = q ? nameKey(q) : '';
  const list = c.names.map((nm, i) => ({ nm, i })).filter(({ nm, i }) => !qk || nameKey(nm).includes(qk) || String(i + 1) === q);
  const k = p.sel.size;
  return T`${appbar({ title: tr('نقل طلاب'), sub: esc(c.label) })}
  <div class="wrap stack">
    <div class="alert info">${icon('info')}<div class="grow"><strong>اختر الطلاب المنقولين</strong><p style="margin:0">تنتقل أسماؤهم مع كل درجاتهم الأسبوعية والنهائية. أرسل الملف للمعلم الجديد (واتساب أو بريد) ليستقبله من «استقبال طلاب منقولين»، أو انقلهم لصف آخر عندك.</p></div></div>
    <div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب" value="${esc(q)}" aria-label="بحث"></div>
    <div class="row" style="justify-content:space-between"><span class="count-badge num">${k ? T`اخترت ${students(k)}` : tr('لم تختر أحدًا')}</span>
      <span><button type="button" class="btn sm ghost" data-act="sel-all" data-v="1">تحديد الكل</button><button type="button" class="btn sm ghost" data-act="sel-all" data-v="0">إلغاء الكل</button></span></div>
    <div class="list">${list.map(({ nm, i }) => `<label class="pick"><input type="checkbox" data-sel="${i}" ${p.sel.has(i) ? 'checked' : ''}><span class="stu-num num">${ar(i + 1)}</span><span class="grow">${esc(nm)}</span>${studentHasGrades(d, i) ? tr('<span class="meta">له درجات</span>') : ''}</label>`).join('') || tr('<p class="hint" style="padding:16px">لا نتائج</p>')}</div>
    <div class="card stack" style="position:sticky;bottom:calc(var(--safe-b) + 8px);box-shadow:var(--shadow-lg)">
      <button type="button" class="btn primary block" data-act="transfer-file" ${k ? '' : 'disabled'}>${icon('send')} حفظ ملف النقل وإرساله لمعلم آخر</button>
      <button type="button" class="btn block" data-act="transfer-move" ${k && S.classes.length > 0 ? '' : 'disabled'}>${icon('move')} نقل إلى صف آخر عندي</button>
    </div>
  </div>`;
}

async function doTransferFile(p) {
  const c = cls(p.id);
  const idxs = [...p.sel].sort((a, b) => a - b);
  const xfer = buildTransfer({ classLabel: c.label, names: c.names, data: dataOf(c.id), idxs, settings: S.settings });
  const name = transferFileName(c.label, idxs.length);
  try {
    await platform.saveFile(name, new Blob([JSON.stringify(xfer)], { type: 'application/json' }), 'application/json');
  } catch { toast(tr('تعذّر حفظ الملف'), { err: true }); return; }
  const remove = await confirmDialog({ title: tr('هل انتقل الطلاب فعلًا؟'), text: T`يمكنك حذف ${students(idxs.length)} من «${c.label}» الآن، أو إبقاؤهم إن كنت أرسلت نسخة فقط.`, ok: tr('نعم، احذفهم من صفّي'), cancel: tr('أبقهم'), danger: true });
  if (remove) {
    const keep = c.names.map((_, i) => i).filter((i) => !p.sel.has(i));
    const before = { names: c.names.slice(), data: dataOf(c.id) };
    c.names = keep.map((i) => before.names[i]);
    S.grades[c.id] = remapData(before.data, keep);
    await saveClassesNow(); await store.saveGrades(c.id, S.grades[c.id]);
    liveResync(c.id);
    p.sel = new Set();
    render();
    toast(T`حُذف ${students(idxs.length)} من الصف`, { ms: CONFIG.undoDeleteMs, action: { label: tr('تراجع'), fn: async () => {
      c.names = before.names; S.grades[c.id] = before.data;
      await saveClassesNow(); await store.saveGrades(c.id, before.data); liveResync(c.id); render();
    } } });
  } else toast(tr('حُفظ ملف النقل ✓'));
}

function doTransferMove(p) {
  const c = cls(p.id);
  const others = S.classes.filter((x) => x.id !== c.id);
  const s = openSheet(T`<h2>نقل ${students(p.sel.size)} إلى…</h2><p>تنتقل الدرجات معهم وتُحذف من «${esc(c.label)}».</p>
    <div class="list">${others.map((o) => `<button type="button" class="list-item" data-to-cls="${o.id}">${icon('users')}<span class="grow"><strong>${esc(o.label)}</strong><small>${students(o.names.length)}</small></span>${icon('fwd')}</button>`).join('')}
    <button type="button" class="list-item" data-to-cls="__new">${icon('plus')}<span class="grow"><strong>صف جديد</strong><small>أنشئ صفًا بهؤلاء الطلاب</small></span></button></div>
    <div class="actions"><button type="button" class="btn" data-x>إلغاء</button></div>`, { label: tr('نقل إلى صف') });
  s.sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) return s.close();
    const b = e.target.closest('[data-to-cls]');
    if (!b) return;
    let dst;
    if (b.dataset.toCls === '__new') {
      dst = { id: uid(), label: T`${c.label} (منقولون)`, names: [] };
      S.classes.push(dst); S.grades[dst.id] = emptyClassData();
    } else dst = cls(b.dataset.toCls);
    s.close();
    const res = moveStudents({ src: { names: c.names, data: dataOf(c.id) }, dst: { names: dst.names, data: dataOf(dst.id) }, idxs: [...p.sel].sort((a, b2) => a - b2) });
    c.names = res.src.names; S.grades[c.id] = res.src.data;
    dst.names = res.dst.names; S.grades[dst.id] = res.dst.data;
    await saveClassesNow(); await store.saveGrades(c.id, S.grades[c.id]); await store.saveGrades(dst.id, S.grades[dst.id]);
    liveResync(c.id); liveResync(dst.id);
    p.sel = new Set();
    const parts = [T`نُقل ${students(res.moved)} إلى «${dst.label}»`];
    if (res.dup) parts.push(T`${ar(res.dup)} موجود مسبقًا`);
    if (res.overLimit) parts.push(T`${ar(res.overLimit)} فوق الحد`);
    toast(parts.join(' · '));
    render();
  });
}

// =====================================================================
// نقل الطلاب — استقبال
// =====================================================================
function TransferIn(p) {
  if (!p.tr) {
    return T`${appbar({ title: tr('استقبال طلاب منقولين') })}
    <div class="wrap stack">
      <div class="empty card">${ART_USERS}<h2>اختر ملف النقل</h2><p>ملف ينتهي بـ ‎.json أرسله لك معلم آخر من «نقل طلاب». يحوي أسماء الطلاب ودرجاتهم.</p>
        <button type="button" class="btn primary lg" data-act="pick-transfer">${icon('upload')} اختيار الملف</button></div>
      <p class="hint">${icon('info')} لإضافة أسماء فقط (بدون درجات) من Excel أو PDF استعمل «الطلاب» داخل الصف.</p>
    </div>`;
  }
  const xfer = p.tr;
  p.pick ||= new Set(xfer.students.map((_, i) => i));
  p.target ||= p.id && cls(p.id) ? p.id : '__new';
  p.newLabel ??= xfer.from.classLabel || '';
  p.per ||= {}; // صف كل طالب عند «التوزيع على أكثر من صف» (الفهرس ← معرّف الصف أو __new)
  const tgtOf = (i) => (p.split && p.per[i]) || p.target;
  const needNew = p.target === '__new' || (p.split && [...p.pick].some((i) => tgtOf(i) === '__new'));
  const opts = (sel) => S.classes.map((o) => `<option value="${o.id}" ${sel === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('') + `<option value="__new" ${sel === '__new' ? 'selected' : ''}>${tr('صف جديد')}</option>`;
  const count = (st) => { let n = 0; for (const w of Object.values(st.weeks || {})) n += (w || []).filter((v) => v != null).length; return n + (st.fin || []).filter((v) => v != null).length; };
  return T`${appbar({ title: tr('استقبال طلاب منقولين') })}
  <div class="wrap stack">
    <div class="card"><div class="kv">
      <div>من المعلم</div><div>${esc(xfer.from.teacher || '—')}</div>
      <div>الصف الأصلي</div><div>${esc(xfer.from.classLabel || '—')}</div>
      <div>المادة</div><div>${esc(xfer.from.subject || '—')}</div>
      <div>تاريخ الملف</div><div class="num">${xfer.at ? ar(new Date(xfer.at).toLocaleDateString('en-GB')) : '—'}</div>
    </div></div>
    <div class="section-title">أضفهم إلى</div>
    <div class="list">
      ${S.classes.map((o) => `<label class="pick"><input type="radio" name="tgt" data-tgt="${o.id}" ${p.target === o.id ? 'checked' : ''}><span class="grow"><strong>${esc(o.label)}</strong> <small class="muted">${students(o.names.length)}</small></span></label>`).join('')}
      <label class="pick"><input type="radio" name="tgt" data-tgt="__new" ${p.target === '__new' ? 'checked' : ''}><span class="grow"><strong>صف جديد</strong></span></label>
    </div>
    ${S.classes.length ? T`<label class="toggle-line split-toggle"><input type="checkbox" class="switch" data-split ${p.split ? 'checked' : ''}> توزيع على أكثر من صف <small class="muted">(اختر صف كل طالب)</small></label>` : ''}
    ${needNew ? T`<div class="field"><label for="new-label">اسم الصف الجديد</label><input id="new-label" class="input" data-new-label value="${esc(p.newLabel)}" placeholder="مثل: العاشر / 3"></div>` : ''}
    <div class="row" style="justify-content:space-between;margin-top:12px"><span class="count-badge num">${ar(p.pick.size)} من ${ar(xfer.students.length)}</span>
      <span><button type="button" class="btn sm ghost" data-act="pick-all" data-v="1">تحديد الكل</button><button type="button" class="btn sm ghost" data-act="pick-all" data-v="0">إلغاء الكل</button></span></div>
    <div class="list">${xfer.students.map((st, i) => `<div class="pick-row ${p.split ? 'split' : ''}"><label class="pick"><input type="checkbox" data-pick-st="${i}" ${p.pick.has(i) ? 'checked' : ''}><span class="grow">${esc(st.name)}</span><span class="meta">${count(st) ? T`${ar(count(st))} درجة` : tr('بدون درجات')}</span></label>${p.split ? `<select class="select st-tgt" data-st-tgt="${i}" aria-label="${tr('الصف')} — ${esc(st.name)}" ${p.pick.has(i) ? '' : 'disabled'}>${opts(tgtOf(i))}</select>` : ''}</div>`).join('')}</div>
    <button type="button" class="btn primary lg block" data-act="apply-transfer" ${p.pick.size ? '' : 'disabled'}>${icon('check')} إضافة ${students(p.pick.size)}</button>
  </div>`;
}

async function pickTransfer(p) {
  const file = await platform.pickFile('.json,application/json');
  if (!file) return;
  try {
    const xfer = parseTransfer(await file.text());
    p.tr = xfer; p.pick = null;
    render();
  } catch (e) {
    toast(e && /[؀-ۿ]/.test(e.message || '') ? e.message : tr('هذا ليس ملف نقل طلاب صالحًا'), { err: true, ms: 5000 });
  }
}

async function applyTransferUI(p) {
  // نجمع الطلاب المحددين حسب صف كل واحد (صف واحد للكل، أو صف لكل طالب عند التوزيع)
  const groups = new Map();
  for (const i of [...p.pick].sort((a, b) => a - b)) {
    const t = (p.split && p.per && p.per[i]) || p.target;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(i);
  }
  const parts = [];
  let last = null;
  for (const [t, idxs] of groups) {
    let target;
    if (t === '__new') {
      const label = (p.newLabel || '').trim() || tr('صف منقول');
      target = { id: uid(), label, names: [] };
      S.classes.push(target); S.grades[target.id] = emptyClassData();
    } else target = cls(t);
    if (!target) continue;
    const res = applyTransfer({ names: target.names, data: dataOf(target.id) }, p.tr, idxs, MAX_STUDENTS);
    target.names = res.names; S.grades[target.id] = res.data;
    await store.saveGrades(target.id, res.data);
    liveResync(target.id);
    let msg = T`أُضيف ${students(res.added)} إلى «${target.label}»`;
    if (res.dup) msg += ' · ' + T`${ar(res.dup)} موجود مسبقًا`;
    if (res.overLimit) msg += ' · ' + T`${ar(res.overLimit)} فوق الحد`;
    parts.push(msg);
    last = target;
  }
  await saveClassesNow();
  toast(parts.join('\n'), { ms: 4500 + 1500 * (parts.length - 1) });
  // صف واحد: افتحه. أكثر من صف: الرئيسية
  S.stack = groups.size === 1 && last ? [{ name: 'home', p: {} }, { name: 'class', p: { id: last.id } }] : [{ name: 'home', p: {} }];
  history.replaceState({ depth: S.stack.length }, '');
  render({ scrollTop: true });
}

// =====================================================================
// الشاشة ٥ — الإعدادات
// =====================================================================
function Settings() {
  const st = S.settings;
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-act="set" data-key="${key}" data-v="${v}" aria-pressed="${String(st[key]) === String(v)}">${l}</button>`).join('')}</div>`;
  const sw = (key, label, hint = '') => `<label class="list-item"><span class="grow"><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" class="switch" data-setting-bool="${key}" ${st[key] ? 'checked' : ''}></label>`;
  const inst = platform.isNative ? tr('مثبّت كتطبيق أندرويد') : platform.isStandalone ? tr('مثبّت على الشاشة الرئيسية') : tr('يعمل داخل المتصفح');
  return T`${appbar({ title: tr('الإعدادات'), backBtn: false, save: true })}
  <div class="wrap stack">
    ${REMOTE ? '' : T`<div class="section-title">التحديثات</div>
    <div class="card stack" data-testid="update-card">${updateCardHTML()}</div>`}

    ${CLOUD_ON ? (C.session ? T`<div class="section-title">الحساب والمزامنة</div>
    <div class="list">
      <div class="list-item">${icon('user')}<span class="grow"><strong dir="ltr" style="text-align:start">${esc(C.session.u)}</strong><small data-cloud-state>${tr(CLOUD_TEXT[C.state] || '')}</small></span>${icon('lock')}</div>
      <button type="button" class="list-item" data-act="cloud-account">${icon('edit')}<span class="grow"><strong>تغيير اسم المستخدم أو كلمة السر</strong></span>${icon('fwd')}</button>
      <button type="button" class="list-item" data-act="cloud-sync">${icon('refresh')}<span class="grow"><strong>مزامنة الآن</strong><small>${C.session.eph ? tr('جلسة مؤقتة: لا يُحفظ شيء على هذا الجهاز') : tr('درجاتك على هذا الجهاز + نسخة مشفّرة في حسابك')}</small></span></button>
      <button type="button" class="list-item" data-act="cloud-logout">${icon('logout')}<span class="grow"><strong>خروج من الحساب</strong></span></button>
    </div>` : T`<div class="section-title">الحساب والمزامنة</div>
    <div class="list">
      <button type="button" class="list-item" data-act="cloud-login">${icon('cloud')}<span class="grow"><strong>تسجيل الدخول</strong><small>احفظ درجاتك مشفّرة واستخدمها من الكمبيوتر — بدون ربط ولا QR</small></span>${icon('fwd')}</button>
    </div>`) : ''}

    <div class="section-title">بياناتي</div>
    <div class="card stack">
      <div class="field"><label for="s-teacher">اسم المعلم</label><input id="s-teacher" class="input" data-setting="teacher" value="${esc(st.teacher)}" placeholder="مثل: يوسف أحمد" autocomplete="name"></div>
      <div class="field"><label for="s-subject">المادة (المجال الدراسي)</label><input id="s-subject" class="input" data-setting="subject" value="${esc(st.subject)}" placeholder="مثل: الحاسوب"></div>
      <div class="field"><label for="s-year">العام الدراسي</label><input id="s-year" class="input" data-setting="year" value="${esc(st.year)}" placeholder="مثل: 2026 / 2027"></div>
      <p class="hint">تظهر في رأس الكشوف والتقارير وبطاقة الطالب.</p>
    </div>

    <div class="section-title">طريقة الرصد</div>
    <div class="card stack">
      <div class="field"><span class="label">إدخال الدرجة</span>${seg('inputMode', [['chips', tr('سلايدر')], ['fields', tr('كتابة الرقم')]])}
        <p class="hint">السلايدر: اضغط المربع واسحب من 0 إلى 5. كتابة الرقم: اكتب ثم Enter. (على الكمبيوتر يظهر جدول دائمًا)</p></div>
    </div>
    <div class="list">
      ${sw('autoAdvance', tr('الانتقال التلقائي للطالب التالي'), tr('بعد إكمال درجات طالب'))}
      ${sw('haptics', tr('الاهتزاز الخفيف'), tr('عند «كامل» والغياب والتعبئة السريعة'))}
    </div>

    <div class="section-title">المظهر</div>
    <div class="card stack">
      ${REMOTE ? '' : T`<div class="field"><span class="label">اللغة · Language</span><div class="seg" role="group"><button type="button" data-act="set-lang" data-v="ar" aria-pressed="${lang() === 'ar'}">العربية</button><button type="button" data-act="set-lang" data-v="en" aria-pressed="${lang() === 'en'}">English</button></div></div>`}
      <div class="field"><span class="label">الألوان</span>${seg('theme', [['auto', tr('تلقائي')], ['light', tr('فاتح')], ['dark', tr('داكن')]])}</div>
      <div class="field"><span class="label">حجم الخط</span>${seg('textScale', [['normal', tr('عادي')], ['large', tr('كبير')]])}</div>
    </div>

    <div class="section-title">التطبيق</div>
    <div class="list">
      <div class="list-item"><span class="grow"><strong>طريقة التشغيل</strong><small>${inst}</small></span></div>
      <button type="button" class="list-item" data-act="go" data-to="guide">${icon('phone')}<span class="grow"><strong>إرشادات التثبيت</strong><small>آيفون وأندرويد</small></span>${icon('fwd')}</button>
      <button type="button" class="list-item" data-act="tour">${icon('sparkle')}<span class="grow"><strong>إعادة الجولة التعريفية</strong></span>${icon('fwd')}</button>
      <button type="button" class="list-item" data-act="nav" data-to="tools">${icon('shield')}<span class="grow"><strong>النسخ الاحتياطي والبيانات</strong><small>في تبويب «الأدوات»</small></span>${icon('fwd')}</button>
      <div class="list-item">${icon('code')}<span class="grow"><strong>تخصيص الواجهة</strong><small>يمكن لأي معلم تعديل التطبيق بما يناسبه عبر Claude Code: افتح مجلد المشروع واطلب التعديل بالعربية. التفاصيل في ملف CLAUDE.md.</small></span></div>
    </div>

    ${REMOTE ? '' : T`<details class="card advanced">
      <summary>${icon('gear')} خيارات متقدمة (للفني فقط)</summary>
      <p class="hint">لا يحتاجها المعلم عادةً: رابط صفحة العرض مضبوط مسبقًا، والاتصال يعمل بدون خادم TURN في أغلب الشبكات.</p>
      <div class="field"><label for="s-view">رابط صفحة العرض</label><input id="s-view" class="input" dir="ltr" data-setting="viewUrl" value="${esc(st.viewUrl)}" placeholder="${esc(defaultViewUrl() || 'https://…/view.html')}"></div>
      <div class="field"><label for="s-turn">خادم TURN</label><input id="s-turn" class="input" dir="ltr" data-setting="turnUrl" value="${esc(st.turnUrl)}" placeholder="turn:example.com:3478"></div>
      <div class="meta-grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="s-tu">اسم المستخدم</label><input id="s-tu" class="input" dir="ltr" data-setting="turnUser" value="${esc(st.turnUser)}" autocomplete="off"></div>
        <div class="field"><label for="s-tp">كلمة المرور</label><input id="s-tp" class="input" dir="ltr" type="password" data-setting="turnPass" value="${esc(st.turnPass)}" autocomplete="off"></div>
      </div>
    </details>`}
    <p class="hint" style="text-align:center;margin:16px 0">${icon('shield')} ${REMOTE ? tr('وضع الإدارة: البيانات محفوظة في جوالك، ولا شيء يُحفظ على هذا الكمبيوتر.') : (C.session ? tr('درجاتك على هذا الجهاز، ونسخة مشفّرة بكلمة سرك في حسابك.') : tr('لا حسابات: كل الدرجات على هذا الجهاز فقط.'))}</p>
  </div>`;
}

// ===== التحديثات =====
const UPD = { state: 'idle', worker: null, build: '' };
function updateCardHTML() {
  const ver = T`الإصدار ${ar(CONFIG.version)}${CONFIG.releaseDate ? ` — ${ar(CONFIG.releaseDate.split('-').reverse().join('/'))}` : ''}`;
  const news = CHANGELOG.slice(0, 5).map((e) => `<li><b class="num">${ar(e.version)}</b> <small class="muted num">${ar(String(e.date || '').split('-').reverse().join('/'))}</small>${e.items.length ? `<ul>${e.items.map((x) => `<li>${esc(tr(x))}</li>`).join('')}</ul>` : ''}</li>`).join('');
  const newsBox = news ? T`<details class="whats-new"><summary>${icon('sparkle')} ما الجديد</summary><ul class="changelog">${news}</ul></details>` : '';
  if (platform.isNative) {
    return T`<div class="row"><span class="grow"><strong>${ver}</strong><small class="muted" style="display:block">تطبيق أندرويد</small></span></div>
      <p class="hint">يتحدّث تطبيق أندرويد بتثبيت ملف APK الجديد الذي يصلك؛ يُثبَّت فوق القديم وتبقى الدرجات.</p>${newsBox}`;
  }
  const st = UPD.state;
  const line = st === 'ready' ? T`<span class="status-pill">${icon('download')} تحديث جديد جاهز</span>`
    : st === 'checking' ? T`<span class="status-pill">${icon('refresh')} جارٍ البحث…</span>`
      : st === 'latest' ? T`<span class="status-pill ok">${icon('checkCircle')} عندك آخر إصدار</span>`
        : st === 'offline' ? T`<span class="status-pill">${icon('wifi')} لا يوجد اتصال بالإنترنت</span>` : '';
  return `<div class="row" style="justify-content:space-between;flex-wrap:wrap"><strong>${ver}</strong>${line}</div>
    ${st === 'ready'
      ? T`<button type="button" class="btn primary block" data-act="update-now">${icon('refresh')} حدّث الآن</button><p class="hint">يُعاد تشغيل التطبيق بالنسخة الجديدة. درجاتك لا تتأثر.</p>`
      : T`<button type="button" class="btn block" data-act="update-check" ${st === 'checking' ? 'disabled' : ''}>${icon('refresh')} ابحث عن تحديث</button><p class="hint">التحديثات تصل تلقائيًا عند فتح التطبيق مع اتصال بالإنترنت.</p>`}${newsBox}`;
}
function paintUpdate() {
  const card = document.querySelector('[data-testid="update-card"]');
  if (card) card.innerHTML = updateCardHTML();
}
// رقم الإصدار المنشور فعليًا (بلا ذاكرة مؤقتة) — حتى لو علق المتصفح على نسخة قديمة
async function publishedVersion() {
  try {
    const t = await (await fetch('config.js?v=' + Date.now(), { cache: 'no-store' })).text();
    const m = /version:\s*'([\d.]+)'/.exec(t);
    return m ? m[1] : null;
  } catch { return null; }
}
const newerThan = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkForUpdate({ quiet = false } = {}) {
  if (!navigator.onLine) { UPD.state = 'offline'; paintUpdate(); if (!quiet) toast(tr('لا يوجد اتصال بالإنترنت'), { err: true }); return; }
  UPD.state = 'checking'; paintUpdate();
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update();
      const w = reg.waiting || reg.installing;
      if (w && w.state !== 'installed') await new Promise((res) => { w.addEventListener('statechange', () => { if (w.state === 'installed' || w.state === 'redundant') res(); }); setTimeout(res, 20000); });
      if (w && w.state === 'installed') { UPD.state = 'ready'; UPD.worker = w; }
    }
    if (UPD.state !== 'ready') {
      const pub = await publishedVersion();
      if (pub && newerThan(pub, CONFIG.version)) { UPD.state = 'ready'; UPD.worker = null; UPD.hard = true; } // المتصفح عالق: تحديث كامل
      else UPD.state = 'latest';
    }
  } catch { UPD.state = navigator.onLine ? 'latest' : 'offline'; }
  paintUpdate();
  if (!quiet) toast(UPD.state === 'ready' ? tr('تحديث جديد جاهز — اضغط «حدّث الآن»') : UPD.state === 'latest' ? tr('عندك آخر إصدار ✓') : tr('لا يوجد اتصال بالإنترنت'), { err: UPD.state === 'offline', action: UPD.state === 'ready' ? { label: tr('حدّث الآن'), fn: applyUpdate } : undefined });
}
// تطبيق التحديث: عبر الـ Service Worker، أو تحديث كامل (مسح نسخ الملفات المخزّنة فقط — الدرجات لا تُلمس)
async function applyUpdate() {
  if (S.dirty.size) await flushSave();
  if (UPD.worker && !UPD.hard) { UPD.worker.postMessage({ type: 'skip-waiting' }); return; }
  try { if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('grades-')) await caches.delete(k); } catch { /* */ }
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.unregister(); } catch { /* */ }
  location.replace(location.pathname + '?u=' + Date.now() + location.hash);
}

let settingsTimer = null;
function onSettingInput(key, value) {
  S.settings[key] = value;
  setSaveState('saving');
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => { await saveSettingsNow(); setSaveState('saved'); }, 300);
}

// =====================================================================
// إرشادات التثبيت
// =====================================================================
function Guide() {
  const ios = T`<ol class="ios-steps">
    <li><span class="pic">${icon('shareIos')}</span><span><strong>1. اضغط زر المشاركة</strong><br><span class="muted">في أسفل Safari (مربع وسهم للأعلى)</span></span></li>
    <li><span class="pic">${icon('plusSquare')}</span><span><strong>2. اختر «إضافة إلى الشاشة الرئيسية»</strong><br><span class="muted">مرّر القائمة للأسفل إن لم تظهر</span></span></li>
    <li><span class="pic">${icon('check')}</span><span><strong>3. اضغط «إضافة»</strong><br><span class="muted">ثم افتح التطبيق دائمًا من أيقونته</span></span></li>
  </ol>`;
  const android = T`<ol class="ios-steps">
    <li><span class="pic">${icon('download')}</span><span><strong>تطبيق APK</strong><br><span class="muted">ثبّت ملف APK الذي يوزعه المعلم المسؤول (اسمح بالتثبيت من هذا المصدر).</span></span></li>
    <li><span class="pic">${icon('more')}</span><span><strong>أو من Chrome</strong><br><span class="muted">القائمة ⋮ ثم «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</span></span></li>
  </ol>`;
  return T`${appbar({ title: tr('تثبيت التطبيق') })}
  <div class="wrap stack">
    ${platform.isIOS && !platform.isStandalone ? T`<div class="alert warn">${icon('warn')}<div class="grow"><strong>أنت الآن في المتصفح</strong><p style="margin:0">بيانات المواقع في Safari أقل حماية وقد تُمسح إذا لم تفتح الموقع لفترة. ثبّت التطبيق واحفظ نسخة احتياطية أسبوعيًا.</p></div></div>` : ''}
    <div class="section-title">آيفون وآيباد (Safari)</div>${ios}
    <div class="section-title">أندرويد</div>${android}
    <div class="alert info">${icon('shield')}<div class="grow"><strong>بياناتك على جهازك فقط</strong><p style="margin:0">لا يرسل التطبيق أي شيء للإنترنت. انقل بياناتك بين الأجهزة عبر «نسخة احتياطية» ثم «استرجاع نسخة».</p></div></div>
    ${platform.isIOS && !platform.isStandalone ? tr('<button type="button" class="btn block" data-act="dismiss-guide">متابعة في المتصفح على أي حال</button>') : ''}
  </div>`;
}

// =====================================================================
// الجولة التعريفية
// =====================================================================
const TOUR = [
  { t: tr('ارصد بضغطة واحدة'), d: tr('لكل طالب زر «كامل» يضع 5 في البنود الأربعة، وأزرار كبيرة لأي درجة أخرى. التطبيق يحفظ تلقائيًا ويعمل بدون إنترنت.'), art: ART_EMPTY },
  { t: tr('أضف طلابك بسهولة'), d: tr('الصق الأسماء أو استوردها من Excel أو PDF. وإذا انتقل طالب، أرسل درجاته لمعلمه الجديد بملف.'), art: ART_USERS },
  { t: tr('صدّر واعرض'), d: tr('صدّر كشف الإكسل الرسمي بضغطة، واعرض الدرجات مباشرة على شاشة الكمبيوتر عبر رمز QR. لا تنسَ النسخة الاحتياطية الأسبوعية.'), art: `<svg class="art" viewBox="0 0 200 150" aria-hidden="true"><rect x="20" y="24" width="120" height="80" rx="10" fill="var(--primary-soft)"/><rect x="34" y="38" width="92" height="8" rx="4" fill="var(--primary)"/><rect x="34" y="54" width="70" height="6" rx="3" fill="var(--border)"/><rect x="34" y="66" width="80" height="6" rx="3" fill="var(--border)"/><rect x="66" y="110" width="28" height="6" rx="3" fill="var(--border)"/><rect x="140" y="50" width="42" height="76" rx="8" fill="var(--card)" stroke="var(--primary)" stroke-width="3"/><rect x="150" y="66" width="22" height="22" rx="2" fill="var(--primary)"/></svg>` },
];
function showTour() {
  let i = 0;
  const s = openSheet('<div class="tour" data-tour></div>', { label: tr('جولة تعريفية'), onClose: async () => { S.settings.tourDone = true; await saveSettingsNow(); } });
  const paint = () => {
    const t = TOUR[i];
    s.sheet.querySelector('[data-tour]').innerHTML = T`${t.art}<h2>${t.t}</h2><p>${t.d}</p>
      <div class="dots">${TOUR.map((_, j) => `<span class="${j === i ? 'on' : ''}"></span>`).join('')}</div>
      <div class="actions"><button type="button" class="btn ghost" data-t="skip">تخطَّ</button><button type="button" class="btn primary" data-t="next">${i === TOUR.length - 1 ? tr('لنبدأ') : tr('التالي')}</button></div>`;
  };
  paint();
  s.sheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    if (b.dataset.t === 'skip' || i === TOUR.length - 1) s.close();
    else { i++; paint(); }
  });
}

// =====================================================================
// تسليم صف كامل (عهدة) لمعلم آخر
// =====================================================================
async function doHandover(c) {
  if (!c) return;
  if (S.dirty.size) await flushSave();
  const TX = await import('./transfer.js');
  const file = TX.buildClassHandover({ classLabel: c.label, names: c.names, data: dataOf(c.id), settings: S.settings });
  const name = TX.handoverFileName ? TX.handoverFileName(c.label) : T`تسليم_عهدة_${c.label}.json`;
  try {
    const r = await platform.saveFile(name, new Blob([JSON.stringify(file)], { type: 'application/json' }), 'application/json');
    if (r === 'cancelled') return;
  } catch { toast(tr('تعذّر حفظ ملف التسليم'), { err: true }); return; }
  const del = await confirmDialog({ title: T`سلّمت «${c.label}»؟`, text: tr('أرسل الملف للمعلم الجديد (واتساب أو بريد) ليستقبله من «الأدوات ← استقبال صف أو طلاب». هل تحذف الصف من جهازك الآن؟ (احتفظ به إن لم تتأكد من وصول الملف)'), ok: tr('احذفها من جهازي'), cancel: tr('أبقها'), danger: true });
  if (del) await deleteClass(c.id, { skipConfirm: true });
  else toast(tr('حُفظ ملف التسليم ✓'));
}

// =====================================================================
// التقارير: نطبع تقريرًا منسّقًا (أو نحفظه PDF من نافذة الطباعة)
// =====================================================================
async function printReport(kind, c, idx) {
  if (!c) return;
  if (S.dirty.size) await flushSave();
  let R;
  try { R = await import('./reports.js'); } catch { toast(tr('تعذّر تجهيز التقرير'), { err: true }); return; }
  const args = { classLabel: c.label, names: c.names, data: dataOf(c.id), settings: S.settings, idx };
  const html = kind === 'attendance' ? R.attendanceReportHTML(args) : kind === 'student' ? R.studentReportHTML(args) : R.gradesReportHTML({ ...args, part: 'all' });
  let css = document.getElementById('report-css');
  if (!css) { css = document.createElement('style'); css.id = 'report-css'; document.head.appendChild(css); }
  css.textContent = R.REPORT_CSS;
  let root = document.getElementById('print-root');
  if (!root) { root = document.createElement('div'); root.id = 'print-root'; document.body.appendChild(root); }
  root.innerHTML = html;
  const title = kind === 'attendance' ? T`كشف_الحضور_${c.label}` : kind === 'student' ? T`تقرير_${c.names[idx]}` : T`كشف_الدرجات_${c.label}`;
  const oldTitle = document.title;
  document.title = title.replace(/[\\/:*?"<>|]+/g, '_');
  try {
    const how = await platform.print(document.title);
    if (how === 'unsupported') toast(tr('الطباعة غير متاحة على هذا الجهاز. جرّب من الكمبيوتر أو صدّر Excel.'), { err: true, ms: 6000 });
  } catch { toast(tr('تعذّرت الطباعة على هذا الجهاز'), { err: true }); }
  setTimeout(() => { document.title = oldTitle; }, 1500);
}

function pickStudent(c, title) {
  return new Promise((resolve) => {
    let res = null;
    const s = openSheet(T`<h2>${esc(title)}</h2><div class="list" style="max-height:60vh;overflow:auto">${c.names.map((nm, i) => `<button type="button" class="list-item" data-ps="${i}"><span class="stu-num num">${ar(i + 1)}</span><span class="grow"><strong>${esc(nm)}</strong></span></button>`).join('')}</div>
      <div class="actions"><button type="button" class="btn" data-ps="">إلغاء</button></div>`, { label: title, onClose: () => resolve(res) });
    s.sheet.addEventListener('click', (e) => { const b = e.target.closest('[data-ps]'); if (!b) return; res = b.dataset.ps === '' ? null : +b.dataset.ps; s.close(); });
  });
}

// =====================================================================
// النسخ الاحتياطي والاسترجاع
// =====================================================================
function backupTip() {
  const where = platform.isIOS
    ? T`<p>نحفظ <b>نسختين</b> حتى تكون درجاتك بأمان:</p>
       <ol class="steps"><li><span class="n">${ar(1)}</span><span><b>على الجوال:</b> «حفظ في الملفات» ← <b>«على الآيفون»</b> ← «حفظ»</span></li>
       <li><span class="n">${ar(2)}</span><span><b>في iCloud:</b> «حفظ في الملفات» ← <b>«iCloud Drive»</b> ← «حفظ»</span></li></ol>
       <p class="hint">نسخة الجوال لا تخرج منه أبدًا. ونسخة iCloud في حسابك الشخصي فقط (لا يراها أحد غيرك)، وتبقى لو ضاع الجوال. إن ظهر «استبدال» فاضغطه.</p>`
    : platform.isNative
      ? T`<p>تُحفظ النسخة تلقائيًا في الجوال: <b>المستندات ← متابعة الدرجات</b>. ثم تظهر قائمة المشاركة: أرسلها أيضًا إلى <b>Google Drive</b> أو لنفسك على واتساب حتى تبقى لو ضاع الجوال.</p>`
      : T`<p>سيُحفظ ملف النسخة في مجلد التنزيلات أو تظهر قائمة المشاركة. احفظه في مكان آمن خاص بك (مثل iCloud Drive أو Google Drive) أو أرسله لنفسك.</p>`;
  return new Promise((resolve) => {
    let go = false;
    const s = openSheet(T`<h2>${icon('shield')} أين تُحفظ النسخة؟</h2>${where}
      <div class="actions"><button type="button" class="btn" data-x="0">لاحقًا</button><button type="button" class="btn primary" data-x="1" autofocus>فهمت، احفظ</button></div>`, { label: tr('النسخة الاحتياطية'), onClose: () => resolve(go) });
    s.sheet.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; go = b.dataset.x === '1'; s.close(); });
  });
}

async function doBackup() {
  // شرح مكان الحفظ أول مرة على الجوال فقط (على الكمبيوتر يُنزَّل الملف مباشرة)
  if (!S.meta.backupTipSeen && (platform.isIOS || platform.isAndroid)) {
    if (!(await backupTip())) return;
    S.meta.backupTipSeen = true;
    store.setMeta('backupTipSeen', true).catch(() => {});
  }
  if (S.dirty.size) await flushSave();
  const b = store.buildBackup({ classes: S.classes, settings: S.settings, data: S.grades });
  const blob = new Blob([JSON.stringify(b)], { type: 'application/json' });
  try {
    const r = await platform.saveFile(store.backupFileName(), blob, 'application/json');
    if (r === 'cancelled') return;
    if (platform.isIOS && !platform.isNative && r === 'shared') {
      // النسخة الثانية تحتاج ضغطة جديدة (قيود آبل على المشاركة)
      const second = await confirmDialog({ title: T`النسخة 1 ✓ — الآن النسخة 2 في iCloud`, text: tr('اضغط «احفظ في iCloud» ثم اختر «حفظ في الملفات» ← «iCloud Drive» ← «حفظ».'), ok: tr('احفظ في iCloud'), cancel: tr('تخطَّ') });
      if (second) {
        const r2 = await platform.shareFile(blob, store.backupFileName(), 'application/json');
        if (r2 === 'shared') { S.meta.lastCloudBackupAt = new Date().toISOString(); await store.setMeta('lastCloudBackupAt', S.meta.lastCloudBackupAt); }
      }
    }
    S.meta.lastBackupAt = new Date().toISOString();
    await store.setMeta('lastBackupAt', S.meta.lastBackupAt);
    S.meta.changedSinceBackup = null;
    await store.setMeta('changedSinceBackup', null);
    toast(tr('حُفظت النسخة الاحتياطية ✓'));
    if (['home', 'settings'].includes(route().name)) render();
  } catch { toast(tr('تعذّر حفظ النسخة'), { err: true }); }
}

async function doRestore() {
  const file = await platform.pickFile('.json,application/json');
  if (!file) return;
  let b;
  try { b = store.parseBackup(await file.text()); } catch (e) {
    toast(e && /[؀-ۿ]/.test(e.message || '') ? e.message : tr('هذا الملف ليس نسخة احتياطية صالحة'), { err: true, ms: 5000 });
    return;
  }
  const date = b.at ? ar(new Date(b.at).toLocaleDateString('en-GB')) : tr('غير معروف');
  const nStu = b.classes.reduce((a, c) => a + c.names.length, 0);
  const ok = await confirmDialog({ title: tr('استرجاع النسخة؟'), text: T`نسخة بتاريخ ${date} فيها ${ar(b.classes.length)} صف و${students(nStu)}. ستُستبدل كل البيانات الحالية على هذا الجهاز.`, ok: tr('استرجاع واستبدال'), danger: true });
  if (!ok) return;
  await store.replaceAll({ classes: b.classes, settings: b.settings, data: b.data });
  await loadState();
  S.meta.lastBackupAt = new Date().toISOString();
  await store.setMeta('lastBackupAt', S.meta.lastBackupAt);
  applyTheme();
  go('home');
  toast(tr('اكتمل الاسترجاع ✓'));
}

async function doWipe() {
  const ok = await confirmDialog({ title: tr('حذف كل البيانات؟'), text: tr('ستُحذف كل الصفوف والدرجات والإعدادات من هذا الجهاز نهائيًا. احفظ نسخة احتياطية أولًا إن كنت تحتاجها.'), ok: tr('حذف الكل'), danger: true });
  if (!ok) return;
  await store.replaceAll({ classes: [], settings: { ...CONFIG.defaultSettings, tourDone: true }, data: {} });
  await store.setMeta('lastBackupAt', null);
  await loadState();
  applyTheme();
  go('home');
  toast(tr('حُذفت كل البيانات'));
}

// =====================================================================
// تصدير الإكسل ومشاركة البطاقة
// =====================================================================
async function exportXlsx(id) {
  const c = cls(id);
  if (!c) return;
  if (S.dirty.size) await flushSave();
  const close = toast(tr('جارٍ تجهيز الكشف…'), { ms: 0 });
  try {
    const { buildWorkbook, exportFileName } = await import('./xlsx-export.js');
    const blob = await buildWorkbook({ classLabel: c.label, names: c.names, data: dataOf(c.id), settings: S.settings });
    close();
    const r = await platform.saveFile(exportFileName(c.label), blob, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (r !== 'cancelled') toast(tr('جاهز ✓ كشف الإكسل'));
  } catch {
    close();
    toast(tr('تعذّر إنشاء ملف الإكسل'), { err: true });
  }
}

async function shareStudent(id, idx) {
  const c = cls(id);
  const text = studentCardText({ name: c.names[idx], classLabel: c.label, subject: S.settings.subject, teacher: S.settings.teacher, data: dataOf(id), idx });
  const r = await platform.shareText(text, tr('بطاقة الطالب'));
  if (r === 'copied') toast(tr('نُسخ نص البطاقة — الصقه في واتساب'));
  else if (r === 'failed') toast(tr('تعذّرت المشاركة'), { err: true });
}

// =====================================================================
// الشاشة ٦ — العرض على الكمبيوتر (جهة الجوال)
// =====================================================================
const L = {
  // مسح واحد: الكمبيوتر يفتح التطبيق كاملًا، ومنه «اعرض للطلاب» والرصد. (display: العرض القديم، للاختبارات فقط)
  mode: typeof window !== 'undefined' && window.__gfuDisplayMode ? 'display' : 'manage',
  room: null,             // غرفة الوسيط (المفتاح) — للرجوع التلقائي بلا مسح QR
  usedOffers: new Set(),  // رموز الكمبيوتر التي استُعملت
  link: null, state: 'idle', classId: null, scope: { kind: 'class', idx: 0 }, hideNames: false, blank: false,
  phase: 'setup', answer: null, frames: [], frameTimer: null, scanner: null, collector: null, mod: null,
};
// سجل الاتصال: أحداث الربط وأسباب الانقطاع (في الذاكرة فقط — لا أسماء ولا درجات) لتشخيص أي انقطاع
L.log = [];
function llog(ev) {
  L.log.push({ t: Date.now(), ev: String(ev) });
  if (L.log.length > 80) L.log.shift();
}
const LOG_TEXT = {
  connected: 'اتصل بالكمبيوتر', disconnected: 'انقطع', 'app-background': 'خرجت من التطبيق / قفلت الشاشة', 'app-foreground': 'رجعت للتطبيق',
  'resume-try': 'محاولة إعادة الاتصال', 'resume-offer': 'وُجد رمز الكمبيوتر — جارٍ الاتصال', 'resume-none': 'لم يُعثر على رمز الكمبيوتر بعد',
  'ice-failed': 'فشل مسار الشبكة', 'pc-failed': 'فشل الاتصال', 'channel-closed': 'أُغلقت القناة', 'transport-down': 'الشبكة غير متاحة', 'no-heartbeat': 'لا رد من الكمبيوتر',
  stopped: 'أوقفت المشاركة', restored: 'فُتح التطبيق — جارٍ الرجوع للكمبيوتر',
};
function logHTML() {
  if (!L.log.length) return '';
  const rows = L.log.slice(-30).reverse().map((e) => {
    const d = new Date(e.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const [k, why] = e.ev.split(':');
    return `<li><span class="num">${time}</span> ${esc(tr(LOG_TEXT[k] || k))}${why ? ` — ${esc(tr(LOG_TEXT[why] || why))}` : ''}</li>`;
  }).join('');
  return T`<details class="card conn-log"><summary>${icon('info')} سجل الاتصال</summary><ul>${rows}</ul><button type="button" class="btn sm" data-act="log-copy">${icon('copy')} نسخ السجل</button></details>`;
}

function defaultViewUrl() {
  if (CONFIG.viewUrl) return CONFIG.viewUrl;
  if (platform.isNative) return '';
  return new URL('view.html', location.href).href;
}
async function liveMod() { return (L.mod ||= await import('./live.js')); }

// الآيفون (الموقع): لا ربط بالـ QR — المعلم يسجّل دخوله في الكمبيوتر بنفس الحساب وكل شيء يتزامن
function siteUrl() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function IphoneComputer() {
  const acct = C.session
    ? T`<div class="alert ok">${icon('checkCircle')}<div class="grow"><strong>حسابك جاهز: <span dir="ltr">${esc(C.session.u)}</span></strong><p style="margin:0">${tr(CLOUD_TEXT[C.state] || '')}</p></div></div>`
    : T`<button type="button" class="btn primary lg block" data-act="cloud-login">${icon('user')} سجّل دخولك أولًا</button>`;
  return T`${appbar({ title: tr('الكمبيوتر'), backBtn: false })}
  <div class="wrap stack live-page">
    <section class="live-step"><h3>${icon('cloud')} استخدم درجاتك من الكمبيوتر</h3>
      <ol class="steps">
        <li><span class="n">1</span><span>في الكمبيوتر افتح الموقع: <button type="button" class="link-btn" data-act="copy-site">${icon('copy')} نسخ الرابط</button></span></li>
        <li><span class="n">2</span><span>اضغط «تسجيل الدخول» واكتب نفس اسم المستخدم وكلمة السر.</span></li>
        <li><span class="n">3</span><span>كل تعديل يتزامن تلقائيًا بين الجوال والكمبيوتر — حتى لو قفلت الجوال.</span></li>
      </ol>
      ${acct}
    </section>
    <p class="hint" style="text-align:center">${icon('lock')} في كمبيوتر المدرسة ألغِ «تذكّرني» عند الدخول: لا يُحفظ عليه شيء.</p>
  </div>`;
}

function Live() {
  if (REMOTE) return RemotePresent();
  if (IOS_WEB && L.phase === 'setup') return IphoneComputer();
  L.scope = { kind: 'class', idx: 0 }; // العرض للصف كاملًا (تعديل طالب بعينه من داخل الصف)
  if (!L.classId || !cls(L.classId)) L.classId = (S.classes[0] || {}).id || null;
  const c = L.classId ? cls(L.classId) : null;
  const viewUrl = S.settings.viewUrl || defaultViewUrl();
  const busy = L.phase !== 'setup';
  const stateLabel = { connected: tr('متصل'), connecting: tr('جارٍ الاتصال'), disconnected: tr('انقطع الاتصال'), closed: tr('غير متصل'), idle: tr('غير متصل') }[L.state] || tr('غير متصل');
  const pill = `<span class="live-state ${L.state}" data-live-state><span class="dot"></span>${stateLabel}</span>`;

  // ١) ماذا تريد؟
  const modeCard = (v, ic, t, sub) => `<button type="button" class="mode-card ${L.mode === v ? 'on' : ''}" data-act="live-mode" data-v="${v}" aria-pressed="${L.mode === v}" ${busy && L.mode !== v ? 'disabled' : ''}>
    <span class="mode-ico">${icon(ic)}</span><span><strong>${t}</strong><small>${sub}</small></span></button>`;
  void modeCard;
  const step1 = '';

  // ٢) الإعدادات حسب الوضع
  let step2;
  if (L.mode === 'manage') {
    step2 = T`<section class="live-step"><h3><span class="step-n">${ar(1)}</span> ماذا يظهر على الكمبيوتر؟</h3>
      <ul class="hint manage-points">
        <li>تظهر صفوفك كلها على الكمبيوتر — اختر الصف الذي تريده.</li>
        <li><b>«اعرض للطلاب وارصد»</b>: جدول الدرجات على الشاشة، وترصد منه الدرجات والغياب والنجوم والملاحظات (طالب أو عدة طلاب معًا).</li>
        <li>تُظهر أو تُخفي النجوم والتنبيهات والأسماء من الشاشة نفسها. نص الملاحظات لا يظهر للطلاب أبدًا.</li>
        <li>تستطيع أيضًا إنشاء الصفوف من ملفات Excel وPDF الموجودة على الكمبيوتر.</li>
        <li>كل شيء يُحفظ في <b>جوالك</b> فقط — الكمبيوتر لا يحفظ شيئًا.</li>
      </ul></section>`;
  } else if (!S.classes.length) {
    step2 = T`<section class="live-step"><h3><span class="step-n">${ar(2)}</span> لا توجد صفوف بعد</h3>
      <p class="hint">أضف صفًا أولًا، أو اختر «أدِر التطبيق من الكمبيوتر» لإنشاء الصفوف من ملفات الكمبيوتر.</p>
      <button type="button" class="btn primary" data-act="new-class">${icon('plus')} إضافة صف</button></section>`;
  } else {
    step2 = T`<section class="live-step"><h3><span class="step-n">${ar(2)}</span> ماذا يظهر على الشاشة؟</h3>
      <div class="field"><label for="lv-class">الصف</label><select id="lv-class" class="select" data-live="class">${S.classes.map((o) => `<option value="${o.id}" ${o.id === L.classId ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
      ${c ? displayOptionsHTML(c) : ''}
    </section>`;
  }

  // ٣) الربط
  let body = '';
  if (L.phase === 'setup') {
    body = T`<p class="hint">1) افتح على الكمبيوتر: <b>شاشة العرض</b>${viewUrl ? T` — <button type="button" class="link-btn" data-act="copy-view">${icon('copy')} نسخ الرابط</button>` : ''}</p>
      <p class="hint">2) اضغط الزر وصوّر الرمز الظاهر على الكمبيوتر. يتصل الكمبيوتر بعدها تلقائيًا.</p>
      <button type="button" class="btn primary lg block" data-act="live-scan" ${L.mode === 'display' && !S.classes.length ? 'disabled' : ''}>${icon('camera')} صوّر رمز الكمبيوتر</button>
      <button type="button" class="link-btn" data-act="live-paste">ما تعمل الكاميرا؟ اكتب الرمز الظاهر في الكمبيوتر</button>`;
  } else if (L.phase === 'scan') {
    const pr = L.collector ? L.collector.progress() : { got: 0, total: 0 };
    body = T`<div class="video-box"><video playsinline muted autoplay data-live-video></video><div class="frame"></div></div>
      <p class="hint" style="text-align:center" data-scan-progress>${pr.total > 1 ? T`قرأنا ${ar(pr.got)} من ${ar(pr.total)} أجزاء… أبقِ الكاميرا على الرمز` : tr('وجّه الكاميرا إلى الرمز على شاشة الكمبيوتر')}</p>
      <button type="button" class="btn block" data-act="live-cancel">إلغاء</button>`;
  } else if (L.phase === 'connecting') {
    body = T`<div class="live-wait"><span class="spinner-lg" aria-hidden="true"></span><h3>جارٍ تجهيز الاتصال…</h3></div>`;
  } else if (L.phase === 'answer') {
    const rs = L.link && L.link.relayState;
    const failed = rs === 'failed' || rs === 'none';
    body = T`${failed
      ? T`<div class="alert warn">${icon('warn')}<div class="grow"><strong>تعذّر الإرسال — لا يوجد إنترنت</strong><p style="margin:0">الربط يحتاج إنترنت في الجوال (بيانات الجوال تكفي). شغّلها ثم اضغط «رمز جديد» في الكمبيوتر وصوّره من جديد.</p></div></div>
        <button type="button" class="btn primary block" data-act="live-scan">${icon('camera')} صوّر الرمز من جديد</button>`
      : T`<div class="live-wait"><span class="spinner-lg" aria-hidden="true"></span><h3>${rs === 'sending' ? tr('جارٍ الإرسال للكمبيوتر…') : tr('أُرسل للكمبيوتر ✓')}</h3><p class="hint">يتصل الكمبيوتر خلال ثوانٍ. أبقِ الشاشة مفتوحة.</p></div>
        ${L.slow ? T`<div class="alert warn">${icon('warn')}<div class="grow"><strong>تأخر الاتصال؟</strong><p style="margin:0">اضغط «رمز جديد» على الكمبيوتر ثم صوّره مرة ثانية. وتأكد أن الجهازين على نفس الشبكة.</p></div></div>
        <button type="button" class="btn primary block" data-act="live-scan">${icon('camera')} صوّر الرمز من جديد</button>` : ''}`}

      <button type="button" class="btn ghost block" data-act="live-stop">إلغاء</button>`;
  } else if (L.phase === 'connected') {
    body = L.mode === 'manage'
      ? T`<div class="alert ok">${icon('checkCircle')}<div class="grow"><strong>الكمبيوتر متصل</strong><p style="margin:0">اختر الصف من الكمبيوتر واعرضه للطلاب أو ارصد منه. تقدر تقفل الجوال أو تستخدمه في شي ثاني — الكمبيوتر يكمل لحاله، وأول ما ترجع للتطبيق تنتقل كل تعديلاته هنا تلقائيًا.</p></div></div>
        <button type="button" class="btn danger block lg" data-act="live-stop">${icon('power')} إيقاف الاتصال</button>`
      : T`<div class="alert ok">${icon('checkCircle')}<div class="grow"><strong>العرض يعمل الآن</strong><p style="margin:0">أي درجة ترصدها تظهر فورًا. تستطيع الخروج للواتساب مثلًا؛ عند رجوعك يعود الاتصال تلقائيًا.</p></div></div>
        ${c ? T`<button type="button" class="btn block" data-act="open-class" data-id="${c.id}">${icon('edit')} ارصد «${esc(c.label)}»</button>` : ''}
        <button type="button" class="btn ${L.blank ? 'primary' : 'soft'} lg block" data-act="live-blank">${icon(L.blank ? 'eye' : 'eyeOff')} ${L.blank ? tr('إظهار الدرجات') : tr('إخفاء الدرجات مؤقتًا')}</button>
        <button type="button" class="btn danger block" data-act="live-stop">${icon('power')} إيقاف العرض</button>`;
  } else if (L.phase === 'resuming') {
    body = T`<div class="live-wait"><span class="spinner-lg" aria-hidden="true"></span><h3>جارٍ إعادة الاتصال تلقائيًا…</h3><p class="hint">لا حاجة لتصوير الرمز من جديد. إن طال الانتظار صوّر الرمز الظاهر في الكمبيوتر.</p></div>
      <button type="button" class="btn block" data-act="live-scan">${icon('camera')} صوّر رمز الكمبيوتر</button>
      <button type="button" class="btn ghost block" data-act="live-stop">إيقاف المشاركة</button>`;
  } else if (L.phase === 'lost') {
    body = T`<div class="alert err">${icon('warn')}<div class="grow"><strong>انقطع الاتصال بالكمبيوتر</strong><p style="margin:0">قد يكون الجوال قُفل أو تغيّرت الشبكة. صوّر الرمز الظاهر في الكمبيوتر (في الشريط السفلي «اعرض الرمز»).</p></div></div>
      <button type="button" class="btn primary lg block" data-act="live-scan">${icon('refresh')} صوّر الرمز الجديد</button>
      <button type="button" class="btn block" data-act="live-reset">رجوع</button>`;
  }
  const step3 = T`<section class="live-step"><h3><span class="step-n">${ar(L.mode === 'manage' ? 2 : 3)}</span> اربط بالكمبيوتر</h3>${body}</section>`;

  const help = T`<details class="card"><summary style="font-weight:800;cursor:pointer;min-height:44px;display:flex;align-items:center;gap:8px">${icon('wifi')} مشاكل الاتصال؟</summary>
    <ul class="hint" style="padding-inline-start:20px;line-height:2">
      <li>اجعل الجوال والكمبيوتر على نفس شبكة Wi‑Fi.</li>
      <li>بعض شبكات المدارس تمنع اتصال الأجهزة ببعضها: شغّل «نقطة الاتصال» من الجوال ووصّل الكمبيوتر بها.</li>
      <li>الدرجات تنتقل مباشرة ومشفّرة بين الجهازين، ولا تُحفظ على الكمبيوتر.</li>
      <li>إن خرجت من التطبيق يبقى العرض على الكمبيوتر، ويعود الاتصال تلقائيًا عند رجوعك (في أندرويد يبقى متصلًا ويظهر إشعار فيه «إيقاف المشاركة»).</li>
    </ul></details>${logHTML()}`;

  return `${appbar({ title: tr('العرض على الكمبيوتر'), backBtn: false, actions: pill })}
  <div class="wrap stack live-page">${step1}${step2}${step3}${help}</div>`;
}

// على الكمبيوتر (وضع الإدارة): اختيار صف لعرضها للطلاب على نفس الشاشة
function RemotePresent() {
  if (!S.classes.length) {
    return T`${appbar({ title: tr('عرض للطلاب'), backBtn: false })}<div class="wrap"><div class="empty card">${ART_EMPTY}<h2>لا توجد صفوف بعد</h2><p>أنشئ الصفوف من «الأدوات ← إنشاء صفوف من ملف».</p></div></div>`;
  }
  if (!S.ui.presentPick || !cls(S.ui.presentPick)) S.ui.presentPick = S.classes[0].id;
  const c = cls(S.ui.presentPick);
  return T`${appbar({ title: tr('عرض للطلاب'), backBtn: false })}
  <div class="wrap stack">
    <div class="field"><label for="pr-class">الصف</label><select id="pr-class" class="select" data-present-pick>${S.classes.map((o) => `<option value="${o.id}" ${o.id === c.id ? 'selected' : ''}>${esc(o.label)} — ${students(o.names.length)}</option>`).join('')}</select></div>
    ${displayOptionsHTML(c)}
    <button type="button" class="btn primary lg block" data-act="present" data-id="${c.id}">${icon('monitor')} اعرض «${esc(c.label)}» للطلاب</button>
    <p class="hint">تتحول هذه الشاشة لعرض الدرجات للطلاب (بدون ملاحظات). للرجوع اضغط «رجوع للإدارة» أسفل الشاشة.</p>
  </div>`;
}
function presentClass(id) {
  if (!REMOTE) return;
  const c = cls(id);
  if (!c) return;
  const first = S.ui.presenting !== id;
  S.ui.presenting = id;
  const o = displayOpts(c);
  const tab = S.ui.tab[id];
  window.parent.postMessage({ gfu: 'present', classId: id, first, week: first && typeof tab === 'number' ? tab : null, label: c.label, hideNames: L.hideNames, names: displayNames(c, L.hideNames), data: displayData(c), opts: { stars: o.stars, issues: o.issues, hide: L.hideNames } }, location.origin);
}

// خيارات ما يظهر على الشاشة (للجوال وللإدارة من الكمبيوتر)
function displayOpts(c) {
  const st = S.settings;
  return { stars: st.liveShowStars !== false, issues: !!st.liveShowIssues, hidden: new Set(((st.liveIssueHidden || {})[c.id]) || []) };
}
function displayOptionsHTML(c) {
  const o = displayOpts(c);
  const d = dataOf(c.id);
  const withIssues = c.names.map((_, i) => i).filter((i) => getNotes(d, i).some((n) => n.issue));
  const hiddenCount = withIssues.filter((i) => o.hidden.has(i)).length;
  return T`<div class="list opts-list">
    <label class="list-item"><span class="grow"><strong>إخفاء الأسماء</strong><small>أرقام الطلاب فقط</small></span><input type="checkbox" class="switch" data-live="hide" ${L.hideNames ? 'checked' : ''}></label>
    ${REMOTE || L.mode === 'manage' ? '' : T`<label class="list-item"><span class="grow"><strong>✏️ الرصد من الكمبيوتر</strong><small>رصد الدرجات والغياب من شاشة العرض (يُحفظ في الجوال)</small></span><input type="checkbox" class="switch" data-live-opt="liveAllowEdit" ${S.settings.liveAllowEdit !== false ? 'checked' : ''}></label>`}
    <label class="list-item"><span class="grow"><strong>⭐ نجوم التميّز</strong><small>تظهر بجانب اسم الطالب المتميز</small></span><input type="checkbox" class="switch" data-live-opt="liveShowStars" ${o.stars ? 'checked' : ''}></label>
    <label class="list-item"><span class="grow"><strong>علامات التنبيه</strong><small>العلامة فقط — نص الملاحظة لا يظهر أبدًا</small></span><input type="checkbox" class="switch" data-live-opt="liveShowIssues" ${o.issues ? 'checked' : ''}></label>
    ${o.issues ? T`<button type="button" class="list-item" data-act="issue-hide" data-id="${c.id}">${icon('eyeOff')}<span class="grow"><strong>إخفاء التنبيه عن طلاب معيّنين</strong><small>${withIssues.length ? T`${ar(withIssues.length)} لديهم تنبيه · مخفي عن ${ar(hiddenCount)}` : tr('لا توجد تنبيهات في هذا الصف')}</small></span>${icon('fwd')}</button>` : ''}
  </div>`;
}

// بيانات العرض فقط: درجات + غياب + (نجوم/❗ حسب اختيار المعلم). الملاحظات لا تخرج أبدًا.
function displayData(c, only = null) {
  const d = dataOf(c.id);
  const o = displayOpts(c);
  const pick = (obj) => {
    const out = {};
    for (const [i, val] of Object.entries(obj || {})) if (only == null || +i === only) out[i] = val;
    return out;
  };
  const out = { weeks: {}, fin: pick(d.fin), t: d.t };
  for (let w = 1; w <= WEEKS; w++) {
    const wk = (d.weeks || {})[w];
    const issue = {};
    if (o.issues) c.names.forEach((_, i) => { if ((only == null || i === only) && !o.hidden.has(i) && weekIssues(d, w, i).length) issue[i] = true; });
    if (!wk && !Object.keys(issue).length) continue;
    out.weeks[w] = { date: (wk && wk.date) || '', lesson: (wk && wk.lesson) || '', s: pick(wk && wk.s), abs: pick(wk && wk.abs), star: o.stars ? pick(wk && wk.star) : {}, issue };
  }
  return out;
}
function displayNames(c, hide, only = null) {
  return c.names.map((nm, i) => (only != null && i !== only ? '' : hide ? T`طالب ${ar(i + 1)}` : nm));
}

// ملاحظة سريعة من صف الطالب، مع خيار «❗ تنبيه هذا الأسبوع»
function quickNote(c, w, i) {
  const d = dataOf(c.id);
  const has = w ? weekIssues(d, w, i).length : 0;
  const s = openSheet(T`<h2>${icon('edit')} ملاحظة على ${esc(c.names[i])}</h2>
    <p>الملاحظات خاصة بك ولا تظهر في بطاقة ولي الأمر ولا على شاشة الطلاب.</p>
    <textarea class="textarea" style="min-height:100px" data-qn-text maxlength="500" placeholder="مثال: لم يُحضر أدواته، تحدّث أثناء الشرح، مستواه تحسّن…" autofocus></textarea>
    ${w ? T`<label class="list-item" style="border:1px solid var(--border);border-radius:14px;margin-top:8px"><span class="grow"><strong>تنبيه في الأسبوع ${ar(w)}</strong><small>تظهر علامة التنبيه عند اسمه في هذا الأسبوع</small></span><input type="checkbox" class="switch" data-qn-issue ${has ? 'checked' : ''}></label>` : ''}
    ${getNotes(d, i).length ? T`<p class="hint" style="margin-top:8px">لديه ${ar(getNotes(d, i).length)} ملاحظة سابقة — <button type="button" class="link-btn" data-qn="open">اعرضها في بطاقته</button></p>` : ''}
    <div class="actions"><button type="button" class="btn" data-qn="cancel">إلغاء</button><button type="button" class="btn primary" data-qn="save">حفظ</button></div>`, { label: tr('ملاحظة') });
  s.sheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-qn]');
    if (!b) return;
    const act = b.dataset.qn;
    if (act === 'cancel') return s.close();
    if (act === 'open') { s.close(); go('student', { id: c.id, idx: i, week: w }); return; }
    const text = s.sheet.querySelector('[data-qn-text]').value.trim();
    const issueBox = s.sheet.querySelector('[data-qn-issue]');
    const issue = !!(issueBox && issueBox.checked);
    if (!text && !issue && !has) { toast(tr('اكتب الملاحظة أولًا'), { err: true }); return; }
    if (text || (issue && !has)) addNote(d, i, text || tr('تنبيه'), new Date(), w ? { week: w, issue } : {});
    if (has && !issue) clearWeekIssues(d, w, i);
    markDirty(c.id);
    if (w) livePatchItems(c.id, w, i);
    s.close();
    const row = main().querySelector(`[data-stu="${i}"]`);
    if (row && row.classList.contains('srow') && w) row.outerHTML = stuRow(c, d, w, i); else softRender();
    toast(issue ? tr('حُفظ التنبيه') : tr('حُفظت الملاحظة ✓'));
  });
}

// اختيار الطلاب الذين نُخفي عنهم ❗
function showIssueHide(c) {
  const d = dataOf(c.id);
  const withIssues = c.names.map((_, i) => i).filter((i) => getNotes(d, i).some((n) => n.issue));
  if (!withIssues.length) { toast(tr('لا يوجد طلاب عليهم تنبيه في هذا الصف')); return; }
  const o = displayOpts(c);
  const s = openSheet(T`<h2>إخفاء التنبيه عن طلاب معيّنين</h2><p>الطلاب المحددون لن تظهر عندهم علامة التنبيه على الشاشة.</p>
    <div class="list" style="max-height:55vh;overflow:auto">${withIssues.map((i) => `<label class="pick"><input type="checkbox" data-ih="${i}" ${o.hidden.has(i) ? 'checked' : ''}><span class="stu-num num">${ar(i + 1)}</span><span class="grow">${esc(c.names[i])}</span></label>`).join('')}</div>
    <div class="actions"><button type="button" class="btn primary" data-x>تم</button></div>`, { label: tr('إخفاء التنبيه'), onClose: async () => {
    const list = [...s.sheet.querySelectorAll('[data-ih]:checked')].map((x) => +x.dataset.ih);
    S.settings.liveIssueHidden = { ...(S.settings.liveIssueHidden || {}), [c.id]: list };
    await saveSettingsNow();
    sendSnapshot(); if (S.ui.presenting === c.id) presentClass(c.id);
    if (route().name === 'live') render();
  } });
  s.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) s.close(); });
}

afterRender.live = () => {
  if (L.phase === 'scan') startScanner();
  if (L.phase === 'answer' && main().querySelector('[data-answer-qr]')) paintAnswerQR();
};

function setLiveState(st) {
  if (st === 'closed') { if (route().name === 'live') render(); return; }
  if (!L.link) return;
  if (st !== L.state && (st === 'connected' || st === 'disconnected')) llog(st === 'disconnected' && L.link.reason ? 'disconnected:' + L.link.reason : st);
  L.state = st;
  if (st === 'connected') {
    L.phase = 'connected';
    stopScanner(); stopFrames();
    sendHello();
    if (L.mode === 'manage') sendState(); else sendSnapshot();
    if (document.hidden && L.link.setAway) L.link.setAway(true);
    if (L.link && L.link.room) L.room = L.link.room;
    saveLiveRoom();
    const c0 = cls(L.classId);
    if (platform.sharingStart) platform.sharingStart(L.mode === 'manage' ? tr('متصل بالكمبيوتر — اضغط للعودة') : T`${c0 ? c0.label : tr('الصف')} — اضغط للعودة`);
    toast(tr('تم الاتصال بالكمبيوتر ✓'));
  } else if (st === 'disconnected' && (L.phase === 'connected' || L.phase === 'answer')) {
    L.phase = 'lost';
    // نحاول الرجوع تلقائيًا ونستمر بالمحاولة (في أندرويد يعمل حتى والجوال في الجيب)
    tryResume();
  }
  if (route().name === 'live') render(); else renderShareBar();
}

// تذكّر الربط على هذا الجوال فقط (مفتاح المصافحة — لا أسماء ولا درجات) حتى يرجع الاتصال تلقائيًا
// بعد إطفاء الجوال أو إغلاق التطبيق، ما دامت صفحة الكمبيوتر مفتوحة. يُمسح عند «إيقاف المشاركة».
const LIVE_KEY = 'gfu-live';
const LIVE_KEEP_MS = 12 * 60 * 60 * 1000;
function saveLiveRoom() {
  if (REMOTE || !L.room) return;
  try { localStorage.setItem(LIVE_KEY, JSON.stringify({ key: L.room.key, topic: L.room.topic, mode: L.mode, classId: L.classId, t: Date.now() })); } catch { /* تصفح خاص */ }
}
function clearLiveRoom() { try { localStorage.removeItem(LIVE_KEY); } catch { /* */ } }
function restoreLive() {
  if (REMOTE) return;
  let o = null;
  try { o = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); } catch { o = null; }
  if (!o) return;
  if (typeof o.key !== 'string' || typeof o.topic !== 'string' || !(Date.now() - Number(o.t) < LIVE_KEEP_MS)) { clearLiveRoom(); return; }
  if (o.mode === 'display' && !cls(o.classId)) { clearLiveRoom(); return; }
  L.room = { key: o.key, topic: o.topic };
  if (o.mode === 'display' || o.mode === 'manage') L.mode = o.mode;
  if (o.classId && cls(o.classId)) L.classId = o.classId;
  L.phase = 'lost'; L.state = 'disconnected';
  llog('restored');
  tryResume();
}

// الرجوع التلقائي: نجلب رمز الكمبيوتر الجديد من الوسيط (بنفس المفتاح) ونتصل بلا مسح
async function tryResume() {
  if (!L.room || L.resumeLoop || L.state === 'connected') return;
  L.resumeLoop = true;
  const m = await liveMod();
  const t0 = Date.now();
  try {
    // نكرر المحاولة حتى يعود الاتصال (٣٠ دقيقة كحد أقصى) — لا ننتظر رجوع المعلم للتطبيق
    while (L.room && L.state !== 'connected' && (L.phase === 'lost' || L.phase === 'resuming') && Date.now() - t0 < 30 * 60 * 1000) {
      L.phase = 'resuming';
      if (route().name === 'live') render(); else renderShareBar();
      llog('resume-try');
      const ac = new AbortController();
      L.resumeAbort = ac;
      const code = await m.fetchLatestOffer(L.room, L.usedOffers, { timeoutMs: 15000, signal: ac.signal });
      if (L.phase !== 'resuming') return; // أُلغي
      if (code) {
        llog('resume-offer');
        await startLiveFromCode(code);
        // ننتظر الاتصال؛ إن لم يتم (رد لم يصل للوسيط مثلًا) نعيد المحاولة بنفس الرمز
        const t1 = Date.now();
        while (L.room && L.state !== 'connected' && Date.now() - t1 < 20000 && (L.phase === 'answer' || L.phase === 'connecting')) await new Promise((res) => setTimeout(res, 500));
        if (L.state === 'connected' || !L.room || L.phase === 'setup') return;
        L.usedOffers.delete(code);
        llog('resume-none');
        L.phase = 'lost';
        continue;
      }
      llog('resume-none');
      L.phase = 'lost';
      if (route().name === 'live') render(); else renderShareBar();
      await new Promise((res) => setTimeout(res, document.hidden ? 6000 : 2500));
    }
  } finally { L.resumeLoop = false; }
}
// أندرويد: النظام يخبرنا بالخروج من التطبيق والرجوع إليه (الصفحة تبقى «ظاهرة» عمدًا حتى لا يتوقف الاتصال)
function onAppActive(active) {
  llog(active ? 'app-foreground' : 'app-background');
  if (L.link && L.state === 'connected' && L.link.setAway) L.link.setAway(!active);
  if (active && L.phase === 'lost') tryResume();
  else if (active && L.phase === 'connected' && L.link && L.link.transportDown && L.link.transportDown()) { L.phase = 'lost'; L.state = 'disconnected'; tryResume(); }
}
if (platform.isNative && !REMOTE) {
  try { const A = platform.plugin('App'); if (A) A.addListener('appStateChange', (s) => onAppActive(!!(s && s.isActive))); } catch { /* */ }
}
document.addEventListener('visibilitychange', () => {
  if (REMOTE || platform.isNative) return; // أندرويد: appStateChange أعلاه
  onAppActive(!document.hidden);
});
// إيقاف من إشعار أندرويد
window.__gfuStopSharing = () => { liveStop(); render(); toast(tr('أُوقفت المشاركة')); };

async function startLiveFromCode(code) {
  const m = await liveMod();
  L.phase = 'connecting';
  if (route().name === 'live') render();
  try {
    if (L.link) L.link.stop();
    L.link = new m.PhoneLink({
      iceServers: m.iceServersFrom(S.settings), onState: setLiveState,
      onWant: () => { sendHello(); if (L.mode === 'manage') sendState(); else sendSnapshot(); },
      // يقبل الجوال تعديلات الكمبيوتر فقط في وضع الإدارة الذي اختاره المعلم بنفسه
      // وضع الإدارة: كل التعديلات. وضع العرض: الرصد فقط (درجات/غياب/نجمة) إن سمح المعلم
      acceptData: () => L.state === 'connected' && (L.mode === 'manage' || displayEditAllowed()),
      onData: (msg) => {
        if (msg.type === 'edit' && L.mode === 'display') applyDisplayEdit(msg);
        else if (msg.type !== 'edit' && L.mode === 'manage') applyRemoteOp(msg);
        else if (L.link) L.link.droppedCount++; // نوع غير مسموح في هذا الوضع: يُرفض
      },
    });
    L.state = 'connecting';
    L.usedOffers.add(code);
    L.answer = await L.link.acceptOffer(code);
    if (L.link.relaySent) L.link.relaySent.then(() => { if (route().name === 'live' && L.phase === 'answer') render(); }).catch(() => {});
    // رموز صغيرة متتابعة بمربعات كبيرة: أسهل بكثير لكاميرا الكمبيوتر من رمز واحد كثيف
    L.frames = m.splitFrames(L.answer, 110);
    L.phase = 'answer';
    L.slow = false;
    clearTimeout(L.slowTimer);
    L.slowTimer = setTimeout(() => { if (L.phase === 'answer' && L.state !== 'connected') { L.slow = true; if (route().name === 'live') render(); } }, 12000);
  } catch (e) {
    stopScanner();
    L.phase = 'setup'; L.state = 'idle';
    toast(e && /[؀-ۿ]/.test(e.message || '') ? e.message : tr('الرمز غير صالح. أنشئ رمزًا جديدًا على الكمبيوتر.'), { err: true, ms: 5000 });
  }
  if (route().name === 'live') render();
}

async function startScanner() {
  const video = main().querySelector('[data-live-video]');
  if (!video || (L.scanner && L.scanner.running)) return;
  stopScanner(); // كاميرا مُبقاة من محاولة سابقة
  const m = await liveMod();
  L.collector = new m.FrameCollector();
  L.scanner = new m.QrScanner(video, (text) => {
    const full = L.collector.push(text);
    const prog = main().querySelector('[data-scan-progress]');
    const pr = L.collector.progress();
    if (prog && pr.total > 1) prog.textContent = T`قرأنا ${ar(pr.got)} من ${ar(pr.total)} أجزاء… أبقِ الكاميرا على الرمز`;
    if (full) {
      haptic('success');
      // نُبقي الكاميرا شغالة أثناء الاتصال (شرط في آيفون ليصل الكمبيوتر إلى الجوال مباشرة)، وتُغلق عند الاتصال أو بعد دقيقة
      L.scanner.pause();
      clearTimeout(L.camTimer);
      L.camTimer = setTimeout(() => { if (L.scanner && !L.scanner.running) stopScanner(); }, 60000);
      startLiveFromCode(full);
    }
  });
  try {
    await L.scanner.start('environment');
  } catch (e) {
    stopScanner();
    L.phase = 'setup';
    render();
    const msg = e && e.code === 'denied'
      ? (platform.isIOS ? tr('رُفض إذن الكاميرا. فعّله من: الإعدادات ← Safari ← الكاميرا ← سماح، ثم أعد المحاولة.') : tr('رُفض إذن الكاميرا. فعّله من إعدادات الجهاز ← التطبيقات ← الأذونات ← الكاميرا.'))
      : e && e.code === 'notfound' ? tr('لا توجد كاميرا متاحة. اضغط «اكتب الرمز الظاهر في الكمبيوتر».')
        : e && e.code === 'insecure' ? tr('الكاميرا تحتاج رابطًا آمنًا (https).') : tr('تعذّر فتح الكاميرا. اضغط «اكتب الرمز الظاهر في الكمبيوتر».');
    toast(msg, { err: true, ms: 7000 });
  }
}
function stopScanner() { clearTimeout(L.camTimer); if (L.scanner) { L.scanner.stop(); L.scanner = null; } }

async function paintAnswerQR() {
  const m = await liveMod();
  const canvas = main().querySelector('[data-answer-qr]');
  if (!canvas) return;
  stopFrames();
  let i = 0;
  const label = main().querySelector('[data-frame-label]');
  const paint = () => {
    const cv = main().querySelector('[data-answer-qr]');
    if (!cv) return stopFrames();
    m.renderQR(cv, L.frames[i], { size: 720, ec: 'L' });
    if (label) label.textContent = L.frames.length > 1 ? T`جزء ${ar(i + 1)} من ${ar(L.frames.length)} — يتبدّل تلقائيًا` : '';
    i = (i + 1) % L.frames.length;
  };
  paint();
  if (L.frames.length > 1) L.frameTimer = setInterval(paint, 1100);
}
function stopFrames() { clearInterval(L.frameTimer); L.frameTimer = null; }

function liveSend(msg) {
  if (L.link && L.state === 'connected') { try { L.link.send({ v: 1, ...msg }); } catch { /* تجاهل */ } }
}
function sendHello() {
  const c = cls(L.classId);
  liveSend({ type: 'hello', lang: lang(), mode: L.mode, allowEdit: displayEditAllowed(), showIssues: !!S.settings.liveShowIssues, teacher: S.settings.teacher, subject: S.settings.subject, classLabel: L.mode === 'manage' ? '' : (c ? c.label : ''), criteria: CRIT.map((x) => x.label), finals: FINS.map((f) => ({ label: f.label, max: f.max })) });
}
function sendSnapshot() {
  if (L.mode === 'manage') return;
  const c = cls(L.classId);
  if (!c) return;
  const only = L.scope.kind === 'student' ? L.scope.idx : null;
  liveSend({ type: 'snapshot', scope: { ...L.scope }, hideNames: L.hideNames, names: displayNames(c, L.hideNames, only), data: displayData(c, only) });
}
// وضع العرض: هل يُسمح للمعلم بالرصد من شاشة الكمبيوتر؟
function displayEditAllowed() {
  return L.mode === 'display' && S.settings.liveAllowEdit !== false && L.scope.kind === 'class' && !!cls(L.classId);
}
// رصد من شاشة العرض: درجة بند، كامل، غياب، نجمة، درجة نهائية — للصف المعروض فقط
function applyDisplayEdit(m) {
  if (!displayEditAllowed()) return;
  const c = cls(L.classId);
  const res = applyEditOp(c, m);
  if (!res) return;
  const ack = typeof m.oid === 'number' || typeof m.oid === 'string' ? String(m.oid).slice(0, 20) : undefined;
  markDirty(c.id);
  if (res.kind === 'fin') livePatchFin(c.id, res.i, ack);
  else if (res.kind === 'items') livePatchItems(c.id, res.w, res.i, ack);
  softRender();
}
// يطبّق تعديلًا واحدًا (درجة/كامل/غياب/نجمة/ملاحظة/نهائي) على بيانات الصف. يرجع ما تغيّر أو null
function applyEditOp(c, m) {
  const d = dataOf(c.id);
  const i = Number(m.idx);
  if (!Number.isInteger(i) || i < 0 || i >= c.names.length) return null;
  const w = Number(m.week);
  const okWeek = Number.isInteger(w) && w >= 1 && w <= WEEKS;
  if (m.kind === 'item' && okWeek) {
    const k = Number(m.k);
    if (!(k >= 0 && k < ITEMS)) return null;
    const res = m.value == null ? { ok: true, value: null } : parseScore(String(m.value), CONFIG.itemMax);
    if (!res.ok) return null;
    setItem(d, w, i, k, res.value);
  } else if (m.kind === 'full' && okWeek) {
    for (let k = 0; k < ITEMS; k++) setItem(d, w, i, k, CONFIG.itemMax);
  } else if (m.kind === 'absent' && okWeek) {
    setAbsent(d, w, i, m.on === true);
  } else if (m.kind === 'star' && okWeek) {
    setStar(d, w, i, m.on === true);
  } else if (m.kind === 'note') {
    const text = typeof m.text === 'string' ? m.text.trim().slice(0, 500) : '';
    const issue = m.issue === true && okWeek;
    if (!text && !issue) return null;
    addNote(d, i, text || tr('تنبيه'), new Date(), okWeek ? { week: w, issue } : {});
    if (!okWeek) return { kind: 'note', i };
  } else if (m.kind === 'issue-off' && okWeek) {
    clearWeekIssues(d, w, i);
  } else if (m.kind === 'fin') {
    const k = Number(m.k);
    if (!(k >= 0 && k < FINS.length)) return null;
    const res = m.value == null ? { ok: true, value: null } : parseScore(String(m.value), FINS[k].max);
    if (!res.ok) return null;
    setFin(d, i, k, res.value);
    return { kind: 'fin', i };
  } else return null;
  return { kind: 'items', w, i };
}
// الكمبيوتر (الإدارة): رصد من شاشة «عرض للطلاب» — يُحفظ في الجوال عبر الحفظ العادي
function presentEdit(m) {
  if (!REMOTE || !S.ui.presenting) return;
  const c = cls(S.ui.presenting);
  if (!c || !applyEditOp(c, m)) return;
  markDirty(c.id);
  softRender();
  presentClass(c.id);
}
// الكمبيوتر: إظهار/إخفاء النجوم والتنبيهات والأسماء من شاشة العرض نفسها
function presentOpt(key, on) {
  if (!REMOTE || !S.ui.presenting) return;
  if (key === 'hide') L.hideNames = !!on;
  else if (key === 'liveShowStars' || key === 'liveShowIssues') { S.settings[key] = !!on; saveSettingsNow(); }
  else return;
  presentClass(S.ui.presenting);
  softRender();
}

// وضع الإدارة: نسخة كاملة لتطبيق الكمبيوتر (في ذاكرته فقط)
function sendState() {
  if (S.dirty.size) flushSave();
  liveSend({ type: 'state', classes: S.classes, grades: S.grades, settings: pickTeacher(S.settings), lastBackupAt: S.meta.lastBackupAt || null });
}
function manageSend(msg) {
  if (L.mode === 'manage' && L.state === 'connected' && !L.applyingRemote) liveSend(msg);
}
// تعديل وصل من الكمبيوتر (يُقبل فقط في وضع الإدارة الذي فعّله المعلم من جواله)
async function applyRemoteOp(m) {
  if (L.mode !== 'manage') return;
  L.applyingRemote = true;
  try {
    if (m.type === 'put-classes' && Array.isArray(m.classes)) {
      const clean = m.classes.filter((c) => c && typeof c.id === 'string' && c.id.length < 40 && typeof c.label === 'string' && Array.isArray(c.names))
        .slice(0, 100).map((c) => ({ id: c.id, label: c.label.slice(0, 100), names: c.names.slice(0, MAX_STUDENTS).map((x) => String(x ?? '').slice(0, 120)) }));
      const ids = new Set(clean.map((c) => c.id));
      for (const id of Object.keys(S.grades)) if (!ids.has(id)) { delete S.grades[id]; await localStore.deleteGrades(id); }
      for (const c of clean) if (!S.grades[c.id]) { S.grades[c.id] = emptyClassData(); await localStore.saveGrades(c.id, S.grades[c.id]); }
      S.classes = clean;
      await localStore.saveClasses(S.classes);
      L.applyingRemote = false; autoPlans(); L.applyingRemote = true;
    } else if (m.type === 'put-grades' && typeof m.id === 'string' && cls(m.id)) {
      S.grades[m.id] = localStore.sanitizeClassData(m.data);
      await localStore.saveGrades(m.id, S.grades[m.id]);
    } else if (m.type === 'del-grades' && typeof m.id === 'string') {
      delete S.grades[m.id]; await localStore.deleteGrades(m.id);
    } else if (m.type === 'put-settings' && m.settings) {
      Object.assign(S.settings, pickTeacher(m.settings));
      await localStore.saveSettings(S.settings);
    } else return;
    noteChange();
    setSaveState('saved');
    if (route().name !== 'live') softRender();
  } finally { L.applyingRemote = false; }
}
function livePatchItems(classId, w, i, ack) {
  if (L.mode === 'manage' || L.classId !== classId || L.state !== 'connected') return;
  if (L.scope.kind === 'student' && L.scope.idx !== i) return;
  const c = cls(classId); const o = displayOpts(c); const d = dataOf(classId);
  liveSend({ type: 'patch', kind: 'items', week: w, idx: i, values: getItems(d, w, i), absent: isAbsent(d, w, i), star: o.stars && isStar(d, w, i), starRaw: isStar(d, w, i), issue: o.issues && !o.hidden.has(i) && weekIssues(d, w, i).length > 0, ack });
}
function livePatchFin(classId, i, ack) {
  if (L.mode === 'manage' || L.classId !== classId || L.state !== 'connected') return;
  if (L.scope.kind === 'student' && L.scope.idx !== i) return;
  liveSend({ type: 'patch', kind: 'fin', idx: i, values: getFin(dataOf(classId), i), ack });
}
function livePatchMeta(classId, w) {
  if (L.mode === 'manage' || L.classId !== classId || L.state !== 'connected') return;
  const m = getWeekMeta(dataOf(classId), w);
  liveSend({ type: 'patch', kind: 'meta', week: w, date: m.date, lesson: m.lesson });
}
function liveResync(classId) { if (L.mode !== 'manage' && L.classId === classId && L.state === 'connected') { sendHello(); sendSnapshot(); } }
function liveStop() {
  const link = L.link;
  L.link = null;
  L.room = null; L.usedOffers = new Set();
  clearLiveRoom();
  if (L.resumeAbort) { L.resumeAbort.abort(); L.resumeAbort = null; }
  if (link) llog('stopped');
  if (platform.sharingStop) platform.sharingStop();
  L.state = 'idle'; L.phase = 'setup'; L.blank = false;
  if (link) { try { link.stop(); } catch { /* */ } }
  stopScanner(); stopFrames();
  liveMod().then((m) => m.wakeLock(false));
}

// =====================================================================
// معالجات الأحداث (تفويض)
// =====================================================================
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.closest('#overlay-root') && !el.closest('.sheet')) return;
  const act = el.dataset.act;
  const r = route();
  const p = r.p;
  switch (act) {
    case 'nav': if (route().name !== el.dataset.to || S.stack.length > 1) go(el.dataset.to); break;
    case 'back': back(); break;
    case 'go': go(el.dataset.to, el.dataset.id ? { id: el.dataset.id } : {}); break;
    case 'new-class': go('editor', {}); break;
    case 'import-classes': importClassesFromFile(); break;
    case 'delete-class-id': deleteClass(el.dataset.id); break;
    case 'delete-pick': { const c = await pickClass(tr('أي صف تريد حذفه؟')); if (c) deleteClass(c.id); break; }
    case 'handover-pick': { const c = await pickClass(tr('أي صف تريد تسليمه؟')); if (c) doHandover(c); break; }
    case 'handover': doHandover(cls(el.dataset.id)); break;
    case 'transfer-pick': { const c = await pickClass(tr('نقل طلاب من أي صف؟')); if (c) go('transferOut', { id: c.id }); break; }
    case 'report-grades': printReport('grades', cls(el.dataset.id)); break;
    case 'report-attendance': printReport('attendance', cls(el.dataset.id)); break;
    case 'report-student': {
      const c = cls(el.dataset.id);
      const i = await pickStudent(c, tr('تقرير أي طالب؟'));
      if (i != null) printReport('student', c, i);
      break;
    }
    case 'print-student': printReport('student', cls(el.dataset.id), +el.dataset.idx); break;
    case 'open-class': S.ui.selected = null; setFilter('all'); go('class', { id: el.dataset.id }); break;
    case 'resume': {
      e.stopPropagation();
      const c = cls(el.dataset.id); const d = dataOf(c.id);
      const tab = firstIncompleteWeek(d, c.names.length);
      const first = tab === 'fin' ? c.names.findIndex((_, i) => getFin(d, i).some((v) => v == null)) : c.names.findIndex((_, i) => !studentComplete(d, tab, i));
      S.ui.tab[c.id] = tab; S.ui.selected = null; setFilter('all');
      go('class', { id: c.id, tab, scrollTo: first >= 0 ? first : null });
      break;
    }
    case 'edit-class': e.stopPropagation(); go('editor', { id: el.dataset.id }); break;
    case 'tab': {
      S.ui.undo = null;
      p.tab = el.dataset.tab === 'fin' ? 'fin' : +el.dataset.tab;
      S.ui.tab[p.id] = p.tab; S.ui.search = '';
      p.painted = true;
      render();
      break;
    }
    case 'missing': setFilter(el.checked ? 'missing' : 'all'); rerenderList(); break;
    case 'filter': setFilter(S.ui.filter === el.dataset.f ? 'all' : el.dataset.f); rerenderList(); break;
    case 'fscope': S.ui.fscope = el.dataset.s === 'all' ? 'all' : 'week'; rerenderList(); break;
    case 'filter-share': shareFilter(cls(p.id), p.tab); break;
    case 'filter-sheet': openFilterSheet(cls(p.id), p.tab); break;
    case 'cloud-login': openCloudLogin(); break;
    case 'cloud-account': openAccountSheet(false); break;
    case 'school-grade': go('school', { grade: el.dataset.g, pick: new Set() }); break; // صفحة مستقلة: «رجوع» يعيد لاختيار الصف
    case 'school-save': saveSchoolPick(p); break;
    case 'school-import': importSchoolFile(); break;
    case 'school-reload': loadSchoolRoster().then((r) => { if (!r) toast(tr('القوائم غير موجودة في الخادم بعد.'), { err: true }); }); break;
    case 'new-class-manual': go('editor', { manual: true }); break;
    case 'show-paste': p.showPaste = true; render(); setTimeout(() => { const t = main().querySelector('[data-paste]'); if (t) t.focus(); }, 30); break;
    case 'copy-site': if (await platform.copyText(siteUrl())) toast(tr('نُسخ الرابط ✓')); break;
    case 'cloud-logout': cloudLogout(); break;
    case 'cloud-sync': if (C.sync) { C.sync.pull(); C.sync.flushSoon(10); toast(tr('جارٍ المزامنة…')); } break;
    case 'side-toggle': S.ui.sideHidden = !S.ui.sideHidden; setDeskPref('gfu-side', S.ui.sideHidden); render(); break;
    case 'rail-toggle': setDeskPref('gfu-rail', !deskPref('gfu-rail')); renderNav(); break;
    case 'undo-bulk': if (S.ui.undo) S.ui.undo.fn(); break;
    case 'quick-note': quickNote(cls(p.id), typeof p.tab === 'number' ? p.tab : null, +el.dataset.idx); break;
    case 'star': {
      const c = cls(p.id); const w = p.tab; const i = +el.dataset.idx; const d = dataOf(c.id);
      const on = !isStar(d, w, i);
      setStar(d, w, i, on);
      markDirty(c.id); livePatchItems(c.id, w, i); haptic(on ? 'success' : 'light');
      { const row = main().querySelector(`[data-stu="${i}"]`); if (row && row.tagName === 'TR') rerenderList(); else if (row) row.outerHTML = stuRow(c, d, w, i); }
      if (on) toast(T`⭐ ${c.names[i].split(' ')[0]}: نجمة تميّز في الأسبوع ${ar(w)}`);
      break;
    }
    case 'absent': {
      const c = cls(p.id); const w = p.tab; const i = +el.dataset.idx; const d = dataOf(c.id);
      const on = !isAbsent(d, w, i);
      const wasDone = studentComplete(d, w, i);
      const prev = setAbsent(d, w, i, on);
      markDirty(c.id); livePatchItems(c.id, w, i); haptic(on ? 'error' : 'light');
      const row = main().querySelector(`[data-stu="${i}"]`);
      if (row && row.tagName === 'TR') rerenderList(); else if (row) row.outerHTML = stuRow(c, d, w, i);
      refreshStudent(c, w, i);
      if (on) {
        toast(T`${c.names[i].split(' ')[0]}: غائب (أصفار)`, { ms: 10000, action: { label: tr('تراجع'), fn: () => {
          setAbsent(d, w, i, false); prev.forEach((v, k) => setItem(d, w, i, k, v));
          markDirty(c.id); livePatchItems(c.id, w, i);
          const r2 = main().querySelector(`[data-stu="${i}"]`); if (r2 && r2.tagName === 'TR') rerenderList(); else if (r2) r2.outerHTML = stuRow(c, d, w, i);
          refreshStudent(c, w, i);
        } } });
        if (!wasDone) { advanceFrom(c, w, i); hideIfMissingOnly(i); }
      }
      break;
    }
    case 'note-add': {
      const c = cls(el.dataset.id); const i = +el.dataset.idx;
      const ta = document.querySelector(`[data-note-input="${i}"]`);
      const text = (ta && ta.value || '').trim();
      if (!text) { toast(tr('اكتب الملاحظة أولًا'), { err: true }); break; }
      const iss = document.querySelector(`[data-note-issue="${i}"]`);
      addNote(dataOf(c.id), i, text, new Date(), iss ? { week: +iss.dataset.week, issue: iss.checked } : {});
      markDirty(c.id);
      toast(tr('أُضيفت الملاحظة ✓'));
      if (route().name === 'student') render(); else refreshAside();
      break;
    }
    case 'note-del': {
      const c = cls(el.dataset.id); const i = +el.dataset.idx;
      const ok = await confirmDialog({ title: tr('حذف الملاحظة؟'), ok: tr('حذف'), danger: true });
      if (!ok) break;
      deleteNote(dataOf(c.id), i, el.dataset.t); markDirty(c.id);
      if (route().name === 'student') render(); else refreshAside();
      break;
    }
    case 'missing-toggle': setFilter(S.ui.missingOnly ? 'all' : 'missing'); rerenderList(); break;
    case 'box': openPicker(cls(p.id), p.tab, +el.dataset.idx, +el.dataset.k); break;
    case 'fin-box': {
      const c = cls(p.id); const i = +el.dataset.idx; const k = +el.dataset.k;
      const res = await keypad({ title: `${FINS[k].label} — ${c.names[i]}`, max: FINS[k].max, value: getFin(dataOf(c.id), i)[k] });
      if (!res) break;
      setFin(dataOf(c.id), i, k, res.value);
      markDirty(c.id); livePatchFin(c.id, i); haptic('light');
      refreshStudent(c, 'fin', i, { rerenderInputs: true });
      break;
    }
    case 'week-step': {
      const order = [...Array(WEEKS).keys()].map((x) => x + 1).concat(['fin']);
      const j = order.indexOf(p.tab) + +el.dataset.dir;
      if (j >= 0 && j < order.length) { S.ui.undo = null; p.tab = order[j]; S.ui.tab[p.id] = p.tab; S.ui.search = ''; p.painted = true; render({ scrollTop: true }); }
      break;
    }
    case 'week-pick': showWeekPicker(p); break;
    case 'week-tools': showWeekTools(p); break;
    case 'class-menu': showClassMenu(p); break;
    case 'open-student': {
      const idx = +el.dataset.idx;
      if (ASIDE.matches && r.name === 'class' && !S.ui.sideHidden) { S.ui.selected = { id: p.id, idx }; refreshAside(); }
      else go('student', { id: p.id, idx, week: typeof p.tab === 'number' ? p.tab : null });
      break;
    }
    case 'close-aside': S.ui.selected = null; refreshAside(); break;
    case 'stu-nav': { const c = cls(p.id); const j = p.idx + +el.dataset.dir; if (j >= 0 && j < c.names.length) { p.idx = j; render({ scrollTop: true }); } break; }
    case 'share-student': shareStudent(el.dataset.id, +el.dataset.idx); break;
    case 'chip': case 'full': case 'other': await onScoreAction(act, el, p); break;
    case 'fill': quickFill(p, el.dataset.k); break;
    case 'today': {
      const d = new Date();
      const v = ar(`${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`);
      setWeekMeta(dataOf(p.id), p.tab, 'date', v);
      const inp = document.querySelector('[data-meta="date"]'); if (inp) inp.value = v;
      markDirty(p.id); livePatchMeta(p.id, p.tab); haptic('light');
      toast(tr('أُضيف تاريخ اليوم'));
      break;
    }
    case 'export-xlsx': exportXlsx(el.dataset.id); break;
    case 'go-live': if (L.classId !== el.dataset.id) { L.classId = el.dataset.id; L.scope = { kind: 'class', idx: 0 }; liveResync(L.classId); } go('live'); break;
    case 'backup': doBackup(); break;
    case 'restore': doRestore(); break;
    case 'wipe': doWipe(); break;
    case 'tour': showTour(); break;
    case 'update-check': checkForUpdate(); break;
    case 'report-class-pick': pickClassSheet(S.ui.reportClass, (id) => { S.ui.reportClass = id; render(); }); break;
    case 'update-now': applyUpdate(); break;
    case 'dismiss-guide': try { sessionStorage.setItem('iosGuideSeen', '1'); } catch { /* */ } go('home'); break;
    case 'slot-add': openSlotSheet(); break;
    case 'plan-sheet': openPlanSheet(); break;
    case 'log-copy': {
      const txt = L.log.map((e) => new Date(e.t).toISOString().slice(11, 19) + ' ' + e.ev).join('\n');
      if (await platform.copyText(txt)) toast(tr('نُسخ السجل ✓'));
      break;
    }
    case 'slot-del': {
      const sid = el.dataset.sid;
      const before = sanitizeSchedule(S.settings.schedule);
      S.settings.schedule = before.filter((x) => x.id !== sid);
      await saveSettingsNow(); await syncReminders(); render();
      toast(tr('حُذفت الحصة'), { action: { label: tr('تراجع'), fn: async () => { S.settings.schedule = before; await saveSettingsNow(); await syncReminders(); render(); } } });
      break;
    }
    case 'remind-min': S.settings.remindBefore = String(Number(el.dataset.v) || 10); await saveSettingsNow(); await syncReminders(); render(); break;
    case 'rem-retry': await syncReminders(); render(); break;
    case 'slot-ics': exportScheduleICS(); break;
    case 'set-lang': {
      const v = el.dataset.v === 'en' ? 'en' : 'ar';
      if (v === lang()) break;
      S.settings.lang = v;
      await saveSettingsNow();
      rememberLang(v);
      { let stored = null; try { stored = localStorage.getItem('gfu-lang'); } catch { /* */ }
        const ok = (stored === 'en') === (v === 'en');
        const q = new URLSearchParams(location.search); q.delete('lang'); if (!ok) q.set('lang', v);
        location.replace(location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
      break;
    }
    case 'set': {
      S.settings[el.dataset.key] = el.dataset.v;
      applyTheme();
      await saveSettingsNow();
      render();
      break;
    }
    // المحرر
    case 'add-names': {
      const ta = main().querySelector('[data-paste]');
      const lines = (ta.value || '').split(/\r?\n/);
      const res = addNamesToDraft(p, lines);
      if (res.names.length) { ta.value = ''; render(); }
      break;
    }
    case 'add-one': {
      if (p.draft.rows.length >= MAX_STUDENTS) { toast(T`الحد الأقصى ${ar(MAX_STUDENTS)} طالبًا`, { err: true }); break; }
      p.draft.rows.push({ name: '', from: null }); p.dirty = true; render();
      const inputs = main().querySelectorAll('[data-name-row]');
      const last = inputs[inputs.length - 1]; if (last) { last.focus(); last.scrollIntoView({ block: 'center' }); }
      break;
    }
    case 'import-file': importFileToDraft(p); break;
    case 'del-row': {
      const j = +el.dataset.row; const row = p.draft.rows[j];
      const c = p.id ? cls(p.id) : null;
      if (c && row.from != null && studentHasGrades(dataOf(c.id), row.from)) {
        const ok = await confirmDialog({ title: T`حذف «${row.name}»؟`, text: tr('لهذا الطالب درجات مرصودة وستُحذف عند الحفظ. إن كان منتقلًا لمعلم آخر فاستعمل «نقل طلاب» لترسل درجاته.'), ok: tr('حذف'), danger: true });
        if (!ok) break;
      }
      p.draft.rows.splice(j, 1); p.dirty = true; render();
      toast(tr('حُذف الطالب من القائمة'), { action: { label: tr('تراجع'), fn: () => { p.draft.rows.splice(j, 0, row); render(); } } });
      break;
    }
    case 'sort-az': p.draft.rows.sort((a, b) => arCompare(a.name, b.name)); p.dirty = true; render(); toast(tr('رُتّبت الأسماء أبجديًا')); break;
    case 'save-class': saveEditor(p); break;
    case 'delete-class': deleteClass(p.id); break;
    // النقل
    case 'sel-all': { const c = cls(p.id); p.sel = el.dataset.v === '1' ? new Set(c.names.map((_, i) => i)) : new Set(); render(); break; }
    case 'transfer-file': doTransferFile(p); break;
    case 'transfer-move': doTransferMove(p); break;
    case 'pick-transfer': pickTransfer(p); break;
    case 'pick-all': p.pick = el.dataset.v === '1' ? new Set(p.tr.students.map((_, i) => i)) : new Set(); render(); break;
    case 'apply-transfer': applyTransferUI(p); break;
    // العرض الحي
    case 'live-mode': if (L.phase === 'setup' || L.phase === 'lost') { L.mode = el.dataset.v; render(); } break;
    case 'issue-hide': showIssueHide(cls(el.dataset.id)); break;
    case 'present': presentClass(el.dataset.id); break;
    case 'live-scope': L.scope = { kind: el.dataset.v, idx: L.scope.idx || 0 }; if (L.state === 'connected') sendHello(); sendSnapshot(); render(); break;
    case 'live-scan': L.phase = 'scan'; render(); break;
    case 'live-cancel': stopScanner(); L.phase = 'setup'; render(); break;
    case 'live-paste': {
      const s = openSheet(T`<h2>اكتب رمز الكمبيوتر</h2><p>في الكمبيوتر اضغط «اعرض الرمز المكتوب» تحت رمز QR، واكتب الأحرف الثمانية هنا.</p>
        <label class="otp" data-otp>
          <input data-code class="otp-input" dir="ltr" inputmode="text" autocapitalize="characters" autocomplete="one-time-code" autocorrect="off" spellcheck="false" aria-label="رمز الكمبيوتر (٨ أحرف)">
          <span class="otp-boxes" dir="ltr" aria-hidden="true">${Array.from({ length: 8 }, (_, i) => `<span class="otp-box" data-ob="${i}"></span>${i === 3 ? '<span class="otp-dash">-</span>' : ''}`).join('')}</span>
        </label>
        <div class="actions"><button type="button" class="btn" data-x="0">إلغاء</button><button type="button" class="btn primary" data-x="1" disabled>اتصال</button></div>`, { label: tr('رمز الكمبيوتر') });
      const inp = s.sheet.querySelector('[data-code]');
      const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const paintOtp = () => {
        let v = inp.value;
        if (v.length <= 12) { // رمز قصير: أحرف كبيرة دائمًا، والمسموح فقط
          v = v.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).toUpperCase().replace(/O/g, '0').split('').filter((ch) => ABC.includes(ch)).join('').slice(0, 8);
          if (v !== inp.value) inp.value = v;
        }
        const short = inp.value.length <= 12;
        s.sheet.querySelectorAll('[data-ob]').forEach((b, i) => { b.textContent = short ? (v[i] || '') : '•'; b.classList.toggle('on', short && i === Math.min(v.length, 7)); b.classList.toggle('full', !!v[i]); });
        const ready = short ? v.length === 8 : inp.value.length > 12;
        s.sheet.querySelector('[data-x="1"]').disabled = !ready;
        if (short && v.length === 8 && !s.autoGo) { s.autoGo = true; setTimeout(() => { const go = s.sheet.querySelector('[data-x="1"]'); if (go && !go.disabled) go.click(); }, 250); }
        if (short && v.length < 8) s.autoGo = false;
      };
      inp.addEventListener('input', paintOtp);
      paintOtp();
      setTimeout(() => inp.focus(), 60);
      s.sheet.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-x]'); if (!b) return;
        const code = s.sheet.querySelector('[data-code]').value.trim();
        s.close();
        if (b.dataset.x === '1' && code) {
          liveMod().then(async (m) => {
            const sc = m.normShortCode(code);
            if (sc) {
              // رمز قصير: نجلب رمز العرض المشفّر من الوسيط
              L.phase = 'connecting'; if (route().name === 'live') render();
              const full = await m.fetchLatestOffer(await m.shortRoom(sc), new Set(), { timeoutMs: 15000 });
              if (full) return startLiveFromCode(full);
              L.phase = 'setup'; if (route().name === 'live') render();
              toast(tr('لم يُعثر على الرمز. تأكد من الأحرف ومن اتصال الجهازين بالإنترنت، أو اضغط «رمز جديد» في الكمبيوتر.'), { err: true, ms: 7000 });
              return;
            }
            const col = new m.FrameCollector(); let full = null; for (const part of code.split(/\s+/)) full = col.push(part) || full; startLiveFromCode(full || code);
          });
        }
      });
      break;
    }
    case 'qr-full': {
      const box = el; box.classList.toggle('full');
      document.body.classList.toggle('qr-fullscreen', box.classList.contains('full'));
      break;
    }
    case 'live-copy': if (await platform.copyText(L.answer || '')) toast(tr('نُسخ رمز الرد ✓')); break;
    case 'copy-view': { let u = S.settings.viewUrl || defaultViewUrl(); if (lang() === 'en' && u) u += (u.includes('?') ? '&' : '?') + 'lang=en'; if (await platform.copyText(u)) toast(tr('نُسخ الرابط ✓')); break; }
    case 'live-blank': L.blank = !L.blank; liveSend({ type: 'blank', on: L.blank }); haptic('light'); render(); break;
    case 'live-stop': liveStop(); render(); toast(tr('أُوقف العرض')); break;
    case 'live-stop-quick': liveStop(); renderShareBar(); toast(tr('أُوقفت المشاركة')); break;
    case 'live-reset': L.phase = 'setup'; L.state = 'idle'; render(); break;
    default: break;
  }
});

// ----- نوافذ شاشة الرصد (الجوال) -----
function showWeekPicker(p) {
  const c = cls(p.id); const d = dataOf(c.id); const n = c.names.length;
  const cell = (w) => {
    const done = weekComplete(d, w, n);
    const rem = weekRemaining(d, w, n);
    const started = rem < n;
    const meta = getWeekMeta(d, w);
    return T`<button type="button" class="wk ${done ? 'done' : ''} ${p.tab === w ? 'on' : ''}" data-act="tab" data-tab="${w}">
      <b>أسبوع ${ar(w)}</b><small>${done ? tr('✓ مكتمل') : started ? T`باقي ${ar(rem)}` : tr('لم يبدأ')}${meta.date ? ` · ${esc(meta.date)}` : ''}</small></button>`;
  };
  const finDone = !finalsRemaining(d, n);
  const s = openSheet(T`<h2>اختر الأسبوع</h2>
    <div class="wk-grid">${[...Array(WEEKS).keys()].map((x) => cell(x + 1)).join('')}</div>
    <button type="button" class="wk wide ${finDone ? 'done' : ''} ${p.tab === 'fin' ? 'on' : ''}" data-act="tab" data-tab="fin"><b>الدرجات النهائية</b><small>${finDone ? tr('✓ مكتملة') : T`باقي ${ar(finalsRemaining(d, n))}`}</small></button>`, { label: tr('اختر الأسبوع') });
  s.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-act="tab"]')) setTimeout(() => s.close(), 0); });
}

function showWeekTools(p) {
  const c = cls(p.id); const d = dataOf(c.id);
  if (p.tab === 'fin') return;
  const meta = getWeekMeta(d, p.tab);
  const s = openSheet(T`<h2>أدوات الأسبوع ${ar(p.tab)}</h2>
    <div class="stack">
      <div class="field"><label for="wdate">التاريخ</label><div class="row"><input id="wdate" class="input grow" data-meta="date" value="${esc(meta.date)}" placeholder="مثال: 12/10" autocomplete="off"><button type="button" class="btn" data-act="today">${icon('calendar')} اليوم</button></div></div>
      <div class="field"><label for="wlesson">عنوان الدرس</label><input id="wlesson" class="input" data-meta="lesson" value="${esc(meta.lesson)}" placeholder="اكتب عنوان الدرس" autocomplete="off"></div>
      <div class="field"><span class="label">تعبئة سريعة (الخانات الفارغة فقط)</span>
        <div class="fill-grid">${CRIT.map((cr, k) => `<button type="button" class="btn soft" data-act="fill" data-k="${k}">${esc(cr.label)} ${ar(CONFIG.itemMax)}</button>`).join('')}
        <button type="button" class="btn success" data-act="fill" data-k="all">${icon('check')} الكل ${ar(CONFIG.itemMax)}</button></div></div>
    </div>
    <div class="actions"><button type="button" class="btn primary" data-x autofocus>تم</button></div>`, { label: tr('أدوات الأسبوع'), onClose: () => {
    // نحفظ قيم الحقول عند الإغلاق أيضًا (لو أُغلقت النافذة قبل وصول حدث الكتابة)
    let changed = false;
    s.sheet.querySelectorAll('[data-meta]').forEach((inp) => { if (getWeekMeta(d, p.tab)[inp.dataset.meta] !== inp.value) { setWeekMeta(d, p.tab, inp.dataset.meta, inp.value); changed = true; } });
    if (changed) { markDirty(c.id); livePatchMeta(c.id, p.tab); }
    if (route().name === 'class') rerenderList();
  } });
  s.sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]') || e.target.closest('[data-act="fill"]')) setTimeout(() => s.close(), 0);
  });
}

function showClassMenu(p) {
  const c = cls(p.id);
  const item = (act, ic, t, sub, extra = '') => `<button type="button" class="list-item" data-act="${act}" data-id="${c.id}" ${extra}>${icon(ic)}<span class="grow"><strong>${t}</strong><small>${sub}</small></span></button>`;
  const s = openSheet(T`<h2>${esc(c.label)}</h2>
    <div class="list">
      ${item('edit-class', 'users', tr('الطلاب'), tr('إضافة، تعديل الأسماء، حذف، ترتيب'))}
      ${item('export-xlsx', 'sheet', tr('تصدير Excel'), tr('كشف المتابعة الرسمي للطباعة'))}
      ${item('go-live', 'monitor', tr('عرض على الكمبيوتر'), tr('اعرض الدرجات على البروجكتر'))}
      ${item('handover', 'send', tr('تسليم الصف لمعلم آخر'), tr('كل الطلاب مع الدرجات والغياب والملاحظات'))}
      ${item('go', 'move', tr('نقل طلاب'), tr('طالب أو أكثر لمعلم آخر أو لصف آخر'), 'data-to="transferOut"')}
      ${item('go', 'inbox', tr('استقبال طلاب منقولين'), tr('من ملف أرسله معلم آخر'), 'data-to="transferIn"')}
    </div>
    <div class="list danger-list" style="margin-top:12px">
      ${item('delete-class-id', 'trash', tr('حذف الصف'), tr('مع كل درجاته — تقدر تتراجع بعدها'))}
    </div>
    <div class="actions"><button type="button" class="btn" data-x>إغلاق</button></div>`, { label: tr('خيارات الصف') });
  s.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-act]') || e.target.closest('[data-x]')) setTimeout(() => s.close(), 0); });
}

function rerenderList() {
  const r = route();
  if (r.name !== 'class') return render();
  const c = cls(r.p.id);
  const box = document.getElementById('cls-body');
  if (!box || !c) return render();
  const active = document.activeElement && document.activeElement.matches('[data-search]');
  const pos = active ? document.activeElement.selectionStart : null;
  box.innerHTML = r.p.tab === 'fin' ? finTab(c, dataOf(c.id)) : weekTab(c, dataOf(c.id), r.p.tab);
  if (active) { const s = box.querySelector('[data-search]'); s.focus(); try { s.setSelectionRange(pos, pos); } catch { /* */ } }
  // الكمبيوتر: حالة الأسبوع في الرأس (خارج منطقة الجدول التي أُعيد رسمها)
  const hs = WIDE.matches && document.querySelector('.hdr-status');
  if (hs) { const d = dataOf(c.id); const n = c.names.length; const w = r.p.tab;
    hs.innerHTML = w === 'fin' ? (finalsRemaining(d, n) ? T`<span class="status-pill">${icon('warn')} باقي ${ar(finalsRemaining(d, n))} من ${ar(n)} طالب</span>` : T`<span class="status-pill ok">${icon('checkCircle')} اكتملت الدرجات النهائية</span>`) : weekStatusHTML(d, w, n); }
  const sub = document.getElementById('week-sub');
  if (sub) { const d = dataOf(c.id); const n = c.names.length; const w = r.p.tab;
    sub.textContent = w === 'fin' ? (finalsRemaining(d, n) ? T`باقي ${ar(finalsRemaining(d, n))}` : tr('مكتملة ✓')) : (weekComplete(d, w, n) ? tr('مكتمل ✓') : T`باقي ${ar(weekRemaining(d, w, n))} من ${ar(n)}`); }
}

async function onScoreAction(act, el, p) {
  const c = cls(p.id); const w = p.tab; const i = +el.dataset.idx;
  const d = dataOf(c.id);
  if (act === 'full') {
    const prev = getItems(d, w, i);
    const wasDone = studentComplete(d, w, i);
    for (let k = 0; k < ITEMS; k++) setItem(d, w, i, k, CONFIG.itemMax);
    markDirty(c.id); livePatchItems(c.id, w, i);
    haptic('success');
    refreshStudent(c, w, i, { rerenderInputs: true });
    toast(T`${c.names[i].split(' ')[0]}: كامل`, { ms: 6000, action: { label: tr('تراجع'), fn: () => { prev.forEach((v, k) => setItem(d, w, i, k, v)); markDirty(c.id); livePatchItems(c.id, w, i); const row = main().querySelector(`[data-stu="${i}"]`); if (row && row.tagName !== 'TR') row.outerHTML = stuRow(c, d, w, i); else refreshStudent(c, w, i, { rerenderInputs: true }); refreshStudent(c, w, i); } } });
    if (!wasDone) { advanceFrom(c, w, i); hideIfMissingOnly(i); }
    return;
  }
  const k = +el.dataset.k;
  let v;
  if (act === 'chip') {
    v = +el.dataset.v;
    if (getItems(d, w, i)[k] === v) v = null; // ضغطة ثانية على نفس الرقم تمسحه
  } else {
    const res = await keypad({ title: `${CRIT[k].label} — ${c.names[i]}`, max: CONFIG.itemMax, value: getItems(d, w, i)[k] });
    if (!res) return;
    v = res.value;
  }
  const { wasDone, nowDone } = changeItem(c, w, i, k, v);
  haptic('light');
  refreshStudent(c, w, i, { rerenderInputs: true });
  if (!wasDone && nowDone) { advanceFrom(c, w, i); hideIfMissingOnly(i); }
}

async function quickFill(p, which) {
  const c = cls(p.id); const w = p.tab; const d = dataOf(c.id);
  const ks = which === 'all' ? CRIT.map((_, k) => k) : [+which];
  const plan = [];
  c.names.forEach((_, i) => {
    if (isAbsent(d, w, i)) return; // الغائب لا يُعبَّأ
    const vals = getItems(d, w, i);
    ks.forEach((k) => { if (vals[k] == null) plan.push([i, k]); });
  });
  if (!plan.length) { toast(tr('لا توجد خانات فارغة لتعبئتها')); return; }
  const label = which === 'all' ? tr('كل البنود') : CRIT[+which].label;
  const who = new Set(plan.map(([i]) => i)).size;
  const ok = await confirmDialog({ title: T`تعبئة ${label} بـ ${ar(CONFIG.itemMax)}؟`, text: T`سيوضع ${ar(CONFIG.itemMax)} في ${cells(plan.length)} فارغة لـ ${students(who)} في الأسبوع ${ar(w)}. الخانات التي فيها درجات والطلاب الغائبون لا يتغيرون، ويمكنك التراجع بعدها.`, ok: tr('عبّئ') });
  if (!ok) return;
  plan.forEach(([i, k]) => setItem(d, w, i, k, CONFIG.itemMax));
  markDirty(c.id);
  const touched = [...new Set(plan.map(([i]) => i))];
  touched.forEach((i) => livePatchItems(c.id, w, i));
  haptic('success');
  const undo = () => {
    plan.forEach(([i, k]) => setItem(d, w, i, k, null));
    markDirty(c.id);
    touched.forEach((i) => livePatchItems(c.id, w, i));
    S.ui.undo = null;
    rerenderList(); refreshChip(c, w); refreshAside();
    toast(tr('تم التراجع'));
  };
  // يبقى زر التراجع ظاهرًا في شريط الإجراءات حتى تعبئة أخرى أو تغيير الأسبوع
  S.ui.undo = { classId: c.id, week: w, label: which === 'all' ? T`الكل ${ar(CONFIG.itemMax)}` : `${CRIT[+which].short} ${ar(CONFIG.itemMax)}`, fn: undo };
  rerenderList(); refreshChip(c, w); refreshAside();
  toast(T`عُبّئت ${cells(plan.length)} (${label})`, { action: { label: tr('تراجع'), fn: () => S.ui.undo && S.ui.undo.fn === undo && undo() } });
}

// إدخال الحقول (الأرقام، البيانات، الإعدادات، البحث)
let searchTimer = null;
document.addEventListener('input', (e) => {
  const t = e.target;
  const r = route();
  if (t.matches('[data-score]')) return onScoreInput(t, r.p);
  if (t.matches('[data-meta]')) {
    setWeekMeta(dataOf(r.p.id), r.p.tab, t.dataset.meta, t.value);
    markDirty(r.p.id); livePatchMeta(r.p.id, r.p.tab);
    return;
  }
  if (t.matches('[data-search]')) {
    S.ui.search = t.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => (r.name === 'class' ? rerenderList() : (() => { const pos = t.selectionStart; render(); const s = main().querySelector('[data-search]'); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch { /* */ } } })()), 140);
    return;
  }
  if (t.matches('[data-setting]')) return onSettingInput(t.dataset.setting, t.value);
  if (t.matches('[data-draft-label]')) { r.p.draft.label = t.value; r.p.dirty = true; return; }
  if (t.matches('[data-name-row]')) { r.p.draft.rows[+t.dataset.nameRow].name = t.value; r.p.dirty = true; return; }
  if (t.matches('[data-new-label]')) { r.p.newLabel = t.value; return; }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  const r = route();
  if (t.matches('[data-setting-bool]')) { S.settings[t.dataset.settingBool] = t.checked; await saveSettingsNow(); if (t.dataset.settingBool === 'remindersOn') { await syncReminders(); render(); } return; }
  if (t.matches('[data-week-select]') && r.name === 'class') { S.ui.undo = null; r.p.tab = t.value === 'fin' ? 'fin' : +t.value; S.ui.tab[r.p.id] = r.p.tab; S.ui.search = ''; r.p.painted = true; render(); return; }
  if (t.matches('[data-sec]')) { const x = t.dataset.sec; r.p.pick ||= new Set(); if (t.checked) r.p.pick.add(x); else r.p.pick.delete(x); render(); return; }
  if (t.matches('[data-sel]')) { const i = +t.dataset.sel; if (t.checked) r.p.sel.add(i); else r.p.sel.delete(i); render(); return; }
  if (t.matches('[data-pick-st]')) { const i = +t.dataset.pickSt; if (t.checked) r.p.pick.add(i); else r.p.pick.delete(i); render(); return; }
  if (t.matches('[data-tgt]')) { r.p.target = t.dataset.tgt; render(); return; }
  if (t.matches('[data-split]')) { r.p.split = t.checked; render(); return; }
  if (t.matches('[data-st-tgt]')) { (r.p.per ||= {})[t.dataset.stTgt] = t.value; render(); return; }
  if (t.matches('[data-report-class]')) { S.ui.reportClass = t.value; render(); return; }
  if (t.matches('[data-present-pick]')) { S.ui.presentPick = t.value; render(); return; }
  if (t.matches('[data-live="class"]')) { L.classId = t.value; L.scope.idx = 0; liveResync(L.classId); render(); return; }
  if (t.matches('[data-live="student"]')) { L.scope.idx = +t.value; sendSnapshot(); return; }
  if (t.matches('[data-live="hide"]')) { L.hideNames = t.checked; sendSnapshot(); if (S.ui.presenting) presentClass(S.ui.presenting); return; }
  if (t.matches('[data-live-opt]')) {
    S.settings[t.dataset.liveOpt] = t.checked;
    await saveSettingsNow();
    if (L.state === 'connected' && L.mode === 'display') sendHello();
    sendSnapshot(); if (S.ui.presenting) presentClass(S.ui.presenting);
    render();
    return;
  }
});

function onScoreInput(t, p) {
  const c = cls(p.id); const i = +t.dataset.idx; const k = +t.dataset.k;
  const isFin = t.dataset.score === 'fin';
  const max = isFin ? FINS[k].max : CONFIG.itemMax;
  const res = parseScore(t.value, max);
  const errEl = t.parentElement.querySelector('[data-err]');
  if (!res.ok) {
    t.classList.add('bad');
    t.setAttribute('aria-invalid', 'true');
    if (errEl) errEl.innerHTML = `${icon('warn')}${esc(res.error)}`;
    haptic('error');
    return;
  }
  t.classList.remove('bad');
  t.removeAttribute('aria-invalid');
  if (errEl) errEl.textContent = '';
  const d = dataOf(c.id);
  if (isFin) {
    setFin(d, i, k, res.value);
    markDirty(c.id); livePatchFin(c.id, i);
    const el = main().querySelector(`[data-stu="${i}"]`);
    refreshStudent(c, 'fin', i);
    if (el) {
      const p1 = el.querySelector('[data-p1]'); if (p1) p1.textContent = fmt(periodScore(d, i, 1));
    }
  } else {
    const { wasDone, nowDone } = changeItem(c, p.tab, i, k, res.value);
    refreshStudent(c, p.tab, i);
    if (!wasDone && nowDone) hideIfMissingOnly(i);
  }
}

// Enter ينقل للحقل التالي ثم للطالب التالي؛ ↑↓ في الجدول
// بطاقة الصف (role=button): Enter أو مسافة تفتحها
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.class-card[data-act="open-class"]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t.matches || !t.matches('input[data-score]')) return;
  const all = [...main().querySelectorAll('input[data-score]')];
  const pos = all.indexOf(t);
  let next = null;
  if (e.key === 'Enter') { e.preventDefault(); next = all[pos + 1]; if (!next) t.blur(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t.closest('table')) {
    e.preventDefault();
    const per = t.closest('tr').querySelectorAll('input[data-score]').length;
    next = all[pos + (e.key === 'ArrowDown' ? per : -per)];
  }
  if (next) { next.focus(); next.select(); keepVisible(next); }
});
function keepVisible(el) { setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50); }
document.addEventListener('focusin', (e) => {
  if (e.target.matches && e.target.matches('input, textarea') && navigator.maxTouchPoints > 0) setTimeout(() => e.target.scrollIntoView({ block: 'center' }), 300);
});

// إعادة الرسم عند تغيير عرض الشاشة (جوال ↔ كمبيوتر)
WIDE.addEventListener('change', () => { if (!document.activeElement || !document.activeElement.matches('input, textarea')) render(); });

// =====================================================================
// التشغيل
// =====================================================================
async function loadState() {
  const all = await store.loadAll();
  S.classes = all.classes || [];
  S.settings = { ...CONFIG.defaultSettings, ...(all.settings || {}) };
  // المادة الافتراضية «الحاسوب» (أو Computer في الواجهة الإنجليزية) إن كانت فارغة أو هي الافتراضية باللغة الأخرى
  { const ds = CONFIG.defaultSubject; const want = ds[lang() === 'en' ? 'en' : 'ar'];
    if (!S.settings.subject || (Object.values(ds).includes(S.settings.subject) && S.settings.subject !== want)) S.settings.subject = want; }
  S.grades = all.grades || {};
  S.meta = all.meta || {};
}

function maybeNagBackup() {
  if (!S.meta.changedSinceBackup) return;
  const days = (Date.now() - new Date(S.meta.changedSinceBackup).getTime()) / 86400000;
  const today = new Date().toDateString();
  if (!hasAnyGrades() || days <= CONFIG.backupReminderDays || S.meta.nagDay === today) return;
  S.meta.nagDay = today;
  store.setMeta('nagDay', today).catch(() => {});
  setTimeout(async () => {
    const ok = await confirmDialog({ title: tr('مرّ أكثر من أسبوع بدون نسخة احتياطية'), text: tr('درجاتك محفوظة على هذا الجوال فقط. احفظ نسخة الآن (ضغطة واحدة) حتى لا تضيع إن ضاع الجوال أو حُذف التطبيق.'), ok: tr('احفظ نسخة الآن'), cancel: tr('لاحقًا') });
    if (ok) doBackup();
  }, 600);
}

function registerSW() {
  if (platform.isNative || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const hadController = !!navigator.serviceWorker.controller; // أول زيارة: لا نعيد التحميل
  fetch('version.txt', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).then((t) => { UPD.build = t.trim().slice(0, 7); paintUpdate(); }).catch(() => {});
  const bootAt = Date.now();
  let hiddenAt = 0;
  // التحديث تلقائيًا في لحظة آمنة: عند فتح التطبيق، أو الرجوع له بعد غياب — إن لم يكن هناك حفظ معلّق أو اتصال بالكمبيوتر
  const safeToApply = () => !S.dirty.size && L.phase === 'setup' && route().name !== 'live' && !document.querySelector('.sheet');
  // أول ضغطة من المعلم: بعدها لا نعيد التحميل فجأة (نعرض «تحديث متوفر» بدلًا من ذلك)
  let touched = false;
  window.addEventListener('pointerdown', () => { touched = true; }, { once: true, capture: true });
  window.addEventListener('keydown', () => { touched = true; }, { once: true, capture: true });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {}); // نفحص فور الفتح دائمًا
    const ask = (w, atBoot = false) => {
      // نسخة جديدة عند الفتح (جاهزة من قبل أو نزلت للتو) والمعلم لم يبدأ بعد: نطبّقها فورًا. وإلا: إشعار فقط
      if ((atBoot || Date.now() - bootAt < 15000) && !touched && safeToApply()) { w.postMessage({ type: 'skip-waiting' }); return; }
      UPD.state = 'ready'; UPD.worker = w; paintUpdate();
      toast(tr('تحديث متوفر، أعد التشغيل'), { ms: 0, action: { label: tr('أعد التشغيل'), fn: () => w.postMessage({ type: 'skip-waiting' }) } });
    };
    if (reg.waiting && hadController) ask(reg.waiting, true);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && hadController) ask(w); });
    });
    // آيفون يُبقي التطبيق معلّقًا في الخلفية: نفحص التحديث كلما رجع المعلم للتطبيق
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
      const away = hiddenAt && Date.now() - hiddenAt > 60 * 1000;
      if (reg.waiting && hadController && away && safeToApply()) { reg.waiting.postMessage({ type: 'skip-waiting' }); return; }
      reg.update().catch(() => {});
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && hadController) { reloaded = true; location.reload(); } });
}

async function boot() {
  const cloudSession = CLOUD_ON ? cloud.readSession() : null;
  if (DESK_WEB && !cloudSession && !new URLSearchParams(location.search).has('login') && toPcHome()) return;
  if (cloudSession && cloudSession.eph) localStore.useMemory(); // كمبيوتر مشترك: لا نقرأ ولا نكتب بيانات هذا الجهاز
  try {
    await loadState();
    if (cloudSession && cloudSession.eph) S.settings.tourDone = true;
    if (IOS_WEB && !cloudSession) S.settings.tourDone = true; // شاشة الدخول أولًا
  } catch {
    main().innerHTML = T`<div class="wrap"><div class="alert err">${icon('warn')}<div class="grow"><strong>تعذّر فتح التخزين</strong><p>قد يكون المتصفح في وضع التصفح الخاص أو يمنع حفظ البيانات. افتح التطبيق في وضع عادي.</p></div></div></div>`;
    return;
  }
  S.booted = true;
  if (!REMOTE && (S.settings.lang === 'en') !== (lang() === 'en') && !new URLSearchParams(location.search).has('lang')) {
    // اللغة المحفوظة في الإعدادات تختلف (مثلًا بعد استرجاع نسخة): نطابقها مرة واحدة.
    // إن تعذّر حفظ التفضيل (تصفح خاص) نضعها في الرابط بدل إعادة التحميل بلا نهاية.
    const want = S.settings.lang === 'en' ? 'en' : 'ar';
    rememberLang(want);
    let stored = null; try { stored = localStorage.getItem('gfu-lang'); } catch { /* */ }
    if ((stored === 'en') === (want === 'en')) location.reload();
    else location.replace(location.pathname + '?lang=' + want + location.hash);
    return;
  }
  translateStatic(document.body);
  applyTheme();
  autoPlans();
  restoreLive();
  loadBundledRoster();
  if (cloudSession) setTimeout(() => startCloud(cloudSession), 0); // بعد أول رسم للشاشة
  else if (CLOUD_ON && new URLSearchParams(location.search).has('login')) {
    // من صفحة العرض («تسجيل الدخول بحسابي»): نفتح نافذة الدخول مباشرة بلا جولة
    S.settings.tourDone = true;
    setTimeout(() => { history.replaceState(history.state, '', location.pathname + location.hash); openCloudLogin(true); }, 300);
  }
  try { if (sessionStorage.getItem('gfu-cloud-ended')) { sessionStorage.removeItem('gfu-cloud-ended'); setTimeout(() => toast(tr('خرجت من حسابك تلقائيًا (مرّت ساعة ونصف). سجّل الدخول من جديد للمتابعة.'), { ms: 9000 }), 500); } } catch { /* */ }
  if (platform.isNative && !REMOTE) {
    const LN = platform.plugin('LocalNotifications');
    if (LN) {
      try {
        LN.addListener('localNotificationActionPerformed', (ev) => {
          const id = ev && ev.notification && ev.notification.extra && ev.notification.extra.classId;
          if (id && cls(id)) go('class', { id });
        });
      } catch { /* */ }
      setTimeout(() => { syncReminders().catch(() => {}); }, 1500);
    }
  }
  if (REMOTE) {
    // على الكمبيوتر: لا تخزين، لا جولة، لا Service Worker — البيانات في الجوال
    S.stack = [{ name: 'home', p: {} }];
    history.replaceState({ depth: 1 }, '');
    document.body.classList.add('remote');
    render();
    setSaveState(S.classes.length ? 'saved' : '');
    return;
  }
  if (S.meta.persist == null || S.meta.persist === 'denied') {
    store.requestPersist().then((st) => { S.meta.persist = st; store.setMeta('persist', st); }).catch(() => {});
  }
  let seen = false;
  try { seen = sessionStorage.getItem('iosGuideSeen') === '1'; } catch { /* */ }
  S.stack = [{ name: 'home', p: {} }];
  history.replaceState({ depth: 1 }, '');
  if (platform.isIOS && !platform.isStandalone && !seen) {
    S.stack.push({ name: 'guide', p: {} });
    history.pushState({ depth: 2 }, '');
    try { sessionStorage.setItem('iosGuideSeen', '1'); } catch { /* */ }
  }
  render();
  setSaveState(S.classes.length ? 'saved' : '');
  if (!S.settings.tourDone) setTimeout(showTour, 400);
  else maybeNagBackup();
  registerSW();
}

// واجهة صغيرة للاختبارات الآلية فقط (لا تحوي بيانات)
window.__app = { S, L, go, flushSave, render };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
