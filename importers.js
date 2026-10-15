// استيراد قوائم الأسماء من ملفات Excel (xlsx) و CSV و TXT و PDF.
// يعمل في المتصفح: JSZip سكربت كلاسيكي (window.JSZip) و pdf.js وحدة ES تُحمَّل عند الحاجة.
import { nameLikeness, isHeaderWord } from './grades-core.js';

const ERR_XLS = 'ملفات xls القديمة غير مدعومة. افتح الملف في Excel واحفظه بصيغة xlsx ثم أعد المحاولة.';
const ERR_SCANNED = 'ملف PDF هذا صورة ممسوحة ولا يحوي نصًا يمكن قراءته. اطلب نسخة PDF مُصدَّرة من البرنامج أو ملف Excel.';
const ERR_PDF = 'تعذّرت قراءة ملف PDF. جرّب ملف Excel أو انسخ الأسماء نصًا.';
const ERR_PDF_PASS = 'ملف PDF محمي بكلمة مرور. احفظ نسخة بدون حماية ثم أعد المحاولة.';
const ERR_XLSX = 'تعذّرت قراءة ملف Excel. تأكد أنه ملف xlsx سليم.';
const ERR_EMPTY = 'لم يُعثر على أسماء في الملف.';
const ERR_IMAGE = 'لم نتمكن من قراءة أسماء من هذه الصورة. صوّر القائمة بإضاءة جيدة ومن الأعلى مباشرة، أو استخدم ملف Excel.';
const ERR_OCR = 'تعذّر تشغيل قارئ النصوص من الصور على هذا الجهاز. جرّب ملف Excel أو انسخ الأسماء نصًا.';

// ---------- نقطة الدخول ----------

// opts.onProgress({stage:'ocr', page, pages, ratio}) يُستدعى أثناء التعرف الضوئي فقط (ratio إجمالي 0..1)
export async function readNamesFromFile(file, opts = {}) {
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;
  const ocrOpts = { ...OCR_DEFAULTS, ...(opts?.ocr || {}) };
  const name = String(file?.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));
  const isZip = head[0] === 0x50 && head[1] === 0x4B;
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
  const isOle = head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0;  // xls قديم
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;

  let kind, rows, sheets = null;
  if (name.endsWith('.xls') || isOle) throw new Error(ERR_XLS);
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || (isZip && !name.endsWith('.pdf'))) {
    kind = 'xlsx';
    sheets = await sheetsFromXlsx(buf);
    rows = sheets.flatMap(s => s.rows);
  } else if (name.endsWith('.pdf') || isPdf) {
    ({ kind, rows } = await readPdf(buf, onProgress, ocrOpts));
  } else if (isPng || isJpg || /\.(png|jpe?g)$/.test(name)) {
    kind = 'image-ocr';
    let bmp;
    try { bmp = await createImageBitmap(new Blob([buf], { type: isPng ? 'image/png' : 'image/jpeg' })); } catch { throw new Error(ERR_IMAGE); }
    rows = await ocrSources([{ draw: () => bitmapToCanvas(bmp, ocrOpts.maxDim) }], onProgress, ocrOpts);
    bmp.close?.();
  } else {
    const text = decodeText(buf);
    if (name.endsWith('.csv') || name.endsWith('.tsv')) {
      kind = 'csv';
      rows = rowsFromCsv(text);
    } else {
      kind = 'txt';
      const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
      // نص منسوخ من جدول (مفصول بعلامات Tab) يُعامل كأعمدة
      const tabbed = lines.filter(l => l.includes('\t')).length;
      rows = tabbed > lines.filter(l => l.trim()).length / 2 ? lines.map(l => l.split('\t')) : lines.map(l => [l]);
    }
  }

  const ocr = kind === 'pdf-ocr' || kind === 'image-ocr';
  const picker = ocr ? pickOcrNames : pickNameColumn;
  // ترويسة/تذييل يتكرر في كل صفحة (اسم المدرسة، المعلم…) ليس طالبًا
  const repeated = (kind === 'pdf' || kind === 'pdf-ocr') ? repeatedKeys(rows) : new Set();
  const keep = (rs) => rs.filter(r => !repeated.has(rowKey(r)));

  // تقسيم إلى شعب: لكل ورقة Excel، ثم حسب عناوين «الصف … / رقم» داخل الورقة أو ملف PDF
  const parts = [];
  for (const src of sheets || [{ name: '', rows }]) {
    const secs = splitSections(src.rows);
    for (const sec of secs) parts.push({ label: sec.label || (secs.length === 1 ? src.name : ''), rows: sec.rows });
  }
  const groups = [];
  for (const part of parts) {
    const pk = picker(keep(part.rows));
    if (!pk.names.length) continue;
    const label = part.label || '';
    const same = groups.find(g => g.label && g.label === label);
    if (same) same.names.push(...pk.names); else groups.push({ label, names: pk.names, header: pk.header });
  }
  // ورقة ملاحظات أو قسم فيه اسم أو اسمان بجانب شعب حقيقية = ليس شعبة
  if (groups.some(g => g.names.length >= 5)) for (let i = groups.length - 1; i >= 0; i--) if (groups[i].names.length < 3) groups.splice(i, 1);
  const names = groups.flatMap(g => g.names);
  if (!names.length) throw new Error(kind === 'pdf-ocr' ? ERR_SCANNED : kind === 'image-ocr' ? ERR_IMAGE : ERR_EMPTY);
  const out = { names, kind };
  const header = groups.find(g => g.header)?.header;
  if (header) out.column = header;
  if (groups.length === 1 && groups[0].label) out.label = groups[0].label;
  // أكثر من شعبة: نعيدها منفصلة ليختار المعلم (الأقسام بلا اسم تأخذ رقمًا)
  if (groups.length > 1) out.groups = groups.map((g, i) => ({ label: g.label || ('شعبة ' + (i + 1)), names: g.names }));
  if (ocr) out.ocr = true;
  return out;
}

