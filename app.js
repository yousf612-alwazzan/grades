// متابعة الدرجات — التطبيق الرئيسي (صفحة واحدة SPA)
// البنية: حالة S + موجّه (stack من الشاشات) + دوال رسم لكل شاشة + معالجات أحداث مفوّضة (data-act).
// للتخصيص راجع CLAUDE.md و config.js.
import CONFIG from './config.js';
import {
  WEEKS, ITEMS, MAX_STUDENTS, parseScore, fmt, emptyClassData, getItems, setItem, getFin, setFin,
  getWeekMeta, setWeekMeta, weekTotal, periodScore, formative, finalTotal, studentSummary,
  studentComplete, weekRemaining, weekComplete, finalsRemaining, firstIncompleteWeek, progress,
  studentCardText, cleanNames, arCompare, remapData, nameKey,
} from './grades-core.js';
import * as store from './store.js';
import { buildTransfer, transferFileName, parseTransfer, applyTransfer, moveStudents } from './transfer.js';
import { platform } from './platform.js';
import { ar, esc, icon, toast, openSheet, closeTopSheet, hasSheet, confirmDialog, keypad, students, cells, names as namesWord } from './ui.js';

const CRIT = CONFIG.criteria;
const FINS = CONFIG.finals;
const WIDE = window.matchMedia('(min-width: 900px)');
const ASIDE = window.matchMedia('(min-width: 1181px)'); // عرض بطاقة الطالب بجانب الجدول

// ===================== الحالة =====================
const S = {
  classes: [],
  settings: { ...CONFIG.defaultSettings },
  grades: {},
  meta: {},
  stack: [],          // [{name, p}]
  ui: { tab: {}, search: '', missingOnly: false, selected: null, undo: null },
  saving: false,
  dirty: new Set(),
};

const cls = (id) => S.classes.find((c) => c.id === id);
const dataOf = (id) => (S.grades[id] ||= emptyClassData());
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const route = () => S.stack[S.stack.length - 1] || { name: 'home', p: {} };
const ROOTS = ['home', 'live', 'settings'];

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
}
async function flushSave() {
  const ids = [...S.dirty];
  S.dirty.clear();
  try {
    for (const id of ids) if (cls(id)) await store.saveGrades(id, dataOf(id));
    setSaveState(S.dirty.size ? 'saving' : 'saved');
  } catch {
    setSaveState('error');
    toast('تعذّر الحفظ. تأكد من وجود مساحة كافية على الجهاز.', { err: true });
  }
}
function setSaveState(st) {
  S.saving = st;
  document.querySelectorAll('[data-save-state]').forEach((el) => paintSave(el));
}
function paintSave(el) {
  const st = S.saving;
  el.className = 'save-state' + (st === 'saved' ? ' ok' : '');
  el.innerHTML = st === 'saving' ? 'جارٍ الحفظ…' : st === 'error' ? `${icon('warn')} لم يُحفظ` : st === 'saved' ? `${icon('check')} محفوظ` : '';
}
async function saveClassesNow() { noteChange(); await store.saveClasses(S.classes); }
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
      confirmDialog({ title: 'تجاهل التعديلات؟', text: 'لم تحفظ التغييرات على الشعبة.', ok: 'تجاهل', danger: true }).then((yes) => {
        if (yes) { leaving.p.confirmedLeave = true; history.back(); }
      });
      return;
    }
    S.stack.pop();
    S.ui.search = '';
    render({ scrollTop: true });
    if (leaving.name === 'class' && S.sessionChanged && S.meta.changedSinceBackup) {
      S.sessionChanged = false;
      toast('الدرجات محفوظة على الجهاز. احفظ نسخة احتياطية؟', { ms: 7000, action: { label: 'احفظ نسخة', fn: doBackup } });
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
  const screens = { home: Home, class: ClassScreen, student: StudentScreen, editor: Editor, settings: Settings, live: Live, transferOut: TransferOut, transferIn: TransferIn, guide: Guide };
  const fn = screens[r.name] || Home;
  const isRoot = ROOTS.includes(r.name);
  main().className = 'main' + (isRoot ? '' : ' no-tabbar');
  document.body.classList.toggle('no-tabbar', !isRoot);
  document.getElementById('tabbar').classList.toggle('hide', !isRoot);
  main().innerHTML = `<div class="screen-enter">${fn(r.p)}</div>`;
  renderNav();
  main().querySelectorAll('[data-save-state]').forEach(paintSave);
  if (scrollTop) window.scrollTo(0, 0);
  const after = afterRender[r.name];
  if (after) after(r.p);
}
const afterRender = {};

function renderNav() {
  const cur = ROOTS.includes(route().name) ? route().name : (S.stack[0] || {}).name;
  const items = [['home', 'home', 'الرئيسية'], ['live', 'monitor', 'العرض'], ['settings', 'gear', 'الإعدادات']];
  const btns = items.map(([n, ic, label]) => `<button type="button" class="tab" data-act="nav" data-to="${n}" ${cur === n ? 'aria-current="page"' : ''}><span class="tab-ico">${icon(ic)}</span><span>${label}</span></button>`).join('');
  document.getElementById('tabbar').innerHTML = btns;
  document.getElementById('rail').innerHTML = `<div class="brand"><img src="icons/icon-192.png" alt=""><span>${esc(CONFIG.appName)}</span></div>${btns}<div class="rail-foot">الإصدار ${ar(CONFIG.version)}<br>بياناتك على هذا الجهاز فقط</div>`;
}

