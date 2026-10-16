// اللغة: العربية (الأصل) أو الإنجليزية.
// - النصوص في الكود مكتوبة بالعربية، والترجمة في i18n-en.js (المفتاح = النص العربي، و{} مكان كل قيمة متغيرة).
// - T`نص ${قيمة}` للقوالب، و tr('نص') للنصوص الثابتة. ما ليس له ترجمة يبقى عربيًا.
// - التطبيق يقرأ اللغة لحظة الفتح (من ?lang= أو من تفضيل محفوظ على الجهاز)؛ تغيير اللغة يعيد تحميل الصفحة.
// - شاشة العرض على الكمبيوتر تتبع لغة الجوال عبر setLang() بلا أي حفظ.
// لإضافة لغة أو تعديل ترجمة: عدّل i18n-en.js فقط.
import EN from './i18n-en.js';

const PREF_KEY = 'gfu-lang'; // تفضيل واجهة فقط (ليس بيانات طلاب)

function detect() {
  if (typeof window === 'undefined') return 'ar';
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'en' || q === 'ar') return q;
  } catch { /* */ }
  try { if (window.localStorage.getItem(PREF_KEY) === 'en') return 'en'; } catch { /* */ }
  return 'ar';
}

let CUR = detect();
export const lang = () => CUR;
export const isEn = () => CUR === 'en';

/** يغيّر اللغة في الذاكرة (لشاشة العرض) ويضبط اتجاه الصفحة. */
export function setLang(l) {
  CUR = l === 'en' ? 'en' : 'ar';
  applyDir();
}
/** يحفظ تفضيل اللغة على هذا الجهاز (للتطبيق فقط — لا يُستدعى في شاشة العرض). */
export function rememberLang(l) {
  try { if (l === 'en') window.localStorage.setItem(PREF_KEY, 'en'); else window.localStorage.removeItem(PREF_KEY); } catch { /* */ }
}

export function applyDir() {
  if (typeof document === 'undefined') return;
  const r = document.documentElement;
  r.lang = CUR;
  r.dir = CUR === 'en' ? 'ltr' : 'rtl';
}

const AR_RE = /[؀-ۿ]/;
const MK = (i) => '\u0001' + i + '\u0002'; // علامة مكان القيمة رقم i
const MK_RE = /\u0001(\d+)\u0002/g;

// يترجم جملة فيها علامات قيم: المفتاح بـ {} مكان كل علامة، والترجمة قد تعيد ترتيبها بـ {0} {1}
// لبّ الجملة: بلا مسافات ولا قيم في طرفيها (أيقونة قبل النص مثلًا لا تدخل في المفتاح)
export function segCore(seg) {
  const m = seg.match(/^((?:\s|\u0001\d+\u0002)*)([\s\S]*?)((?:\s|\u0001\d+\u0002)*)$/);
  return m ? m[2] : seg.trim();
}
function trSegment(seg) {
  const t = segCore(seg);
  if (!t || !AR_RE.test(t)) return seg;
  const ids = [];
  const key = t.replace(MK_RE, (_, i) => { ids.push(i); return '{}'; });
  const en = EN[key];
  if (en == null) return seg;
  let k = 0;
  const out = en.replace(/\{(\d*)\}/g, (_, d) => { const id = ids[d === '' ? k++ : Number(d)]; return id == null ? '' : MK(id); });
  return seg.replace(t, () => out);
}
// HTML: نترجم كل نص بين الوسوم، وقيم title/aria-label/placeholder/alt داخل الوسوم
function trHtml(s) {
  return s.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      return AR_RE.test(part) ? part.replace(/(\s(?:title|aria-label|placeholder|alt)=")([^"]*)(")/g, (m, a, v, b) => a + trSegment(v) + b) : part;
    }
    return trSegment(part);
  }).join('');
}
function fill(s, vals) { return s.replace(MK_RE, (_, i) => { const v = vals[Number(i)]; return v == null ? '' : String(v); }); }

/** نص ثابت. */
export function tr(s) {
  if (CUR !== 'en' || typeof s !== 'string' || !AR_RE.test(s)) return s;
  const v = EN[s];
  if (v != null) return v;
  return s.includes('<') ? trHtml(s) : trSegment(s);
}

/** اسم بند أو درجة نهائية: مفتاح خاص «بند: …» أولًا (تتشابه بعض الأسماء مع كلمات عامة)، ثم الترجمة العامة. */
export function trCrit(s) {
  if (CUR !== 'en' || typeof s !== 'string') return s;
  const v = EN['بند: ' + s];
  return v != null ? v : tr(s);
}

/** قالب نصي: T`باقي ${n} من ${m}` ← "Remaining {} of {}". القوالب الكبيرة (HTML) تُترجم جملةً جملة. */
export function T(strings, ...vals) {
  if (CUR === 'en') {
    const en = EN[strings.join('{}')];
    if (en != null) {
      let k = 0;
      return en.replace(/\{(\d*)\}/g, (_, d) => { const v = vals[d === '' ? k++ : Number(d)]; return v == null ? '' : String(v); });
    }
    let marked = strings[0];
    for (let i = 0; i < vals.length; i++) marked += MK(i) + strings[i + 1];
    if (AR_RE.test(marked)) return fill(marked.includes('<') ? trHtml(marked) : trSegment(marked), vals);
  }
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += String(vals[i]) + strings[i + 1];
  return out;
}

/** يترجم النصوص الثابتة في صفحة HTML (index.html / view.html). يحفظ العربي الأصلي ليرجع إليه. */
export function translateStatic(root) {
  if (typeof document === 'undefined' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const AR = /[؀-ۿ]/;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.__ar == null) { if (!AR.test(n.nodeValue)) continue; n.__ar = n.nodeValue; }
    const raw = n.__ar; const t = raw.trim();
    const v = CUR === 'en' ? EN[t] : null;
    n.nodeValue = v != null ? raw.replace(t, v) : raw;
  }
  for (const el of root.querySelectorAll('[title],[aria-label],[placeholder]')) {
    for (const a of ['title', 'aria-label', 'placeholder']) {
      if (!el.hasAttribute(a)) continue;
      const key = 'data-ar-' + a;
      if (!el.hasAttribute(key)) { if (!AR.test(el.getAttribute(a))) continue; el.setAttribute(key, el.getAttribute(a)); }
      const raw = el.getAttribute(key);
      el.setAttribute(a, CUR === 'en' && EN[raw] != null ? EN[raw] : raw);
    }
  }
}

applyDir();
