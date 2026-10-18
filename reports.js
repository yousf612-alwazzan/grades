// كشوف قابلة للطباعة / الحفظ PDF (A4 أفقي). توليد HTML صافٍ: لا DOM ولا شبكة عند الاستيراد،
// فيمكن استيراده من Node للاختبار. الواجهة تضع الناتج داخل <div id="print-root"> ثم تستدعي platform.print().
//
// gradesReportHTML     : كشف الدرجات (part: 'p1' | 'p2' | 'final' | 'all')
// attendanceReportHTML : كشف الحضور والغياب
// studentReportHTML    : تقرير طالب واحد (يشمل الملاحظات — لا يُطبع إلا بطلب المعلم لهذا الطالب)
// REPORT_CSS           : تنسيق الكشوف + قواعد الطباعة (يُحقن مرة واحدة في <style>)

import CONFIG from './config.js';
import {
  WEEKS, ITEMS, ITEM_MAX, FIN_MAX, getItems, getWeekMeta, studentSummary, isAbsent, attendanceStatus,
  attendanceSummary, getNotes, toArabicDigits, fmt,
} from './grades-core.js';
import { T, tr, trCrit } from './i18n.js';

const WEEK_MAX = ITEMS * ITEM_MAX;                 // ٢٠
const HALF = Math.ceil(WEEKS / 2);                 // ٥
const FORMATIVE_MAX = WEEK_MAX * 2;                // ٤٠
const TOTAL_MAX = FORMATIVE_MAX + FIN_MAX.reduce((a, b) => a + b, 0); // ١٠٠
const DASH = '—';
const ABS = tr('غ');
const PRESENT = '✓';

const ar = toArabicDigits;
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const of = m => T`<span class="max">(من ${ar(m)})</span>`;

function dateText(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return ar(`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`);
}
// تاريخ الأسبوع كما أدخله المعلم (غالبًا YYYY-MM-DD) بأرقام هندية؛ المختصر: يوم/شهر (لترويسات الأعمدة الضيقة)
const weekDate = s => (s ? ar(String(s).replace(/-/g, '/')) : '');
function shortDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  return m ? ar(`${m[3]}/${m[2]}`) : weekDate(s);
}

function headerBlock({ title, subtitle, classLabel, settings }) {
  const st = settings || {};
  const right = [tr('دولة الكويت'), tr('وزارة التربية'), st.school ? String(st.school) : '']
    .filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('');
  const info = [
    [tr('الصف'), classLabel],
    [tr('المادة'), st.subject],
    [tr('المعلم'), st.teacher],
    [tr('العام الدراسي'), st.year],
  ].map(([k, v]) => `<div><span class="k">${k}:</span> <span class="v">${v ? esc(ar(v)) : '<span class="blank-line"></span>'}</span></div>`).join('');
  return `<header class="r-head">
  <div class="r-org">${right}</div>
  <div class="r-title"><h1>${esc(title)}</h1>${subtitle ? `<div class="r-sub">${esc(subtitle)}</div>` : ''}</div>
  <div class="r-info">${info}</div>
</header>`;
}

function footerBlock(date) {
  const sig = [tr('المعلم'), tr('رئيس القسم'), tr('مدير المدرسة')]
    .map(x => T`<div class="sig"><div class="sig-k">${x}</div><div class="sig-line"></div><div class="sig-n">التوقيع</div></div>`).join('');
  return T`<footer class="r-foot"><div class="sigs">${sig}</div><div class="r-date">تاريخ الطباعة: ${dateText(date)}</div></footer>`;
}

function weekHead(w, data, extra = '', short = false) {
  const raw = getWeekMeta(data, w).date;
  const d = short ? shortDate(raw) : weekDate(raw);
  return T`<th class="wk"${extra}><span class="wk-n">الأسبوع ${ar(w)}</span>${d ? `<span class="wk-d">${d}</span>` : ''}</th>`;
}

const cleanNames = names => (Array.isArray(names) ? names : []);
const n0 = names => Math.min(cleanNames(names).length, CONFIG.maxStudents);
const nameCell = name => `<td class="name">${esc(name)}</td>`;
const numCell = (v, cls = '') => `<td class="${('num ' + cls).trim()}">${fmt(v)}</td>`;