function appbar({ title, sub = '', backBtn = true, actions = '', save = false }) {
  return `<header class="appbar"><div class="appbar-row">
    ${backBtn ? `<button type="button" class="icon-btn" data-act="back" aria-label="رجوع">${icon('back')}</button>` : ''}
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
  if (platform.isIOS && !platform.isStandalone) {
    alerts.push(`<div class="alert warn">${icon('warn')}<div class="grow"><strong>ثبّت التطبيق على الشاشة الرئيسية</strong><p>في وضع المتصفح قد يمسح آيفون البيانات. أضِفه للشاشة الرئيسية لحماية أفضل.</p><button type="button" class="btn sm soft" data-act="go" data-to="guide">اعرض الطريقة</button></div></div>`);
  }
  if (!st.teacher || !st.subject) {
    alerts.push(`<div class="alert info">${icon('info')}<div class="grow"><strong>أضف اسمك والمادة</strong><p>تظهر في كشف الإكسل وبطاقة الطالب.</p><button type="button" class="btn sm soft" data-act="nav" data-to="settings">إضافة الآن</button></div></div>`);
  }
  const last = S.meta.lastBackupAt ? new Date(S.meta.lastBackupAt) : null;
  const days = last ? (Date.now() - last.getTime()) / 86400000 : Infinity;
  const pending = !!S.meta.changedSinceBackup && hasAnyGrades();
  if (hasAnyGrades() && days > CONFIG.backupReminderDays) {
    alerts.push(`<div class="alert warn" data-testid="backup-reminder">${icon('shield')}<div class="grow"><strong>احفظ نسخة احتياطية</strong><p>${last ? `آخر نسخة قبل ${ar(Math.floor(days))} يومًا.` : 'لم تحفظ أي نسخة بعد.'} احفظها في «الملفات» أو أرسلها لنفسك.</p><button type="button" class="btn sm primary" data-act="backup">احفظ نسخة الآن</button></div></div>`);
  } else if (pending) {
    alerts.push(`<div class="alert info" data-testid="backup-nudge">${icon('shield')}<div class="grow"><strong>عندك درجات جديدة بدون نسخة احتياطية</strong><p>ضغطة واحدة تحفظها في iCloud Drive أو ترسلها لنفسك، فلا تضيع لو ضاع الجوال.</p><button type="button" class="btn sm primary" data-act="backup">${icon('download')} احفظ نسخة الآن</button></div></div>`);
  }

  const backupOk = last && !pending && hasAnyGrades()
    ? `<p class="hint" data-testid="backup-ok" style="color:var(--success);font-weight:700">${icon('checkCircle')} نسختك الاحتياطية محدّثة (${days < 1 ? 'اليوم' : `قبل ${ar(Math.floor(days))} يوم`})</p>` : '';
  const hello = `<div class="hello"><h2>${st.teacher ? `أهلًا أ. ${esc(st.teacher)}` : 'أهلًا بك'}</h2><p>${st.subject ? esc(st.subject) + ' · ' : ''}${S.classes.length ? `${ar(S.classes.length)} ${S.classes.length === 1 ? 'شعبة' : S.classes.length === 2 ? 'شعبتان' : 'شعب'}` : 'لنبدأ'}</p></div>`;

  let body;
  if (!S.classes.length) {
    body = `<div class="empty card">${ART_EMPTY}<h2>ابدأ بثلاث خطوات</h2>
      <ol class="steps">
        <li><span class="n">${ar(1)}</span><span>أضف شعبة (مثل «العاشر / ٣»)</span></li>
        <li><span class="n">${ar(2)}</span><span>الصق أسماء الطلاب أو استوردها من Excel أو PDF</span></li>
        <li><span class="n">${ar(3)}</span><span>ارصد الدرجات ثم صدّر الكشف</span></li>
      </ol>
      <button type="button" class="btn primary lg block" data-act="new-class">${icon('plus')} إضافة شعبة</button>
      <p class="hint" style="margin-top:12px">لديك نسخة احتياطية؟ <button type="button" class="btn ghost sm" data-act="restore">استرجاع نسخة</button></p></div>`;
  } else {
    body = `<div class="home-grid stack">${S.classes.map(classCard).join('')}</div>`;
  }

  return `${appbar({ title: CONFIG.appName, backBtn: false, save: true })}
  <div class="wrap stack home-wrap">
    ${hello}
    ${backupOk}
    ${alerts.join('')}
    ${body}
    ${S.classes.length ? `<button type="button" class="btn primary lg fab" data-act="new-class">${icon('plus')} إضافة شعبة</button>` : ''}
    <div class="section-title">أدوات</div>
    <div class="list">
      <button type="button" class="list-item" data-act="backup">${icon('download')}<span class="grow"><strong>نسخة احتياطية</strong><small>احفظ كل الشعب والدرجات في ملف</small></span></button>
      <button type="button" class="list-item" data-act="restore">${icon('upload')}<span class="grow"><strong>استرجاع نسخة</strong><small>من ملف نسخة احتياطية سابق</small></span></button>
      <button type="button" class="list-item" data-act="go" data-to="transferIn">${icon('inbox')}<span class="grow"><strong>استقبال طلاب منقولين</strong><small>من ملف نقل أرسله معلم آخر</small></span></button>
    </div>
  </div>`;
}

function classCard(c) {
  const n = c.names.length;
  const d = dataOf(c.id);
  const pr = progress(d, n);
  const pct = Math.round(pr.ratio * 100);
  const fw = n ? firstIncompleteWeek(d, n) : null;
  const where = fw == null ? '' : fw === 'fin' ? (finalsRemaining(d, n) ? 'الدرجات النهائية' : 'اكتمل كل شيء ✓') : `الأسبوع ${ar(fw)}`;
  const short = (c.label.match(/[\d٠-٩]+/g) || []).join('/') || c.label.slice(0, 2);
  return `<article class="card class-card tap" data-act="open-class" data-id="${c.id}">
    <div class="head"><span class="class-badge">${esc(ar(short).slice(0, 5))}</span>
      <div class="grow"><h3>${esc(c.label)}</h3><div class="meta">${students(n)}${where ? ` · ${where}` : ''}</div></div>
    </div>
    <div><div class="row" style="justify-content:space-between"><span class="meta">نسبة الرصد</span><b class="num">${ar(pct)}٪</b></div>
      <div class="progress ${pct === 100 ? 'done' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div></div>
    <div class="class-actions">
      ${n ? `<button type="button" class="btn primary" data-act="resume" data-id="${c.id}">${icon('bolt')} تابع من حيث وقفت</button>` : `<button type="button" class="btn soft" data-act="edit-class" data-id="${c.id}">${icon('users')} أضف الطلاب</button>`}
    </div>
  </article>`;
}

// =====================================================================
// الشاشة ٢ — الشعبة (إدخال الدرجات)
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
  const tools = wide ? `<div class="toolbar wrap" style="padding-top:0;padding-bottom:0">
    <button type="button" class="btn sm" data-act="edit-class" data-id="${c.id}">${icon('users')} الطلاب</button>
    <button type="button" class="btn sm" data-act="export-xlsx" data-id="${c.id}">${icon('sheet')} تصدير Excel</button>
    <button type="button" class="btn sm" data-act="go-live" data-id="${c.id}">${icon('monitor')} عرض على الكمبيوتر</button>
    <button type="button" class="btn sm" data-act="go" data-to="transferOut" data-id="${c.id}">${icon('send')} نقل طلاب</button>
  </div>` : '';
  const menuBtn = wide ? '' : `<button type="button" class="icon-btn labeled" data-act="class-menu" aria-label="خيارات الشعبة">${icon('more')}</button>`;
  const weekLabel = p.tab === 'fin' ? 'الدرجات النهائية' : `الأسبوع ${ar(p.tab)}`;
  const weekSub = !n ? '' : p.tab === 'fin'
    ? (finalsRemaining(d, n) ? `باقي ${ar(finalsRemaining(d, n))}` : 'مكتملة ✓')
    : (weekComplete(d, p.tab, n) ? 'مكتمل ✓' : `باقي ${ar(weekRemaining(d, p.tab, n))} من ${ar(n)}`);
  const weekbar = `<div class="weekbar">
    <button type="button" class="icon-btn" data-act="week-step" data-dir="-1" aria-label="الأسبوع السابق" ${p.tab === 1 ? 'disabled' : ''}>${icon('prev')}</button>
    <button type="button" class="week-btn" data-act="week-pick" aria-label="اختر الأسبوع"><b>${weekLabel} ▾</b><small id="week-sub">${weekSub}</small></button>
    <button type="button" class="icon-btn" data-act="week-step" data-dir="1" aria-label="الأسبوع التالي" ${p.tab === 'fin' ? 'disabled' : ''}>${icon('next')}</button>
  </div>`;

  const chips = `<div class="chips" role="tablist" aria-label="الأسابيع">${Array.from({ length: WEEKS }, (_, i) => {
    const w = i + 1;
    const done = n && weekComplete(d, w, n);
    return `<button type="button" role="tab" class="chip ${done ? 'done' : ''}" aria-selected="${p.tab === w}" data-act="tab" data-tab="${w}">${done ? icon('check') : ''}أسبوع ${ar(w)}</button>`;
  }).join('')}<button type="button" role="tab" class="chip ${n && !finalsRemaining(d, n) ? 'done' : ''}" aria-selected="${p.tab === 'fin'}" data-act="tab" data-tab="fin">${n && !finalsRemaining(d, n) ? icon('check') : ''}الدرجات النهائية</button></div>`;

  let body;
  if (!n) {
    body = `<div class="wrap"><div class="empty card">${ART_USERS}<h2>لا يوجد طلاب في هذه الشعبة</h2><p>أضف الأسماء بلصقها أو استوردها من ملف Excel أو PDF.</p>
      <button type="button" class="btn primary lg" data-act="edit-class" data-id="${c.id}">${icon('plus')} أضف الطلاب</button>
      <button type="button" class="btn lg ghost" data-act="go" data-to="transferIn" data-id="${c.id}">${icon('inbox')} استقبال طلاب منقولين</button></div></div>`;
  } else {
    body = `<div class="wrap wide"><div class="split">
      <section id="cls-body">${n > 30 && !p.painted ? skeleton() : (p.tab === 'fin' ? finTab(c, d) : weekTab(c, d, p.tab))}</section>
      <aside class="desk-only" id="aside">${asideHTML(c, d, p)}</aside>
    </div></div>`;
  }

  return `<div class="cls-head">${appbar({ title: c.label, sub: students(n), save: true, actions: menuBtn })}${tools}${n ? (wide ? chips : weekbar) : ''}</div>${body}`;
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

function asideHTML(c, d, p) {
  if (S.ui.selected && S.ui.selected.id === c.id && S.ui.selected.idx < c.names.length) {
    return `<div class="card">${studentCardBody(c, S.ui.selected.idx, { compact: true })}</div>`;
  }
  const n = c.names.length;
  const totals = c.names.map((_, i) => finalTotal(d, i)).filter((v) => v != null);
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  const pr = progress(d, n);
  return `<div class="card stack">
    <h3>ملخص الشعبة</h3>
    <div class="kv">
      <div>نسبة الرصد</div><div class="num">${ar(Math.round(pr.ratio * 100))}٪</div>
      <div>اكتمل مجموعهم النهائي</div><div class="num">${ar(totals.length)} / ${ar(n)}</div>
      <div>متوسط المجموع النهائي</div><div class="num">${fmt(avg)}</div>
      ${p.tab !== 'fin' ? `<div>باقي في الأسبوع ${ar(p.tab)}</div><div class="num">${ar(weekRemaining(d, p.tab, n))}</div>` : ''}
    </div>
    <p class="hint">${icon('info')} اضغط اسم أي طالب لعرض بطاقته هنا.</p>
  </div>`;
}
function refreshAside() {
  const r = route();
  if (r.name !== 'class' || !ASIDE.matches) return;
  const a = document.getElementById('aside');
  const c = cls(r.p.id);
  if (a && c) a.innerHTML = asideHTML(c, dataOf(c.id), r.p);
}

// ----- تبويب الأسبوع -----
function weekTab(c, d, w) {
  const n = c.names.length;
  const meta = getWeekMeta(d, w);
  const q = S.ui.search.trim();
  const qk = q ? nameKey(q) : '';
  const idxs = c.names.map((_, i) => i).filter((i) => !qk || nameKey(c.names[i]).includes(qk) || String(i + 1) === q);
  const visible = idxs.filter((i) => !S.ui.missingOnly || !studentComplete(d, w, i));
  const useGrid = WIDE.matches;
  if (!useGrid) {
    // الجوال: شريط إجراءات صغير + صف مختصر لكل طالب
    const metaLine = meta.date || meta.lesson
      ? `<button type="button" class="meta-line" data-act="week-tools">${icon('calendar')} ${esc([meta.date, meta.lesson].filter(Boolean).join(' · '))}</button>`
      : `<button type="button" class="meta-line muted" data-act="week-tools">${icon('calendar')} أضف التاريخ وعنوان الدرس</button>`;
    const rows = visible.map((i) => stuRow(c, d, w, i)).join('');
    return `<div class="stack">
      <div class="action-row">
        <button type="button" class="btn success" data-act="fill" data-k="all">${icon('check')} الكل ${ar(CONFIG.itemMax)}</button>
        <button type="button" class="btn ${S.ui.missingOnly ? 'primary' : ''}" data-act="missing-toggle" aria-pressed="${S.ui.missingOnly}">الناقص فقط</button>
        <button type="button" class="btn" data-act="week-tools">${icon('edit')} أدوات</button>
      </div>
      ${metaLine}
      <span id="week-status" hidden>${weekStatusHTML(d, w, n)}</span>
      ${n > 12 ? `<div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب أو رقمه" value="${esc(q)}" aria-label="بحث"></div>` : ''}
      <div id="stu-list" class="slist">${rows || `<p class="hint" style="text-align:center;padding:24px">${S.ui.missingOnly && !q ? '🎉 كل الطلاب مكتملون في هذا الأسبوع' : 'لا نتائج'}</p>`}</div>
      <p class="hint" style="text-align:center">${icon('info')} اضغط أي مربع لاختيار الدرجة، أو «كامل» لوضع ${ar(CONFIG.itemMax)} في الأربعة.</p>
    </div>`;
  }

  const list = weekGrid(c, d, w, visible);
  return `<div class="stack">
    <div class="card"><div class="meta-grid">
      <div class="field"><label for="wdate">التاريخ</label><div class="row"><input id="wdate" class="input" data-meta="date" value="${esc(meta.date)}" placeholder="مثال: ١٢/١٠" autocomplete="off"></div></div>
      <div class="field"><label for="wlesson">عنوان الدرس</label><input id="wlesson" class="input" data-meta="lesson" value="${esc(meta.lesson)}" placeholder="اكتب عنوان الدرس" autocomplete="off"></div>
    </div></div>
    <div class="card"><div class="label" style="margin-bottom:8px">تعبئة سريعة <span class="hint">(تملأ الخانات الفارغة فقط)</span></div>
      <div class="toolbar wrap-tools">
        <button type="button" class="btn sm success" data-act="fill" data-k="all">${icon('check')} الكل ${ar(CONFIG.itemMax)}</button>
        ${CRIT.map((cr, k) => `<button type="button" class="btn sm soft" data-act="fill" data-k="${k}">${esc(cr.short)} ${ar(CONFIG.itemMax)}</button>`).join('')}
        <button type="button" class="btn sm" data-act="today">${icon('calendar')} تاريخ اليوم</button>
      </div></div>
    <div class="status-line">
      <span id="week-status">${weekStatusHTML(d, w, n)}</span>
      <label class="toggle-line">الناقص فقط <input type="checkbox" class="switch" data-act="missing" ${S.ui.missingOnly ? 'checked' : ''}></label>
    </div>
    <div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب أو رقمه" value="${esc(q)}" aria-label="بحث"></div>
    <div id="stu-list" class="stack">${list || `<p class="hint" style="text-align:center;padding:24px">${S.ui.missingOnly && !q ? '🎉 لا يوجد طلاب ناقصون في هذا الأسبوع' : 'لا نتائج'}</p>`}</div>
  </div>`;
}

function weekStatusHTML(d, w, n) {
  const rem = weekRemaining(d, w, n);
  return rem ? `<span class="status-pill">${icon('warn')} باقي ${ar(rem)} من ${ar(n)} طالب</span>` : `<span class="status-pill ok">${icon('checkCircle')} اكتمل هذا الأسبوع</span>`;
}

function totalBadge(t, max) {
  const full = t != null && t === max;
  return `<span class="stu-total num ${full ? 'full' : ''}" data-total>${t == null ? '—' : fmt(t)} <span class="of">/ ${ar(max)}</span></span>`;
}

// ----- صف الطالب المختصر (الجوال) -----
function stuRow(c, d, w, i) {
  const done = studentComplete(d, w, i);
  const t = weekTotal(d, w, i);
  return `<div class="srow ${done ? 'complete' : ''}" data-stu="${i}">
    <span class="srow-num num">${ar(i + 1)}</span>
    <button type="button" class="srow-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}</button>
    <div class="boxes" data-inputs>${rowBoxes(w, i, getItems(d, w, i), c.names[i])}</div>
    <span class="srow-total num ${t === CONFIG.itemMax * ITEMS ? 'full' : ''}" data-total>${t == null ? '' : fmt(t)}</span>
    <span class="srow-act" data-rowact>${rowAct(done, i)}</span>
  </div>`;
}
function rowAct(done, i) {
  return done ? `<span class="srow-done" aria-label="مكتمل">${icon('checkCircle')}</span>`
    : `<button type="button" class="btn-full" data-act="full" data-idx="${i}" aria-label="كامل: ${ar(CONFIG.itemMax)} في كل البنود">كامل</button>`;
}
function rowBoxes(w, i, vals, name) {
  if (S.settings.inputMode === 'fields') {
    return CRIT.map((cr, k) => `<label class="box field"><small>${esc(cr.short)}</small><input class="score-input" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-score="item" data-idx="${i}" data-k="${k}" value="${vals[k] == null ? '' : ar(vals[k])}" placeholder="" aria-label="${esc(cr.label)} — ${esc(name)}"><span class="cell-err" data-err></span></label>`).join('');
  }
  return CRIT.map((cr, k) => `<button type="button" class="box ${vals[k] == null ? '' : 'filled'}" data-act="box" data-idx="${i}" data-k="${k}" aria-label="${esc(cr.label)}: ${vals[k] == null ? 'فارغ' : ar(vals[k])}"><small>${esc(cr.short)}</small><b class="num">${vals[k] == null ? '' : ar(vals[k])}</b></button>`).join('');
}

// نافذة اختيار الدرجة: تبقى مفتوحة وتنتقل للبند التالي حتى يكتمل الطالب
function openPicker(c, w, i, k0) {
  const d = dataOf(c.id);
  let k = k0;
  const s = openSheet('<div data-picker></div>', { label: 'اختيار الدرجة' });
  const paint = () => {
    const vals = getItems(d, w, i);
    s.sheet.querySelector('[data-picker]').innerHTML = `
      <div class="picker-head"><span class="srow-num num">${ar(i + 1)}</span><b>${esc(c.names[i])}</b></div>
      <div class="seg picker-tabs" role="tablist">${CRIT.map((cr, j) => `<button type="button" data-pk="${j}" aria-pressed="${j === k}">${esc(cr.short)} <span class="num">${vals[j] == null ? '—' : ar(vals[j])}</span></button>`).join('')}</div>
      <div class="picker-grid">${CONFIG.chipValues.map((x) => `<button type="button" class="pv ${vals[k] === x ? 'on' : ''}" data-pv="${x}">${ar(x)}</button>`).join('')}
        <button type="button" class="pv other" data-pv="other">رقم آخر</button></div>
      <div class="actions"><button type="button" class="btn" data-pv="clear">مسح</button><button type="button" class="btn primary" data-pv="close">تم</button></div>`;
  };
  paint();
  (s.sheet.querySelector('.pv.on') || s.sheet.querySelector('.pv')).focus({ preventScroll: true });
  s.sheet.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-pk]');
    if (tab) { k = +tab.dataset.pk; paint(); return; }
    const b = e.target.closest('[data-pv]');
    if (!b) return;
    const v = b.dataset.pv;
    if (v === 'close') return s.close();
    let val;
    if (v === 'clear') val = null;
    else if (v === 'other') {
      const res = await keypad({ title: `${CRIT[k].label} — ${c.names[i]}`, max: CONFIG.itemMax, value: getItems(d, w, i)[k] });
      if (!res) return;
      val = res.value;
    } else val = +v;
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
  });
}

function stuCard(c, d, w, i) {
  const vals = getItems(d, w, i);
  const done = studentComplete(d, w, i);
  return `<article class="card stu ${done ? 'complete' : ''}" data-stu="${i}">
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
    return `<div class="item-row"><span class="item-label">${esc(cr.label)}</span><div class="score-chips" role="group" aria-label="${esc(cr.label)}">
      ${CONFIG.chipValues.map((x) => `<button type="button" class="sc" data-act="chip" data-idx="${i}" data-k="${k}" data-v="${x}" aria-pressed="${v === x}">${ar(x)}</button>`).join('')}
      <button type="button" class="sc other" data-act="other" data-idx="${i}" data-k="${k}" aria-pressed="${other}" aria-label="رقم آخر" title="رقم آخر">${other ? ar(v) : 'أخرى'}</button>
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
    return `<tr data-stu="${i}" class="${studentComplete(d, w, i) ? 'complete' : ''}">
      <td class="num">${ar(i + 1)}</td>
      <td class="name"><button type="button" class="stu-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}</button></td>
      ${CRIT.map((cr, k) => `<td><input class="score-input" inputmode="decimal" autocomplete="off" data-score="item" data-idx="${i}" data-k="${k}" value="${vals[k] == null ? '' : ar(vals[k])}" placeholder="—" aria-label="${esc(cr.label)} — ${esc(c.names[i])}"><span class="cell-err" data-err></span></td>`).join('')}
      <td class="total num" data-total>${t == null ? '—' : fmt(t)}</td>
      <td><button type="button" class="btn-full" data-act="full" data-idx="${i}">${icon('check')} كامل</button></td>
    </tr>`;
  }).join('');
  return `<div class="grid-wrap"><table class="grid">
    <thead><tr><th>م</th><th class="name">اسم الطالب</th>${CRIT.map((cr) => `<th>${esc(cr.label)}<br><small>/ ${ar(CONFIG.itemMax)}</small></th>`).join('')}<th>المجموع<br><small>/ ${ar(CONFIG.itemMax * ITEMS)}</small></th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="hint">${icon('info')} اكتب الدرجة ثم Enter للانتقال. الأسهم ↑↓ تنقلك بين الطلاب في نفس العمود.</p>`;
}

// ----- تبويب الدرجات النهائية -----
function finTab(c, d) {
  const n = c.names.length;
  const q = S.ui.search.trim();
  const qk = q ? nameKey(q) : '';
  const idxs = c.names.map((_, i) => i).filter((i) => !qk || nameKey(c.names[i]).includes(qk) || String(i + 1) === q)
    .filter((i) => !S.ui.missingOnly || getFin(d, i).some((v) => v == null));
  const rem = finalsRemaining(d, n);
  const intro = `<div class="alert info">${icon('info')}<div class="grow"><strong>الدرجات النهائية</strong><p style="margin:0">أدخل ${FINS.map((f) => `${f.label} (من ${ar(f.max)})`).join('، ')}. يُحسب المجموع من ${ar(100)} عند اكتمال كل الأسابيع والدرجات.</p></div></div>`;
  const status = `<div class="status-line"><span id="week-status">${rem ? `<span class="status-pill">${icon('warn')} باقي ${ar(rem)} من ${ar(n)} طالب</span>` : `<span class="status-pill ok">${icon('checkCircle')} اكتملت الدرجات النهائية</span>`}</span>
    <label class="toggle-line">الناقص فقط <input type="checkbox" class="switch" data-act="missing" ${S.ui.missingOnly ? 'checked' : ''}></label></div>`;
  const search = `<div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب أو رقمه" value="${esc(q)}" aria-label="بحث"></div>`;
  let list;
  if (WIDE.matches) {
    list = `<div class="grid-wrap"><table class="grid"><thead><tr><th>م</th><th class="name">اسم الطالب</th><th>الفترة ١<br><small>/ ٢٠</small></th><th>الفترة ٢<br><small>/ ٢٠</small></th><th>البنائي<br><small>/ ٤٠</small></th>
      ${FINS.map((f) => `<th>${esc(f.label)}<br><small>/ ${ar(f.max)}</small></th>`).join('')}<th>المجموع<br><small>/ ١٠٠</small></th></tr></thead><tbody>
      ${idxs.map((i) => { const fin = getFin(d, i); return `<tr data-stu="${i}"><td class="num">${ar(i + 1)}</td><td class="name"><button type="button" class="stu-name" data-act="open-student" data-idx="${i}">${esc(c.names[i])}</button></td>
        <td class="num" data-p1>${fmt(periodScore(d, i, 1))}</td><td class="num" data-p2>${fmt(periodScore(d, i, 2))}</td><td class="num" data-form>${fmt(formative(d, i))}</td>
        ${FINS.map((f, k) => `<td><input class="score-input" inputmode="decimal" autocomplete="off" data-score="fin" data-idx="${i}" data-k="${k}" value="${fin[k] == null ? '' : ar(fin[k])}" placeholder="—" aria-label="${esc(f.label)} — ${esc(c.names[i])}"><span class="cell-err" data-err></span></td>`).join('')}
        <td class="total num" data-total>${fmt(finalTotal(d, i))}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  } else {
    const rows = idxs.map((i) => finRow(c, d, i)).join('');
    return `<div class="stack">
      <div class="action-row">
        <button type="button" class="btn ${S.ui.missingOnly ? 'primary' : ''}" data-act="missing-toggle" aria-pressed="${S.ui.missingOnly}">الناقص فقط</button>
      </div>
      <span id="week-status" hidden></span>
      <p class="hint">${FINS.map((f) => `${esc(f.label)} من ${ar(f.max)}`).join(' · ')}. المجموع من ${ar(100)} يظهر عند اكتمال كل شيء.</p>
      ${n > 12 ? search : ''}
      <div id="stu-list" class="slist">${rows || '<p class="hint" style="text-align:center;padding:24px">لا نتائج</p>'}</div>
    </div>`;
  }
  return `<div class="stack">${intro}${status}${search}<div id="stu-list" class="stack">${list || '<p class="hint" style="text-align:center;padding:24px">لا نتائج</p>'}</div></div>`;
}

