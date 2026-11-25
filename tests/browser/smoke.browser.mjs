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
    const seen = await p.evaluate(() => { const m = document.querySelector('.cp-back'), c = getComputedStyle(m); const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      return { display: c.display, rect: m.getBoundingClientRect().width, covered: !!(hit && hit.closest('.cp-back')), scroll: document.body.style.overflow }; });
    assert.deepEqual(seen, { display: 'none', rect: 0, covered: false, scroll: '' }, 'the dialog must really be gone (display, size, nothing on top of the page)');
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
  await step('default relay is coop-relay.vizkidd.workers.dev; a saved copy of the previous default is migrated', async () => {
    assert.equal(await p.evaluate(() => DEFAULT_RELAY), 'wss://coop-relay.vizkidd.workers.dev');
    const r = await p.evaluate(() => { localStorage.setItem('coop-net', JSON.stringify({ relay: 'wss://coop-relay.coop-reader.workers.dev', mode: 'auto' })); return getStoredNet().relay; });
    assert.equal(r, '');
    const keep = await p.evaluate(() => { localStorage.setItem('coop-net', JSON.stringify({ relay: 'wss://my.relay.example', mode: 'auto' })); const v = getStoredNet().relay; localStorage.removeItem('coop-net'); return v; });
    assert.equal(keep, 'wss://my.relay.example', 'a custom relay is never touched');
  });
} finally { await browser.close(); srv.close(); }
console.log(failed ? failed + ' FAILED' : 'ALL PASSED'); process.exit(failed ? 1 : 0);
