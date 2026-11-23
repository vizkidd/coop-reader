import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServers, launch, newPage, sleep, waitFor, cdnFile } from './harness.mjs';
const NM = process.env.NM || path.join(process.cwd(), 'node_modules');
const require = createRequire(path.join(NM, 'x.js'));
export { startServers, launch, newPage, sleep, waitFor, cdnFile };
export function runner() {
  let failed = 0;
  return { async step(n, fn) { const t0 = Date.now(); try { await fn(); console.log(`ok  ${n} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (e) { failed++; console.log('FAIL ' + n + '\n    ' + String(e.stack || e).split('\n').slice(0, 5).join('\n    ')); } }, done() { console.log(failed ? failed + ' FAILED' : 'ALL PASSED'); return failed; } };
}
// text-heavy PDF (pages with real text so the text layer has something to select)
export async function makePdf(file, pages = 3, extraBytes = 0) {
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([600, 800]);
    for (let l = 0; l < 20; l++) p.drawText(`Page ${i} line ${l}: the quick brown fox jumps over the lazy dog ${l * 7}`, { x: 50, y: 740 - l * 30, size: 14, font });
  }
  if (extraBytes) { const u = new Uint8Array(extraBytes); for (let o = 0; o < extraBytes; o += 65536) crypto.getRandomValues(u.subarray(o, Math.min(extraBytes, o + 65536))); await doc.attach(u, 'payload.bin', { mimeType: 'application/octet-stream' }); }
  fs.writeFileSync(file, await doc.save());
  return file;
}
export async function hostSession(browser, url, name = 'Host', opts = {}) {
  const h = await newPage(browser, url, { name, net: opts.net, init: opts.init });
  await h.evaluate(pw => { if (pw) document.getElementById('host-password').value = pw; return startHost(); }, opts.password || '');
  await waitFor(h, () => !!myPeerId && !!peer && !peer.disconnected);
  return h;
}
export async function guestJoin(browser, url, hostId, name = 'Guest', opts = {}) {
  const g = await newPage(browser, url, { name, net: opts.net, init: opts.init });
  if (opts.password) await g.evaluate(pw => { document.getElementById('join-password').value = pw; }, opts.password);
  await g.evaluate(id => joinSession(id), opts.key ? hostId + '.' + opts.key : hostId);
  await waitFor(g, () => connections.some(c => c.open && c._synced), null, opts.timeout || 20000);
  return g;
}
import { spawn } from 'node:child_process';
export async function startRelay(port = 8799) {   // needs wrangler (dev dependency); serves src/relay-worker.js in the real Workers runtime
  const dir = fs.mkdtempSync('/tmp/relay-'); fs.copyFileSync(path.join(process.cwd(), 'src/relay-worker.js'), dir + '/relay-worker.js');
  fs.writeFileSync(dir + '/wrangler.toml', 'name="t"\nmain="relay-worker.js"\ncompatibility_date="2024-09-01"\n[[durable_objects.bindings]]\nname="ROOMS"\nclass_name="Room"\n[[migrations]]\ntag="v1"\nnew_sqlite_classes=["Room"]\n');
  const bin = process.env.WRANGLER || path.join(NM, '.bin/wrangler'); const child = spawn(bin, ['dev', '--port', String(port), '--local'], { cwd: dir, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://localhost:' + port + '/'); if (r.ok) return { url: 'ws://localhost:' + port, close: () => child.kill() }; } catch (_) {} await sleep(1000); }
  child.kill(); throw new Error('relay did not start');
}
export async function openFile(page, file) { const inp = await page.$('#file-input'); await inp.uploadFile(file); }
