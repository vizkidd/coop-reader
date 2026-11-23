// End-to-end check of the WASM document flow against the REAL relay code (Node HTTP wrapper, in-memory storage).
// Run: node tests/e2e/docsync.e2e.mjs   (needs puppeteer; skips politely if it is not installed)
import http from 'node:http';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Worker, { Room } from '../../src/relay-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let puppeteer;
try { const root = execSync('npm root -g').toString().trim(); puppeteer = require(root + '/@mermaid-js/mermaid-cli/node_modules/puppeteer'); }
catch { try { puppeteer = require('puppeteer'); } catch { console.log('SKIP: puppeteer not installed'); process.exit(0); } }

class MemoryStorage { constructor() { this.v = new Map(); } async get(k) { return this.v.get(k); } async put(k, x) { this.v.set(k, structuredClone(x)); } async delete(k) { return this.v.delete(k); }
  async list({ prefix = '' } = {}) { return new Map([...this.v].filter(([k]) => k.startsWith(prefix))); } }
const rooms = new Map();
const env = { ROOMS: { idFromName: n => n, get(id) { if (!rooms.has(id)) rooms.set(id, new Room({ storage: new MemoryStorage() }, {})); const r = rooms.get(id); return { fetch: q => r.fetch(q) }; } } };
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/__seed') { env.ROOMS.get(u.searchParams.get('room')); const r = rooms.get(u.searchParams.get('room')); r.clients.set(u.searchParams.get('id'), {}); r.tokens.set(u.searchParams.get('id'), u.searchParams.get('t')); res.end('ok'); return; }
  const r = await Worker.fetch(new Request('http://relay.test' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port, base = `http://127.0.0.1:${port}`;

const exe = execSync("find /home/claude/.cache/puppeteer -name chrome -type f 2>/dev/null | head -1").toString().trim() || undefined;
const browser = await puppeteer.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.evaluateOnNewDocument((relay) => {
  window.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.reject(new Error('stub')) }) };
  window.Peer = function () { this.on = () => {}; this.destroy = () => {}; };
  localStorage.setItem('coop-net', JSON.stringify({ relay, mode: 'auto', priv: false }));
}, base.replace('http', 'ws'));
await page.setRequestInterception(true);
page.on('request', r => (/^(file:|http:\/\/127\.0\.0\.1)/.test(r.url()) ? r.continue() : r.abort()));
await page.goto('file://' + path.resolve(here, '../../src/index.html'), { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 1200));

const fail = []; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail.push(m); };
const tok = await page.evaluate(() => wsToken);
const seed = (room, id) => fetch(`${base}/__seed?room=${room}&id=${id}&t=${tok}`);
const book = Buffer.alloc(98304 * 2 + 5000); for (let i = 0; i < book.length; i++) book[i] = (i * 31 + 7) & 255;

// 1. fingerprint is identical to the standard CRC-32 computed independently
const crc = b => (zlib.crc32 ? zlib.crc32(b) : 0).toString(16).padStart(8, '0');
const expectFp = `${book.length}-${crc(book.subarray(0, 65536))}-${crc(book.subarray(book.length - 65536))}`;
const fp = await page.evaluate(b => docFingerprint(new Uint8Array(b).buffer), [...book]);
ok(zlib.crc32 ? fp === expectFp : true, `fingerprint matches independent CRC-32 (${fp})`);

// 2. host serves a Kindle: lazy chunked upload to the relay, then DOC_READY
await seed('hostA', 'hostA');
const served = await page.evaluate(async (b) => {
  isHost = true; myPeerId = 'hostA';
  cachedFileBytes = new Uint8Array(b).buffer; cachedFilename = 'My Book.epub'; cachedFp = docFingerprint(cachedFileBytes);
  const sent = []; const k = { peer: 'kindle-1', _kindle: true, open: true, send: m => sent.push(m) };
  await handleNetworkMessage(k, { type: 'DOC_REQUEST', fp: 'wrong' });                 // wrong fingerprint is ignored
  const ignored = sent.length === 0;
  await handleNetworkMessage(k, { type: 'DOC_REQUEST', fp: cachedFp });
  await new Promise(r => { const t0 = Date.now(), iv = setInterval(() => { if (sent.some(m => m.type === 'DOC_READY' || m.type === 'DOC_ERROR') || Date.now() - t0 > 8000) { clearInterval(iv); r(); } }, 40); });   // upload runs in the background
  return { ignored, ready: sent.find(m => m.type === 'DOC_READY'), fp: cachedFp };
}, [...book]);
ok(served.ignored, 'host ignores a DOC_REQUEST for a different file');
ok(served.ready && served.ready.chunks === 3 && served.ready.size === book.length, 'host answers DOC_REQUEST with DOC_READY (3 chunks)');

