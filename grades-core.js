// منطق الدرجات الصافي: بلا DOM، قابل للاستيراد من Node للاختبارات.
import CONFIG from './config.js';

export const WEEKS = CONFIG.weeks;
export const ITEMS = CONFIG.criteria.length;
export const ITEM_MAX = CONFIG.itemMax;
export const FIN_MAX = CONFIG.finals.map(f => f.max);
export const MAX_STUDENTS = CONFIG.maxStudents;
export const SLOTS_PER_STUDENT = WEEKS * ITEMS + FIN_MAX.length;

const WEEK_MAX = ITEMS * ITEM_MAX;                       // 20
const PERIOD_WEEKS = Math.ceil(WEEKS / 2);               // 5
const FORMATIVE_MAX = WEEK_MAX * 2;                      // 40
const TOTAL_MAX = FORMATIVE_MAX + FIN_MAX.reduce((a, b) => a + b, 0); // 100

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// ---------- الأرقام ----------

export function normalizeDigits(str) {
  return String(str ?? '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[،٫,]/g, '.')
    .replace(/[−–]/g, '-')
    .trim();
}

export function toArabicDigits(x) {
  return String(x ?? '').replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]).replace(/\./g, '٫');
}

export function round2(n) {
  return Math.round((n + Number.EPSILON * Math.sign(n)) * 100) / 100;
}

export function fmt(n) {
  if (!isNum(n)) return '—';
  return toArabicDigits(String(round2(n)));
}

export function parseScore(input, max) {
  const s = normalizeDigits(input).replace(/\s+/g, '');
  if (s === '') return { ok: true, value: null };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, error: 'ليست رقمًا' };
  const v = Number(s);
  if (!Number.isFinite(v)) return { ok: false, error: 'ليست رقمًا' };
  if (v < 0) return { ok: false, error: 'قيمة سالبة' };
  if (v > max) return { ok: false, error: `أكبر من ${toArabicDigits(max)}` };
  return { ok: true, value: round2(v) };
}

// ---------- الوصول إلى البيانات ----------

export function emptyClassData() {
  return { weeks: {}, fin: {}, t: 0 };
}

function ensureWeek(data, week) {
  data.weeks ||= {};
  const w = (data.weeks[week] ||= { date: '', lesson: '', s: {} });
  w.s ||= {};
  if (w.date == null) w.date = '';
  if (w.lesson == null) w.lesson = '';
  return w;
}

export function getItems(data, week, idx) {
  const arr = data?.weeks?.[week]?.s?.[idx];
  return Array.from({ length: ITEMS }, (_, i) => (arr && isNum(arr[i]) ? arr[i] : null));
}

// إدخال درجة غير صفرية لطالب مسجّل غائبًا في هذا الأسبوع يلغي علامة الغياب تلقائيًا
// (لا يبقى «غائب» وله درجات). الصفر أو المسح (null) لا يغيّران علامة الغياب.
export function setItem(data, week, idx, item, value) {
  const w = ensureWeek(data, week);
  const arr = (w.s[idx] ||= Array(ITEMS).fill(null));
  arr[item] = isNum(value) ? value : null;
  if (isNum(value) && value !== 0 && w.abs && w.abs[idx]) {
    delete w.abs[idx];
    if (!Object.keys(w.abs).length) delete w.abs;
  }
  data.t = Date.now();
}

// ---------- الغياب ----------
// الشكل: data.weeks["w"].abs = {"<idx>": true}. الغائب درجاته في الأسبوع أصفار (فيُعد مكتملًا ويُحسب في المجموع).

export function isAbsent(data, week, idx) {
  return data?.weeks?.[week]?.abs?.[idx] === true;
}

/** on=true: علامة غياب + البنود الأربعة = ٠. on=false: تُزال العلامة، وإن كانت البنود [٠،٠،٠،٠] بالضبط تعود فارغة.
 *  ترجع البنود السابقة (للتراجع). */
export function setAbsent(data, week, idx, on) {
  const prev = getItems(data, week, idx);
  const w = ensureWeek(data, week);
  if (on) {
    w.abs ||= {};
    w.abs[idx] = true;
    w.s[idx] = Array(ITEMS).fill(0);
  } else {
    if (w.abs) {
      delete w.abs[idx];
      if (!Object.keys(w.abs).length) delete w.abs;
    }
    if (prev.every(v => v === 0)) delete w.s[idx];
  }
  data.t = Date.now();
  return prev;
}

