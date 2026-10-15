// نقل الطلاب بين المعلمين (ملف نقل) أو بين صفين على نفس الجهاز. منطق صافٍ بلا DOM.
import {
  WEEKS, ITEMS, ITEM_MAX, FIN_MAX, MAX_STUDENTS,
  getItems, getFin, getWeekMeta, emptyClassData, cleanName, nameKey, remapData, isAbsent, getNotes, noteShape, isStar,
} from './grades-core.js';
import { sanitizeScore, sanitizeNotes } from './store.js';

const clone = v => JSON.parse(JSON.stringify(v));

export function buildTransfer({ classLabel, names, data, idxs, settings }) {
  const list = Array.isArray(idxs) ? idxs : names.map((_, i) => i);
  const weeksMeta = {};
  for (let w = 1; w <= WEEKS; w++) {
    const m = getWeekMeta(data, w);
    if (m.date || m.lesson) weeksMeta[w] = m;
  }
  const students = list.filter(i => i >= 0 && i < names.length).map(i => {
    const weeks = {};
    for (let w = 1; w <= WEEKS; w++) {
      const items = getItems(data, w, i);
      if (items.some(v => v !== null)) weeks[w] = items;
    }
    const abs = [];
    for (let w = 1; w <= WEEKS; w++) if (isAbsent(data, w, i)) abs.push(w);
    const star = [];
    for (let w = 1; w <= WEEKS; w++) if (isStar(data, w, i)) star.push(w);
    return { name: names[i], weeks, fin: getFin(data, i), abs, star, notes: getNotes(data, i) };
  });
  return {
    app: 'grades-transfer', v: 1, at: new Date().toISOString(),
    from: { teacher: settings?.teacher || '', subject: settings?.subject || '', classLabel: classLabel || '' },
    weeksMeta, students,
  };
}

// ملف «تسليم عهدة»: الصف كاملًا (كل الطلاب + بيانات الأسابيع + الغياب + الملاحظات) لمعلم آخر.
// نفس صيغة ملف النقل (app:'grades-transfer', v:1) مع handover:true و classLabel، فيُقرأ بـ parseTransfer.
export function buildClassHandover({ classLabel, names, data, settings }) {
  const t = buildTransfer({ classLabel, names: names || [], data: data || emptyClassData(), settings });
  return { ...t, handover: true, classLabel: String(classLabel || '') };
}

export function handoverFileName(classLabel) {
  const label = String(classLabel || 'صف').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '').trim().replace(/\s+/g, '_') || 'صف';
  return `تسليم_عهدة_${label}.json`;
}

export function transferFileName(classLabel, count) {
  const label = String(classLabel || 'صف').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '').trim().replace(/\s+/g, '_') || 'صف';
  return `نقل_طلاب_${label}_${count}.json`;
}

const ERR_READ = 'تعذّرت قراءة ملف النقل. تأكد أنه ملف (json) صدّره تطبيق متابعة الدرجات.';
const ERR_BACKUP = 'هذا ملف نسخة احتياطية وليس ملف نقل طلاب. استخدم «استرجاع نسخة احتياطية» من الإعدادات.';
const ERR_APP = 'هذا الملف ليس ملف نقل طلاب من تطبيق متابعة الدرجات.';
const ERR_EMPTY = 'ملف النقل لا يحتوي على أي طالب.';

export function parseTransfer(textOrObj) {
  let obj = textOrObj;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj.replace(/^﻿/, '')); } catch { throw new Error(ERR_READ); }
  }
  if (!obj || typeof obj !== 'object') throw new Error(ERR_READ);
  if (obj.app === 'grades-followup') throw new Error(ERR_BACKUP);
  if (obj.app !== 'grades-transfer' || !Array.isArray(obj.students)) throw new Error(ERR_APP);
  if (Number(obj.v) > 1) throw new Error('ملف النقل من إصدار أحدث من التطبيق. حدّث التطبيق ثم أعد المحاولة.');

  const weeksMeta = {};
  for (const [wk, m] of Object.entries(obj.weeksMeta || {})) {
    const n = Number(wk);
    if (Number.isInteger(n) && n >= 1 && n <= WEEKS && m && typeof m === 'object') {
      weeksMeta[n] = { date: typeof m.date === 'string' ? m.date : '', lesson: typeof m.lesson === 'string' ? m.lesson : '' };
    }
  }
  const students = obj.students
    .filter(s => s && typeof s.name === 'string' && s.name.trim())
    .map(s => {
      const weeks = {};
      for (const [wk, arr] of Object.entries(s.weeks || {})) {
        const n = Number(wk);
        if (!Number.isInteger(n) || n < 1 || n > WEEKS || !Array.isArray(arr)) continue;
        weeks[n] = Array.from({ length: ITEMS }, (_, i) => sanitizeScore(arr[i], ITEM_MAX));
      }
      const fin = FIN_MAX.map((m, i) => sanitizeScore(Array.isArray(s.fin) ? s.fin[i] : null, m));
      const abs = [...new Set((Array.isArray(s.abs) ? s.abs : []).map(Number))]
        .filter(n => Number.isInteger(n) && n >= 1 && n <= WEEKS).sort((a, b) => a - b);
      const star = [...new Set((Array.isArray(s.star) ? s.star : []).map(Number))]
        .filter(n => Number.isInteger(n) && n >= 1 && n <= WEEKS).sort((a, b) => a - b);
      const notes = sanitizeNotes({ 0: s.notes })?.[0] || [];
      return { name: s.name.trim(), weeks, fin, abs, star, notes };
    });
  if (!students.length) throw new Error(ERR_EMPTY);
  const f = obj.from || {};
  const out = {
    app: 'grades-transfer', v: 1, at: typeof obj.at === 'string' ? obj.at : null,
    from: { teacher: String(f.teacher || ''), subject: String(f.subject || ''), classLabel: String(f.classLabel || '') },
    weeksMeta, students,
  };
  if (obj.handover === true) {
    out.handover = true;
    out.classLabel = String(obj.classLabel || f.classLabel || '');
  }
  return out;
}