function finRow(c, d, i) {
  const fin = getFin(d, i);
  const t = finalTotal(d, i);
  const boxes = S.settings.inputMode === 'fields'
    ? FINS.map((f, k) => `<label class="box field"><small>${esc(f.short || f.label)} /${ar(f.max)}</small><input class="score-input" inputmode="decimal" enterkeyhint="next" autocomplete="off" data-score="fin" data-idx="${i}" data-k="${k}" value="${fin[k] == null ? '' : ar(fin[k])}" placeholder="" aria-label="${esc(f.label)} — ${esc(c.names[i])}"><span class="cell-err" data-err></span></label>`).join('')
    : FINS.map((f, k) => `<button type="button" class="box ${fin[k] == null ? '' : 'filled'}" data-act="fin-box" data-idx="${i}" data-k="${k}" aria-label="${esc(f.label)}: ${fin[k] == null ? 'فارغ' : ar(fin[k])}"><small>${esc(f.short || f.label)} /${ar(f.max)}</small><b class="num">${fin[k] == null ? '' : ar(fin[k])}</b></button>`).join('');
  return `<div class="srow fin ${t != null ? 'complete' : ''}" data-stu="${i}">
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
  return `<article class="card stu ${t != null ? 'complete' : ''}" data-stu="${i}">
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
    if (!isFin) el.querySelector('[data-rowact]').innerHTML = rowAct(done, i);
    if (isFin) { const f = el.querySelector('[data-form]'); if (f) f.textContent = fmt(formative(d, i)); }
    if (rerenderInputs || S.settings.inputMode !== 'fields') {
      if (isFin) { const tmp = document.createElement('div'); tmp.innerHTML = finRow(cls(c.id), d, i); el.querySelector('[data-inputs]').innerHTML = tmp.querySelector('[data-inputs]').innerHTML; }
      else el.querySelector('[data-inputs]').innerHTML = rowBoxes(w, i, getItems(d, w, i), c.names[i]);
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
    ? (finalsRemaining(d, n) ? `<span class="status-pill">${icon('warn')} باقي ${ar(finalsRemaining(d, n))} من ${ar(n)} طالب</span>` : `<span class="status-pill ok">${icon('checkCircle')} اكتملت الدرجات النهائية</span>`)
    : weekStatusHTML(d, w, n);
  const sub = document.getElementById('week-sub');
  if (sub) sub.textContent = w === 'fin'
    ? (finalsRemaining(d, n) ? `باقي ${ar(finalsRemaining(d, n))}` : 'مكتملة ✓')
    : (weekComplete(d, w, n) ? 'مكتمل ✓' : `باقي ${ar(weekRemaining(d, w, n))} من ${ar(n)}`);
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
    chip.innerHTML = (done ? icon('check') : '') + (w === 'fin' ? 'الدرجات النهائية' : `أسبوع ${ar(w)}`);
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
function studentCardBody(c, i, { compact: small = false } = {}) {
  const d = dataOf(c.id);
  const compact = small || window.innerWidth < 480; // بدون عمود التاريخ على الشاشات الضيقة
  const sm = studentSummary(d, i);
  const total = sm.total;
  const rows = [];
  for (let w = 1; w <= WEEKS; w++) {
    const it = getItems(d, w, i);
    const meta = getWeekMeta(d, w);
    rows.push(`<tr><td class="start"><b>${ar(w)}</b></td>${compact ? '' : `<td class="muted">${esc(meta.date) || '—'}</td>`}${it.map((v) => `<td class="num">${fmt(v)}</td>`).join('')}<td class="num"><b>${fmt(sm.weeks[w - 1])}</b></td></tr>`);
    if (w === 5) rows.push(`<tr class="sum"><td class="start" colspan="${compact ? 5 : 6}">الفترة الأولى (من ٢٠)</td><td class="num">${fmt(sm.p1)}</td></tr>`);
  }
  rows.push(`<tr class="sum"><td class="start" colspan="${compact ? 5 : 6}">الفترة الثانية (من ٢٠)</td><td class="num">${fmt(sm.p2)}</td></tr>`);
  return `<div class="stack">
    <div><p class="big-name" ${small ? 'style="font-size:21px"' : ''}>${esc(c.names[i])}</p>
      <div class="meta">${esc(c.label)} · رقم ${ar(i + 1)}${S.settings.subject ? ' · ' + esc(S.settings.subject) : ''}</div></div>
    <div class="banner ${total != null ? 'ok' : ''}"><span>المجموع النهائي</span>${total != null ? `<b class="num">${fmt(total)} <small>/ ${ar(100)}</small></b>` : '<strong>لم يكتمل بعد</strong>'}</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="start">الأسبوع</th>${compact ? '' : '<th>التاريخ</th>'}${CRIT.map((cr) => `<th>${esc(cr.short)}</th>`).join('')}<th>المجموع</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <div class="card flat"><h3 style="margin-bottom:8px">الدرجات النهائية</h3><div class="kv">
      <div>التقويم البنائي</div><div class="num">${fmt(sm.formative)} / ${ar(40)}</div>
      ${FINS.map((f, k) => `<div>${esc(f.label)}</div><div class="num">${fmt(sm.fin[k])} / ${ar(f.max)}</div>`).join('')}
    </div></div>
    <button type="button" class="btn primary block" data-act="share-student" data-id="${c.id}" data-idx="${i}">${icon('share')} مشاركة البطاقة</button>
    ${small ? `<button type="button" class="btn ghost block" data-act="close-aside">إغلاق البطاقة</button>` : ''}
  </div>`;
}

function StudentScreen(p) {
  const c = cls(p.id);
  if (!c || p.idx >= c.names.length) return Home();
  const n = c.names.length;
  const nav = `<button type="button" class="icon-btn" data-act="stu-nav" data-dir="-1" ${p.idx === 0 ? 'disabled' : ''} aria-label="الطالب السابق">${icon('prev')}</button>
    <button type="button" class="icon-btn" data-act="stu-nav" data-dir="1" ${p.idx === n - 1 ? 'disabled' : ''} aria-label="الطالب التالي">${icon('next')}</button>`;
  return `${appbar({ title: 'بطاقة الطالب', sub: `${ar(p.idx + 1)} من ${ar(n)}`, actions: nav })}
    <div class="wrap">${studentCardBody(c, p.idx)}</div>`;
}

// =====================================================================
// الشاشة ٤ — إضافة/تعديل شعبة (مسودة)
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
    return `<div class="name-row" data-row="${j}"><span class="stu-num num">${ar(j + 1)}</span>
      <input class="input grow" data-name-row="${j}" value="${esc(r.name)}" aria-label="اسم الطالب ${ar(j + 1)}">
      ${has ? '<span class="tag">له درجات</span>' : ''}
      <button type="button" class="icon-btn" data-act="del-row" data-row="${j}" aria-label="حذف الطالب">${icon('x')}</button></div>`;
  }).join('');
  return `${appbar({ title: p.id ? 'تعديل الشعبة' : 'شعبة جديدة', actions: `<button type="button" class="btn primary sm" data-act="save-class">${p.id ? 'حفظ' : 'إنشاء'}</button>` })}
  <div class="wrap stack">
    <div class="card"><div class="field"><label for="cls-label">اسم الشعبة</label><input id="cls-label" class="input" data-draft-label value="${esc(dr.label)}" placeholder="مثل: العاشر / ٣" autocomplete="off"></div></div>
    <div class="card stack">
      <h3>إضافة طلاب</h3>
      <div class="field"><label for="paste">الصق الأسماء (اسم في كل سطر)</label>
        <textarea id="paste" class="textarea" data-paste placeholder="الصق هنا قائمة الأسماء من Excel أو واتساب أو أي ملف…"></textarea></div>
      <div class="row wrap-row">
        <button type="button" class="btn primary" data-act="add-names">${icon('plus')} إضافة الأسماء</button>
        <button type="button" class="btn" data-act="import-file">${icon('upload')} استيراد من ملف</button>
        <button type="button" class="btn ghost" data-act="add-one">${icon('plus')} طالب جديد</button>
      </div>
      <p class="hint">يقبل الاستيراد: Excel (xlsx)، PDF (حتى الممسوح ضوئيًا)، صورة للكشف، CSV، نص. ننظف الترقيم والمسافات ونتجاهل المكرر. الحد الأقصى ${ar(MAX_STUDENTS)} طالبًا.</p>
      ${p.id ? `<button type="button" class="btn soft" data-act="go" data-to="transferIn" data-id="${p.id}">${icon('inbox')} استقبال طلاب منقولين من معلم آخر</button>` : ''}
    </div>
    <div class="row" style="justify-content:space-between;margin-top:20px">
      <div class="section-title" style="margin:0">قائمة الطلاب <span class="count-badge num">${ar(n)} / ${ar(MAX_STUDENTS)}</span></div>
      ${n > 1 ? `<button type="button" class="btn sm" data-act="sort-az">${icon('sort')} ترتيب أبجدي</button>` : ''}
    </div>
    <div class="list" id="name-list">${rows || '<p class="hint" style="padding:16px;text-align:center">لا يوجد طلاب بعد.</p>'}</div>
    ${p.id ? `<div class="section-title">منطقة الخطر</div><button type="button" class="btn danger-ghost block" data-act="delete-class">${icon('trash')} حذف الشعبة</button>` : ''}
    <button type="button" class="btn primary lg block" data-act="save-class">${p.id ? 'حفظ التعديلات' : 'إنشاء الشعبة'}</button>
  </div>`;
}