// يفك ترميز النص: UTF-8 أولًا ثم Windows-1256 (ملفات Excel العربية القديمة)
function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('windows-1256').decode(bytes); } catch { return utf8; }
}

// ---------- CSV ----------

export function rowsFromCsv(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const delim = detectDelimiter(src);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { q = true; cell = ''; }
    else if (delim && ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(c => c !== ''));
}

function detectDelimiter(text) {
  const sample = text.split(/\r\n|\r|\n/).filter(l => l.trim()).slice(0, 20);
  let best = null, bestCount = 0;
  for (const d of ['\t', ';', ',']) {
    let count = 0;
    for (const l of sample) {
      let inQ = false;
      for (const ch of l) { if (ch === '"') inQ = !inQ; else if (ch === d && !inQ) count++; }
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

// ---------- XLSX ----------

function xmlDoc(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}
const byTag = (node, tag) => Array.from(node.getElementsByTagNameNS('*', tag));

// يجمع نص عنصر <si> أو <is> بما فيه أجزاء النص المنسق <r><t> مع تجاهل النطق <rPh>
function richText(node) {
  let s = '';
  for (const t of byTag(node, 't')) {
    let p = t.parentNode, skip = false;
    while (p && p !== node) { if (p.localName === 'rPh') { skip = true; break; } p = p.parentNode; }
    if (!skip) s += t.textContent;
  }
  return s;
}

function colIndex(ref) {
  const m = /^([A-Z]+)/i.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// كل أوراق المصنف بالترتيب: [{name, rows}]
export async function sheetsFromXlsx(arrayBuffer) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error(ERR_XLSX);
  let zip;
  try { zip = await JSZip.loadAsync(arrayBuffer); } catch { throw new Error(ERR_XLSX); }
  const read = async p => { const f = zip.file(p); return f ? f.async('string') : null; };
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const list = [];
  if (wb && rels) {
    const relEls = byTag(xmlDoc(rels), 'Relationship');
    for (const sh of byTag(xmlDoc(wb), 'sheet')) {
      const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const rel = relEls.find(x => x.getAttribute('Id') === rid);
      if (!rel) continue;
      const target = rel.getAttribute('Target');
      const p = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      if (zip.file(p)) list.push({ name: sh.getAttribute('name') || '', path: p });
    }
  }
  if (!list.length) for (const p of Object.keys(zip.files).filter(p => /^xl\/worksheets\/[^/]+\.xml$/.test(p)).sort()) list.push({ name: '', path: p });
  if (!list.length) throw new Error(ERR_XLSX);
  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const si of byTag(xmlDoc(ss), 'si')) shared.push(richText(si));
  const out = [];
  for (const sh of list) out.push({ name: sh.name, rows: parseSheetRows(xmlDoc(await read(sh.path)), shared) });
  return out;
}

function parseSheetRows(sheet, shared) {
  const rows = [];
  byTag(sheet, 'row').forEach((rowEl, ri) => {
    const r = Number(rowEl.getAttribute('r')) - 1;
    const rowIdx = Number.isInteger(r) && r >= 0 ? r : ri;
    const cells = [];
    let next = 0;
    for (const c of byTag(rowEl, 'c')) {
      let ci = colIndex(c.getAttribute('r'));
      if (ci < 0) ci = next;
      next = ci + 1;
      const t = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') { const is = byTag(c, 'is')[0]; val = is ? richText(is) : ''; }
      else val = v;
      cells[ci] = String(val).trim();
    }
    rows[rowIdx] = Array.from(cells, x => x ?? '');
  });
  return Array.from(rows, r => r || []).filter(r => r.some(c => c !== ''));
}

// ---------- تقسيم الملف إلى شعب ----------
// يستخرج اسم الشعبة من عنوان مثل «كشف أسماء طلبة الصف العاشر / ٣ — العام الدراسي…» أو «الفصل: ١٠-٢».
// لا يُعد عنوانًا إلا إذا احتوى رقمًا (حتى لا يُخلط بـ «الفصل الدراسي الأول»).
export function classLabelFrom(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /(?:^|\s)(?:الصف|الفصل|الشعبة|شعبة|فصل)\s*[:：]?\s*((?:[^\s\d٠-٩—–(،:\/\\-]+\s*){0,3}[\/\\\-–]?\s*[\d٠-٩]+(?:\s*[\/\\\-–]\s*[\d٠-٩]+)?)/.exec(t);
  if (!m) return null;
  const label = m[1].replace(/\s*([\/\\\-–])\s*/g, ' $1 ').replace(/\s+/g, ' ').replace(/^[\/\\\-–]\s*/, '').trim();
  if (/^(الدراسي|الأول|الثاني)/.test(label)) return null;
  return /[\d٠-٩]/.test(label) ? label : null;
}

// يقسم الصفوف عند كل عنوان شعبة؛ يدمج الأقسام ذات الاسم نفسه (صفحة «تابع»).
export function splitSections(rows) {
  const secs = [];
  let cur = null;
  for (const row of rows || []) {
    const line = (Array.isArray(row) ? row : [row]).join(' ');
    const label = line.length < 160 ? classLabelFrom(line) : null;
    if (label) {
      const key = label.replace(/\s/g, '');
      cur = secs.find(x => x.key === key);
      if (!cur) { cur = { key, label, rows: [] }; secs.push(cur); }
      continue;
    }
    if (!cur) { cur = { key: '', label: '', rows: [] }; secs.push(cur); }
    cur.rows.push(row);
  }
  return secs.map(({ label, rows }) => ({ label, rows }));
}

export async function rowsFromXlsx(arrayBuffer) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error(ERR_XLSX);
  let zip;
  try { zip = await JSZip.loadAsync(arrayBuffer); } catch { throw new Error(ERR_XLSX); }
  const read = async p => { const f = zip.file(p); return f ? f.async('string') : null; };

  // أول ورقة في ترتيب المصنف
  let sheetPath = null;
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = byTag(xmlDoc(wb), 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rel = byTag(xmlDoc(rels), 'Relationship').find(r => r.getAttribute('Id') === rid);
    if (rel) {
      const target = rel.getAttribute('Target');
      sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    }
  }
  if (!sheetPath || !zip.file(sheetPath)) {
    sheetPath = Object.keys(zip.files).filter(p => /^xl\/worksheets\/[^/]+\.xml$/.test(p)).sort()[0];
  }
  if (!sheetPath) throw new Error(ERR_XLSX);

  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const si of byTag(xmlDoc(ss), 'si')) shared.push(richText(si));

  const sheet = xmlDoc(await read(sheetPath));
  const rows = [];
  byTag(sheet, 'row').forEach((rowEl, ri) => {
    const r = Number(rowEl.getAttribute('r')) - 1;
    const rowIdx = Number.isInteger(r) && r >= 0 ? r : ri;
    const cells = [];
    let next = 0;
    for (const c of byTag(rowEl, 'c')) {
      let ci = colIndex(c.getAttribute('r'));
      if (ci < 0) ci = next;
      next = ci + 1;
      const t = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let val;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') { const is = byTag(c, 'is')[0]; val = is ? richText(is) : ''; }
      else val = v;
      cells[ci] = String(val).trim();
    }
    rows[rowIdx] = Array.from(cells, x => x ?? '');
  });
  return Array.from(rows, r => r || []).filter(r => r.some(c => c !== ''));
}

// ---------- PDF ----------

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL('./vendor/pdfjs/pdf.min.mjs', import.meta.url).href).then(m => {
      m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return pdfjsPromise;
}

async function openPdf(arrayBuffer) {
  const pdfjs = await loadPdfjs();
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)), isEvalSupported: false, disableFontFace: true }).promise;
  } catch (e) {
    throw new Error(e && e.name === 'PasswordException' ? ERR_PDF_PASS : ERR_PDF);
  }
}