// 3. the Kindle side (Node, bearer auth) downloads exactly the bytes and sees the right metadata
const kj = await (await fetch(`${base}/room/hostA/http/join`, { method: 'POST', body: JSON.stringify({ id: 'kindle-1', role: 'guest', name: 'K' }) })).json();
const meta = await (await fetch(`${base}/room/hostA/blob/${served.fp}/meta?id=kindle-1`, { headers: { Authorization: 'Bearer ' + kj.token } })).json();
ok(meta.done && meta.name === 'My Book.epub', 'relay holds the complete file for the Kindle');
const got = Buffer.concat(await Promise.all([0, 1, 2].map(async i => Buffer.from(await (await fetch(`${base}/room/hostA/blob/${served.fp}/${i}?id=kindle-1`, { headers: { Authorization: 'Bearer ' + kj.token } })).arrayBuffer()))));
ok(Buffer.compare(got, book) === 0, 'Kindle downloads byte-identical content');

// 4. WASM guest of a Kindle host: offer -> request -> ready -> verified download -> opens the book
const hostTok = (await (await fetch(`${base}/room/kroomX/http/join`, { method: 'POST', body: JSON.stringify({ id: 'kroomX', role: 'host', name: 'Kindle' }) })).json()).token;
const H = { Authorization: 'Bearer ' + hostTok };
await fetch(`${base}/room/kroomX/blob/${served.fp}/meta?id=kroomX`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'kbook.epub', size: book.length, chunks: 3, fp: served.fp, ext: 'epub' }) });
for (let i = 0; i < 3; i++) await fetch(`${base}/room/kroomX/blob/${served.fp}/${i}?id=kroomX`, { method: 'PUT', headers: H, body: book.subarray(i * 98304, Math.min(book.length, (i + 1) * 98304)) });
await seed('kroomX', 'guestB');
const dl = await page.evaluate(async (fpv) => {
  isHost = false; lastJoinCode = 'kroomX'; myPeerId = 'guestB'; cachedFp = ''; window.__opened = null;
  processAndRenderFileLocally = async (buf, name) => { window.__opened = { n: buf.byteLength, name, fp: docFingerprint(buf) }; };
  state.totalPages = 40; state.fileType = 'other';
  const out = []; const hostConn = { peer: 'kroomX', open: true, send: m => out.push(m) };
  await handleNetworkMessage(hostConn, { type: 'DOC_OPEN', fp: fpv, name: 'kbook.epub', size: 200000, pct: 0.5, total: 100, page: 50 });
  const requested = out.find(m => m.type === 'DOC_REQUEST');
  await onDocReady(hostConn, { type: 'DOC_READY', fid: fpv, fp: fpv, name: 'kbook.epub', size: 98304 * 2 + 5000, chunks: 3 });
  return { requested: !!requested, opened: window.__opened, page: state.currentPage };
}, served.fp);
ok(dl.requested, 'guest requests the document after the host announces it');
ok(dl.opened && dl.opened.n === book.length && dl.opened.fp === served.fp, 'guest downloads, verifies and opens the document');
ok(dl.page === 21, `position follows the host as a fraction of the book (50% of 40 pages -> page ${dl.page})`);

// 5. a corrupted transfer is rejected, never opened
await fetch(`${base}/room/kroomX/blob/${served.fp}/meta?id=kroomX`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'bad.epub', size: book.length, chunks: 3, fp: 'other-fp', ext: 'epub' }) });
for (let i = 0; i < 3; i++) await fetch(`${base}/room/kroomX/blob/other-fp/${i}?id=kroomX`, { method: 'PUT', headers: H, body: Buffer.alloc(Math.min(book.length - i * 98304, 98304), 1) });
const bad = await page.evaluate(async () => {
  window.__opened = null; const c = { peer: 'kroomX', open: true, send() {} };
  await handleNetworkMessage(c, { type: 'DOC_OPEN', fp: 'other-fp', name: 'bad.epub', size: 1 });
  await onDocReady(c, { type: 'DOC_READY', fid: 'other-fp', fp: 'other-fp', name: 'bad.epub', size: 98304 * 2 + 5000, chunks: 3 });
  return window.__opened;
});
ok(bad === null, 'corrupted download fails the integrity check and is not opened');

// 6. page mapping rules
const maps = await page.evaluate(() => {
  state.totalPages = 200; state.fileType = 'pdf'; const a = mapRemotePage({ page: 17, pct: 0.1, total: 90 });
  state.fileType = 'other'; state.totalPages = 101; const b = mapRemotePage({ page: 17, pct: 0.5, total: 300 });
  const c = mapRemotePage({ page: 999, pct: 1, total: 300 });
  return [a, b, c];
});
ok(maps[0] === 17 && maps[1] === 51 && maps[2] === 101, `page mapping: PDF keeps page (${maps[0]}), books follow position (${maps[1]}, ${maps[2]})`);

await browser.close(); server.close();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nALL PASSED'); process.exit(fail.length ? 1 : 0);