export function absenceCount(data, idx) {
  let c = 0;
  for (let w = 1; w <= WEEKS; w++) if (isAbsent(data, w, idx)) c++;
  return c;
}

export function weekAbsentList(data, week, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (isAbsent(data, week, i)) out.push(i);
  return out;
}

/** حالة الحضور: 'absent' | 'present' (له أي درجة في الأسبوع) | null (لم يُرصد بعد) */
export function attendanceStatus(data, week, idx) {
  if (isAbsent(data, week, idx)) return 'absent';
  return getItems(data, week, idx).some(v => v !== null) ? 'present' : null;
}

/** لكل طالب: {absent:[أرقام الأسابيع], count, present:عدد الأسابيع المرصود حضوره} */
export function attendanceSummary(data, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const absent = [];
    let present = 0;
    for (let w = 1; w <= WEEKS; w++) {
      const st = attendanceStatus(data, w, i);
      if (st === 'absent') absent.push(w);
      else if (st === 'present') present++;
    }
    out.push({ absent, count: absent.length, present });
  }
  return out;
}

// ---------- الملاحظات ----------
// الشكل: data.notes = {"<idx>": [{t: ISO, text}]} — لا تدخل في بطاقة المشاركة ولا كشف الدرجات.
export const NOTE_MAX_LEN = 500;
export const NOTES_PER_STUDENT = 200;

export function getNotes(data, idx) {
  const list = data?.notes?.[idx];
  return Array.isArray(list) ? list.map(x => ({ t: x.t, text: x.text })) : [];
}

/** يضيف ملاحظة مؤرخة (تُقص لـ ٥٠٠ حرف). نص فارغ يُتجاهل → null. ترجع الملاحظة المضافة. */
export function addNote(data, idx, text, now = new Date()) {
  const clean = String(text ?? '').trim().slice(0, NOTE_MAX_LEN).trim();
  if (!clean) return null;
  data.notes ||= {};
  const list = (data.notes[idx] ||= []);
  let ms = now.getTime();
  while (list.some(x => x.t === new Date(ms).toISOString())) ms++; // t فريد لكل ملاحظة
  const note = { t: new Date(ms).toISOString(), text: clean };
  list.push(note);
  if (list.length > NOTES_PER_STUDENT) list.splice(0, list.length - NOTES_PER_STUDENT);
  data.t = Date.now();
  return { ...note };
}

/** يحذف الملاحظة ذات الوقت t. ترجع true إن حُذفت. */
export function deleteNote(data, idx, t) {
  const list = data?.notes?.[idx];
  if (!Array.isArray(list)) return false;
  const i = list.findIndex(x => x.t === t);
  if (i < 0) return false;
  list.splice(i, 1);
  if (!list.length) delete data.notes[idx];
  if (!Object.keys(data.notes).length) delete data.notes;
  data.t = Date.now();
  return true;
}

export function getFin(data, idx) {
  const arr = data?.fin?.[idx];
  return FIN_MAX.map((_, i) => (arr && isNum(arr[i]) ? arr[i] : null));
}

export function setFin(data, idx, k, value) {
  data.fin ||= {};
  const arr = (data.fin[idx] ||= Array(FIN_MAX.length).fill(null));
  arr[k] = isNum(value) ? value : null;
  data.t = Date.now();
}

export function getWeekMeta(data, week) {
  const w = data?.weeks?.[week];
  return { date: w?.date || '', lesson: w?.lesson || '' };
}

export function setWeekMeta(data, week, field, value) {
  const w = ensureWeek(data, week);
  w[field] = String(value ?? '');
  data.t = Date.now();
}

// ---------- الحساب ----------

export function weekTotal(data, week, idx) {
  const items = getItems(data, week, idx);
  if (items.some(v => v === null)) return null;
  return items.reduce((a, b) => a + b, 0);
}

export function periodScore(data, idx, period) {
  const start = period === 1 ? 1 : PERIOD_WEEKS + 1;
  const end = period === 1 ? PERIOD_WEEKS : WEEKS;
  let sum = 0;
  for (let w = start; w <= end; w++) {
    const t = weekTotal(data, w, idx);
    if (t === null) return null;
    sum += t;
  }
  return sum / (end - start + 1);
}

export function formative(data, idx) {
  const p1 = periodScore(data, idx, 1), p2 = periodScore(data, idx, 2);
  return p1 === null || p2 === null ? null : p1 + p2;
}

export function finalTotal(data, idx) {
  const f = formative(data, idx);
  const fin = getFin(data, idx);
  if (f === null || fin.some(v => v === null)) return null;
  return fin.reduce((a, b) => a + b, f);
}

