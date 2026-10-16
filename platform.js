import { T, tr } from './i18n.js';
// طبقة المنصة: كل ما يختلف بين أندرويد (Capacitor) والويب/آيفون يمر من هنا بواجهة واحدة.

const Cap = globalThis.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const P = (name) => (isNative && Cap.Plugins ? Cap.Plugins[name] : null);

const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isStandalone = isNative || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function downloadLink(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// يكتب الملف في Documents/متابعة الدرجات على أندرويد ويرجع رابطه
async function nativeWrite(name, blob) {
  const Filesystem = P('Filesystem');
  const data = await blobToBase64(blob);
  const path = T`متابعة الدرجات/${name}`;
  try {
    const r = await Filesystem.writeFile({ path, data, directory: 'DOCUMENTS', recursive: true });
    return r.uri;
  } catch {
    // بعض الأجهزة تمنع Documents؛ نستعمل مجلد التطبيق المؤقت للمشاركة
    const r = await Filesystem.writeFile({ path: name, data, directory: 'CACHE', recursive: true });
    return r.uri;
  }
}

// يستدعي دالة مشاركة في الجسر الأصلي GradesNative (أندرويد فقط)؛ غير ذلك 'unsupported'.
function sharingCall(method, text) {
  const bridge = globalThis.GradesNative;
  if (!isNative || !isAndroid || !bridge || typeof bridge[method] !== 'function') return 'unsupported';
  try {
    const r = text === undefined ? bridge[method]() : bridge[method](String(text ?? '').slice(0, 120));
    return typeof r === 'string' ? r : 'failed';
  } catch { return 'failed'; }
}

let backHandler = null;
let lastFileInput = null;

export const platform = {
  isNative, isIOS, isAndroid, isStandalone,

  // حفظ ملف: أندرويد = حفظ في المستندات ثم قائمة المشاركة؛ الويب = مشاركة الملف إن أمكن وإلا تنزيل
  async saveFile(name, blob, mime) {
    if (isNative) {
      const uri = await nativeWrite(name, blob);
      try { await P('Share').share({ title: name, url: uri, dialogTitle: tr('حفظ أو إرسال الملف') }); } catch { /* أُلغيت المشاركة */ }
      return 'saved';
    }
    if (isIOS || (navigator.maxTouchPoints > 0 && isStandalone)) {
      const r = await platform.shareFile(blob, name, mime);
      if (r !== 'unsupported') return r;
    }
    downloadLink(name, blob);
    return 'downloaded';
  },

  async shareText(text, title = '') {
    if (isNative) {
      try { await P('Share').share({ title, text, dialogTitle: tr('مشاركة') }); return 'shared'; } catch { return 'cancelled'; }
    }
    if (navigator.share) {
      try { await navigator.share({ title, text }); return 'shared'; } catch (e) { return e && e.name === 'AbortError' ? 'cancelled' : (await platform.copyText(text) ? 'copied' : 'failed'); }
    }
    return (await platform.copyText(text)) ? 'copied' : 'failed';
  },

  async shareFile(blob, name, mime) {
    if (isNative) return platform.saveFile(name, blob, mime);
    try {
      const file = new File([blob], name, { type: mime || blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
    return 'unsupported';
  },

  pickFile(accept) {
    return new Promise((resolve) => {
      if (lastFileInput) lastFileInput.remove();
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept || '';
      input.style.position = 'fixed'; input.style.opacity = '0'; input.style.pointerEvents = 'none';
      lastFileInput = input;
      let done = false;
      const finish = (f) => { if (done) return; done = true; resolve(f); setTimeout(() => input.remove(), 0); };
      input.addEventListener('change', () => finish(input.files && input.files[0] ? input.files[0] : null));
      input.addEventListener('cancel', () => finish(null));
      document.body.appendChild(input);
      input.click();
    });
  },

  // handler يرجع true إذا عالج الرجوع داخل التطبيق
  onBack(handler) {
    backHandler = handler;
  },

  haptic(type = 'light') {
    try {
      if (isNative && P('Haptics')) {
        const H = P('Haptics');
        if (type === 'success') H.notification({ type: 'SUCCESS' });
        else if (type === 'error') H.notification({ type: 'ERROR' });
        else H.impact({ style: 'LIGHT' });
        return;
      }
      if (navigator.vibrate) navigator.vibrate(type === 'error' ? [30, 40, 30] : type === 'success' ? 18 : 10);
    } catch { /* غير مدعوم */ }
  },

  async copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* نجرب الطريقة القديمة */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  },

  // طباعة الصفحة الحالية (الكشف داخل #print-root). أندرويد: نافذة الطباعة في النظام عبر الجسر الأصلي
  // GradesNative.printPage — ومنها «حفظ بتنسيق PDF». الويب/آيفون: window.print().
  // ترجع 'native' | 'web' | 'unsupported'.
  print(title) {
    const name = String(title || document.title || tr('كشف')).slice(0, 120);
    const bridge = globalThis.GradesNative;
    if (isNative && bridge && typeof bridge.printPage === 'function') {
      try { bridge.printPage(name); return 'native'; } catch { /* نجرب طباعة المتصفح */ }
    }
    if (typeof window.print !== 'function') return 'unsupported';
    const old = document.title;
    try { document.title = name; window.print(); } finally { setTimeout(() => { document.title = old; }, 1000); }
    return 'web';
  },

  // العرض على الكمبيوتر في الخلفية (أندرويد فقط): خدمة أمامية بإشعار «العرض على الكمبيوتر يعمل» تُبقي الاتصال حيًّا
  // حين يخرج المعلم من التطبيق. النص (≤ ١٢٠ محرفًا) يظهر تحت العنوان، مثل «الصف العاشر / ٣ — اضغط للعودة».
  // زر «إيقاف المشاركة» في الإشعار يستدعي window.__gfuStopSharing() إن عرّفتها الصفحة.
  // الويب/آيفون: لا شيء ('unsupported').
  sharingStart(text) { return sharingCall('startSharing', text); },   // 'started'|'failed'|'unsupported'
  sharingUpdate(text) { return sharingCall('updateSharing', text); }, // 'updated'|'inactive'|'unsupported'
  sharingStop() { return sharingCall('stopSharing'); },               // 'stopped'|'unsupported'

  exitApp() {
    if (isNative && P('App')) P('App').exitApp();
  },
};

// زر الرجوع في أندرويد
if (isNative && P('App')) {
  P('App').addListener('backButton', () => {
    if (backHandler && backHandler()) return;
    P('App').exitApp();
  });
}

export default platform;
