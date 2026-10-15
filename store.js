// التخزين المحلي (IndexedDB) والنسخ الاحتياطي.
// لا يُلمس indexedDB عند الاستيراد، لذا يمكن استيراد الدوال الصافية من Node.
import CONFIG from './config.js';
import { WEEKS, ITEMS, ITEM_MAX, FIN_MAX, emptyClassData, parseScore, round2 } from './grades-core.js';

const DB_NAME = 'grades-followup';
const DB_VERSION = 1;
const STORES = ['classes', 'settings', 'grades', 'meta'];
const SCHEMA = 3;

// ---------- IndexedDB ----------

let dbPromise = null;
let memory = null;   // بديل في الذاكرة إن تعذّر IndexedDB (وضع خاص قديم مثلًا)

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no idb');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      memory = memory || Object.fromEntries(STORES.map(s => [s, new Map()]));
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      memory = memory || Object.fromEntries(STORES.map(s => [s, new Map()]));
      resolve(null);
    };
  });
  return dbPromise;
}

const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

async function get(store, key) {
  const db = await openDb();
  if (!db) return clone(memory[store].get(key));
  return reqP(db.transaction(store).objectStore(store).get(key));
}

async function put(store, key, value) {
  const db = await openDb();
  if (!db) { memory[store].set(key, clone(value)); return; }
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return txDone(tx);
}

async function del(store, key) {
  const db = await openDb();
  if (!db) { memory[store].delete(key); return; }
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return txDone(tx);
}

async function entries(store) {
  const db = await openDb();
  if (!db) return [...memory[store].entries()].map(([k, v]) => [k, clone(v)]);
  const os = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
  return keys.map((k, i) => [k, values[i]]);
}

export async function loadAll() {
  const [classes, settings, gradeEntries, metaEntries] = await Promise.all([
    get('classes', 'list'), get('settings', 'settings'), entries('grades'), entries('meta'),
  ]);
  const meta = Object.fromEntries(metaEntries);
  if (meta.schema !== SCHEMA) await setMeta('schema', SCHEMA);
  const list = Array.isArray(classes) ? classes : [];
  const grades = {};
  for (const [k, v] of gradeEntries) grades[k] = v || emptyClassData();
  for (const c of list) grades[c.id] ||= emptyClassData();
  return {
    classes: list,
    settings: { ...CONFIG.defaultSettings, ...(settings || {}) },
    grades,
    // persist = null حتى يُطلب التخزين الدائم أول مرة
    meta: { ...meta, lastBackupAt: meta.lastBackupAt ?? null, schema: SCHEMA, persist: meta.persist ?? null },
  };
}

export async function saveClasses(classes) { await put('classes', 'list', clone(classes)); }
export async function saveSettings(settings) { await put('settings', 'settings', clone(settings)); }
export async function saveGrades(classId, data) { await put('grades', classId, clone(data)); }
export async function deleteGrades(classId) { await del('grades', classId); }
export async function setMeta(key, value) { await put('meta', key, value); }
export async function getMeta(key) { return get('meta', key); }

export async function replaceAll({ classes, settings, data }) {
  const db = await openDb();
  if (!db) {
    for (const s of ['classes', 'settings', 'grades']) memory[s].clear();
  } else {
    const tx = db.transaction(['classes', 'settings', 'grades'], 'readwrite');
    for (const s of ['classes', 'settings', 'grades']) tx.objectStore(s).clear();
    await txDone(tx);
  }
  await saveClasses(classes || []);
  await saveSettings({ ...CONFIG.defaultSettings, ...(settings || {}) });
  for (const c of classes || []) await saveGrades(c.id, data?.[c.id] || emptyClassData());
}

export async function requestPersist() {
  let result = 'unsupported';
  try {
    const st = typeof navigator !== 'undefined' ? navigator.storage : null;
    if (st && st.persist) {
      result = (st.persisted && await st.persisted()) || await st.persist() ? 'granted' : 'denied';
    }
  } catch { result = 'unsupported'; }
  try { await setMeta('persist', result); } catch { /* تجاهل */ }
  return result;
}

// ---------- النسخ الاحتياطي ----------

export function buildBackup({ classes, settings, data }) {
  return { app: 'grades-followup', v: SCHEMA, at: new Date().toISOString(), classes: clone(classes || []), settings: clone(settings || {}), data: clone(data || {}) };
}

export function backupFileName(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `نسخة_الدرجات_${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.json`;
}

const ERR_READ = 'تعذّرت قراءة الملف. تأكد أنه ملف نسخة احتياطية (json) من تطبيق متابعة الدرجات.';
const ERR_APP = 'هذا الملف ليس نسخة احتياطية من تطبيق متابعة الدرجات.';
const ERR_NEWER = 'هذه النسخة الاحتياطية من إصدار أحدث من التطبيق. حدّث التطبيق ثم أعد المحاولة.';
const ERR_SHAPE = 'النسخة الاحتياطية ناقصة أو تالفة ولا يمكن استرجاعها.';