export function studentSummary(data, idx) {
  const weeks = [];
  for (let w = 1; w <= WEEKS; w++) weeks.push(weekTotal(data, w, idx));
  return {
    weeks,
    p1: periodScore(data, idx, 1),
    p2: periodScore(data, idx, 2),
    formative: formative(data, idx),
    fin: getFin(data, idx),
    total: finalTotal(data, idx),
  };
}

export function studentComplete(data, week, idx) {
  return getItems(data, week, idx).every(v => v !== null);
}

export function weekRemaining(data, week, n) {
  let r = 0;
  for (let i = 0; i < n; i++) if (!studentComplete(data, week, i)) r++;
  return r;
}

export function weekComplete(data, week, n) {
  return n > 0 && weekRemaining(data, week, n) === 0;
}

export function finalsRemaining(data, n) {
  let r = 0;
  for (let i = 0; i < n; i++) if (getFin(data, i).some(v => v === null)) r++;
  return r;
}

export function firstIncompleteWeek(data, n) {
  for (let w = 1; w <= WEEKS; w++) if (!weekComplete(data, w, n)) return w;
  return 'fin';
}

export function progress(data, n) {
  let filled = 0;
  for (let i = 0; i < n; i++) {
    for (let w = 1; w <= WEEKS; w++) filled += getItems(data, w, i).filter(v => v !== null).length;
    filled += getFin(data, i).filter(v => v !== null).length;
  }
  const total = n * SLOTS_PER_STUDENT;
  return { filled, total, ratio: total ? filled / total : 0 };
}

export function studentCardText({ name, classLabel, subject, teacher, data, idx }) {
  const s = studentSummary(data, idx);
  const weekParts = [];
  s.weeks.forEach((t, i) => { if (t !== null) weekParts.push(`أسبوع ${toArabicDigits(i + 1)}: ${fmt(t)}`); });
  const of = m => `من ${toArabicDigits(m)}`;
  const lines = [
    `الطالب: ${name}`,
    subject ? `الصف: ${classLabel} · ${subject}` : `الصف: ${classLabel}`,
    `درجات الأسابيع (${of(WEEK_MAX)}): ${weekParts.length ? weekParts.join('، ') : 'لا توجد بعد'}`,
    `الفترة الأولى: ${fmt(s.p1)} ${of(WEEK_MAX)} / الفترة الثانية: ${fmt(s.p2)} ${of(WEEK_MAX)} / التقويم البنائي: ${fmt(s.formative)} ${of(FORMATIVE_MAX)}`,
    CONFIG.finals.map((f, i) => `${f.label}: ${fmt(s.fin[i])} ${of(f.max)}`).join(' / '),
    s.total === null ? 'المجموع النهائي: لم يكتمل بعد' : `المجموع النهائي: ${fmt(s.total)} ${of(TOTAL_MAX)}`,
  ];
  if (teacher) lines.push(`المعلم: ${teacher}`);
  return lines.join('\n');
}

// ---------- الأسماء ----------

const BIDI_RE = /[​-‏‪-‮⁦-⁩؜﻿]/g;
const DIACRITICS_RE = /[ً-ٰٟۖ-ۭ]/g;
const DIGIT_CLASS = '0-9٠-٩۰-۹';