async function pdfTextRows(doc) {
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tc.items.filter(it => typeof it.str === 'string'));
    }
  } catch { throw new Error(ERR_PDF); }
  return rowsFromPdfItems(pages);
}

export async function linesFromPdf(arrayBuffer) {
  const doc = await openPdf(arrayBuffer);
  let rows;
  try { rows = await pdfTextRows(doc); } finally { doc.destroy?.(); }
  if (!rows.length) throw new Error(ERR_SCANNED);
  return rows;
}

// PDF نصي → 'pdf'. بلا نص (ممسوح) أو نص لا يحوي أسماء (ترويسة الماسح مثلًا) → تعرّف ضوئي 'pdf-ocr'.
async function readPdf(buf, onProgress, ocrOpts) {
  const doc = await openPdf(buf);
  try {
    const rows = await pdfTextRows(doc);
    if (rows.length && pickNameColumn(rows).names.length) return { kind: 'pdf', rows };
    const sources = [];
    for (let p = 1; p <= doc.numPages && p <= ocrOpts.maxPages; p++) {
      sources.push({ draw: () => renderPdfPage(doc, p, ocrOpts) });
    }
    const ocrRows = await ocrSources(sources, onProgress, ocrOpts);
    if (!ocrRows.length && rows.length) return { kind: 'pdf', rows };
    return { kind: 'pdf-ocr', rows: ocrRows };
  } finally { doc.destroy?.(); }
}