function addNamesToDraft(p, raw) {
  const existing = p.draft.rows.map((r) => r.name);
  const res = cleanNames(raw, existing, MAX_STUDENTS);
  res.names.forEach((name) => p.draft.rows.push({ name, from: null }));
  if (res.names.length) p.dirty = true;
  const parts = [`أُضيف ${namesWord(res.names.length)}`];
  if (res.dup) parts.push(`${ar(res.dup)} مكرر`);
  if (res.overLimit) parts.push(`${ar(res.overLimit)} فوق الحد (${ar(MAX_STUDENTS)})`);
  toast(res.names.length || res.dup || res.overLimit ? parts.join(' · ') : 'لم نجد أسماء صالحة', { err: !res.names.length && !res.dup });
  return res;
}

async function saveEditor(p) {
  const label = (p.draft.label || '').trim();
  if (!label) { toast('اكتب اسم الشعبة أولًا', { err: true }); document.getElementById('cls-label')?.focus(); return; }
  const rows = p.draft.rows.map((r) => ({ ...r, name: r.name.replace(/\s+/g, ' ').trim() })).filter((r) => r.name);
  if (rows.length > MAX_STUDENTS) { toast(`الحد الأقصى ${ar(MAX_STUDENTS)} طالبًا`, { err: true }); return; }
  if (p.id) {
    const c = cls(p.id);
    c.label = label;
    c.names = rows.map((r) => r.name);
    S.grades[c.id] = remapData(dataOf(c.id), rows.map((r) => r.from));
    await saveClassesNow();
    await store.saveGrades(c.id, S.grades[c.id]);
    liveResync(c.id);
    toast('حُفظت الشعبة ✓');
    p.dirty = false; p.confirmedLeave = true;
    back();
  } else {
    const c = { id: uid(), label, names: rows.map((r) => r.name) };
    S.classes.push(c);
    S.grades[c.id] = emptyClassData();
    await saveClassesNow();
    await store.saveGrades(c.id, S.grades[c.id]);
    toast('أُنشئت الشعبة ✓');
    p.dirty = false; p.confirmedLeave = true;
    S.stack.pop();
    S.stack.push({ name: 'class', p: { id: c.id } });
    history.replaceState({ depth: S.stack.length }, '');
    render({ scrollTop: true });
  }
}

async function deleteClass(id) {
  const c = cls(id);
  if (!c) return;
  const ok = await confirmDialog({ title: `حذف «${c.label}»؟`, text: `سيُحذف ${students(c.names.length)} وكل درجاتهم من هذا الجهاز.`, ok: 'حذف الشعبة', danger: true });
  if (!ok) return;
  const pos = S.classes.indexOf(c);
  const data = dataOf(id);
  S.classes.splice(pos, 1);
  delete S.grades[id];
  await saveClassesNow();
  await store.deleteGrades(id);
  S.stack = [{ name: 'home', p: {} }];
  history.replaceState({ depth: 1 }, '');
  render({ scrollTop: true });
  toast(`حُذفت «${c.label}»`, {
    ms: CONFIG.undoDeleteMs,
    action: { label: 'تراجع', fn: async () => {
      S.classes.splice(Math.min(pos, S.classes.length), 0, c);
      S.grades[id] = data;
      await saveClassesNow();
      await store.saveGrades(id, data);
      render();
      toast('أُعيدت الشعبة ✓');
    } },
  });
}

// معاينة الأسماء المستوردة من ملف قبل الإضافة
async function importFileToDraft(p) {
  const file = await platform.pickFile('.xlsx,.xls,.csv,.txt,.pdf,.jpg,.jpeg,.png,application/pdf,text/csv,text/plain,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  if (!file) return;
  let close = toast('جارٍ قراءة الملف…', { ms: 0 });
  let res;
  let lastPct = -1;
  const onProgress = (pr) => {
    if (!pr || pr.stage !== 'ocr') return;
    const pct = Math.round(((pr.page - 1 + (pr.ratio || 0)) / (pr.pages || 1)) * 100);
    if (pct === lastPct || pct % 5) return;
    lastPct = pct;
    close();
    close = toast(`نقرأ الأسماء من الصورة… ${ar(pct)}٪ (صفحة ${ar(pr.page)} من ${ar(pr.pages)})`, { ms: 0 });
  };
  try {
    const { readNamesFromFile } = await import('./importers.js');
    res = await readNamesFromFile(file, { onProgress });
  } catch (e) {
    close();
    toast(e && e.message && /[؀-ۿ]/.test(e.message) ? e.message : 'تعذّرت قراءة الملف. جرّب حفظه بصيغة xlsx أو انسخ الأسماء والصقها.', { err: true, ms: 6000 });
    return;
  }
  close();
  const existing = p.draft.rows.map((r) => r.name);
  const cleaned = cleanNames(res.names, existing, 999);
  if (!cleaned.names.length) {
    toast(cleaned.dup ? `كل الأسماء موجودة مسبقًا (${ar(cleaned.dup)})` : 'لم نجد أسماء طلاب في هذا الملف', { err: !cleaned.dup });
    return;
  }
  const kindName = { xlsx: 'Excel', csv: 'CSV', txt: 'ملف نصي', pdf: 'PDF', 'pdf-ocr': 'PDF', 'image-ocr': 'الصورة' }[res.kind] || 'الملف';
  const ocr = res.ocr || /ocr/.test(res.kind || '');
  const room = MAX_STUDENTS - p.draft.rows.length;
  const s = openSheet(`<h2>وجدنا ${namesWord(cleaned.names.length)} في ${kindName}</h2>
    <p>${res.column ? `من عمود «${esc(res.column)}». ` : ''}ألغِ تحديد أي سطر ليس اسم طالب، ويمكنك تصحيح أي اسم قبل الإضافة.${cleaned.dup ? ` (تجاهلنا ${ar(cleaned.dup)} مكرر)` : ''}</p>
    ${ocr ? `<div class="alert warn">${icon('eye')}<div class="grow"><strong>قُرئت الأسماء من صورة</strong><p style="margin:0">القراءة الآلية قد تخطئ في بعض الحروف؛ راجع الأسماء وصحّحها هنا أو لاحقًا من قائمة الطلاب.</p></div></div>` : ''}
    ${cleaned.names.length > room ? `<div class="alert warn">${icon('warn')}<div class="grow">يتسع الفصل لـ ${ar(room)} فقط؛ سيُضاف أول ${ar(room)} محدد.</div></div>` : ''}
    <div class="row" style="justify-content:space-between;margin:8px 0"><span class="count-badge num" data-count></span>
      <span><button type="button" class="btn sm ghost" data-pick-all="1">تحديد الكل</button><button type="button" class="btn sm ghost" data-pick-all="0">إلغاء الكل</button></span></div>
    <div class="list" style="max-height:46vh;overflow:auto">${cleaned.names.map((nm, j) => `<div class="pick"><input type="checkbox" data-pick="${j}" checked aria-label="تحديد"><input class="input grow" data-pick-name="${j}" value="${esc(nm)}" aria-label="الاسم ${ar(j + 1)}"></div>`).join('')}</div>
    <div class="actions"><button type="button" class="btn" data-x="cancel">إلغاء</button><button type="button" class="btn primary" data-x="ok">إضافة المحدد</button></div>`, { wide: true, label: 'معاينة الأسماء' });
  const count = () => { s.sheet.querySelector('[data-count]').textContent = `${ar(s.sheet.querySelectorAll('[data-pick]:checked').length)} محدد`; };
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
// نقل الطلاب — إرسال (لمعلم آخر أو لشعبة أخرى على نفس الجهاز)
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
  return `${appbar({ title: 'نقل طلاب', sub: esc(c.label) })}
  <div class="wrap stack">
    <div class="alert info">${icon('info')}<div class="grow"><strong>اختر الطلاب المنقولين</strong><p style="margin:0">تنتقل أسماؤهم مع كل درجاتهم الأسبوعية والنهائية. أرسل الملف للمعلم الجديد (واتساب أو بريد) ليستقبله من «استقبال طلاب منقولين»، أو انقلهم لشعبة أخرى عندك.</p></div></div>
    <div class="search">${icon('search')}<input class="input" type="search" data-search placeholder="ابحث باسم الطالب" value="${esc(q)}" aria-label="بحث"></div>
    <div class="row" style="justify-content:space-between"><span class="count-badge num">${k ? `اخترت ${students(k)}` : 'لم تختر أحدًا'}</span>
      <span><button type="button" class="btn sm ghost" data-act="sel-all" data-v="1">تحديد الكل</button><button type="button" class="btn sm ghost" data-act="sel-all" data-v="0">إلغاء الكل</button></span></div>
    <div class="list">${list.map(({ nm, i }) => `<label class="pick"><input type="checkbox" data-sel="${i}" ${p.sel.has(i) ? 'checked' : ''}><span class="stu-num num">${ar(i + 1)}</span><span class="grow">${esc(nm)}</span>${studentHasGrades(d, i) ? '<span class="meta">له درجات</span>' : ''}</label>`).join('') || '<p class="hint" style="padding:16px">لا نتائج</p>'}</div>
    <div class="card stack" style="position:sticky;bottom:calc(var(--safe-b) + 8px);box-shadow:var(--shadow-lg)">
      <button type="button" class="btn primary block" data-act="transfer-file" ${k ? '' : 'disabled'}>${icon('send')} حفظ ملف النقل وإرساله لمعلم آخر</button>
      <button type="button" class="btn block" data-act="transfer-move" ${k && S.classes.length > 0 ? '' : 'disabled'}>${icon('move')} نقل إلى شعبة أخرى عندي</button>
    </div>
  </div>`;
}

async function doTransferFile(p) {
  const c = cls(p.id);
  const idxs = [...p.sel].sort((a, b) => a - b);
  const tr = buildTransfer({ classLabel: c.label, names: c.names, data: dataOf(c.id), idxs, settings: S.settings });
  const name = transferFileName(c.label, idxs.length);
  try {
    await platform.saveFile(name, new Blob([JSON.stringify(tr)], { type: 'application/json' }), 'application/json');
  } catch { toast('تعذّر حفظ الملف', { err: true }); return; }
  const remove = await confirmDialog({ title: 'هل انتقل الطلاب فعلًا؟', text: `يمكنك حذف ${students(idxs.length)} من «${c.label}» الآن، أو إبقاؤهم إن كنت أرسلت نسخة فقط.`, ok: 'نعم، احذفهم من شعبتي', cancel: 'أبقهم', danger: true });
  if (remove) {
    const keep = c.names.map((_, i) => i).filter((i) => !p.sel.has(i));
    const before = { names: c.names.slice(), data: dataOf(c.id) };
    c.names = keep.map((i) => before.names[i]);
    S.grades[c.id] = remapData(before.data, keep);
    await saveClassesNow(); await store.saveGrades(c.id, S.grades[c.id]);
    liveResync(c.id);
    p.sel = new Set();
    render();
    toast(`حُذف ${students(idxs.length)} من الشعبة`, { ms: CONFIG.undoDeleteMs, action: { label: 'تراجع', fn: async () => {
      c.names = before.names; S.grades[c.id] = before.data;
      await saveClassesNow(); await store.saveGrades(c.id, before.data); liveResync(c.id); render();
    } } });
  } else toast('حُفظ ملف النقل ✓');
}

function doTransferMove(p) {
  const c = cls(p.id);
  const others = S.classes.filter((x) => x.id !== c.id);
  const s = openSheet(`<h2>نقل ${students(p.sel.size)} إلى…</h2><p>تنتقل الدرجات معهم وتُحذف من «${esc(c.label)}».</p>
    <div class="list">${others.map((o) => `<button type="button" class="list-item" data-to-cls="${o.id}">${icon('users')}<span class="grow"><strong>${esc(o.label)}</strong><small>${students(o.names.length)}</small></span>${icon('fwd')}</button>`).join('')}
    <button type="button" class="list-item" data-to-cls="__new">${icon('plus')}<span class="grow"><strong>شعبة جديدة</strong><small>أنشئ شعبة بهؤلاء الطلاب</small></span></button></div>
    <div class="actions"><button type="button" class="btn" data-x>إلغاء</button></div>`, { label: 'نقل إلى شعبة' });
  s.sheet.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) return s.close();
    const b = e.target.closest('[data-to-cls]');
    if (!b) return;
    let dst;
    if (b.dataset.toCls === '__new') {
      dst = { id: uid(), label: `${c.label} (منقولون)`, names: [] };
      S.classes.push(dst); S.grades[dst.id] = emptyClassData();
    } else dst = cls(b.dataset.toCls);
    s.close();
    const res = moveStudents({ src: { names: c.names, data: dataOf(c.id) }, dst: { names: dst.names, data: dataOf(dst.id) }, idxs: [...p.sel].sort((a, b2) => a - b2) });
    c.names = res.src.names; S.grades[c.id] = res.src.data;
    dst.names = res.dst.names; S.grades[dst.id] = res.dst.data;
    await saveClassesNow(); await store.saveGrades(c.id, S.grades[c.id]); await store.saveGrades(dst.id, S.grades[dst.id]);
    liveResync(c.id); liveResync(dst.id);
    p.sel = new Set();
    const parts = [`نُقل ${students(res.moved)} إلى «${dst.label}»`];
    if (res.dup) parts.push(`${ar(res.dup)} موجود مسبقًا`);
    if (res.overLimit) parts.push(`${ar(res.overLimit)} فوق الحد`);
    toast(parts.join(' · '));
    render();
  });
}