const PARTS = {
  p1: { title: tr('الفترة الأولى'), weeks: [1, HALF] },
  p2: { title: tr('الفترة الثانية'), weeks: [HALF + 1, WEEKS] },
  final: { title: tr('رصد الدرجات النهائية') },
  all: { title: tr('الكشف الشامل') },
};

/** كشف الدرجات. p1/p2: البنود الأربعة ومجموع كل أسبوع ودرجة الفترة. final: الفترتان والبنائي والنهائي.
 *  all: مجاميع الأسابيع ١–١٠ والفترتان والبنائي والنهائي والمجموع. لا يتضمن الملاحظات. */
export function gradesReportHTML({ classLabel = '', names = [], data, settings = {}, part = 'all', date } = {}) {
  const P = PARTS[part] ? part : 'all';
  const n = n0(names);
  names = cleanNames(names);
  data = data || { weeks: {}, fin: {}, t: 0 };
  const sub = P === 'p1' || P === 'p2'
    ? T`${PARTS[P].title} (الأسابيع ${ar(PARTS[P].weeks[0])}–${ar(PARTS[P].weeks[1])})`
    : PARTS[P].title;
  let head, rows = [];
  const finHeads = CONFIG.finals.map(f => `<th class="col-fin">${esc(trCrit(f.label))} ${of(f.max)}</th>`).join('');

  if (P === 'p1' || P === 'p2') {
    const [w0, w1] = PARTS[P].weeks;
    const ws = []; for (let w = w0; w <= w1; w++) ws.push(w);
    head = T`<tr><th rowspan="2" class="col-m">م</th><th rowspan="2" class="col-name">اسم الطالب</th>${ws.map(w => weekHead(w, data, ` colspan="${ITEMS + 1}"`)).join('')}<th rowspan="2" class="col-p">${PARTS[P].title} ${of(WEEK_MAX)}</th></tr>
<tr>${ws.map(() => CONFIG.criteria.map(c => `<th class="crit">${esc(trCrit(c.short))}</th>`).join('') + T`<th class="crit tot">المجموع</th>`).join('')}</tr>`;
    for (let i = 0; i < n; i++) {
      const s = studentSummary(data, i);
      const cells = ws.map(w => {
        if (isAbsent(data, w, i)) return T`<td class="abs" colspan="${ITEMS}">غائب</td><td class="num tot abs-t">${ABS}</td>`;
        return getItems(data, w, i).map(v => numCell(v)).join('') + numCell(s.weeks[w - 1], 'tot');
      }).join('');
      rows.push(`<tr><td class="num m">${ar(i + 1)}</td>${nameCell(names[i])}${cells}${numCell(P === 'p1' ? s.p1 : s.p2, 'strong')}</tr>`);
    }
  } else if (P === 'final') {
    head = T`<tr><th class="col-m">م</th><th class="col-name">اسم الطالب</th><th>الفترة الأولى ${of(WEEK_MAX)}</th><th>الفترة الثانية ${of(WEEK_MAX)}</th><th>التقويم البنائي ${of(FORMATIVE_MAX)}</th>${finHeads}<th>المجموع ${of(TOTAL_MAX)}</th></tr>`;
    for (let i = 0; i < n; i++) {
      const s = studentSummary(data, i);
      rows.push(`<tr><td class="num m">${ar(i + 1)}</td>${nameCell(names[i])}${numCell(s.p1)}${numCell(s.p2)}${numCell(s.formative, 'tot')}${s.fin.map(v => numCell(v)).join('')}${numCell(s.total, 'strong')}</tr>`);
    }
  } else {
    const ws = []; for (let w = 1; w <= WEEKS; w++) ws.push(w);
    head = T`<tr><th class="col-m">م</th><th class="col-name">اسم الطالب</th>${ws.map(w => weekHead(w, data, '', true)).join('')}<th>الفترة الأولى ${of(WEEK_MAX)}</th><th>الفترة الثانية ${of(WEEK_MAX)}</th><th>التقويم البنائي ${of(FORMATIVE_MAX)}</th>${finHeads}<th>المجموع ${of(TOTAL_MAX)}</th></tr>`;
    for (let i = 0; i < n; i++) {
      const s = studentSummary(data, i);
      const wk = ws.map(w => (isAbsent(data, w, i) ? `<td class="num abs-t">${ABS}</td>` : numCell(s.weeks[w - 1]))).join('');
      rows.push(`<tr><td class="num m">${ar(i + 1)}</td>${nameCell(names[i])}${wk}${numCell(s.p1, 'tot')}${numCell(s.p2, 'tot')}${numCell(s.formative, 'tot')}${s.fin.map(v => numCell(v)).join('')}${numCell(s.total, 'strong')}</tr>`);
    }
  }
  if (!rows.length) rows.push(T`<tr><td class="empty" colspan="99">لا يوجد طلاب في هذا الصف</td></tr>`);
  const note = P === 'p1' || P === 'p2' || P === 'all'
    ? T`<p class="r-legend">«${ABS}» = غائب في ذلك الأسبوع (درجاته أصفار) · «${DASH}» = لم تُرصد بعد · مجموع الأسبوع من ${ar(WEEK_MAX)}</p>` : '';
  return `<div class="report report-grades report-${P}" dir="rtl" lang="ar">
${headerBlock({ title: T`كشف درجات الصف ${classLabel}`.trim(), subtitle: sub, classLabel, settings })}
<table class="r-table"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>
${note}
${footerBlock(date)}
</div>`;
}