async function renderPdfPage(doc, p, o) {
  let page;
  try { page = await doc.getPage(p); } catch { throw new Error(ERR_PDF); }
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.max(1, Math.min(o.pdfScale, o.maxDim / Math.max(vp1.width, vp1.height)));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup?.();
  return canvas;
}

const AR_LETTER = /[ء-يٱ-ۓﭐ-﷿ﹰ-ﻼ]/;
const DIGIT_RUN = /[0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?/g;

// يحوّل عناصر النص (من getTextContent لكل صفحة) إلى صفوف خلايا بترتيب من اليمين لليسار.
// مُصدَّرة لتسهيل الاختبار، ليست جزءًا أساسيًا من العقد.
export function rowsFromPdfItems(pages) {
  const all = pages.flat().filter(it => it.str && it.str.trim());
  if (!all.length) return [];
  const reversed = looksReversed(all.map(it => it.str));
  const fix = s => (reversed && AR_LETTER.test(s) ? reverseVisual(s) : s).normalize('NFKC');

  const rows = [];
  for (const items of pages) {
    const list = items.filter(it => it.str && it.str.trim()).map(it => {
      const h = Math.abs(it.height || it.transform[3] || it.transform[0] || 10);
      return { str: it.str, x: it.transform[4], y: it.transform[5], w: Math.abs(it.width || 0), h };
    });
    list.sort((a, b) => b.y - a.y);
    // تجميع العناصر في أسطر حسب الموضع الرأسي
    const lines = [];
    for (const it of list) {
      const line = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, Math.min(l.h, it.h) * 0.5));
      if (line) line.items.push(it); else lines.push({ y: it.y, h: it.h, items: [it] });
    }
    for (const line of lines) {
      line.items.sort((a, b) => (b.x + b.w) - (a.x + a.w));
      const cells = [];
      let cur = null, prev = null;
      for (const it of line.items) {
        const gap = prev ? prev.x - (it.x + it.w) : 0;
        const h = Math.max(prev?.h || 0, it.h);
        if (!cur || gap > h * 0.9) { cur = { parts: [fix(it.str)] }; cells.push(cur); }
        else {
          const sep = gap > h * 0.12 || /\s$/.test(prev.str) || /^\s/.test(it.str) ? ' ' : '';
          cur.parts.push(sep, fix(it.str));
        }
        prev = it;
      }
      const row = [];
      for (const c of cells) row.push(...splitCell(unifyLetters(c.parts.join(''))));
      if (row.length) rows.push(row);
    }
  }
  return rows;
}

// خطوط كثيرة تربط أشكال الحروف بنظائرها الفارسية (ی ھ ک)؛ نعيدها إلى العربية
function unifyLetters(s) {
  return s
    .replace(/ی(?=[ء-يٱ-ۓ])/g, 'ي')
    .replace(/ی/g, 'ى')
    .replace(/ھ/g, 'ه')
    .replace(/ک/g, 'ك');
}

