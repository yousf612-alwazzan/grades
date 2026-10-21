// قوائم صفوف المدرسة: الصف ← الشعب ← أسماء الطلاب فقط (بلا رقم مدني ولا أي بيانات أخرى).
// المصدر: الخادم بعد تسجيل الدخول (آيفون/كمبيوتر)، أو «ملف صفوف المدرسة» يستورده معلم الأندرويد مرة واحدة.
// لا تُضمَّن الأسماء في كود التطبيق أبدًا (الموقع عام).

export const GRADE_NAMES = { 6: 'السادس', 7: 'السابع', 8: 'الثامن', 9: 'التاسع' };
const MAX_SECTIONS = 40;
const MAX_PER_SECTION = 80;

/** ينظّف ملف/رد القوائم ويرجع {year, grades: {"8": {"10": [names]}}} أو null إن لم يكن صالحًا. */
export function sanitizeRoster(raw) {
  if (!raw || typeof raw !== 'object' || raw.app !== 'grades-school' || !raw.grades || typeof raw.grades !== 'object') return null;
  const grades = {};
  for (const [g, secs] of Object.entries(raw.grades)) {
    if (!/^\d{1,2}$/.test(g) || !secs || typeof secs !== 'object') continue;
    const out = {};
    for (const [s, names] of Object.entries(secs).slice(0, MAX_SECTIONS)) {
      if (!/^\d{1,3}$/.test(s) || !Array.isArray(names)) continue;
      const clean = names.filter((n) => typeof n === 'string').map((n) => n.replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, MAX_PER_SECTION);
      if (clean.length) out[s] = clean;
    }
    if (Object.keys(out).length) grades[g] = out;
  }
  if (!Object.keys(grades).length) return null;
  return { app: 'grades-school', v: 1, year: typeof raw.year === 'string' ? raw.year.slice(0, 20) : '', grades };
}

export const gradeName = (g) => GRADE_NAMES[g] || String(g);
/** اسم الصف كما يُحفظ: «الثامن / 10» (نفس شكل خطط المنهج). */
export const sectionLabel = (g, s) => `${gradeName(g)} / ${s}`;
/** «الثامن / 4» ← «8-4» (معرّف الشعبة في المخزن المشترك)، أو null إن لم يكن اسم شعبة من المدرسة. */
export function sectionOf(label) {
  const m = /^\s*(\S+)\s*\/\s*(\d{1,2})\s*$/.exec(String(label || ''));
  if (!m) return null;
  const g = Object.keys(GRADE_NAMES).find((k) => GRADE_NAMES[k] === m[1]);
  return g ? `${g}-${Number(m[2])}` : null;
}
export const sortedSections = (secs) => Object.keys(secs || {}).sort((a, b) => Number(a) - Number(b));
export const sortedGrades = (roster) => Object.keys((roster && roster.grades) || {}).sort((a, b) => Number(a) - Number(b));