/** كشف الحضور والغياب: ✓ حاضر · غ غائب · فارغ لم يُرصد. نسبة الحضور = الحضور ÷ الأسابيع المرصودة. */
export function attendanceReportHTML({ classLabel = '', names = [], data, settings = {}, date } = {}) {
  const n = n0(names);
  names = cleanNames(names);
  data = data || { weeks: {}, fin: {}, t: 0 };
  const sum = attendanceSummary(data, n);
  const ws = []; for (let w = 1; w <= WEEKS; w++) ws.push(w);
  const head = T`<tr><th class="col-m">م</th><th class="col-name">اسم الطالب</th>${ws.map(w => weekHead(w, data)).join('')}<th>عدد أسابيع الغياب</th><th>نسبة الحضور</th></tr>`;
  const perWeek = ws.map(() => 0);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const cells = ws.map((w, k) => {
      const st = attendanceStatus(data, w, i);
      if (st === 'absent') { perWeek[k]++; return `<td class="att abs-t">${ABS}</td>`; }
      return st === 'present' ? `<td class="att ok">${PRESENT}</td>` : '<td class="att"></td>';
    }).join('');
    const { count, present } = sum[i];
    const rec = count + present;
    const pct = rec ? T`${ar(Math.round((present / rec) * 100))}%` : DASH;
    rows.push(`<tr><td class="num m">${ar(i + 1)}</td>${nameCell(names[i])}${cells}<td class="num tot">${ar(count)}</td><td class="num">${pct}</td></tr>`);
  }
  if (!rows.length) rows.push(T`<tr><td class="empty" colspan="99">لا يوجد طلاب في هذا الصف</td></tr>`);
  else {
    const total = perWeek.reduce((a, b) => a + b, 0);
    rows.push(T`<tr class="sum-row"><td class="num m"></td><td class="name">عدد الغائبين</td>${perWeek.map(c => `<td class="num">${ar(c)}</td>`).join('')}<td class="num tot">${ar(total)}</td><td></td></tr>`);
  }
  return T`<div class="report report-attendance" dir="rtl" lang="ar">
${headerBlock({ title: tr('كشف الحضور والغياب'), subtitle: classLabel ? T`الصف ${classLabel}` : '', classLabel, settings })}
<table class="r-table"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>
<p class="r-legend">«${PRESENT}» = حاضر · «${ABS}» = غائب · خانة فارغة = لم يُرصد الأسبوع بعد</p>
${footerBlock(date)}
</div>`;
}