// خلية قد تحوي عدة أعمدة في نص واحد: نفصل بالمسافات المتعددة وبالأرقام
function splitCell(text) {
  const out = [];
  for (const piece of text.replace(/[‎‏‪-‮⁦-⁩]/g, '').split(/\s{2,}/)) {
    let last = 0;
    for (const m of piece.matchAll(DIGIT_RUN)) {
      out.push(piece.slice(last, m.index), m[0]);
      last = m.index + m[0].length;
    }
    out.push(piece.slice(last));
  }
  return out.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// يعكس نصًا مخزنًا بالترتيب البصري مع إبقاء الأرقام واللاتيني في اتجاهها
function reverseVisual(s) {
  return Array.from(s).reverse().join('').replace(/[0-9A-Za-z٠-٩۰-۹.,٫]+/g, m => Array.from(m).reverse().join(''));
}

// هل النص العربي مقلوب الحروف؟ نقارن مؤشرات بداية/نهاية الكلمة في النص كما هو ومقلوبًا.
function arabicScore(text) {
  let score = 0;
  for (const w of text.normalize('NFKC').split(/[^ء-يٱ-ۓ]+/)) {
    if (w.length < 2) continue;
    if (/^ال/.test(w)) score += 2;
    if (/^(عبد|محمد|احمد|أحمد|ابو|أبو|بن|بنت)/.test(w)) score += 2;
    if (/[ةى]$/.test(w)) score += 2;
    if (/^[ةى]/.test(w)) score -= 3;          // التاء المربوطة والألف المقصورة لا تأتي أول الكلمة
    if (/لا$/.test(w)) score -= 1;            // «ال» مقلوبة في آخر الكلمة
    if (/(دبع|دمحم|دمحا|دمحأ)$/.test(w)) score -= 2;
  }
  return score;
}

function looksReversed(strs) {
  const arabic = strs.filter(s => AR_LETTER.test(s));
  if (!arabic.length) return false;
  const asIs = arabicScore(arabic.join(' '));
  const flipped = arabicScore(arabic.map(reverseVisual).join(' '));
  return flipped > asIs + 2;
}

// ---------- اختيار عمود الأسماء ----------

const LEAD_NUM = /^[\s([]*[0-9٠-٩۰-۹]+[\s).:\-ـ/\]]*/;

// صف يتكرر نصه ٣ مرات أو أكثر في ملف PDF = ترويسة أو تذييل صفحة، لا اسم طالب
function rowKey(r) { return (Array.isArray(r) ? r : [r]).map((c) => String(c ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' '); }
function repeatedKeys(rows) {
  const counts = new Map();
  for (const r of rows || []) { const k = rowKey(r); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  return new Set([...counts].filter(([, n]) => n >= 3).map(([k]) => k));
}

export function dropRepeatedLines(rows) {
  const key = (r) => (Array.isArray(r) ? r : [r]).map((c) => String(c ?? '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ');
  const counts = new Map();
  for (const r of rows || []) { const k = key(r); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
  return (rows || []).filter((r) => (counts.get(key(r)) || 0) < 3);
}

export function pickNameColumn(rows) {
  const clean = (rows || []).map(r => (Array.isArray(r) ? r : [r]).map(c => String(c ?? '').trim()));
  const width = Math.max(0, ...clean.map(r => r.length));
  // نتجاهل ترقيم السطر في أوله (مثل «١- » أو «(٣)») عند التقييم
  const score = v => (v ? nameLikeness(v.replace(LEAD_NUM, '')) : 0);
  let best = { index: -1, score: 0, names: [] };

  for (let c = 0; c < width; c++) {
    const vals = clean.map(r => r[c] || '');
    const scores = vals.map(score);
    const good = scores.filter(s => s >= 0.5).length;
    if (!good) continue;
    const nonEmpty = vals.filter(Boolean).length || 1;
    const avg = scores.reduce((a, b) => a + b, 0) / nonEmpty;
    const total = good * (0.5 + avg / 2);
    if (total > best.score) best = { index: c, score: total, names: vals.filter((v, i) => scores[i] >= 0.5) };
  }

  // صفوف غير منتظمة (PDF مثلًا): أفضل خلية في كل صف
  const perRow = [];
  for (const r of clean) {
    let top = '', topScore = 0;
    for (const v of r) { const s = score(v); if (s > topScore) { top = v; topScore = s; } }
    if (topScore >= 0.5) perRow.push(top);
  }
  if (perRow.length > best.names.length * 1.15 + 1) return { index: -1, names: perRow };
  if (best.index < 0) return { index: -1, names: [] };

  // عنوان العمود: أول خلية غير فارغة قبل أول اسم إن كانت كلمة عنوان
  let header;
  for (const r of clean) {
    const v = r[best.index] || '';
    if (!v) continue;
    if (isHeaderWord(v) || score(v) < 0.5) { if (isHeaderWord(v)) header = v; continue; }
    break;
  }
  const out = { index: best.index, names: best.names };
  if (header) out.header = header;
  return out;
}

// ---------- التعرف الضوئي على الحروف (OCR) — يعمل دون اتصال ----------
// tesseract.js مضمَّن في vendor/tesseract: tesseract.min.js و worker.min.js والنواة (wasm مدمج داخل js)
// وبيانات العربية ara.traineddata.gz. لا يُطلب أي ملف من خارج الموقع.

const OCR_DEFAULTS = {
  psm: '4',            // المرحلة الأولى: عمود واحد بأسطر متفاوتة — أفضل في تحديد مواضع الأعمدة
  psm2: '6',           // المرحلة الثانية: عمود الأسماء وحده ككتلة نص واحدة
  twoPass: true,
  targetH: 40,         // ارتفاع الكلمة المستهدف (بكسل) عند إعادة قراءة عمود الأسماء
  pdfScale: 300 / 72,  // ≈ 300 نقطة في البوصة
  maxDim: 3000,        // أقصى بُعد للصورة المرسلة للتعرف (ذاكرة الهاتف والسرعة)
  prep: 'gray',        // 'none' | 'gray' (رمادي + شدّ التباين) | 'bin' (أبيض/أسود بعتبة Otsu)
  lang: 'lang',        // مجلد البيانات داخل vendor/tesseract
  lines: true,         // مسح خطوط الجدول قبل التعرف
  gap: 1.2,            // فجوة أفقية (× ارتفاع الكلمة) تفصل خلايا الجدول
  maxPages: 20,
};

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(new URL('./vendor/tesseract/tesseract.min.js', import.meta.url).href)
      .then(() => {
        if (!globalThis.Tesseract?.createWorker) throw new Error('Tesseract');
        return globalThis.Tesseract;
      })
      .catch(e => { tesseractPromise = null; throw e; });
  }
  return tesseractPromise;
}

// دعم SIMD في WebAssembly (نفس فحص wasm-feature-detect)؛ بدونه نستعمل النواة العادية
function wasmSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
}

async function createOcrWorker(o, logger) {
  const T = await loadTesseract();
  const base = new URL('./vendor/tesseract/', import.meta.url);
  const core = wasmSimd() ? 'core/tesseract-core-simd-lstm.wasm.js' : 'core/tesseract-core-lstm.wasm.js';
  const worker = await T.createWorker('ara', 1 /* OEM.LSTM_ONLY */, {
    workerPath: new URL('worker.min.js', base).href,
    corePath: new URL(core, base).href,
    langPath: new URL(o.lang, base).href.replace(/\/$/, ''),
    workerBlobURL: false,   // سياسة CSP: العامل من نفس الأصل
    gzip: true,
    cacheMethod: 'none',    // الملفات مخزنة أصلًا في ذاكرة Service Worker؛ لا نكررها في IndexedDB
    logger,
  });
  await worker.setParameters({
    tessedit_pageseg_mode: String(o.psm),
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });
  return worker;
}

// sources: [{draw: async () => HTMLCanvasElement}] — صفحة واحدة لكل عنصر، تُرسم عند الحاجة فقط.
// لكل صفحة مرحلتان: (١) قراءة الصفحة كاملة لمعرفة بنية الجدول وموضع عمود الأسماء،
// (٢) إعادة قراءة عمود الأسماء وحده مقصوصًا ومُحجَّمًا: حجم خط موحّد يرفع الدقة كثيرًا
// (الأرقام الكبيرة بجانب أسماء صغيرة تربك تقدير ارتفاع السطر في المحرك).
async function ocrSources(sources, onProgress, o) {
  const pages = sources.length;
  if (!pages) return [];
  let cur = 1, base = 0, span = 1;
  const report = r => {
    if (!onProgress) return;
    const ratio = (cur - 1 + base + span * r) / pages;
    try { onProgress({ stage: 'ocr', page: cur, pages, ratio: Math.min(1, Math.max(0, ratio)) }); } catch { /* تجاهل أخطاء الواجهة */ }
  };
  report(0);
  let worker;
  try {
    worker = await createOcrWorker(o, m => { if (m?.status === 'recognizing text') report(Number(m.progress) || 0); });
  } catch { throw new Error(ERR_OCR); }
  const recognize = async (canvas, psm) => {
    try {
      await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
      const res = await worker.recognize(canvas, {}, { text: false, tsv: true });
      return wordsFromTsv(res?.data?.tsv);
    } catch { throw new Error(ERR_OCR); }
  };
  const rows = [];
  try {
    for (let i = 0; i < pages; i++) {
      cur = i + 1; base = 0; span = o.twoPass ? 0.6 : 1;
      report(0);
      const canvas = await sources[i].draw();
      preprocessCanvas(canvas, o.prep, o.lines);
      const grid = ocrCells(await recognize(canvas, o.psm), o.gap);
      let pageRows = grid.map(cellsToRow).filter(r => r.length);
      const region = o.twoPass ? nameRegion(grid, canvas.width, canvas.height) : null;
      if (region) {
        base = 0.6; span = 0.4;
        const crop = cropCanvas(canvas, region, o.targetH);
        const rows2 = ocrCells(await recognize(crop, o.psm2), o.gap).map(cellsToRow).filter(r => r.length);
        crop.width = crop.height = 0;
        const n1 = pickNameColumn(pageRows).names.length;
        const n2 = pickNameColumn(rows2).names.length;
        if (n2 >= n1 * 0.8) pageRows = rows2;
      }
      canvas.width = canvas.height = 0; // تحرير الذاكرة مبكرًا
      rows.push(...dropAboveHeader(pageRows));
      base = 0; span = 1;
      report(1);
    }
  } finally {
    try { await worker.terminate(); } catch { /* */ }
  }
  return rows;
}

// عنوان الصفحة وترويسة الجدول ليسا أسماء: نحذف ما قبل صف العناوين (اسم الطالب، م، …) إن وُجد في أعلى الصفحة
function dropAboveHeader(rows) {
  const i = rows.findIndex(r => r.some(c => isHeaderWord(c)));
  return i >= 0 && i < rows.length / 2 ? rows.slice(i + 1) : rows;
}

// مستطيل عمود الأسماء من نتيجة المرحلة الأولى، أو null إن لم يتضح
function nameRegion(grid, w, h) {
  const boxes = [];
  for (const r of grid) for (const c of r.cells) if (nameLikeness(c.text) >= 0.5) boxes.push(c);
  if (boxes.length < 3) return null;
  // نبقي الخلايا التي تتداخل أفقيًا مع الخلية «الوسيطة» (عمود واحد)
  const cx = median(boxes.map(b => (b.x0 + b.x1) / 2));
  const col = boxes.filter(b => b.x0 - (b.x1 - b.x0) * 0.25 <= cx && b.x1 + (b.x1 - b.x0) * 0.25 >= cx);
  if (col.length < 3) return null;
  const lh = median(col.map(b => b.y1 - b.y0)) || 20;
  const rowH = median(col.slice(1).map((b, i) => b.y0 - col[i].y0).filter(d => d > 0)) || lh * 2;
  const x0 = Math.max(0, Math.min(...col.map(b => b.x0)) - lh);
  const x1 = Math.min(w, Math.max(...col.map(b => b.x1)) + lh);
  // رأسيًا: من أول اسم إلى آخر صف في الجدول (قد تفوت المرحلة الأولى بعض الأسماء لكن تلتقط أرقام صفوفها)
  const below = grid.filter(r => r.y0 >= col[0].y0).map(r => r.y1);
  const y0 = Math.max(0, col[0].y0 - rowH * 1.2);
  const y1 = Math.min(h, Math.max(...col.map(b => b.y1), ...below) + rowH * 1.2);
  if (x1 - x0 < lh * 2 || y1 - y0 < lh * 2) return null;
  return { x0, y0, x1, y1, lh };
}

function cropCanvas(src, r, targetH) {
  const scale = Math.max(0.5, Math.min(3, targetH / r.lh));
  const c = document.createElement('canvas');
  const pad = Math.round(r.lh * scale);
  c.width = Math.round((r.x1 - r.x0) * scale) + pad * 2;
  c.height = Math.round((r.y1 - r.y0) * scale) + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, pad, pad, c.width - pad * 2, c.height - pad * 2);
  return c;
}

function bitmapToCanvas(bmp, maxDim) {
  const big = Math.max(bmp.width, bmp.height) || 1;
  // صور الهاتف الكبيرة تُصغَّر؛ الصور الصغيرة جدًا تُكبَّر قليلًا ليقرأها المحرك
  const scale = big > maxDim ? maxDim / big : big < 1600 ? Math.min(2.5, 1600 / big) : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// رمادي + شدّ التباين (يُضعف العلامات المائية الفاتحة)، أو عتبة Otsu
function preprocessCanvas(canvas, mode, lines) {
  if (!mode || mode === 'none') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const n = d.length / 4;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    gray[j] = g; hist[g]++;
  }
  let map;
  if (mode === 'bin') {
    const t = otsu(hist, n);
    map = new Uint8ClampedArray(256).map((_, v) => (v > t ? 255 : 0));
  } else {
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
    acc = 0;
    for (; hi > 0 && (acc += hist[hi]) < n * 0.02; hi--);
    if (hi - lo < 32) { lo = 0; hi = 255; }
    map = new Uint8ClampedArray(256).map((_, v) => ((v - lo) * 255) / (hi - lo));
  }
  for (let j = 0; j < n; j++) gray[j] = map[gray[j]];
  if (lines) eraseTableLines(gray, canvas.width, canvas.height, otsu(hist, n));
  for (let i = 0, j = 0; j < n; i += 4, j++) { const v = gray[j]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

// يمسح خطوط الجدول الطويلة (أفقية ورأسية) التي يقرؤها المحرك حروفًا («ا» و«ـ») فتفسد الأسماء.
// خط الجدول مسار داكن متصل أطول بكثير من أي كلمة؛ نسمح بانحراف ±٢ بكسل لتحمّل ميل المسح.
function eraseTableLines(gray, w, h, t) {
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < dark.length; i++) dark[i] = gray[i] <= t ? 1 : 0;
  const erase = new Uint8Array(w * h);
  const R = 2;
  const minH = Math.max(60, Math.round(w * 0.15));
  const minV = Math.max(60, Math.round(h * 0.04));
  // أفقي: صف «موسَّع» رأسيًا بمقدار R
  for (let y = 0; y < h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      let on = 0;
      if (x < w) for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R) && !on; k++) on = dark[k * w + x];
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        if (x - start >= minH) for (let i = start; i < x; i++) erase[y * w + i] = 1;
        start = -1;
      }
    }
  }
  // رأسي: عمود موسَّع أفقيًا بمقدار R
  for (let x = 0; x < w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      let on = 0;
      if (y < h) for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R) && !on; k++) on = dark[y * w + k];
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        if (y - start >= minV) for (let i = start; i < y; i++) erase[i * w + x] = 1;
        start = -1;
      }
    }
  }
  for (let i = 0; i < erase.length; i++) if (erase[i] && dark[i]) gray[i] = 255;
}

