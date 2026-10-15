// تصدير كشف المتابعة إلى ملف Excel (xlsx) داخل المتصفح بالكامل، بدون خادم.
// يُكتب الملف يدويًا (SpreadsheetML) ويُضغط بـ JSZip (window.JSZip المضمّن في vendor).
// يعمل أيضًا في Node للاختبار إذا ضُبط globalThis.JSZip.
//
// الأوراق:
//  1) «المتابعة»     : إدخال/عرض الدرجات للأسابيع ١–١٠ × ٤ بنود (قيم).
//  2) «طباعة ١–٥»    : جاهزة للطباعة، معادلات تشير إلى «المتابعة» + مجموع كل أسبوع + الفترة الأولى.
//  3) «طباعة ٦–١٠»   : نفسها للأسابيع ٦–١٠ + الفترة الثانية.
//  4) «رصد النهائي»  : الفترتان + التقويم البنائي + المشروعان + الاختبار العملي + المجموع.
//  5) «الحضور والغياب»: لكل أسبوع ✓ حاضر / «غ» غائب / فارغ (لم يُرصد) + عدد أسابيع الغياب.
// كل معادلة تحمل قيمة محسوبة مسبقًا (<v>) لتظهر الأرقام في المعاينات التي لا تعيد الحساب.
//
// تخطيط الصفوف (كل الأوراق): ١ العنوان · ٢–٣ بيانات الصف والمعلم · ٤–٧ ترويسة الجدول · ٨ فما بعد الطلاب.

import CONFIG from './config.js';
import {
  getItems, getFin, getWeekMeta, weekTotal, periodScore, formative, finalTotal, toArabicDigits, attendanceStatus,
} from './grades-core.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const FIRST_ROW = 8;                 // أول صف للطلاب
const HEAD_ROWS = 7;                        // الصفوف المكررة عند الطباعة
const WEEKS = CONFIG.weeks;
const HALF = Math.ceil(WEEKS / 2);
const NCRIT = CONFIG.criteria.length;
const WEEK_MAX = NCRIT * CONFIG.itemMax;   // ٢٠
const PERIOD_MAX = WEEK_MAX;               // الفترة تُحسب من ٢٠
const ROWS = CONFIG.maxStudents;
const LAST_ROW = FIRST_ROW + ROWS - 1;

export const SHEET_NAMES = [
  'المتابعة',
  `طباعة ${toArabicDigits(1)}–${toArabicDigits(HALF)}`,
  `طباعة ${toArabicDigits(HALF + 1)}–${toArabicDigits(WEEKS)}`,
  'رصد النهائي',
  'الحضور والغياب',
];
export const MARK_PRESENT = '✓';
export const MARK_ABSENT = 'غ';

// أنماط الخلايا (فهارس cellXfs في styles.xml)
const S = { title: 1, head: 2, headRot: 3, num: 4, name: 5, total: 6, headSmall: 7, infoLabel: 8, infoValue: 9, note: 10 };