/** تقرير طالب واحد: درجات الأسابيع بالبنود، الحضور، الملخص النهائي، والملاحظات المؤرخة. */
export function studentReportHTML({ classLabel = '', names = [], data, settings = {}, idx = 0, date } = {}) {
  names = cleanNames(names);
  data = data || { weeks: {}, fin: {}, t: 0 };
  const s = studentSummary(data, idx);
  const crit = CONFIG.criteria.map(c => `<th>${esc(c.label)} ${of(ITEM_MAX)}</th>`).join('');
  const wrows = [];
  let absN = 0;
  for (let w = 1; w <= WEEKS; w++) {
    const m = getWeekMeta(data, w);
    const absent = isAbsent(data, w, idx);
    if (absent) absN++;
    const items = absent
      ? T`<td class="abs" colspan="${ITEMS}">غائب</td><td class="num tot abs-t">${ABS}</td>`
      : getItems(data, w, idx).map(v => numCell(v)).join('') + numCell(s.weeks[w - 1], 'tot');
    wrows.push(`<tr><td class="num">${ar(w)}</td><td class="num">${weekDate(m.date) || DASH}</td><td class="lesson">${m.lesson ? esc(m.lesson) : DASH}</td>${items}</tr>`);
  }
  const fins = CONFIG.finals.map((f, i) => `<tr><th>${esc(f.label)}</th><td class="num">${fmt(s.fin[i])} ${of(f.max)}</td></tr>`).join('');
  const notes = getNotes(data, idx);
  const notesHtml = notes.length
    ? `<ul class="notes">${notes.map(x => `<li><span class="note-d">${dateText(new Date(x.t))}</span> ${esc(x.text)}</li>`).join('')}</ul>`
    : tr('<p class="muted">لا توجد ملاحظات.</p>');
  return T`<div class="report report-student" dir="rtl" lang="ar">
${headerBlock({ title: tr('تقرير متابعة طالب'), subtitle: T`الطالب: ${names[idx] ?? ''}`, classLabel, settings })}
<div class="st-grid">
<section class="st-weeks"><h2>درجات الأسابيع</h2>
<table class="r-table"><thead><tr><th>الأسبوع</th><th>التاريخ</th><th>الدرس</th>${crit}<th>المجموع ${of(WEEK_MAX)}</th></tr></thead><tbody>${wrows.join('')}</tbody></table></section>
<section class="st-side"><h2>الملخص</h2>
<table class="r-table kv"><tbody>
<tr><th>الفترة الأولى</th><td class="num">${fmt(s.p1)} ${of(WEEK_MAX)}</td></tr>
<tr><th>الفترة الثانية</th><td class="num">${fmt(s.p2)} ${of(WEEK_MAX)}</td></tr>
<tr><th>التقويم البنائي</th><td class="num">${fmt(s.formative)} ${of(FORMATIVE_MAX)}</td></tr>
${fins}
<tr class="strong-row"><th>المجموع</th><td class="num">${fmt(s.total)} ${of(TOTAL_MAX)}</td></tr>
<tr><th>أسابيع الغياب</th><td class="num">${ar(absN)}</td></tr>
</tbody></table>
<h2>ملاحظات المعلم</h2>${notesHtml}</section>
</div>
${footerBlock(date)}
</div>`;
}

