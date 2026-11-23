/* Coop Reader service worker: the app starts offline after one online visit.
 *  - same-origin files (page, scripts): network first (updates apply at once), cache when the network is slow or gone
 *  - pinned CDN libraries (PeerJS, pdf.js, pdf-lib, docx-preview, Pyodide): cache first, filled the first time they are used
 *  - never touched: other origins, non-GET, range requests, the relay and signalling servers
 * Bump VERSION to drop old caches.
 */
const VERSION = 'coop-2.1.1';
const SHELL = ['./', 'index.html', 'worker.js', 'manifest.webmanifest', 'icon.svg', 'config.js',
  'js/coop-profile.js', 'js/coop-codec.js', 'js/coop-trust.js', 'js/coop-net.js', 'js/coop-session.js', 'js/coop-store.js', 'js/coop-comments.js', 'js/coop-input.js',
  'js/coop-comments-ui.js', 'js/coop-live.js', 'js/coop-extras.js', 'js/vendor/qrcode.js'];
const CDN = [/^https:\/\/unpkg\.com\/peerjs@\d/, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/(pdf\.js|pdf-lib)\/[\d.]+\//, /^https:\/\/cdn\.jsdelivr\.net\/npm\/docx-preview@[\d.]+\//,
  /^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v[\d.]+\//];

self.addEventListener('install', e => {
  e.waitUntil((async () => { const c = await caches.open(VERSION); await Promise.allSettled(SHELL.map(u => c.add(u))); await self.skipWaiting(); })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k); await self.clients.claim(); })());
});

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || req.headers.has('range')) return;
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await withTimeout(fetch(req), 4000);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : undefined) || Response.error();
      }
    })());
    return;
  }
  if (CDN.some(re => re.test(req.url))) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION), hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })());
  }
});
