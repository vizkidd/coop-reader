// Browser test harness: serves src/, replaces CDN scripts with local npm copies, runs a local PeerJS signaling server and a
// headless Chromium. Needs (dev): puppeteer-core @sparticuz/chromium peer peerjs pdfjs-dist pdf-lib docx-preview
//   npm i -D puppeteer-core @sparticuz/chromium peer peerjs pdfjs-dist@3.11.174 pdf-lib@1.17.1 docx-preview@0.3.2
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const NM = process.env.NM || path.join(ROOT, 'node_modules');
const require = createRequire(path.join(NM, 'x.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const CDN = [
  [/unpkg\.com\/peerjs@/, 'peerjs/dist/peerjs.min.js'],
  [/pdf\.js\/3\.11\.174\/pdf\.min\.js/, 'pdfjs-dist/build/pdf.min.js'],
  [/pdf\.js\/3\.11\.174\/pdf\.worker\.min\.js/, 'pdfjs-dist/build/pdf.worker.min.js'],
  [/pdf-lib\/1\.17\.1\/pdf-lib\.min\.js/, 'pdf-lib/dist/pdf-lib.min.js'],
  [/docx-preview@0\.3\.2/, 'docx-preview/dist/docx-preview.min.js'],
];
export function cdnFile(u) { for (const [re, rel] of CDN) if (re.test(u)) return path.join(NM, rel); return null; }
export async function startServers({ port = 8080, peerPort = 9000 } = {}) {
  const { PeerServer } = require('peer');
  const peerServer = PeerServer({ port: peerPort, host: '127.0.0.1', path: '/coop', key: 'peerjs', allow_discovery: false });
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
    const f = path.join(ROOT, 'src', p); if (!f.startsWith(path.join(ROOT, 'src')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));
  return { url: `http://localhost:${port}/`, close: () => { srv.close(); try { peerServer.close?.(); } catch (_) {} } };
}
export async function launch() {
  const chromium = require('@sparticuz/chromium'); const chromiumLib = chromium.default || chromium;
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: await chromiumLib.executablePath(), headless: 'shell', args: [...chromiumLib.args.filter(a => !/single-process|no-zygote|headless/.test(a)), '--no-sandbox', '--host-resolver-rules=MAP localhost 127.0.0.1', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  return browser;
}
export async function newPage(browser, url, { name, skipProfile = true, net = { relay: '' }, init = '', sw = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  if (!sw) { const cdp = await page.createCDPSession(); await cdp.send('Network.enable'); await cdp.send('Network.setBypassServiceWorker', { bypass: true }); }   // the sandbox has no internet: libraries are served by request interception, not by the service worker
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    for (const [re, rel] of CDN) if (re.test(u)) return req.respond({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(NM, rel)) });
    if (/^https?:\/\/(?!localhost)/.test(u)) return req.abort();   // no internet: fonts, widgets, relay probes
    req.continue();
  });
  page.on('pageerror', e => { page.errors = page.errors || []; page.errors.push(String(e.message || e)); });
  page.on('console', m => { if (m.type() === 'error') { page.consoleErrors = page.consoleErrors || []; page.consoleErrors.push(m.text()); } });
  await page.evaluateOnNewDocument((name, skipProfile, net, init) => {
    try {
      localStorage.setItem('coop-server-config', JSON.stringify({ host: 'localhost', port: 9000, path: '/coop', key: 'peerjs', secure: false }));
      localStorage.setItem('coop-net', JSON.stringify(net));
      if (name) { localStorage.setItem('coop-name', name); if (skipProfile) localStorage.setItem('coop-profile-skip', '1'); }
    } catch (_) {}
    if (init) (0, eval)(init);
  }, name, skipProfile, net, init);
  await page.goto(url, { waitUntil: 'load' });
  return page;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(page, fn, arg, ms = 15000) { await page.waitForFunction(fn, { timeout: ms, polling: 100 }, arg); }
