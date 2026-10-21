// جدول حصص المدرسة: لكل معلم حصصه (اليوم، رقم الحصة، حصة مفردة/مزدوجة، الصف والشعبة) — بلا أي أسماء طلاب.
// المصدر: الخادم بعد تسجيل الدخول (ومعه اسم صاحب الحساب في الجدول)، أو ملف مضمّن في تطبيق أندرويد.
// لا يُنشر في الموقع العام. أوقات الحصص في config.js (bells).
import CONFIG from './config.js';
import { sectionLabel } from './school.js';
import { tr } from './i18n.js';

/** ينظّف ملف الجدول (من الخادم أو التطبيق). يرجع null إن لم يكن جدولًا صالحًا. */
export function sanitizeTimetable(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'grades-timetable' || !raw.teachers || typeof raw.teachers !== 'object') return null;
  const teachers = {};
  for (const [name, list] of Object.entries(raw.teachers).slice(0, 300)) {
    const n = String(name).trim().slice(0, 80);
    if (!n || !Array.isArray(list)) continue;
    teachers[n] = list.slice(0, 60).map((x) => {
      const d = Number(x && x.d); const p = Number(x && x.p); const span = Number(x && x.n) === 2 ? 2 : 1;
      if (!Number.isInteger(d) || d < 0 || d > 6 || !Number.isInteger(p) || p < 1 || p + span - 1 > CONFIG.bells.length) return null;
      const g = /^\d{1,2}$/.test(String(x.g ?? '')) ? String(x.g) : '';
      const s = /^\d{1,2}$/.test(String(x.s ?? '')) ? String(x.s) : '';
      const t = typeof x.t === 'string' ? x.t.slice(0, 40) : '';
      if (!(g && s) && !t) return null;
      return g && s ? { d, p, n: span, g, s } : { d, p, n: span, t };
    }).filter(Boolean);
  }
  if (!Object.keys(teachers).length) return null;
  return { app: 'grades-timetable', v: 1, teachers, at: Number(raw.at) || 0 };
}

// مدخل تذكير من حصة في الجدول
function entry(x, c) {
  const [start] = CONFIG.bells[x.p - 1];
  const end = CONFIG.bells[x.p + x.n - 2][1];
  const meeting = !(x.g && x.s);
  return { id: `tt${x.d}-${x.p}`, day: x.d, time: start, end, period: x.p, span: x.n, label: meeting ? tr(x.t) : c.label, classId: c ? c.id : null, kind: meeting ? 'meeting' : 'class' };
}

/** حصص صفوف المعلم من جدول المدرسة — تلقائيًا من الصفوف نفسها (الثامن / 4 ← وقت حصتها).
 *  صاحب أكثر الشعب المطابقة في الجدول هو المعلم: تُضاف مواعيده الأخرى أيضًا (الاجتماعات). */
export function entriesFor(tt, classes) {
  if (!tt) return [];
  const byLabel = new Map(classes.map((c) => [c.label, c]));
  const out = [];
  const score = new Map();
  for (const [name, list] of Object.entries(tt.teachers)) {
    for (const x of list) {
      if (!(x.g && x.s)) continue;
      const c = byLabel.get(sectionLabel(x.g, x.s));
      if (!c) continue;
      out.push(entry(x, c));
      score.set(name, (score.get(name) || 0) + 1);
    }
  }
  let best = '';
  for (const [n, k] of score) if (!best || k > score.get(best)) best = n;
  if (best) for (const x of tt.teachers[best]) if (!(x.g && x.s)) out.push(entry(x, null));
  return out;
}

/** صفوف المعلم غير الموجودة في جدول المدرسة (لا يُعرف وقتها). */
export function unmatchedClasses(tt, classes) {
  if (!tt) return [];
  const all = new Set();
  for (const list of Object.values(tt.teachers)) for (const x of list) if (x.g && x.s) all.add(sectionLabel(x.g, x.s));
  return classes.filter((c) => !all.has(c.label));
}