// ───────────── أدوات ─────────────
export function colName(n) { // 1 → A
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
const ref = (c, r) => colName(c) + r;
const qs = (name) => `'${name.replace(/'/g, "''")}'`; // اسم ورقة داخل معادلة

function clean(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
}
function esc(s) {
  return clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numStr = (v) => String(v);

// ───────────── ورقة ─────────────
class Sheet {
  constructor(name, ncols) {
    this.name = name; this.ncols = ncols;
    this.rows = new Map(); this.merges = []; this.cols = []; this.heights = {}; this.hidden = new Set();
    this.freeze = null; this.printCols = false;
  }
  _put(c, r, cell) {
    if (!this.rows.has(r)) this.rows.set(r, new Map());
    this.rows.get(r).set(c, cell);
  }
  str(c, r, text, s) { this._put(c, r, { s, t: 'str', v: clean(text) }); }
  num(c, r, v, s) { this._put(c, r, isNum(v) ? { s, t: 'num', v } : { s, t: 'blank' }); }
  blank(c, r, s) { this._put(c, r, { s, t: 'blank' }); }
  formula(c, r, f, cached, s) { this._put(c, r, { s, t: 'f', f, v: cached }); }
  // دمج نطاق مع تنسيق كل خلاياه (حتى تظهر الحدود كاملة)
  merge(c1, r1, c2, r2, s) {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const row = this.rows.get(r);
      if (!(row && row.has(c))) this.blank(c, r, s);
    }
    if (c1 !== c2 || r1 !== r2) this.merges.push(`${ref(c1, r1)}:${ref(c2, r2)}`);
  }
  xml() {
    const lastRow = Math.max(...this.rows.keys());
    const out = [];
    out.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${NS_R}">`);
    out.push('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    out.push(`<dimension ref="A1:${ref(this.ncols, lastRow)}"/>`);
    out.push('<sheetViews><sheetView rightToLeft="1" workbookViewId="0" zoomScale="100">');
    if (this.freeze) {
      const [xs, ys] = this.freeze;
      out.push(`<pane xSplit="${xs}" ySplit="${ys}" topLeftCell="${ref(xs + 1, ys + 1)}" activePane="bottomRight" state="frozen"/>`);
      out.push(`<selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="${ref(xs + 1, ys + 1)}" sqref="${ref(xs + 1, ys + 1)}"/>`);
    }
    out.push('</sheetView></sheetViews>');
    out.push('<sheetFormatPr defaultRowHeight="18" customHeight="1"/>');
    if (this.cols.length) {
      out.push('<cols>');
      for (const [min, max, w] of this.cols) out.push(`<col min="${min}" max="${max}" width="${w}" customWidth="1"/>`);
      out.push('</cols>');
    }
    out.push('<sheetData>');
    for (const r of [...this.rows.keys()].sort((a, b) => a - b)) {
      const cells = this.rows.get(r);
      let attrs = ` r="${r}"`;
      if (this.heights[r]) attrs += ` ht="${this.heights[r]}" customHeight="1"`;
      if (this.hidden.has(r)) attrs += ' hidden="1"';
      out.push(`<row${attrs}>`);
      for (const c of [...cells.keys()].sort((a, b) => a - b)) {
        const cell = cells.get(c); const a = `r="${ref(c, r)}"${cell.s ? ` s="${cell.s}"` : ''}`;
        if (cell.t === 'blank') out.push(`<c ${a}/>`);
        else if (cell.t === 'num') out.push(`<c ${a}><v>${numStr(cell.v)}</v></c>`);
        else if (cell.t === 'str') {
          const sp = /^\s|\s$/.test(cell.v) ? ' xml:space="preserve"' : '';
          out.push(`<c ${a} t="inlineStr"><is><t${sp}>${esc(cell.v)}</t></is></c>`);
        } else if (isNum(cell.v)) out.push(`<c ${a}><f>${esc(cell.f)}</f><v>${numStr(cell.v)}</v></c>`);
        else out.push(`<c ${a} t="str"><f>${esc(cell.f)}</f><v>${esc(cell.v ?? '')}</v></c>`);
      }
      out.push('</row>');
    }
    out.push('</sheetData>');
    if (this.merges.length) {
      out.push(`<mergeCells count="${this.merges.length}">`);
      for (const m of this.merges) out.push(`<mergeCell ref="${m}"/>`);
      out.push('</mergeCells>');
    }
    out.push('<printOptions horizontalCentered="1"/>');
    out.push('<pageMargins left="0.25" right="0.25" top="0.4" bottom="0.45" header="0.2" footer="0.2"/>');
    out.push('<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
    out.push('<headerFooter><oddFooter>&amp;Cصفحة &amp;P من &amp;N</oddFooter></headerFooter>');
    out.push('</worksheet>');
    return out.join('');
  }
}

// ترويسة مشتركة: العنوان + بيانات الصف والمعلم في الصفين ٢–٣.
// ترجع مواقع خلايا القيم ليُشار إليها من الأوراق الأخرى.
function infoLayout(ncols) {
  const rest = ncols - 2;
  const v1 = Math.ceil(rest * 0.4), l2 = Math.ceil(rest * 0.2);
  return { lab1: [2, 2], val1: [3, 2 + v1], lab2: [3 + v1, 2 + v1 + l2], val2: [3 + v1 + l2, ncols] };
}
const INFO_LABELS = [['الصف', 'المجال الدراسي'], ['المعلم', 'العام الدراسي']];

function writeHeader(sh, title, values, srcRefs /* null | [[ref,ref],[ref,ref]] in المتابعة */) {
  sh.str(1, 1, title, S.title); sh.merge(1, 1, sh.ncols, 1, S.title);
  sh.heights[1] = 30;
  const L = infoLayout(sh.ncols);
  for (let i = 0; i < 2; i++) {
    const r = 2 + i;
    sh.str(L.lab1[0], r, INFO_LABELS[i][0], S.infoLabel); sh.merge(L.lab1[0], r, L.lab1[1], r, S.infoLabel);
    sh.str(L.lab2[0], r, INFO_LABELS[i][1], S.infoLabel); sh.merge(L.lab2[0], r, L.lab2[1], r, S.infoLabel);
    [[L.val1, values[i][0]], [L.val2, values[i][1]]].forEach(([span, v], j) => {
      if (srcRefs) {
        const src = `${qs(SHEET_NAMES[0])}!${srcRefs[i][j]}`;
        sh.formula(span[0], r, `IF(${src}="","",${src})`, v, S.infoValue);
      } else if (v) sh.str(span[0], r, v, S.infoValue);
      sh.merge(span[0], r, span[1], r, S.infoValue);
    });
    sh.heights[r] = 22;
    sh.blank(1, r, 0);
  }
  return L;
}

function studentCols(sh, names, n) {
  // م + اسم الطالب للصفوف ٨…
  for (let i = 0; i < ROWS; i++) {
    const r = FIRST_ROW + i;
    sh.num(1, r, i + 1, S.num);
    sh.heights[r] = 20;
    if (i >= n) sh.hidden.add(r);
  }
}

function signatures(sh) {
  const r = LAST_ROW + 2;
  sh.str(2, r, 'توقيع المعلم: ....................', S.note);
  const c = Math.max(4, Math.floor(sh.ncols / 2));
  sh.str(c, r, 'توقيع رئيس القسم: ....................', S.note);
  sh.heights[r] = 26;
}

// ───────────── بناء الأوراق ─────────────
function buildMain({ classLabel, names, data, info, n }) {
  const ncols = 2 + WEEKS * NCRIT;
  const sh = new Sheet(SHEET_NAMES[0], ncols);
  const L = writeHeader(sh, 'كشف المتابعة الأسبوعية للطلاب', info, null);
  sh.str(1, 4, 'م', S.head); sh.merge(1, 4, 1, 7, S.head);
  sh.str(2, 4, 'الأسبوع', S.head); sh.str(2, 5, 'التاريخ', S.headSmall);
  sh.str(2, 6, 'عنوان الدرس', S.headSmall); sh.str(2, 7, 'اسم الطالب', S.head);
  for (let w = 1; w <= WEEKS; w++) {
    const c0 = 3 + (w - 1) * NCRIT, c1 = c0 + NCRIT - 1;
    const meta = getWeekMeta(data, w);
    sh.str(c0, 4, `الأسبوع ${toArabicDigits(w)}`, S.head); sh.merge(c0, 4, c1, 4, S.head);
    if (meta.date) sh.str(c0, 5, meta.date, S.headSmall); sh.merge(c0, 5, c1, 5, S.headSmall);
    if (meta.lesson) sh.str(c0, 6, meta.lesson, S.headSmall); sh.merge(c0, 6, c1, 6, S.headSmall);
    CONFIG.criteria.forEach((cr, k) => sh.str(c0 + k, 7, cr.label, S.headRot));
  }
  studentCols(sh, names, n);
  for (let i = 0; i < ROWS; i++) {
    const r = FIRST_ROW + i;
    if (i < n) sh.str(2, r, names[i] ?? '', S.name); else sh.blank(2, r, S.name);
    for (let w = 1; w <= WEEKS; w++) {
      const vals = i < n ? getItems(data, w, i) : [];
      for (let k = 0; k < NCRIT; k++) sh.num(3 + (w - 1) * NCRIT + k, r, vals[k] ?? null, S.num);
    }
  }
  sh.heights[4] = 20; sh.heights[5] = 18; sh.heights[6] = 34; sh.heights[7] = 62;
  sh.cols = [[1, 1, 4.5], [2, 2, 30], [3, ncols, 5.2]];
  sh.freeze = [2, HEAD_ROWS];
  sh.printCols = true;
  return { sh, infoRefs: [[ref(L.val1[0], 2), ref(L.val2[0], 2)], [ref(L.val1[0], 3), ref(L.val2[0], 3)]] };
}

// خريطة أعمدة ورقة الطباعة لفترة: لكل أسبوع ٤ بنود + المجموع، ثم الفترة
function printLayout(period) {
  const w0 = period === 1 ? 1 : HALF + 1, w1 = period === 1 ? HALF : WEEKS;
  const weeks = [];
  let c = 3;
  for (let w = w0; w <= w1; w++) { weeks.push({ w, c0: c, totalCol: c + NCRIT }); c += NCRIT + 1; }
  return { weeks, periodCol: c, ncols: c };
}
export const PERIOD_COLS = { 1: colName(printLayout(1).periodCol), 2: colName(printLayout(2).periodCol) };

function buildPrint({ period, names, data, info, infoRefs, n }) {
  const lay = printLayout(period);
  const sh = new Sheet(SHEET_NAMES[period], lay.ncols);
  const main = qs(SHEET_NAMES[0]);
  const a = toArabicDigits(lay.weeks[0].w), b = toArabicDigits(lay.weeks[lay.weeks.length - 1].w);
  const pLabel = period === 1 ? 'الفترة الأولى' : 'الفترة الثانية';
  writeHeader(sh, `كشف المتابعة الأسبوعية — ${pLabel} (الأسابيع ${a}–${b})`, info, infoRefs);
  sh.str(1, 4, 'م', S.head); sh.merge(1, 4, 1, 7, S.head);
  sh.str(2, 4, 'الأسبوع', S.head); sh.str(2, 5, 'التاريخ', S.headSmall);
  sh.str(2, 6, 'عنوان الدرس', S.headSmall); sh.str(2, 7, 'اسم الطالب', S.head);
  for (const { w, c0, totalCol } of lay.weeks) {
    const meta = getWeekMeta(data, w);
    const mc = 3 + (w - 1) * NCRIT; // عمود الأسبوع في «المتابعة»
    sh.str(c0, 4, `الأسبوع ${toArabicDigits(w)}`, S.head); sh.merge(c0, 4, totalCol, 4, S.head);
    for (const [r, v] of [[5, meta.date], [6, meta.lesson]]) {
      const src = `${main}!${ref(mc, r)}`;
      sh.formula(c0, r, `IF(${src}="","",${src})`, clean(v || ''), S.headSmall);
      sh.merge(c0, r, totalCol, r, S.headSmall);
    }
    CONFIG.criteria.forEach((cr, k) => sh.str(c0 + k, 7, cr.label, S.headRot));
    sh.str(totalCol, 7, `المجموع (من ${toArabicDigits(WEEK_MAX)})`, S.headRot);
  }
  sh.str(lay.periodCol, 4, `${pLabel} (من ${toArabicDigits(PERIOD_MAX)})`, S.head);
  sh.merge(lay.periodCol, 4, lay.periodCol, 7, S.head);
  studentCols(sh, names, n);
  for (let i = 0; i < ROWS; i++) {
    const r = FIRST_ROW + i;
    const nameSrc = `${main}!B${r}`;
    sh.formula(2, r, `IF(${nameSrc}="","",${nameSrc})`, i < n ? clean(names[i] ?? '') : '', S.name);
    const ranges = [];
    for (const { w, c0, totalCol } of lay.weeks) {
      const vals = i < n ? getItems(data, w, i) : [];
      const mc = 3 + (w - 1) * NCRIT;
      for (let k = 0; k < NCRIT; k++) {
        const src = `${main}!${ref(mc + k, r)}`;
        const v = vals[k];
        sh.formula(c0 + k, r, `IF(${src}="","",${src})`, isNum(v) ? v : '', S.num);
      }
      const rg = `${ref(c0, r)}:${ref(c0 + NCRIT - 1, r)}`;
      ranges.push(rg);
      const t = i < n ? weekTotal(data, w, i) : null;
      sh.formula(totalCol, r, `IF(COUNT(${rg})=${NCRIT},SUM(${rg}),"")`, isNum(t) ? t : '', S.total);
    }
    const all = ranges.join(',');
    const p = i < n ? periodScore(data, i, period) : null;
    sh.formula(lay.periodCol, r, `IF(COUNT(${all})=${NCRIT * lay.weeks.length},SUM(${all})/${lay.weeks.length},"")`,
      isNum(p) ? p : '', S.total);
  }
  signatures(sh);
  sh.heights[4] = 20; sh.heights[5] = 18; sh.heights[6] = 34; sh.heights[7] = 70;
  const cols = [[1, 1, 4.5], [2, 2, 28]];
  for (const { c0, totalCol } of lay.weeks) { cols.push([c0, c0 + NCRIT - 1, 4.6]); cols.push([totalCol, totalCol, 6]); }
  cols.push([lay.periodCol, lay.periodCol, 9]);
  sh.cols = cols;
  sh.freeze = [2, HEAD_ROWS];
  return sh;
}

function buildFinal({ names, data, info, infoRefs, n }) {
  const nF = CONFIG.finals.length;
  const ncols = 2 + 3 + nF + 1; // م، الاسم، ف١، ف٢، البنائي، المشاريع…، المجموع
  const sh = new Sheet(SHEET_NAMES[3], ncols);
  writeHeader(sh, 'رصد الدرجات النهائية', info, infoRefs);
  const formMax = PERIOD_MAX * 2;
  const total = formMax + CONFIG.finals.reduce((s, f) => s + f.max, 0);
  const heads = [
    'م', 'اسم الطالب',
    `الفترة الأولى (من ${toArabicDigits(PERIOD_MAX)})`, `الفترة الثانية (من ${toArabicDigits(PERIOD_MAX)})`,
    `التقويم البنائي (من ${toArabicDigits(formMax)})`,
    ...CONFIG.finals.map((f) => `${f.label} (من ${toArabicDigits(f.max)})`),
    `المجموع (من ${toArabicDigits(total)})`,
  ];
  heads.forEach((h, k) => { sh.str(k + 1, 4, h, S.head); sh.merge(k + 1, 4, k + 1, 7, S.head); });
  studentCols(sh, names, n);
  const p1s = qs(SHEET_NAMES[1]), p2s = qs(SHEET_NAMES[2]);
  const totCol = ncols;
  for (let i = 0; i < ROWS; i++) {
    const r = FIRST_ROW + i;
    const nameSrc = `${qs(SHEET_NAMES[0])}!B${r}`;
    sh.formula(2, r, `IF(${nameSrc}="","",${nameSrc})`, i < n ? clean(names[i] ?? '') : '', S.name);
    const p1 = i < n ? periodScore(data, i, 1) : null, p2 = i < n ? periodScore(data, i, 2) : null;
    const s1 = `${p1s}!${PERIOD_COLS[1]}${r}`, s2 = `${p2s}!${PERIOD_COLS[2]}${r}`;
    sh.formula(3, r, `IF(ISNUMBER(${s1}),${s1},"")`, isNum(p1) ? p1 : '', S.num);
    sh.formula(4, r, `IF(ISNUMBER(${s2}),${s2},"")`, isNum(p2) ? p2 : '', S.num);
    const fm = i < n ? formative(data, i) : null;
    sh.formula(5, r, `IF(AND(ISNUMBER(C${r}),ISNUMBER(D${r})),C${r}+D${r},"")`, isNum(fm) ? fm : '', S.total);
    const fin = i < n ? getFin(data, i) : [];
    for (let k = 0; k < nF; k++) sh.num(6 + k, r, fin[k] ?? null, S.num);
    const parts = [];
    for (let c = 5; c < totCol; c++) parts.push(`${colName(c)}${r}`);
    const ft = i < n ? finalTotal(data, i) : null;
    sh.formula(totCol, r, `IF(AND(${parts.map((p) => `ISNUMBER(${p})`).join(',')}),${parts.join('+')},"")`,
      isNum(ft) ? ft : '', S.total);
  }
  signatures(sh);
  sh.heights[4] = 20; sh.heights[5] = 20; sh.heights[6] = 20; sh.heights[7] = 20;
  sh.cols = [[1, 1, 4.5], [2, 2, 32], [3, ncols, 12]];
  sh.freeze = [2, HEAD_ROWS];
  return sh;
}

function buildAttendance({ names, data, info, infoRefs, n }) {
  const ncols = 2 + WEEKS + 1; // م، الاسم، الأسابيع، عدد الغياب
  const sh = new Sheet(SHEET_NAMES[4], ncols);
  writeHeader(sh, 'كشف الحضور والغياب', info, infoRefs);
  const main = qs(SHEET_NAMES[0]);
  sh.str(1, 4, 'م', S.head); sh.merge(1, 4, 1, 7, S.head);
  sh.str(2, 4, 'اسم الطالب', S.head); sh.merge(2, 4, 2, 7, S.head);
  for (let w = 1; w <= WEEKS; w++) {
    const c = 2 + w;
    sh.str(c, 4, `الأسبوع ${toArabicDigits(w)}`, S.head); sh.merge(c, 4, c, 5, S.head);
    const src = `${main}!${ref(3 + (w - 1) * NCRIT, 5)}`;
    sh.formula(c, 6, `IF(${src}="","",${src})`, clean(getWeekMeta(data, w).date || ''), S.headSmall);
    sh.merge(c, 6, c, 7, S.headSmall);
  }
  const cc = ncols;
  sh.str(cc, 4, 'عدد أسابيع الغياب', S.head); sh.merge(cc, 4, cc, 7, S.head);
  studentCols(sh, names, n);
  const rg = (r) => `${ref(3, r)}:${ref(2 + WEEKS, r)}`;
  for (let i = 0; i < ROWS; i++) {
    const r = FIRST_ROW + i;
    const nameSrc = `${main}!B${r}`;
    sh.formula(2, r, `IF(${nameSrc}="","",${nameSrc})`, i < n ? clean(names[i] ?? '') : '', S.name);
    let count = 0;
    for (let w = 1; w <= WEEKS; w++) {
      const st = i < n ? attendanceStatus(data, w, i) : null;
      if (st === 'absent') { count++; sh.str(2 + w, r, MARK_ABSENT, S.num); }
      else if (st === 'present') sh.str(2 + w, r, MARK_PRESENT, S.num);
      else sh.blank(2 + w, r, S.num);
    }
    sh.formula(cc, r, `IF(B${r}="","",COUNTIF(${rg(r)},"${MARK_ABSENT}"))`, i < n ? count : '', S.total);
  }
  signatures(sh);
  sh.heights[4] = 20; sh.heights[5] = 20; sh.heights[6] = 20; sh.heights[7] = 20;
  sh.cols = [[1, 1, 4.5], [2, 2, 32], [3, 2 + WEEKS, 9], [cc, cc, 12]];
  sh.freeze = [2, HEAD_ROWS];
  return sh;
}

// ───────────── أجزاء الحزمة ─────────────
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function stylesXml() {
  const font = (sz, bold) => `<font>${bold ? '<b/>' : ''}<sz val="${sz}"/><color theme="1"/><name val="Arial"/><family val="2"/></font>`;
  const fill = (rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const thin = '<left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/>';
  const xf = (fontId, fillId, borderId, align) =>
    `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment ${align}/></xf>`;
  const C = 'horizontal="center" vertical="center"';
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    xf(1, 0, 0, `${C} readingOrder="2"`),                                  // 1 title
    xf(2, 2, 1, `${C} wrapText="1" readingOrder="2"`),                     // 2 head
    xf(2, 2, 1, `${C} textRotation="90" wrapText="1" readingOrder="2"`),   // 3 head rotated
    xf(3, 0, 1, C),                                                        // 4 number
    xf(3, 0, 1, 'horizontal="right" vertical="center" indent="1" readingOrder="2"'), // 5 name
    xf(2, 3, 1, C),                                                        // 6 total
    xf(4, 2, 1, `${C} wrapText="1" readingOrder="2"`),                     // 7 head small
    xf(2, 4, 1, `${C} readingOrder="2"`),                                  // 8 info label
    xf(5, 0, 1, `${C} readingOrder="2"`),                                  // 9 info value
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf>', // 10 note
  ];
  return XML_HEAD + `<styleSheet xmlns="${NS}">`
    + `<fonts count="6">${font(11)}${font(14, 1)}${font(10, 1)}${font(10)}${font(9)}${font(11, 1)}</fonts>`
    + `<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill('DDEBF7')}${fill('FFF2CC')}${fill('F2F2F2')}</fills>`
    + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${thin}</border></borders>`
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
    + '</styleSheet>';
}

function workbookXml(sheets) {
  const names = sheets.map((sh, i) => {
    const q = qs(sh.name);
    const rows = `${q}!$1:$${HEAD_ROWS}`;
    const v = sh.printCols ? `${q}!$A:$B,${rows}` : rows;
    return `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${esc(v)}</definedName>`;
  }).join('');
  return XML_HEAD + `<workbook xmlns="${NS}" xmlns:r="${NS_R}">`
    + '<workbookPr defaultThemeVersion="164011"/>'
    + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="0"/></bookViews>'
    + '<sheets>' + sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>'
    + `<definedNames>${names}</definedNames>`
    + '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
    + '</workbook>';
}

function contentTypes(n) {
  let s = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
  for (let i = 1; i <= n; i++) s += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  s += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>';
  return s;
}

const ROOT_RELS = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>';

function workbookRels(n) {
  let s = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  for (let i = 1; i <= n; i++) s += `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  s += `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return s + '</Relationships>';
}

function appXml(sheets) {
  return XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + `<Application>${esc(CONFIG.appName)}</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>`
    + `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>`
    + `<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((s) => `<vt:lpstr>${esc(s.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts>`
    + `<AppVersion>16.0300</AppVersion></Properties>`;
}

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${esc(title)}</dc:title><dc:creator>${esc(CONFIG.appName)}</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>';
}

// ───────────── الواجهة العامة ─────────────
export function buildParts({ classLabel = '', names = [], data, settings = {} } = {}) {
  data = data || { weeks: {}, fin: {}, t: 0 };
  names = Array.isArray(names) ? names : [];
  const n = Math.min(names.length, ROWS);
  const teacher = clean(settings.teacher || '').trim();
  const info = [
    [clean(classLabel), clean(settings.subject || '')],
    [teacher ? `أ. ${teacher}` : '', clean(settings.year || '')],
  ];
  const { sh: main, infoRefs } = buildMain({ classLabel, names, data, info, n });
  const ctx = { names, data, info, infoRefs, n };
  const sheets = [main, buildPrint({ ...ctx, period: 1 }), buildPrint({ ...ctx, period: 2 }), buildFinal(ctx), buildAttendance(ctx)];
  const parts = {
    '[Content_Types].xml': contentTypes(sheets.length),
    '_rels/.rels': ROOT_RELS,
    'docProps/app.xml': appXml(sheets),
    'docProps/core.xml': coreXml(`كشف متابعة ${clean(classLabel)}`.trim()),
    'xl/workbook.xml': workbookXml(sheets),
    'xl/_rels/workbook.xml.rels': workbookRels(sheets.length),
    'xl/styles.xml': stylesXml(),
  };
  sheets.forEach((sh, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = sh.xml(); });
  return parts;
}

export async function buildWorkbook(opts) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('تعذّر تجهيز ملف Excel: مكتبة الضغط غير محمّلة.');
  const parts = buildParts(opts);
  const zip = new JSZip();
  // [Content_Types].xml أولًا كما يفعل Excel
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: MIME });
  return new Blob([bytes], { type: MIME });
}

export function exportFileName(classLabel) {
  const label = String(classLabel ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  return label ? `كشف_متابعة_${label}.xlsx` : 'كشف_متابعة.xlsx';
}