// اسم ملف/عنوان مقترح لمهمة الطباعة (يظهر اسمًا لملف PDF)
export function reportTitle(kind, classLabel = '') {
  const t = { p1: tr('كشف_الفترة_الأولى'), p2: tr('كشف_الفترة_الثانية'), final: tr('كشف_الرصد_النهائي'), all: tr('كشف_الدرجات'), attendance: tr('كشف_الحضور_والغياب'), student: tr('تقرير_طالب') }[kind] || tr('كشف');
  const label = String(classLabel || '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '').trim().replace(/\s+/g, '_');
  return label ? `${t}_${label}` : t;
}

export const REPORT_CSS = `
#print-root { display: none; }
@page { size: A4 landscape; margin: 10mm; }
@media print {
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; }
  body > *:not(#print-root) { display: none !important; }
  #print-root { display: block !important; }
}
.report { font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif; color: #000; background: #fff; direction: rtl;
  font-size: 10pt; line-height: 1.35; width: 100%; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.report + .report { break-before: page; page-break-before: always; }
.report *, .report *::before, .report *::after { box-sizing: border-box; }
.report .r-head { display: grid; grid-template-columns: 1fr 1.4fr 1fr; align-items: center; gap: 6mm;
  border-bottom: 1.5pt solid #000; padding-bottom: 2.5mm; margin-bottom: 3mm; }
.report .r-org { font-weight: 700; font-size: 10.5pt; line-height: 1.5; text-align: start; }
.report .r-title { text-align: center; }
.report .r-title h1 { font-size: 15pt; font-weight: 800; margin: 0; }
.report .r-sub { font-size: 11pt; font-weight: 600; margin-top: 1mm; }
.report .r-info { font-size: 9.5pt; line-height: 1.6; text-align: start; justify-self: end; min-width: 55mm; }
.report .r-info .k { font-weight: 700; }
.report .blank-line { display: inline-block; width: 30mm; border-bottom: 0.6pt dotted #000; }
.report .r-table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 9pt; }
.report .r-table thead { display: table-header-group; }
.report .r-table tr { break-inside: avoid; page-break-inside: avoid; }
.report .r-table th, .report .r-table td { border: 0.6pt solid #000; padding: 0.6mm 1mm; text-align: center; vertical-align: middle; }
.report .r-table th { background: #e6e6e6; font-weight: 700; font-size: 8.5pt; line-height: 1.25; }
.report .r-table td.name { text-align: start; font-weight: 600; padding-inline-start: 2mm; line-height: 1.2; }
.report .r-table td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.report .r-table td.m { width: 7mm; }
.report .r-table td.tot { background: #f2f2f2; font-weight: 700; }
.report .r-table td.strong { font-weight: 800; background: #e6e6e6; }
.report .r-table td.abs { font-weight: 700; letter-spacing: 0.5pt; background: repeating-linear-gradient(135deg, #fff 0 2px, #ececec 2px 4px); }
.report .r-table td.abs-t { font-weight: 800; }
.report .r-table td.att { min-width: 9mm; font-size: 10pt; }
.report .r-table td.att.ok { font-family: 'Segoe UI Symbol', 'DejaVu Sans', 'Cairo', sans-serif; }
.report .r-table td.empty { padding: 6mm; color: #333; }
.report .r-table tbody tr:nth-child(even) td:not(.tot):not(.strong):not(.abs) { background: #fafafa; }
.report .r-table .sum-row td { font-weight: 800; background: #e6e6e6; border-top: 1.2pt solid #000; }
.report .col-m { width: 7mm; }
.report .col-name { min-width: 42mm; }
.report.report-all .col-name, .report.report-p1 .col-name, .report.report-p2 .col-name { min-width: 36mm; }
.report.report-all .r-table th { font-size: 8pt; }
.report th.wk .wk-n { display: block; }
.report th.wk .wk-d { display: block; font-weight: 400; font-size: 7.5pt; white-space: nowrap; }
.report th.crit { font-size: 7.5pt; font-weight: 600; padding: 0.4mm 0.3mm; }
.report th.crit.tot { background: #d6d6d6; }
.report .max { font-weight: 400; font-size: 0.85em; white-space: nowrap; }
.report.report-p1 .r-table, .report.report-p2 .r-table { font-size: 8.5pt; }
.report.report-p1 .r-table td, .report.report-p2 .r-table td { padding: 0.5mm 0.4mm; }
.report.report-p1 td.name, .report.report-p2 td.name { padding-inline-start: 1.5mm; }
.report .r-legend { font-size: 8pt; margin: 1.5mm 0 0; color: #222; }
.report .r-foot { margin-top: 6mm; break-inside: avoid; page-break-inside: avoid; }
.report .sigs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12mm; }
.report .sig { text-align: center; font-size: 10pt; }
.report .sig-k { font-weight: 700; }
.report .sig-line { border-bottom: 0.8pt solid #000; height: 10mm; margin: 0 6mm; }
.report .sig-n { font-size: 8pt; color: #333; margin-top: 0.5mm; }
.report .r-date { margin-top: 3mm; font-size: 9pt; text-align: end; }
.report h2 { font-size: 11pt; margin: 0 0 1.5mm; }
.report .st-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 6mm; align-items: start; }
.report .st-weeks td.lesson { text-align: start; max-width: 50mm; overflow-wrap: anywhere; }
.report .kv th { text-align: start; width: 45%; }
.report .kv td { text-align: start; }
.report .kv .strong-row th, .report .kv .strong-row td { font-weight: 800; background: #e6e6e6; }
.report .st-side h2 + .notes, .report .st-side .r-table + h2 { margin-top: 4mm; }
.report .notes { margin: 0; padding: 0; list-style: none; font-size: 9pt; }
.report .notes li { border-bottom: 0.5pt dotted #777; padding: 1mm 0; break-inside: avoid; overflow-wrap: anywhere; }
.report .note-d { font-weight: 700; margin-inline-end: 1.5mm; white-space: nowrap; }
.report .muted { color: #444; font-size: 9pt; }
`;
