// أدوات الواجهة المشتركة: الأيقونات، الهروب من HTML، رسائل toast، النوافذ السفلية، التأكيد، لوحة الأرقام.
import CONFIG from './config.js';
import { toArabicDigits, parseScore } from './grades-core.js';
import { T, tr } from './i18n.js';

export const ar = (x) => toArabicDigits(x);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// عدد + تمييز عربي مبسّط: ١ طالب، ٢ طالبان، ٣–١٠ طلاب، ١١+ طالبًا
export function students(n) {
  if (n === 0) return tr('لا يوجد طلاب');
  if (n === 1) return tr('طالب واحد');
  if (n === 2) return tr('طالبان');
  if (n % 100 >= 3 && n % 100 <= 10) return T`${ar(n)} طلاب`;
  return T`${ar(n)} طالبًا`;
}
export function cells(n) {
  if (n === 1) return tr('خانة واحدة');
  if (n === 2) return tr('خانتان');
  if (n % 100 >= 3 && n % 100 <= 10) return T`${ar(n)} خانات`;
  return T`${ar(n)} خانة`;
}
export function names(n) {
  if (n === 1) return tr('اسم واحد');
  if (n === 2) return tr('اسمان');
  if (n % 100 >= 3 && n % 100 <= 10) return T`${ar(n)} أسماء`;
  return T`${ar(n)} اسمًا`;
}

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  back: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  fwd: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M15 6l-6 6 6 6"/>',
  prev: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  sheet: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13l4 5M12 13l-4 5"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12.5l3 3 5-6"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  cloud: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  cloudOff: '<path d="M7 18a5 5 0 0 1-.6-9.96A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/><path d="M3 3l18 18"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  eyeOff: '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  sort: '<path d="M3 6h13M3 12h9M3 18h5M17 8V20M14 17l3 3 3-3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  wifi: '<path d="M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01"/>',
  shareIos: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
  plusSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8M8 12h8"/>',
  more: '<circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
  code: '<path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitFull: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  unlink: '<path d="M9 15l-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4 0"/><path d="M15 9l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 0"/><path d="M4 4l16 16"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  star: '<path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z"/>',
  note: '<path d="M15.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M15 3v5h5M8 13h8M8 17h5"/>',
};

const DIR_ICONS = new Set(['back', 'fwd', 'next', 'prev', 'send', 'undo']);
export function icon(name, cls = '') {
  if (DIR_ICONS.has(name)) cls += ' dir';
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

// ===== Toast =====
export function toast(msg, opts = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (opts.err ? ' err' : '');
  el.innerHTML = `<span>${esc(tr(msg))}</span>`;
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action.label;
    b.addEventListener('click', () => { close(); opts.action.fn(); });
    el.appendChild(b);
  }
  // نفس الرسالة الظاهرة لا تتكرر
  for (const old of host.children) if (old.firstChild && old.firstChild.textContent === String(msg)) old.remove();
  // لا نكدّس أكثر من رسالتين
  while (host.children.length >= 2) host.firstChild.remove();
  host.appendChild(el);
  const ms = opts.ms ?? (opts.action ? Math.max(CONFIG.toastMs, 6000) : CONFIG.toastMs);
  if (ms > 0) timer = setTimeout(close, ms);
  return close;
}

// ===== النوافذ (bottom sheets) =====
const stack = [];

export function openSheet(html, { wide = false, onClose, label = '' } = {}) {
  const root = document.getElementById('overlay-root');
  const bd = document.createElement('div');
  bd.className = 'backdrop';
  bd.innerHTML = T`<div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}<button type="button" class="sheet-x" aria-label="إغلاق">${icon('x')}</button></div>`;
  const sheet = bd.firstElementChild;
  const entry = { bd, sheet, onClose };
  const prevFocus = document.activeElement;
  entry.close = () => {
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    bd.remove();
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  };
  const openedAt = Date.now();
  // ضغطة على الخلفية تغلق النافذة — إلا في أول لحظة (النافذة ما زالت تصعد؛ ضغطة مزدوجة لا تغلقها بالخطأ)
  bd.addEventListener('click', (e) => { if (e.target === bd && Date.now() - openedAt > 350) entry.close(); });
  sheet.querySelector(':scope > .sheet-x').addEventListener('click', () => entry.close());
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') entry.close(); });
  root.appendChild(bd);
  stack.push(entry);
  const f = sheet.querySelector('[autofocus]') || sheet.querySelector('button, input, select, textarea');
  if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
  return entry;
}

export function closeTopSheet() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
export const hasSheet = () => stack.length > 0;

export function confirmDialog({ title, text = '', ok = tr('تأكيد'), cancel = tr('إلغاء'), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const s = openSheet(`
      <h2>${esc(title)}</h2>
      ${text ? `<p>${esc(text)}</p>` : ''}
      <div class="actions">
        <button type="button" class="btn" data-r="0">${esc(cancel)}</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-r="1" autofocus>${esc(ok)}</button>
      </div>`, { label: title, onClose: () => resolve(result) });
    s.sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      result = b.dataset.r === '1';
      s.close();
    });
  });
}

// لوحة أرقام عشرية لقيمة «رقم آخر»
export function keypad({ title, max, value }) {
  return new Promise((resolve) => {
    let v = value == null ? '' : String(value);
    let result;
    const s = openSheet(T`
      <h2>${esc(title)}</h2>
      <p class="hint">من ${ar(max)} — يقبل الكسور مثل 3.5</p>
      <div class="keypad-display num" aria-live="polite"></div>
      <div class="err-msg" data-err></div>
      <div class="keypad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button type="button" data-k="${d}">${ar(d)}</button>`).join('')}
        <button type="button" data-k=".">.</button><button type="button" data-k="0">0</button>
        <button type="button" data-k="del" aria-label="حذف">⌫</button>
      </div>
      <div class="actions">
        <button type="button" class="btn" data-k="cancel">إلغاء</button>
        <button type="button" class="btn" data-k="clear">مسح الدرجة</button>
        <button type="button" class="btn primary" data-k="ok">حفظ</button>
      </div>`, { label: title, onClose: () => resolve(result) });
    const disp = s.sheet.querySelector('.keypad-display');
    const err = s.sheet.querySelector('[data-err]');
    const paint = () => { disp.textContent = v ? ar(v) : '—'; err.textContent = ''; };
    paint();
    s.sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      const k = b.dataset.k;
      if (k === 'cancel') return s.close();
      if (k === 'del') v = v.slice(0, -1);
      else if (k === 'clear') { result = { value: null }; return s.close(); }
      else if (k === 'ok') {
        const r = parseScore(v, max);
        if (!r.ok) { err.textContent = r.error; return; }
        result = { value: r.value };
        return s.close();
      } else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
      else if (v.length < 5) v += k;
      paint();
    });
  });
}
