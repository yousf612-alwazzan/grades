// Service Worker: يخزّن كل ملفات التطبيق ليعمل بدون إنترنت (cache-first بنسخة ثابتة).
// CACHE_VERSION وقائمة الملفات يكتبهما سكربت البناء scripts/build-web.mjs.
const CACHE_VERSION = '9d20120cd3c2';
const CACHE = 'grades-' + CACHE_VERSION;
const PRECACHE = ["./","./app.css","./app.js","./changelog.js","./config.js","./fonts/cairo-arabic-400-normal.woff2","./fonts/cairo-arabic-600-normal.woff2","./fonts/cairo-arabic-800-normal.woff2","./fonts/cairo-latin-400-normal.woff2","./fonts/cairo-latin-600-normal.woff2","./fonts/cairo-latin-800-normal.woff2","./grades-core.js","./icons/apple-touch-icon.png","./icons/favicon.svg","./icons/icon-192.png","./icons/icon-512.png","./icons/maskable-512.png","./importers.js","./index.html","./live.js","./manifest.webmanifest","./platform.js","./reports.js","./store.js","./transfer.js","./ui.js","./vendor/fflate.min.js","./vendor/jsQR.js","./vendor/jszip.min.js","./vendor/pdfjs/pdf.min.mjs","./vendor/pdfjs/pdf.worker.min.mjs","./vendor/qrcode.js","./vendor/tesseract/LICENSE.txt","./vendor/tesseract/core/tesseract-core-lstm.wasm.js","./vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js","./vendor/tesseract/lang/ara.traineddata.gz","./vendor/tesseract/tesseract.min.js","./vendor/tesseract/worker.min.js","./view.css","./view.html","./view.js","./view.webmanifest","./xlsx-export.js"];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' حتى لا نأخذ نسخة قديمة من ذاكرة المتصفح
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) await cache.put(url, res);
      } catch { /* يُجلب لاحقًا عند الطلب */ }
    }));
    // أول تثبيت: نتفعّل مباشرة. التحديثات تنتظر موافقة المعلم (رسالة skip-waiting)
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('grades-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (CACHE_VERSION.startsWith('__')) return; // وضع التطوير (web/src بدون بناء): بلا تخزين مؤقت
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.txt')) return; // دائمًا من الشبكة

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = await cache.match(url.pathname.endsWith('view.html') ? './view.html' : './index.html');
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        if (shell) return shell;
        throw new Error('offline');
      }
    }
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  })());
});