function otsu(hist, n) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// مخرجات TSV من Tesseract → كلمات بإحداثياتها (المستوى 5 = كلمة)
function wordsFromTsv(tsv) {
  const out = [];
  for (const line of String(tsv || '').split('\n')) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join(' ').trim();
    if (!text) continue;
    const x0 = +c[6], y0 = +c[7], w = +c[8], h = +c[9];
    out.push({ text, x0, y0, x1: x0 + w, y1: y0 + h, conf: +c[10], line: `${c[1]}.${c[2]}.${c[3]}.${c[4]}` });
  }
  return out;
}

const OCR_KEEP = /[^ء-يٱ-ۓ0-9٠-٩۰-۹A-Za-z./-]/g;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// كلمات OCR ({text, x0, y0, x1, y1, line?}) → صفوف خلايا بترتيب من اليمين لليسار.
// تُدمج الأسطر المتقابلة رأسيًا (أعمدة قرأها المحرك كتلًا منفصلة) ثم تُقسم بالفجوات الأفقية الكبيرة.
// مُصدَّرة للاختبار.
export function rowsFromOcrWords(words, opts = {}) {
  return ocrCells(words, opts.gap ?? OCR_DEFAULTS.gap).map(cellsToRow).filter(r => r.length);
}

const cellsToRow = r => r.cells.flatMap(c => splitCell(c.text));