// قيمة درجة آمنة: رقم ضمن [0, max] أو null
export function sanitizeScore(v, max) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= max ? round2(v) : null;
  if (typeof v === 'string') { const r = parseScore(v, max); return r.ok ? r.value : null; }
  return null;
}

// يعيد بيانات صف نظيفة بالشكل المعتمد مهما كان شكل المصدر (v2/v3)
export function sanitizeClassData(raw) {
  const out = emptyClassData();
  if (!raw || typeof raw !== 'object') return out;
  let weeks = raw.weeks;
  if (Array.isArray(weeks)) weeks = Object.fromEntries(weeks.map((w, i) => [String(i + 1), w]));
  for (const [wk, w] of Object.entries(weeks || {})) {
    const n = Number(wk);
    if (!Number.isInteger(n) || n < 1 || n > WEEKS || !w || typeof w !== 'object') continue;
    const s = {};
    for (const [idx, arr] of Object.entries(w.s || {})) {
      if (!/^\d+$/.test(idx) || !Array.isArray(arr)) continue;
      s[idx] = Array.from({ length: ITEMS }, (_, i) => sanitizeScore(arr[i], ITEM_MAX));
    }
    out.weeks[String(n)] = { date: typeof w.date === 'string' ? w.date : '', lesson: typeof w.lesson === 'string' ? w.lesson : '', s };
  }
  for (const [idx, arr] of Object.entries(raw.fin || {})) {
    if (!/^\d+$/.test(idx) || !Array.isArray(arr)) continue;
    out.fin[idx] = FIN_MAX.map((m, i) => sanitizeScore(arr[i], m));
  }
  out.t = Number.isFinite(Number(raw.t)) ? Number(raw.t) : 0;
  return out;
}

const def = k => CONFIG.defaultSettings[k];

function sanitizeSettings(raw) {
  const s = { ...CONFIG.defaultSettings };
  if (!raw || typeof raw !== 'object') return s;
  // أسماء حقول محتملة في الإصدار الأقدم
  const alias = { teacher: ['teacher', 'teacherName'], subject: ['subject', 'subjectName'], year: ['year', 'schoolYear'] };
  for (const [k, keys] of Object.entries(alias)) {
    const v = keys.map(x => raw[x]).find(x => typeof x === 'string');
    if (v !== undefined) s[k] = v;
  }
  for (const [k, def] of Object.entries(CONFIG.defaultSettings)) {
    if (k in alias || raw[k] === undefined) continue;
    if (typeof def === 'boolean') s[k] = raw[k] === true || raw[k] === 'true';
    else if (typeof raw[k] === 'string') s[k] = raw[k];
  }
  if (!['auto', 'light', 'dark'].includes(s.theme)) s.theme = def('theme');
  if (!['normal', 'large'].includes(s.textScale)) s.textScale = def('textScale');
  if (!['chips', 'fields'].includes(s.inputMode)) s.inputMode = def('inputMode');
  return s;
}
export function parseBackup(textOrObj) {
  let obj = textOrObj;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj.replace(/^﻿/, '')); } catch { throw new Error(ERR_READ); }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(ERR_READ);
  if (obj.app !== 'grades-followup') throw new Error(ERR_APP);
  const v = Number(obj.v ?? 2);
  if (v > SCHEMA) throw new Error(ERR_NEWER);
  if (v < 2) throw new Error(ERR_APP);
  if (!Array.isArray(obj.classes) || !obj.data || typeof obj.data !== 'object') throw new Error(ERR_SHAPE);

  const used = new Set();
  const classes = obj.classes.filter(c => c && typeof c === 'object').map((c, i) => {
    let id = String(c.id ?? '').trim() || `c${i + 1}`;
    while (used.has(id)) id += '_';
    used.add(id);
    const names = (Array.isArray(c.names) ? c.names : Array.isArray(c.students) ? c.students : [])
      .map(n => (typeof n === 'string' ? n : n && typeof n.name === 'string' ? n.name : '')).map(n => n.trim());
    return { id, label: String(c.label ?? c.name ?? c.title ?? '').trim() || `صف ${i + 1}`, names, srcId: c.id };
  });
  const data = {};
  for (const c of classes) {
    data[c.id] = sanitizeClassData(obj.data[c.srcId] ?? obj.data[c.id]);
    delete c.srcId;
  }
  return { classes, settings: sanitizeSettings(obj.settings), data, at: typeof obj.at === 'string' ? obj.at : null, v };
}