// يضيف الطلاب المختارين إلى صف ويعيد أيضًا مواضعهم في المصدر (للاستخدام الداخلي في moveStudents)
function appendStudents({ names, data }, transfer, pickIdxs, max) {
  const outNames = [...(names || [])];
  const outData = clone(data || emptyClassData());
  outData.weeks ||= {};
  outData.fin ||= {};
  const seen = new Set(outNames.map(nameKey));
  const picks = Array.isArray(pickIdxs) ? pickIdxs : transfer.students.map((_, i) => i);
  const taken = [];
  let dup = 0, overLimit = 0;

  for (const p of picks) {
    const st = transfer.students[p];
    if (!st) continue;
    const name = cleanName(st.name) || st.name.trim();
    const key = nameKey(name);
    if (seen.has(key)) { dup++; continue; }
    if (outNames.length >= max) { overLimit++; continue; }
    seen.add(key);
    const idx = outNames.length;
    outNames.push(name);
    for (const [wk, items] of Object.entries(st.weeks || {})) {
      if (!items.some(v => v !== null)) continue;
      const w = (outData.weeks[wk] ||= { date: '', lesson: '', s: {} });
      w.s ||= {};
      w.s[idx] = items.slice(0, ITEMS);
    }
    if (st.fin && st.fin.some(v => v !== null)) outData.fin[idx] = st.fin.slice(0, FIN_MAX.length);
    for (const wk of st.abs || []) {
      const w = (outData.weeks[wk] ||= { date: '', lesson: '', s: {} });
      w.s ||= {};
      (w.abs ||= {})[idx] = true;
      w.s[idx] = Array(ITEMS).fill(0); // الغائب درجاته أصفار
    }
    for (const wk of st.star || []) {
      const w = (outData.weeks[wk] ||= { date: '', lesson: '', s: {} });
      (w.star ||= {})[idx] = true;
    }
    if (Array.isArray(st.notes) && st.notes.length) {
      outData.notes ||= {};
      outData.notes[idx] = st.notes.map(noteShape);
    }
    taken.push(p);
  }

  if (taken.length) {
    // تعبئة تاريخ/درس الأسابيع الفارغة فقط
    for (const [wk, m] of Object.entries(transfer.weeksMeta || {})) {
      const w = (outData.weeks[wk] ||= { date: '', lesson: '', s: {} });
      if (!w.date && m.date) w.date = m.date;
      if (!w.lesson && m.lesson) w.lesson = m.lesson;
    }
    outData.t = Date.now();
  }
  return { names: outNames, data: outData, added: taken.length, dup, overLimit, taken };
}

export function applyTransfer({ names, data }, transfer, pickIdxs, max = MAX_STUDENTS) {
  const { taken, ...rest } = appendStudents({ names, data }, transfer, pickIdxs, max);
  return rest;
}

export function moveStudents({ src, dst, idxs }) {
  const t = buildTransfer({ classLabel: '', names: src.names, data: src.data, idxs });
  // نحتفظ بمواضع المصدر الأصلية لكل طالب في ملف النقل
  const srcIdxs = (Array.isArray(idxs) ? idxs : src.names.map((_, i) => i)).filter(i => i >= 0 && i < src.names.length);
  const r = appendStudents(dst, t, undefined, MAX_STUDENTS);
  const movedSrc = new Set(r.taken.map(p => srcIdxs[p]));
  const from = src.names.map((_, i) => i).filter(i => !movedSrc.has(i));
  const srcNames = from.map(i => src.names[i]);
  const srcData = movedSrc.size ? remapData(src.data || emptyClassData(), from) : clone(src.data || emptyClassData());
  return {
    src: { names: srcNames, data: srcData },
    dst: { names: r.names, data: r.data },
    moved: r.added, dup: r.dup, overLimit: r.overLimit,
  };
}