// مفتاح المقارنة: توحيد الألف والتاء المربوطة والياء، حذف التطويل والتشكيل.
export function nameKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(BIDI_RE, '')
    .replace(DIACRITICS_RE, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىی]/g, 'ي')
    .replace(/ھ/g, 'ه')
    .replace(/ک/g, 'ك')
    .replace(/[.:\-_]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const HEADER_WORDS = new Set([
  'الاسم', 'اسم', 'الأسم', 'اسم الطالب', 'اسم الطالبة', 'اسماء الطلاب', 'أسماء الطلاب', 'أسماء الطالبات', 'اسماء الطالبات',
  'م', 'م.', 'الرقم', 'رقم', 'الرقم التسلسلي', 'التسلسل', 'تسلسل', 'مسلسل', 'ت', 'ر', 'ن',
  'الاسم الرباعي', 'الاسم الثلاثي', 'الاسم الكامل', 'الاسم الثنائي', 'اسم التلميذ', 'اسم التلميذة', 'التلميذ', 'الطالب', 'الطالبة',
  'الصف', 'الفصل', 'الشعبة', 'ملاحظات', 'الملاحظات', 'المجموع', 'الدرجة', 'الرقم المدني', 'الجنسية', 'المادة',
  'name', 'names', 'student', 'students', 'student name', 'full name', 'no', 'no.', '#', 'id',
].map(nameKey));

// كلمات لا تأتي في أسماء الأشخاص: تظهر في ترويسات الكشوف (اسم المدرسة، الوزارة، عناوين الأعمدة، التواقيع…)
const NON_NAME_WORDS = new Set([
  'مدرسة', 'المدرسة', 'مدرسه', 'ثانوية', 'الثانوية', 'متوسطة', 'المتوسطة', 'ابتدائية', 'الابتدائية', 'روضة', 'معهد', 'كلية', 'جامعة',
  'وزارة', 'الوزارة', 'التربية', 'تربية', 'التعليم', 'تعليم', 'منطقة', 'المنطقة', 'التعليمية', 'تعليمية', 'إدارة', 'ادارة', 'الإدارة', 'الادارة', 'قسم', 'القسم',
  'كشف', 'كشوف', 'بيان', 'بيانات', 'درجات', 'الدرجات', 'درجة', 'نتائج', 'نتيجة', 'النتيجة', 'سجل', 'رصد', 'متابعة', 'المتابعة', 'حضور', 'الحضور', 'غياب', 'الغياب',
  'الفصل', 'فصل', 'الفصلي', 'الدراسي', 'الدراسية', 'دراسي', 'العام', 'عام', 'الصف', 'صف', 'الشعبة', 'شعبة', 'المرحلة', 'مرحلة', 'الفترة', 'فترة',
  'المادة', 'مادة', 'المجال', 'المعلم', 'المعلمة', 'معلم', 'معلمة', 'رئيس', 'رئيسة', 'مدير', 'مديرة', 'المدير', 'المديرة', 'الموجه', 'الموجهة', 'موجه',
  'توقيع', 'التوقيع', 'ملاحظات', 'ملاحظة', 'التاريخ', 'تاريخ', 'اليوم', 'صفحة', 'الصفحة', 'عدد', 'المجموع', 'مجموع', 'النسبة', 'نسبة', 'التقدير', 'تقدير',
  'دولة', 'الكويت', 'الحكومية', 'حكومية', 'الخاصة', 'بنين', 'بنات', 'للبنين', 'للبنات', 'الطلاب', 'طلاب', 'الطالبات', 'طالبات', 'أسماء', 'اسماء', 'التلاميذ',
  'التقويم', 'تقويم', 'اختبار', 'الاختبار', 'امتحان', 'الامتحان', 'النهائي', 'نهائي', 'الشفوي', 'التحريري', 'العملي', 'المشروع', 'مشروع', 'السلوك', 'المشاركة',
  'الرياضيات', 'العلوم', 'الإنجليزية', 'الانجليزية', 'الإسلامية', 'الاسلامية', 'الاجتماعيات', 'الحاسوب', 'الحاسب', 'البدنية', 'الفنية', 'الموسيقية', 'اللغة', 'لغة',
  'ممتاز', 'جيد', 'مقبول', 'ضعيف', 'راسب', 'ناجح', 'منقول', 'غائب', 'الجنسية', 'كويتي', 'كويتية', 'المدني', 'هاتف', 'الهاتف', 'العنوان', 'عنوان',
  'ministry', 'school', 'class', 'grade', 'grades', 'teacher', 'subject', 'date', 'page', 'total',
].map(nameKey));

/** سطر ترويسة/عنوان وليس اسم طالب: فيه كلمة لا تأتي في الأسماء، أو «عنوان: قيمة». */
export function isNonNameLine(s) {
  const t = String(s ?? '').trim();
  if (!t) return true;
  if (/[:：]/.test(t)) return true; // «المدرسة: …» «الصف: …»
  if (/^(أ|ا|د|م)\s*[./]/.test(t) || /^(الأستاذ|الاستاذ|الأستاذة|الاستاذة|المعلم|المعلمة)\s/.test(t)) return true; // «أ. فلان» توقيع المعلم
  return t.split(/[\s/\\|\-–—_.,،]+/).some((w) => w && NON_NAME_WORDS.has(nameKey(w)));
}

export function isHeaderWord(s) {
  return HEADER_WORDS.has(nameKey(s));
}

export function nameLikeness(s) {
  const t = String(s ?? '').replace(BIDI_RE, '').replace(/\s+/g, ' ').trim();
  if (!t || isHeaderWord(t) || isNonNameLine(t.replace(/^[\s\d٠-٩۰-۹().\-]+/, ''))) return 0;
  const chars = t.replace(/\s/g, '');
  if (!chars.length) return 0;
  const arabic = (chars.match(/[ء-يٱ-ۓۺ-ۿﭐ-﷿ﹰ-ﻼ]/g) || []).length;
  const marks = (chars.match(/[ً-ٰٟـ]/g) || []).length;
  const latin = (chars.match(/[A-Za-z]/g) || []).length;
  const hasDigit = new RegExp(`[${DIGIT_CLASS}]`).test(chars);
  const letterRatio = Math.min(1, (arabic + marks + latin * 0.6) / chars.length);
  const words = t.split(' ').length;
  const wordScore = words >= 2 && words <= 6 ? 1 : words === 1 ? 0.4 : 0.6;
  const lenScore = t.length > 60 ? 0.5 : 1;
  return letterRatio * wordScore * lenScore * (hasDigit ? 0.3 : 1);
}

export function cleanName(line) {
  let s = String(line ?? '').normalize('NFKC').replace(BIDI_RE, '').replace(/[  - 　]/g, ' ');
  // سطر بأعمدة (من جدول أو CSV): نختار الخلية الأشبه بالاسم
  const cells = s.split(/\t|[|;,،]/).map(c => c.trim()).filter(Boolean);
  if (cells.length > 1) {
    let best = cells[0], bestScore = -1;
    for (const c of cells) {
      const sc = nameLikeness(stripNumbering(c));
      if (sc > bestScore) { best = c; bestScore = sc; }
    }
    s = best;
  }
  s = stripNumbering(s);
  // ما بعد أول رقم ضجيج أعمدة (درجات/أرقام مدنية)
  s = s.replace(new RegExp(`[${DIGIT_CLASS}].*$`), '');
  s = s.replace(/ـ/g, '')
    .replace(/[^\p{L}\p{M}\s'’.\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s'’.\-]+|[\s'’.\-]+$/g, '')
    .trim();
  const letters = (s.match(/\p{L}/gu) || []).length;
  if (letters < 2 || isHeaderWord(s) || isNonNameLine(s)) return '';
  if (s.split(' ').length > 7) return ''; // جملة وليست اسمًا
  return s;
}

function stripNumbering(s) {
  const d = `[${DIGIT_CLASS}]+`;
  return s.trim()
    .replace(new RegExp(`^[(\\[]\\s*${d}\\s*[)\\]]\\s*[-.:ـ]?\\s*`), '')
    .replace(new RegExp(`^${d}\\s*[-.):/ـ\\]]+\\s*`), '')
    .replace(new RegExp(`^${d}\\s+`), '')
    .trim();
}

export function cleanNames(lines, existing = [], max = MAX_STUDENTS) {
  const seen = new Set((existing || []).map(nameKey));
  const names = [];
  let dup = 0, overLimit = 0, skipped = 0;
  const room = Math.max(0, max - (existing || []).length);
  for (const line of lines || []) {
    const n = cleanName(line);
    if (!n) { skipped++; continue; }
    const k = nameKey(n);
    if (seen.has(k)) { dup++; continue; }
    if (names.length >= room) { overLimit++; continue; }
    seen.add(k);
    names.push(n);
  }
  return { names, dup, overLimit, skipped };
}

let collator;
export function arCompare(a, b) {
  collator ||= new Intl.Collator('ar');
  return collator.compare(String(a ?? ''), String(b ?? ''));
}

// from[i] = الفهرس القديم للطالب الذي سيصبح في الموضع i (أو null لطالب جديد بلا درجات)
export function remapData(data, from) {
  const out = { weeks: {}, fin: {}, t: Date.now() };
  for (const [wk, w] of Object.entries(data?.weeks || {})) {
    const s = {};
    from.forEach((old, i) => {
      const arr = old == null ? null : w?.s?.[old];
      if (arr) s[i] = arr.slice();
    });
    out.weeks[wk] = { date: w?.date || '', lesson: w?.lesson || '', s };
    const abs = {};
    from.forEach((old, i) => { if (old != null && w?.abs?.[old] === true) abs[i] = true; });
    if (Object.keys(abs).length) out.weeks[wk].abs = abs;
  }
  from.forEach((old, i) => {
    const arr = old == null ? null : data?.fin?.[old];
    if (arr) out.fin[i] = arr.slice();
  });
  const notes = {};
  from.forEach((old, i) => {
    const list = old == null ? null : data?.notes?.[old];
    if (Array.isArray(list) && list.length) notes[i] = list.map(x => ({ t: x.t, text: x.text }));
  });
  if (Object.keys(notes).length) out.notes = notes;
  return out;
}
