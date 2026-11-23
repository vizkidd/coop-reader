import assert from 'node:assert/strict';
import { startServers, launch, newPage, sleep, waitFor } from './harness.mjs';
const srv = await startServers(); const browser = await launch();
let failed = 0; const step = async (n, fn) => { try { await fn(); console.log('ok  ' + n); } catch (e) { failed++; console.log('FAIL ' + n + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); } };
try {
  const p = await newPage(browser, srv.url, { skipProfile: false });
  await step('page loads without script errors', async () => { await sleep(800); assert.deepEqual(p.errors || [], []); });
  await step('profile dialog is shown at start and blocks auto-join until confirmed', async () => {
    const vis = await p.evaluate(() => { const m = document.querySelector('.cp-back'); return !!m && !m.hidden; }); assert.equal(vis, true);
    await p.type('#cp-name', 'Ana'); await p.click('#cp-go');
    await waitFor(p, () => document.querySelector('.cp-back').hidden === true);
    assert.equal(await p.evaluate(() => myDisplayName), 'Ana');
    assert.equal(await p.evaluate(() => localStorage.getItem('coop-name')), 'Ana');
  });
  await step('empty name is refused', async () => {
    await p.evaluate(() => { document.getElementById('cp-name') && 0; CoopProfile.open(); });
    await p.evaluate(() => { document.getElementById('cp-name').value = ''; });
    await p.click('#cp-go'); assert.equal(await p.evaluate(() => document.querySelector('.cp-back').hidden), false);
    assert.match(await p.evaluate(() => document.getElementById('cp-err').textContent), /name/i);
    await p.type('#cp-name', 'Ana'); await p.click('#cp-go');
  });
  await step('avatar upload is cropped to a small JPEG and stored', async () => {
    await p.evaluate(() => CoopProfile.open());
    const b64 = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#3c3'; g.fillRect(100, 50, 100, 100); return c.toDataURL('image/png').split(',')[1]; });
    const fs = await import('node:fs'); fs.writeFileSync('/tmp/av.png', Buffer.from(b64, 'base64'));
    const inp = await p.$('#cp-file'); await inp.uploadFile('/tmp/av.png');
    await waitFor(p, () => !!document.querySelector('#cp-av img'));
    const src = await p.evaluate(() => document.querySelector('#cp-av img').src); assert.match(src, /^data:image\/jpeg/); assert.ok(src.length < 20000);
    await p.click('#cp-go'); assert.match(await p.evaluate(() => localStorage.getItem('coop-avatar') || ''), /^data:image\/jpeg/);
  });
  await step('"remember me" skips the dialog on the next start', async () => {
    await p.evaluate(() => CoopProfile.open()); await p.click('#cp-skip'); await p.click('#cp-go');
    await p.reload({ waitUntil: 'load' }); await sleep(500);
    assert.equal(await p.evaluate(() => document.querySelector('.cp-back') ? document.querySelector('.cp-back').hidden : true), true);
  });
} finally { await browser.close(); srv.close(); }
console.log(failed ? failed + ' FAILED' : 'ALL PASSED'); process.exit(failed ? 1 : 0);