function ocrCells(words, gapK) {
  const ws = [];
  for (const w of words || []) {
    const text = unifyLetters(String(w.text ?? '').normalize('NFKC')).replace(/[ـً-ٰٟ]/g, '').replace(OCR_KEEP, '');
    if (!text || !(w.y1 > w.y0)) continue;
    ws.push({ ...w, text });
  }
  if (!ws.length) return [];
  // وحدات = أسطر المحرك
  const units = new Map();
  ws.forEach((w, i) => {
    const k = w.line ?? `w${i}`;
    if (!units.has(k)) units.set(k, []);
    units.get(k).push(w);
  });
  const list = [...units.values()].map(u => ({ words: u, y0: median(u.map(w => w.y0)), y1: median(u.map(w => w.y1)) }));
  list.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
  const rows = [];
  for (const u of list) {
    const h = u.y1 - u.y0;
    const row = rows.slice(-4).find(r => Math.min(r.y1, u.y1) - Math.max(r.y0, u.y0) >= 0.5 * Math.min(h, r.y1 - r.y0));
    if (row) row.words.push(...u.words); else rows.push({ y0: u.y0, y1: u.y1, words: [...u.words] });
  }
  for (const r of rows) {
    const items = r.words.sort((a, b) => b.x1 - a.x1);
    const h = median(items.map(w => w.y1 - w.y0)) || 1;
    r.cells = [];
    let cur = null, prev = null;
    for (const w of items) {
      if (!cur || prev.x0 - w.x1 > h * gapK) { cur = { words: [], x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 }; r.cells.push(cur); }
      cur.words.push(w.text);
      cur.x0 = Math.min(cur.x0, w.x0); cur.x1 = Math.max(cur.x1, w.x1);
      cur.y0 = Math.min(cur.y0, w.y0); cur.y1 = Math.max(cur.y1, w.y1);
      prev = w;
    }
    for (const c of r.cells) c.text = c.words.join(' ');
  }
  return rows;
}

// اختيار عمود الأسماء ثم تنظيف ضجيج التعرف: كلمات من حرف واحد ورموز وأرقام ملتصقة
function pickOcrNames(rows) {
  const pick = pickNameColumn(rows);
  const names = [];
  for (const n of pick.names) {
    const words = n.replace(LEAD_NUM, '').split(/\s+/)
      .map(w => w.replace(/[^ء-يٱ-ۓ]/g, ''))
      .filter(w => w.length >= 2);
    if (words.length >= 2 && words.length <= 7) names.push(words.join(' '));
  }
  // الأسماء في الكشوف ثلاثية/رباعية غالبًا: إن كانت الأغلبية الواضحة كذلك فالأسطر الثنائية ضجيج (عناوين أعمدة مثلًا)
  const long = names.filter(n => n.split(' ').length >= 3).length;
  const kept = long >= names.length * 0.8 ? names.filter(n => n.split(' ').length >= 3) : names;
  const out = { index: pick.index, names: kept };
  if (pick.header) out.header = pick.header;
  return out;
}