// =====================================================================
// نقل الطلاب — استقبال
// =====================================================================
function TransferIn(p) {
  if (!p.tr) {
    return `${appbar({ title: 'استقبال طلاب منقولين' })}
    <div class="wrap stack">
      <div class="empty card">${ART_USERS}<h2>اختر ملف النقل</h2><p>ملف ينتهي بـ ‎.json أرسله لك معلم آخر من «نقل طلاب». يحوي أسماء الطلاب ودرجاتهم.</p>
        <button type="button" class="btn primary lg" data-act="pick-transfer">${icon('upload')} اختيار الملف</button></div>
      <p class="hint">${icon('info')} لإضافة أسماء فقط (بدون درجات) من Excel أو PDF استعمل «الطلاب» داخل الشعبة.</p>
    </div>`;
  }
  const tr = p.tr;
  p.pick ||= new Set(tr.students.map((_, i) => i));
  p.target ||= p.id && cls(p.id) ? p.id : '__new';
  p.newLabel ??= tr.from.classLabel || '';
  const count = (st) => { let n = 0; for (const w of Object.values(st.weeks || {})) n += (w || []).filter((v) => v != null).length; return n + (st.fin || []).filter((v) => v != null).length; };
  return `${appbar({ title: 'استقبال طلاب منقولين' })}
  <div class="wrap stack">
    <div class="card"><div class="kv">
      <div>من المعلم</div><div>${esc(tr.from.teacher || '—')}</div>
      <div>الشعبة الأصلية</div><div>${esc(tr.from.classLabel || '—')}</div>
      <div>المادة</div><div>${esc(tr.from.subject || '—')}</div>
      <div>تاريخ الملف</div><div class="num">${tr.at ? ar(new Date(tr.at).toLocaleDateString('en-GB')) : '—'}</div>
    </div></div>
    <div class="section-title">أضفهم إلى</div>
    <div class="list">
      ${S.classes.map((o) => `<label class="pick"><input type="radio" name="tgt" data-tgt="${o.id}" ${p.target === o.id ? 'checked' : ''}><span class="grow"><strong>${esc(o.label)}</strong> <small class="muted">${students(o.names.length)}</small></span></label>`).join('')}
      <label class="pick"><input type="radio" name="tgt" data-tgt="__new" ${p.target === '__new' ? 'checked' : ''}><span class="grow"><strong>شعبة جديدة</strong></span></label>
    </div>
    ${p.target === '__new' ? `<div class="field"><label for="new-label">اسم الشعبة الجديدة</label><input id="new-label" class="input" data-new-label value="${esc(p.newLabel)}" placeholder="مثل: العاشر / ٣"></div>` : ''}
    <div class="row" style="justify-content:space-between;margin-top:12px"><span class="count-badge num">${ar(p.pick.size)} من ${ar(tr.students.length)}</span>
      <span><button type="button" class="btn sm ghost" data-act="pick-all" data-v="1">تحديد الكل</button><button type="button" class="btn sm ghost" data-act="pick-all" data-v="0">إلغاء الكل</button></span></div>
    <div class="list">${tr.students.map((st, i) => `<label class="pick"><input type="checkbox" data-pick-st="${i}" ${p.pick.has(i) ? 'checked' : ''}><span class="grow">${esc(st.name)}</span><span class="meta">${count(st) ? `${ar(count(st))} درجة` : 'بدون درجات'}</span></label>`).join('')}</div>
    <button type="button" class="btn primary lg block" data-act="apply-transfer" ${p.pick.size ? '' : 'disabled'}>${icon('check')} إضافة ${students(p.pick.size)}</button>
  </div>`;
}

async function pickTransfer(p) {
  const file = await platform.pickFile('.json,application/json');
  if (!file) return;
  try {
    const tr = parseTransfer(await file.text());
    p.tr = tr; p.pick = null;
    render();
  } catch (e) {
    toast(e && /[؀-ۿ]/.test(e.message || '') ? e.message : 'هذا ليس ملف نقل طلاب صالحًا', { err: true, ms: 5000 });
  }
}

async function applyTransferUI(p) {
  let target;
  if (p.target === '__new') {
    const label = (p.newLabel || '').trim() || 'شعبة منقولة';
    target = { id: uid(), label, names: [] };
    S.classes.push(target); S.grades[target.id] = emptyClassData();
  } else target = cls(p.target);
  const res = applyTransfer({ names: target.names, data: dataOf(target.id) }, p.tr, [...p.pick].sort((a, b) => a - b), MAX_STUDENTS);
  target.names = res.names; S.grades[target.id] = res.data;
  await saveClassesNow(); await store.saveGrades(target.id, res.data);
  liveResync(target.id);
  const parts = [`أُضيف ${students(res.added)} إلى «${target.label}»`];
  if (res.dup) parts.push(`${ar(res.dup)} موجود مسبقًا`);
  if (res.overLimit) parts.push(`${ar(res.overLimit)} فوق الحد`);
  toast(parts.join(' · '), { ms: 4500 });
  S.stack = [{ name: 'home', p: {} }, { name: 'class', p: { id: target.id } }];
  history.replaceState({ depth: 2 }, '');
  render({ scrollTop: true });
}

// =====================================================================
// الشاشة ٥ — الإعدادات
// =====================================================================
function Settings() {
  const st = S.settings;
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-act="set" data-key="${key}" data-v="${v}" aria-pressed="${String(st[key]) === String(v)}">${l}</button>`).join('')}</div>`;
  const sw = (key, label, hint = '') => `<label class="list-item"><span class="grow"><strong>${label}</strong>${hint ? `<small>${hint}</small>` : ''}</span><input type="checkbox" class="switch" data-setting-bool="${key}" ${st[key] ? 'checked' : ''}></label>`;
  const persist = S.meta.persist === 'granted' ? `<span class="status-pill ok">${icon('shield')} مفعّل</span>` : S.meta.persist === 'denied' ? `<span class="status-pill">${icon('warn')} غير مفعّل</span>` : `<span class="status-pill">${icon('info')} غير مدعوم</span>`;
  const last = S.meta.lastBackupAt ? ar(new Date(S.meta.lastBackupAt).toLocaleDateString('en-GB')) : 'لم تُحفظ بعد';
  const inst = platform.isNative ? 'مثبّت كتطبيق أندرويد' : platform.isStandalone ? 'مثبّت على الشاشة الرئيسية' : 'يعمل داخل المتصفح';
  return `${appbar({ title: 'الإعدادات', backBtn: false, save: true })}
  <div class="wrap stack">
    <div class="section-title">بياناتي</div>
    <div class="card stack">
      <div class="field"><label for="s-teacher">اسم المعلم</label><input id="s-teacher" class="input" data-setting="teacher" value="${esc(st.teacher)}" placeholder="مثل: يوسف أحمد" autocomplete="name"></div>
      <div class="field"><label for="s-subject">المادة (المجال الدراسي)</label><input id="s-subject" class="input" data-setting="subject" value="${esc(st.subject)}" placeholder="مثل: الحاسوب"></div>
      <div class="field"><label for="s-year">العام الدراسي</label><input id="s-year" class="input" data-setting="year" value="${esc(st.year)}" placeholder="مثل: ٢٠٢٦ / ٢٠٢٧"></div>
      <p class="hint">تظهر في رأس كشف الإكسل وفي بطاقة الطالب.</p>
    </div>

    <div class="section-title">طريقة الرصد</div>
    <div class="card stack">
      <div class="field"><span class="label">نمط الإدخال</span>${seg('inputMode', [['chips', 'أزرار لمس'], ['fields', 'حقول أرقام']])}
        <p class="hint">الأزرار: ضغطة واحدة لكل بند. الحقول: اكتب الرقم ثم Enter. (على الكمبيوتر يظهر جدول دائمًا)</p></div>
    </div>
    <div class="list">
      ${sw('autoAdvance', 'الانتقال التلقائي للطالب التالي', 'بعد إكمال درجات طالب')}
      ${sw('haptics', 'الاهتزاز الخفيف', 'عند «كامل» والتعبئة السريعة والأخطاء')}
    </div>

    <div class="section-title">المظهر</div>
    <div class="card stack">
      <div class="field"><span class="label">الألوان</span>${seg('theme', [['auto', 'تلقائي'], ['light', 'فاتح'], ['dark', 'داكن']])}</div>
      <div class="field"><span class="label">حجم الخط</span>${seg('textScale', [['normal', 'عادي'], ['large', 'كبير']])}</div>
    </div>

    <div class="section-title">البيانات والنسخ الاحتياطي</div>
    <div class="list">
      <div class="list-item"><span class="grow"><strong>التخزين الدائم</strong><small>يطلب من المتصفح عدم حذف بياناتك تلقائيًا</small></span>${persist}</div>
      <div class="list-item"><span class="grow"><strong>آخر نسخة احتياطية</strong><small class="num">${last}</small></span></div>
      <button type="button" class="list-item" data-act="backup">${icon('download')}<span class="grow"><strong>حفظ نسخة احتياطية</strong><small>ملف واحد فيه كل الشعب والدرجات</small></span></button>
      <button type="button" class="list-item" data-act="restore">${icon('upload')}<span class="grow"><strong>استرجاع نسخة</strong><small>يستبدل كل البيانات الحالية</small></span></button>
      <button type="button" class="list-item" data-act="go" data-to="transferIn">${icon('inbox')}<span class="grow"><strong>استقبال طلاب منقولين</strong><small>من ملف أرسله معلم آخر</small></span></button>
      <button type="button" class="list-item" data-act="wipe">${icon('trash')}<span class="grow"><strong style="color:var(--error)">حذف كل البيانات</strong><small>من هذا الجهاز فقط</small></span></button>
    </div>

    <div class="section-title">العرض على الكمبيوتر (متقدم)</div>
    <div class="card stack">
      <div class="field"><label for="s-view">رابط صفحة العرض</label><input id="s-view" class="input" dir="ltr" data-setting="viewUrl" value="${esc(st.viewUrl)}" placeholder="${esc(defaultViewUrl() || 'https://…/view.html')}"></div>
      <div class="field"><label for="s-turn">خادم TURN (اختياري)</label><input id="s-turn" class="input" dir="ltr" data-setting="turnUrl" value="${esc(st.turnUrl)}" placeholder="turn:example.com:3478"></div>
      <div class="meta-grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label for="s-tu">اسم المستخدم</label><input id="s-tu" class="input" dir="ltr" data-setting="turnUser" value="${esc(st.turnUser)}" autocomplete="off"></div>
        <div class="field"><label for="s-tp">كلمة المرور</label><input id="s-tp" class="input" dir="ltr" type="password" data-setting="turnPass" value="${esc(st.turnPass)}" autocomplete="off"></div>
      </div>
      <p class="hint">اتركها فارغة في الغالب. تحتاجها فقط إذا كانت شبكة المدرسة تمنع الاتصال المباشر ولا تستطيع استعمال نقطة اتصال الجوال.</p>
    </div>

    <div class="section-title">التطبيق</div>
    <div class="list">
      <div class="list-item"><span class="grow"><strong>طريقة التشغيل</strong><small>${inst}</small></span></div>
      <button type="button" class="list-item" data-act="go" data-to="guide">${icon('phone')}<span class="grow"><strong>إرشادات التثبيت</strong><small>آيفون وأندرويد</small></span>${icon('fwd')}</button>
      <button type="button" class="list-item" data-act="tour">${icon('sparkle')}<span class="grow"><strong>إعادة الجولة التعريفية</strong></span>${icon('fwd')}</button>
      <div class="list-item">${icon('code')}<span class="grow"><strong>تخصيص الواجهة</strong><small>يمكن لأي معلم تعديل التطبيق بما يناسبه عبر Claude Code: افتح مجلد المشروع واطلب التعديل بالعربية (مثل «غيّر أسماء البنود» أو «أضف زر ٣٫٥»). التفاصيل في ملف CLAUDE.md.</small></span></div>
      <div class="list-item"><span class="grow"><strong>الإصدار</strong><small class="num">${ar(CONFIG.version)}</small></span></div>
    </div>
    <p class="hint" style="text-align:center;margin:16px 0">${icon('shield')} لا حسابات ولا إنترنت: كل البيانات على هذا الجهاز فقط.</p>
  </div>`;
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
  const ios = `<ol class="ios-steps">
    <li><span class="pic">${icon('shareIos')}</span><span><strong>١. اضغط زر المشاركة</strong><br><span class="muted">في أسفل Safari (مربع وسهم للأعلى)</span></span></li>
    <li><span class="pic">${icon('plusSquare')}</span><span><strong>٢. اختر «إضافة إلى الشاشة الرئيسية»</strong><br><span class="muted">مرّر القائمة للأسفل إن لم تظهر</span></span></li>
    <li><span class="pic">${icon('check')}</span><span><strong>٣. اضغط «إضافة»</strong><br><span class="muted">ثم افتح التطبيق دائمًا من أيقونته</span></span></li>
  </ol>`;
  const android = `<ol class="ios-steps">
    <li><span class="pic">${icon('download')}</span><span><strong>تطبيق APK</strong><br><span class="muted">ثبّت ملف APK الذي يوزعه المعلم المسؤول (اسمح بالتثبيت من هذا المصدر).</span></span></li>
    <li><span class="pic">${icon('more')}</span><span><strong>أو من Chrome</strong><br><span class="muted">القائمة ⋮ ثم «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».</span></span></li>
  </ol>`;
  return `${appbar({ title: 'تثبيت التطبيق' })}
  <div class="wrap stack">
    ${platform.isIOS && !platform.isStandalone ? `<div class="alert warn">${icon('warn')}<div class="grow"><strong>أنت الآن في المتصفح</strong><p style="margin:0">بيانات المواقع في Safari أقل حماية وقد تُمسح إذا لم تفتح الموقع لفترة. ثبّت التطبيق واحفظ نسخة احتياطية أسبوعيًا.</p></div></div>` : ''}
    <div class="section-title">آيفون وآيباد (Safari)</div>${ios}
    <div class="section-title">أندرويد</div>${android}
    <div class="alert info">${icon('shield')}<div class="grow"><strong>بياناتك على جهازك فقط</strong><p style="margin:0">لا يرسل التطبيق أي شيء للإنترنت. انقل بياناتك بين الأجهزة عبر «نسخة احتياطية» ثم «استرجاع نسخة».</p></div></div>
    ${platform.isIOS && !platform.isStandalone ? '<button type="button" class="btn block" data-act="dismiss-guide">متابعة في المتصفح على أي حال</button>' : ''}
  </div>`;
}

// =====================================================================
// الجولة التعريفية
// =====================================================================
const TOUR = [
  { t: 'ارصد بضغطة واحدة', d: 'لكل طالب زر «كامل» يضع ٥ في البنود الأربعة، وأزرار كبيرة لأي درجة أخرى. التطبيق يحفظ تلقائيًا ويعمل بدون إنترنت.', art: ART_EMPTY },
  { t: 'أضف طلابك بسهولة', d: 'الصق الأسماء أو استوردها من Excel أو PDF. وإذا انتقل طالب، أرسل درجاته لمعلمه الجديد بملف.', art: ART_USERS },
  { t: 'صدّر واعرض', d: 'صدّر كشف الإكسل الرسمي بضغطة، واعرض الدرجات مباشرة على شاشة الكمبيوتر عبر رمز QR. لا تنسَ النسخة الاحتياطية الأسبوعية.', art: `<svg class="art" viewBox="0 0 200 150" aria-hidden="true"><rect x="20" y="24" width="120" height="80" rx="10" fill="var(--primary-soft)"/><rect x="34" y="38" width="92" height="8" rx="4" fill="var(--primary)"/><rect x="34" y="54" width="70" height="6" rx="3" fill="var(--border)"/><rect x="34" y="66" width="80" height="6" rx="3" fill="var(--border)"/><rect x="66" y="110" width="28" height="6" rx="3" fill="var(--border)"/><rect x="140" y="50" width="42" height="76" rx="8" fill="var(--card)" stroke="var(--primary)" stroke-width="3"/><rect x="150" y="66" width="22" height="22" rx="2" fill="var(--primary)"/></svg>` },
];
function showTour() {
  let i = 0;
  const s = openSheet('<div class="tour" data-tour></div>', { label: 'جولة تعريفية', onClose: async () => { S.settings.tourDone = true; await saveSettingsNow(); } });
  const paint = () => {
    const t = TOUR[i];
    s.sheet.querySelector('[data-tour]').innerHTML = `${t.art}<h2>${t.t}</h2><p>${t.d}</p>
      <div class="dots">${TOUR.map((_, j) => `<span class="${j === i ? 'on' : ''}"></span>`).join('')}</div>
      <div class="actions"><button type="button" class="btn ghost" data-t="skip">تخطَّ</button><button type="button" class="btn primary" data-t="next">${i === TOUR.length - 1 ? 'لنبدأ' : 'التالي'}</button></div>`;
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
// النسخ الاحتياطي والاسترجاع
// =====================================================================
function backupTip() {
  const where = platform.isIOS
    ? `<p>نحفظ <b>نسختين</b> حتى تكون درجاتك بأمان:</p>
       <ol class="steps"><li><span class="n">${ar(1)}</span><span><b>على الجوال:</b> «حفظ في الملفات» ← <b>«على الآيفون»</b> ← «حفظ»</span></li>
       <li><span class="n">${ar(2)}</span><span><b>في iCloud:</b> «حفظ في الملفات» ← <b>«iCloud Drive»</b> ← «حفظ»</span></li></ol>
       <p class="hint">نسخة الجوال لا تخرج منه أبدًا. ونسخة iCloud في حسابك الشخصي فقط (لا يراها أحد غيرك)، وتبقى لو ضاع الجوال. إن ظهر «استبدال» فاضغطه.</p>`
    : platform.isNative
      ? `<p>تُحفظ النسخة تلقائيًا في الجوال: <b>المستندات ← متابعة الدرجات</b>. ثم تظهر قائمة المشاركة: أرسلها أيضًا إلى <b>Google Drive</b> أو لنفسك على واتساب حتى تبقى لو ضاع الجوال.</p>`
      : `<p>سيُحفظ ملف النسخة في مجلد التنزيلات أو تظهر قائمة المشاركة. احفظه في مكان آمن خاص بك (مثل iCloud Drive أو Google Drive) أو أرسله لنفسك.</p>`;
  return new Promise((resolve) => {
    let go = false;
    const s = openSheet(`<h2>${icon('shield')} أين تُحفظ النسخة؟</h2>${where}
      <div class="actions"><button type="button" class="btn" data-x="0">لاحقًا</button><button type="button" class="btn primary" data-x="1" autofocus>فهمت، احفظ</button></div>`, { label: 'النسخة الاحتياطية', onClose: () => resolve(go) });
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
      const second = await confirmDialog({ title: `النسخة ١ ✓ — الآن النسخة ٢ في iCloud`, text: 'اضغط «احفظ في iCloud» ثم اختر «حفظ في الملفات» ← «iCloud Drive» ← «حفظ».', ok: 'احفظ في iCloud', cancel: 'تخطَّ' });
      if (second) {
        const r2 = await platform.shareFile(blob, store.backupFileName(), 'application/json');
        if (r2 === 'shared') { S.meta.lastCloudBackupAt = new Date().toISOString(); await store.setMeta('lastCloudBackupAt', S.meta.lastCloudBackupAt); }
      }
    }
    S.meta.lastBackupAt = new Date().toISOString();
    await store.setMeta('lastBackupAt', S.meta.lastBackupAt);
    S.meta.changedSinceBackup = null;
    await store.setMeta('changedSinceBackup', null);
    toast('حُفظت النسخة الاحتياطية ✓');
    if (['home', 'settings'].includes(route().name)) render();
  } catch { toast('تعذّر حفظ النسخة', { err: true }); }
}

async function doRestore() {
  const file = await platform.pickFile('.json,application/json');
  if (!file) return;
  let b;
  try { b = store.parseBackup(await file.text()); } catch (e) {
    toast(e && /[؀-ۿ]/.test(e.message || '') ? e.message : 'هذا الملف ليس نسخة احتياطية صالحة', { err: true, ms: 5000 });
    return;
  }
  const date = b.at ? ar(new Date(b.at).toLocaleDateString('en-GB')) : 'غير معروف';
  const nStu = b.classes.reduce((a, c) => a + c.names.length, 0);
  const ok = await confirmDialog({ title: 'استرجاع النسخة؟', text: `نسخة بتاريخ ${date} فيها ${ar(b.classes.length)} شعبة و${students(nStu)}. ستُستبدل كل البيانات الحالية على هذا الجهاز.`, ok: 'استرجاع واستبدال', danger: true });
  if (!ok) return;
  await store.replaceAll({ classes: b.classes, settings: b.settings, data: b.data });
  await loadState();
  S.meta.lastBackupAt = new Date().toISOString();
  await store.setMeta('lastBackupAt', S.meta.lastBackupAt);
  applyTheme();
  go('home');
  toast('اكتمل الاسترجاع ✓');
}

async function doWipe() {
  const ok = await confirmDialog({ title: 'حذف كل البيانات؟', text: 'ستُحذف كل الشعب والدرجات والإعدادات من هذا الجهاز نهائيًا. احفظ نسخة احتياطية أولًا إن كنت تحتاجها.', ok: 'حذف الكل', danger: true });
  if (!ok) return;
  await store.replaceAll({ classes: [], settings: { ...CONFIG.defaultSettings, tourDone: true }, data: {} });
  await store.setMeta('lastBackupAt', null);
  await loadState();
  applyTheme();
  go('home');
  toast('حُذفت كل البيانات');
}

// =====================================================================
// تصدير الإكسل ومشاركة البطاقة
// =====================================================================
async function exportXlsx(id) {
  const c = cls(id);
  if (!c) return;
  if (S.dirty.size) await flushSave();
  const close = toast('جارٍ تجهيز الكشف…', { ms: 0 });
  try {
    const { buildWorkbook, exportFileName } = await import('./xlsx-export.js');
    const blob = await buildWorkbook({ classLabel: c.label, names: c.names, data: dataOf(c.id), settings: S.settings });
    close();
    const r = await platform.saveFile(exportFileName(c.label), blob, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (r !== 'cancelled') toast('جاهز ✓ كشف الإكسل');
  } catch {
    close();
    toast('تعذّر إنشاء ملف الإكسل', { err: true });
  }
}

async function shareStudent(id, idx) {
  const c = cls(id);
  const text = studentCardText({ name: c.names[idx], classLabel: c.label, subject: S.settings.subject, teacher: S.settings.teacher, data: dataOf(id), idx });
  const r = await platform.shareText(text, 'بطاقة الطالب');
  if (r === 'copied') toast('نُسخ نص البطاقة — الصقه في واتساب');
  else if (r === 'failed') toast('تعذّرت المشاركة', { err: true });
}

// =====================================================================
// الشاشة ٦ — العرض على الكمبيوتر (جهة الجوال)
// =====================================================================
const L = {
  link: null, state: 'idle', classId: null, scope: { kind: 'class', idx: 0 }, hideNames: false, blank: false,
  phase: 'setup', answer: null, frames: [], frameTimer: null, scanner: null, collector: null, mod: null,
};
function defaultViewUrl() {
  if (CONFIG.viewUrl) return CONFIG.viewUrl;
  if (platform.isNative) return '';
  return new URL('view.html', location.href).href;
}
async function liveMod() { return (L.mod ||= await import('./live.js')); }

function Live() {
  if (!L.classId || !cls(L.classId)) L.classId = (S.classes[0] || {}).id || null;
  const c = L.classId ? cls(L.classId) : null;
  const viewUrl = S.settings.viewUrl || defaultViewUrl();
  const stateLabel = { connected: 'متصل', connecting: 'جارٍ الاتصال', disconnected: 'انقطع الاتصال', closed: 'غير متصل', idle: 'غير متصل' }[L.state] || 'غير متصل';
  const pill = `<span class="live-state ${L.state}" data-live-state><span class="dot"></span>${stateLabel}</span>`;
  if (!S.classes.length) {
    return `${appbar({ title: 'العرض على الكمبيوتر', backBtn: false })}<div class="wrap"><div class="empty card">${ART_EMPTY}<h2>أضف شعبة أولًا</h2><p>بعدها تستطيع عرض درجاتها على شاشة الكمبيوتر أو البروجكتر.</p><button type="button" class="btn primary" data-act="new-class">${icon('plus')} إضافة شعبة</button></div></div>`;
  }
  const backToClass = c ? `<button type="button" class="btn block" data-act="open-class" data-id="${c.id}">${icon('edit')} ارجع لرصد «${esc(c.label)}»</button>` : '';
  const scopeCtl = `${backToClass}<div class="card stack">
    <div class="field"><label for="lv-class">الشعبة</label><select id="lv-class" class="select" data-live="class">${S.classes.map((o) => `<option value="${o.id}" ${o.id === L.classId ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>
    <div class="field"><span class="label">ماذا يظهر على الشاشة؟</span><div class="seg" role="group">
      <button type="button" data-act="live-scope" data-v="class" aria-pressed="${L.scope.kind === 'class'}">الشعبة كاملة</button>
      <button type="button" data-act="live-scope" data-v="student" aria-pressed="${L.scope.kind === 'student'}">طالب واحد فقط</button></div></div>
    ${L.scope.kind === 'student' && c ? `<div class="field"><label for="lv-stu">الطالب</label><select id="lv-stu" class="select" data-live="student">${c.names.map((nm, i) => `<option value="${i}" ${i === L.scope.idx ? 'selected' : ''}>${ar(i + 1)}. ${esc(nm)}</option>`).join('')}</select></div>` : ''}
    <label class="toggle-line" style="justify-content:space-between">إخفاء الأسماء (أرقام فقط) <input type="checkbox" class="switch" data-live="hide" ${L.hideNames ? 'checked' : ''}></label>
  </div>`;

  let body = '';
  if (L.phase === 'setup') {
    body = `<div class="card stack">
      <h3>${icon('monitor')} الخطوة ١: على الكمبيوتر</h3>
      <p class="hint">افتح صفحة العرض في متصفح الكمبيوتر (<bdi>Chrome</bdi> أو <bdi>Edge</bdi> أو <bdi>Safari</bdi>):</p>
      ${viewUrl ? `<div class="row"><code class="input grow" dir="ltr" style="display:flex;align-items:center;overflow:auto;white-space:nowrap">${esc(viewUrl)}</code><button type="button" class="icon-btn" data-act="copy-view" aria-label="نسخ الرابط">${icon('copy')}</button></div>` : '<div class="alert warn">' + icon('warn') + '<div class="grow">أضف رابط صفحة العرض من الإعدادات (رابط الاستضافة + view.html).</div></div>'}
      <h3>${icon('qr')} الخطوة ٢: امسح الرمز الظاهر على الكمبيوتر</h3>
      <p class="hint">سيطلب التطبيق إذن الكاميرا لقراءة الرمز فقط، ولا يحفظ أي صورة.</p>
      <button type="button" class="btn primary lg block" data-act="live-scan">${icon('camera')} افتح الكاميرا وامسح الرمز</button>
      <button type="button" class="btn block" data-act="live-paste">${icon('paste')} لا تعمل الكاميرا؟ الصق رمز العرض</button>
    </div>`;
  } else if (L.phase === 'scan') {
    const pr = L.collector ? L.collector.progress() : { got: 0, total: 0 };
    body = `<div class="card stack"><div class="video-box"><video playsinline muted autoplay data-live-video></video><div class="frame"></div></div>
      <p class="hint" style="text-align:center" data-scan-progress>${pr.total > 1 ? `قرأنا ${ar(pr.got)} من ${ar(pr.total)} أجزاء… أبقِ الكاميرا على الرمز` : 'وجّه الكاميرا إلى الرمز على شاشة الكمبيوتر'}</p>
      <button type="button" class="btn block" data-act="live-cancel">إلغاء</button></div>`;
  } else if (L.phase === 'connecting') {
    body = `<div class="card stack" style="text-align:center"><div class="skel" style="height:220px"></div><p class="hint">جارٍ تجهيز رمز الرد…</p></div>`;
  } else if (L.phase === 'answer') {
    body = `<div class="card stack" style="text-align:center"><h3>${icon('qr')} الخطوة ٣: اعرض هذا الرمز للكمبيوتر</h3>
      <p class="hint">اضغط «مسح الرد» على الكمبيوتر، ثم قرّب شاشة الجوال من كاميرته (٢٠–٣٠ سم) وثبّتها حتى تُقرأ كل الأجزاء.</p>
      <button type="button" class="qr-box qr-tap" data-act="qr-full" aria-label="تكبير الرمز"><canvas data-answer-qr width="300" height="300" aria-label="رمز الرد"></canvas></button>
      <p class="hint">${icon('info')} ارفع سطوع الشاشة. اضغط الرمز لتكبيره.</p>
      <p class="hint" data-frame-label></p>
      <button type="button" class="btn block" data-act="live-copy">${icon('copy')} نسخ الرمز (للصق على الكمبيوتر)</button>
      <button type="button" class="btn ghost block" data-act="live-stop">إلغاء</button></div>`;
  } else if (L.phase === 'connected') {
    body = `<div class="card stack">
      <div class="alert ok">${icon('checkCircle')}<div class="grow"><strong>العرض يعمل الآن</strong><p style="margin:0">أي درجة ترصدها تظهر فورًا على الشاشة. أبقِ شاشة الجوال مفتوحة أثناء العرض.</p></div></div>
      <button type="button" class="btn ${L.blank ? 'primary' : 'soft'} lg block" data-act="live-blank">${icon(L.blank ? 'eye' : 'eyeOff')} ${L.blank ? 'إظهار الدرجات' : 'إخفاء الدرجات مؤقتًا'}</button>
      <button type="button" class="btn danger block" data-act="live-stop">${icon('power')} إيقاف العرض</button></div>`;
  } else if (L.phase === 'lost') {
    body = `<div class="card stack"><div class="alert err">${icon('warn')}<div class="grow"><strong>انقطع الاتصال بالكمبيوتر</strong><p style="margin:0">قد يكون الجوال قُفل أو تغيّرت الشبكة. أعد الاتصال بمسح رمز جديد من الكمبيوتر (اضغط «إعادة الاتصال» هناك).</p></div></div>
      <button type="button" class="btn primary lg block" data-act="live-scan">${icon('refresh')} إعادة الاتصال</button>
      <button type="button" class="btn block" data-act="live-reset">رجوع</button></div>`;
  }

  const help = `<details class="card"><summary style="font-weight:800;cursor:pointer;min-height:40px;display:flex;align-items:center;gap:8px">${icon('wifi')} مشاكل الاتصال؟</summary>
    <ul class="hint" style="padding-inline-start:20px;line-height:2">
      <li>اجعل الجوال والكمبيوتر على نفس شبكة Wi‑Fi.</li>
      <li>بعض شبكات المدارس تمنع اتصال الأجهزة ببعضها: شغّل «نقطة الاتصال» من الجوال ووصّل الكمبيوتر بها، ثم أعد المحاولة.</li>
      <li>الاتصال مباشر ومشفّر بين الجهازين؛ لا تمر الدرجات على أي خادم ولا تُحفظ على الكمبيوتر.</li>
      <li>في آيفون: لا تقفل الشاشة أثناء العرض.</li>
    </ul></details>`;

  return `${appbar({ title: 'العرض على الكمبيوتر', backBtn: false, actions: pill })}
  <div class="wrap stack">${scopeCtl}${body}${help}</div>`;
}
afterRender.live = () => {
  if (L.phase === 'scan') startScanner();
  if (L.phase === 'answer') paintAnswerQR();
};

function setLiveState(st) {
  if (st === 'closed') { if (route().name === 'live') render(); return; }
  if (!L.link) return;
  L.state = st;
  if (st === 'connected') {
    L.phase = 'connected';
    stopScanner(); stopFrames();
    sendHello(); sendSnapshot();
    liveMod().then((m) => m.wakeLock(true));
    toast('تم الاتصال بالكمبيوتر ✓');
  } else if (st === 'disconnected' && (L.phase === 'connected' || L.phase === 'answer')) {
    L.phase = 'lost';
    liveMod().then((m) => m.wakeLock(false));
    haptic('error');
  }
  if (route().name === 'live') render();
}

async function startLiveFromCode(code) {
  const m = await liveMod();
  L.phase = 'connecting';
  if (route().name === 'live') render();
  try {
    if (L.link) L.link.stop();
    L.link = new m.PhoneLink({ iceServers: m.iceServersFrom(S.settings), onState: setLiveState });
    L.state = 'connecting';
    L.answer = await L.link.acceptOffer(code);
    // رموز صغيرة متتابعة بمربعات كبيرة: أسهل بكثير لكاميرا الكمبيوتر من رمز واحد كثيف
    L.frames = m.splitFrames(L.answer, 110);
    L.phase = 'answer';
  } catch (e) {
    L.phase = 'setup'; L.state = 'idle';
    toast(e && /[؀-ۿ]/.test(e.message || '') ? e.message : 'الرمز غير صالح. أنشئ رمزًا جديدًا على الكمبيوتر.', { err: true, ms: 5000 });
  }
  if (route().name === 'live') render();
}

async function startScanner() {
  const video = main().querySelector('[data-live-video]');
  if (!video || L.scanner) return;
  const m = await liveMod();
  L.collector = new m.FrameCollector();
  L.scanner = new m.QrScanner(video, (text) => {
    const full = L.collector.push(text);
    const prog = main().querySelector('[data-scan-progress]');
    const pr = L.collector.progress();
    if (prog && pr.total > 1) prog.textContent = `قرأنا ${ar(pr.got)} من ${ar(pr.total)} أجزاء… أبقِ الكاميرا على الرمز`;
    if (full) { haptic('success'); stopScanner(); startLiveFromCode(full); }
  });
  try {
    await L.scanner.start('environment');
  } catch (e) {
    stopScanner();
    L.phase = 'setup';
    render();
    const msg = e && e.code === 'denied'
      ? (platform.isIOS ? 'رُفض إذن الكاميرا. فعّله من: الإعدادات ← Safari ← الكاميرا ← سماح، ثم أعد المحاولة.' : 'رُفض إذن الكاميرا. فعّله من إعدادات الجهاز ← التطبيقات ← الأذونات ← الكاميرا.')
      : e && e.code === 'notfound' ? 'لا توجد كاميرا متاحة. استعمل «الصق رمز العرض».'
        : e && e.code === 'insecure' ? 'الكاميرا تحتاج رابطًا آمنًا (https).' : 'تعذّر فتح الكاميرا. استعمل «الصق رمز العرض».';
    toast(msg, { err: true, ms: 7000 });
  }
}
function stopScanner() { if (L.scanner) { L.scanner.stop(); L.scanner = null; } }

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
    if (label) label.textContent = L.frames.length > 1 ? `جزء ${ar(i + 1)} من ${ar(L.frames.length)} — يتبدّل تلقائيًا` : '';
    i = (i + 1) % L.frames.length;
  };
  paint();
  if (L.frames.length > 1) L.frameTimer = setInterval(paint, 1100);
}
function stopFrames() { clearInterval(L.frameTimer); L.frameTimer = null; }

function liveNames(c) {
  return c.names.map((nm, i) => {
    if (L.scope.kind === 'student' && i !== L.scope.idx) return '';
    return L.hideNames ? `طالب ${ar(i + 1)}` : nm;
  });
}
function liveData(c) {
  const d = dataOf(c.id);
  if (L.scope.kind === 'class') return d;
  const i = L.scope.idx;
  const out = { weeks: {}, fin: {}, t: d.t };
  for (const [w, wk] of Object.entries(d.weeks || {})) {
    out.weeks[w] = { date: wk.date || '', lesson: wk.lesson || '', s: {} };
    if (wk.s && wk.s[i]) out.weeks[w].s[i] = wk.s[i];
  }
  if (d.fin && d.fin[i]) out.fin[i] = d.fin[i];
  return out;
}
function liveSend(msg) {
  if (L.link && L.state === 'connected') { try { L.link.send({ v: 1, ...msg }); } catch { /* تجاهل */ } }
}
function sendHello() {
  const c = cls(L.classId);
  liveSend({ type: 'hello', teacher: S.settings.teacher, subject: S.settings.subject, classLabel: c ? c.label : '', criteria: CRIT.map((x) => x.label), finals: FINS.map((f) => ({ label: f.label, max: f.max })) });
}
function sendSnapshot() {
  const c = cls(L.classId);
  if (!c) return;
  liveSend({ type: 'snapshot', scope: { ...L.scope }, hideNames: L.hideNames, names: liveNames(c), data: liveData(c) });
}
function livePatchItems(classId, w, i) {
  if (L.classId !== classId || L.state !== 'connected') return;
  if (L.scope.kind === 'student' && L.scope.idx !== i) return;
  liveSend({ type: 'patch', kind: 'items', week: w, idx: i, values: getItems(dataOf(classId), w, i) });
}
function livePatchFin(classId, i) {
  if (L.classId !== classId || L.state !== 'connected') return;
  if (L.scope.kind === 'student' && L.scope.idx !== i) return;
  liveSend({ type: 'patch', kind: 'fin', idx: i, values: getFin(dataOf(classId), i) });
}
function livePatchMeta(classId, w) {
  if (L.classId !== classId || L.state !== 'connected') return;
  const m = getWeekMeta(dataOf(classId), w);
  liveSend({ type: 'patch', kind: 'meta', week: w, date: m.date, lesson: m.lesson });
}
function liveResync(classId) { if (L.classId === classId && L.state === 'connected') { sendHello(); sendSnapshot(); } }
function liveStop() {
  const link = L.link;
  L.link = null;
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
    case 'open-class': S.ui.selected = null; S.ui.missingOnly = false; go('class', { id: el.dataset.id }); break;
    case 'resume': {
      e.stopPropagation();
      const c = cls(el.dataset.id); const d = dataOf(c.id);
      const tab = firstIncompleteWeek(d, c.names.length);
      const first = tab === 'fin' ? c.names.findIndex((_, i) => getFin(d, i).some((v) => v == null)) : c.names.findIndex((_, i) => !studentComplete(d, tab, i));
      S.ui.tab[c.id] = tab; S.ui.selected = null; S.ui.missingOnly = false;
      go('class', { id: c.id, tab, scrollTo: first >= 0 ? first : null });
      break;
    }
    case 'edit-class': e.stopPropagation(); go('editor', { id: el.dataset.id }); break;
    case 'tab': {
      p.tab = el.dataset.tab === 'fin' ? 'fin' : +el.dataset.tab;
      S.ui.tab[p.id] = p.tab; S.ui.search = '';
      p.painted = true;
      render();
      break;
    }
    case 'missing': S.ui.missingOnly = el.checked; rerenderList(); break;
    case 'missing-toggle': S.ui.missingOnly = !S.ui.missingOnly; rerenderList(); break;
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
      if (j >= 0 && j < order.length) { p.tab = order[j]; S.ui.tab[p.id] = p.tab; S.ui.search = ''; p.painted = true; render({ scrollTop: true }); }
      break;
    }
    case 'week-pick': showWeekPicker(p); break;
    case 'week-tools': showWeekTools(p); break;
    case 'class-menu': showClassMenu(p); break;
    case 'open-student': {
      const idx = +el.dataset.idx;
      if (ASIDE.matches && r.name === 'class') { S.ui.selected = { id: p.id, idx }; refreshAside(); }
      else go('student', { id: p.id, idx });
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
      toast('أُضيف تاريخ اليوم');
      break;
    }
    case 'export-xlsx': exportXlsx(el.dataset.id); break;
    case 'go-live': if (L.classId !== el.dataset.id) { L.classId = el.dataset.id; L.scope = { kind: 'class', idx: 0 }; liveResync(L.classId); } go('live'); break;
    case 'backup': doBackup(); break;
    case 'restore': doRestore(); break;
    case 'wipe': doWipe(); break;
    case 'tour': showTour(); break;
    case 'dismiss-guide': try { sessionStorage.setItem('iosGuideSeen', '1'); } catch { /* */ } go('home'); break;
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
      if (p.draft.rows.length >= MAX_STUDENTS) { toast(`الحد الأقصى ${ar(MAX_STUDENTS)} طالبًا`, { err: true }); break; }
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
        const ok = await confirmDialog({ title: `حذف «${row.name}»؟`, text: 'لهذا الطالب درجات مرصودة وستُحذف عند الحفظ. إن كان منتقلًا لمعلم آخر فاستعمل «نقل طلاب» لترسل درجاته.', ok: 'حذف', danger: true });
        if (!ok) break;
      }
      p.draft.rows.splice(j, 1); p.dirty = true; render();
      toast('حُذف الطالب من القائمة', { action: { label: 'تراجع', fn: () => { p.draft.rows.splice(j, 0, row); render(); } } });
      break;
    }
    case 'sort-az': p.draft.rows.sort((a, b) => arCompare(a.name, b.name)); p.dirty = true; render(); toast('رُتّبت الأسماء أبجديًا'); break;
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
    case 'live-scope': L.scope = { kind: el.dataset.v, idx: L.scope.idx || 0 }; sendSnapshot(); render(); break;
    case 'live-scan': L.phase = 'scan'; render(); break;
    case 'live-cancel': stopScanner(); L.phase = 'setup'; render(); break;
    case 'live-paste': {
      const s = openSheet(`<h2>الصق رمز العرض</h2><p>على الكمبيوتر اضغط «نسخ رمز العرض» وأرسله لنفسك (واتساب مثلًا)، ثم الصقه هنا.</p>
        <textarea class="textarea" dir="ltr" data-code style="min-height:120px" placeholder="الصق الرمز هنا"></textarea>
        <div class="actions"><button type="button" class="btn" data-x="0">إلغاء</button><button type="button" class="btn primary" data-x="1">متابعة</button></div>`, { label: 'لصق الرمز' });
      s.sheet.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-x]'); if (!b) return;
        const code = s.sheet.querySelector('[data-code]').value.trim();
        s.close();
        if (b.dataset.x === '1' && code) {
          liveMod().then((m) => { const col = new m.FrameCollector(); let full = null; for (const part of code.split(/\s+/)) full = col.push(part) || full; startLiveFromCode(full || code); });
        }
      });
      break;
    }
    case 'qr-full': {
      const box = el; box.classList.toggle('full');
      document.body.classList.toggle('qr-fullscreen', box.classList.contains('full'));
      break;
    }
    case 'live-copy': if (await platform.copyText(L.answer || '')) toast('نُسخ الرمز ✓ الصقه في صفحة العرض («لصق الرد»)'); break;
    case 'copy-view': if (await platform.copyText(S.settings.viewUrl || defaultViewUrl())) toast('نُسخ الرابط ✓'); break;
    case 'live-blank': L.blank = !L.blank; liveSend({ type: 'blank', on: L.blank }); haptic('light'); render(); break;
    case 'live-stop': liveStop(); render(); toast('أُوقف العرض'); break;
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
    return `<button type="button" class="wk ${done ? 'done' : ''} ${p.tab === w ? 'on' : ''}" data-act="tab" data-tab="${w}">
      <b>أسبوع ${ar(w)}</b><small>${done ? '✓ مكتمل' : started ? `باقي ${ar(rem)}` : 'لم يبدأ'}${meta.date ? ` · ${esc(meta.date)}` : ''}</small></button>`;
  };
  const finDone = !finalsRemaining(d, n);
  const s = openSheet(`<h2>اختر الأسبوع</h2>
    <div class="wk-grid">${[...Array(WEEKS).keys()].map((x) => cell(x + 1)).join('')}</div>
    <button type="button" class="wk wide ${finDone ? 'done' : ''} ${p.tab === 'fin' ? 'on' : ''}" data-act="tab" data-tab="fin"><b>الدرجات النهائية</b><small>${finDone ? '✓ مكتملة' : `باقي ${ar(finalsRemaining(d, n))}`}</small></button>`, { label: 'اختر الأسبوع' });
  s.sheet.addEventListener('click', (e) => { if (e.target.closest('[data-act="tab"]')) setTimeout(() => s.close(), 0); });
}

function showWeekTools(p) {
  const c = cls(p.id); const d = dataOf(c.id);
  if (p.tab === 'fin') return;
  const meta = getWeekMeta(d, p.tab);
  const s = openSheet(`<h2>أدوات الأسبوع ${ar(p.tab)}</h2>
    <div class="stack">
      <div class="field"><label for="wdate">التاريخ</label><div class="row"><input id="wdate" class="input grow" data-meta="date" value="${esc(meta.date)}" placeholder="مثال: ١٢/١٠" autocomplete="off"><button type="button" class="btn" data-act="today">${icon('calendar')} اليوم</button></div></div>
      <div class="field"><label for="wlesson">عنوان الدرس</label><input id="wlesson" class="input" data-meta="lesson" value="${esc(meta.lesson)}" placeholder="اكتب عنوان الدرس" autocomplete="off"></div>
      <div class="field"><span class="label">تعبئة سريعة (الخانات الفارغة فقط)</span>
        <div class="fill-grid">${CRIT.map((cr, k) => `<button type="button" class="btn soft" data-act="fill" data-k="${k}">${esc(cr.label)} ${ar(CONFIG.itemMax)}</button>`).join('')}
        <button type="button" class="btn success" data-act="fill" data-k="all">${icon('check')} الكل ${ar(CONFIG.itemMax)}</button></div></div>
    </div>
    <div class="actions"><button type="button" class="btn primary" data-x autofocus>تم</button></div>`, { label: 'أدوات الأسبوع', onClose: () => { if (route().name === 'class') rerenderList(); } });
  s.sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]') || e.target.closest('[data-act="fill"]')) setTimeout(() => s.close(), 0);
  });
}

function showClassMenu(p) {
  const c = cls(p.id);
  const item = (act, ic, t, sub, extra = '') => `<button type="button" class="list-item" data-act="${act}" data-id="${c.id}" ${extra}>${icon(ic)}<span class="grow"><strong>${t}</strong><small>${sub}</small></span></button>`;
  const s = openSheet(`<h2>${esc(c.label)}</h2>
    <div class="list">
      ${item('edit-class', 'users', 'الطلاب', 'إضافة، تعديل الأسماء، حذف، ترتيب')}
      ${item('export-xlsx', 'sheet', 'تصدير Excel', 'كشف المتابعة الرسمي للطباعة')}
      ${item('go-live', 'monitor', 'عرض على الكمبيوتر', 'اعرض الدرجات على البروجكتر')}
      ${item('go', 'send', 'نقل طلاب', 'لمعلم آخر أو لشعبة أخرى', 'data-to="transferOut"')}
      ${item('go', 'inbox', 'استقبال طلاب منقولين', 'من ملف أرسله معلم آخر', 'data-to="transferIn"')}
    </div>
    <div class="actions"><button type="button" class="btn" data-x>إغلاق</button></div>`, { label: 'خيارات الشعبة' });
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
  const sub = document.getElementById('week-sub');
  if (sub) { const d = dataOf(c.id); const n = c.names.length; const w = r.p.tab;
    sub.textContent = w === 'fin' ? (finalsRemaining(d, n) ? `باقي ${ar(finalsRemaining(d, n))}` : 'مكتملة ✓') : (weekComplete(d, w, n) ? 'مكتمل ✓' : `باقي ${ar(weekRemaining(d, w, n))} من ${ar(n)}`); }
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
    if (prev.some((v) => v != null && v !== CONFIG.itemMax)) {
      toast(`${c.names[i].split(' ')[0]}: كامل`, { action: { label: 'تراجع', fn: () => { prev.forEach((v, k) => setItem(d, w, i, k, v)); markDirty(c.id); livePatchItems(c.id, w, i); refreshStudent(c, w, i, { rerenderInputs: true }); } } });
    }
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

function quickFill(p, which) {
  const c = cls(p.id); const w = p.tab; const d = dataOf(c.id);
  const ks = which === 'all' ? CRIT.map((_, k) => k) : [+which];
  const changes = [];
  c.names.forEach((_, i) => {
    const vals = getItems(d, w, i);
    ks.forEach((k) => { if (vals[k] == null) { changes.push([i, k]); setItem(d, w, i, k, CONFIG.itemMax); } });
  });
  if (!changes.length) { toast('لا توجد خانات فارغة لتعبئتها'); return; }
  markDirty(c.id);
  [...new Set(changes.map(([i]) => i))].forEach((i) => livePatchItems(c.id, w, i));
  haptic('success');
  rerenderList(); refreshChip(c, w); refreshAside();
  const label = which === 'all' ? 'كل البنود' : CRIT[+which].label;
  toast(`عُبّئت ${cells(changes.length)} (${label})`, { action: { label: 'تراجع', fn: () => {
    changes.forEach(([i, k]) => setItem(d, w, i, k, null));
    markDirty(c.id);
    [...new Set(changes.map(([i]) => i))].forEach((i) => livePatchItems(c.id, w, i));
    rerenderList(); refreshChip(c, w); refreshAside();
    toast('تم التراجع');
  } } });
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
  if (t.matches('[data-setting-bool]')) { S.settings[t.dataset.settingBool] = t.checked; await saveSettingsNow(); return; }
  if (t.matches('[data-sel]')) { const i = +t.dataset.sel; if (t.checked) r.p.sel.add(i); else r.p.sel.delete(i); render(); return; }
  if (t.matches('[data-pick-st]')) { const i = +t.dataset.pickSt; if (t.checked) r.p.pick.add(i); else r.p.pick.delete(i); render(); return; }
  if (t.matches('[data-tgt]')) { r.p.target = t.dataset.tgt; render(); return; }
  if (t.matches('[data-live="class"]')) { L.classId = t.value; L.scope.idx = 0; liveResync(L.classId); render(); return; }
  if (t.matches('[data-live="student"]')) { L.scope.idx = +t.value; sendSnapshot(); return; }
  if (t.matches('[data-live="hide"]')) { L.hideNames = t.checked; sendSnapshot(); return; }
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
    const ok = await confirmDialog({ title: 'مرّ أكثر من أسبوع بدون نسخة احتياطية', text: 'درجاتك محفوظة على هذا الجوال فقط. احفظ نسخة الآن (ضغطة واحدة) حتى لا تضيع إن ضاع الجوال أو حُذف التطبيق.', ok: 'احفظ نسخة الآن', cancel: 'لاحقًا' });
    if (ok) doBackup();
  }, 600);
}

function registerSW() {
  if (platform.isNative || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  const hadController = !!navigator.serviceWorker.controller; // أول زيارة: لا نعيد التحميل
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ask = (w) => toast('تحديث متوفر، أعد التشغيل', { ms: 0, action: { label: 'أعد التشغيل', fn: () => w.postMessage({ type: 'skip-waiting' }) } });
    if (reg.waiting && navigator.serviceWorker.controller) ask(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ask(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && hadController) { reloaded = true; location.reload(); } });
}

async function boot() {
  try {
    await loadState();
  } catch {
    main().innerHTML = `<div class="wrap"><div class="alert err">${icon('warn')}<div class="grow"><strong>تعذّر فتح التخزين</strong><p>قد يكون المتصفح في وضع التصفح الخاص أو يمنع حفظ البيانات. افتح التطبيق في وضع عادي.</p></div></div></div>`;
    return;
  }
  applyTheme();
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
