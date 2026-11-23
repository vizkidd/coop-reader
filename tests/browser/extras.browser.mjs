import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { startServers, launch, runner, sleep, waitFor, makePdf, hostSession, guestJoin, openFile, newPage } from './lib.mjs';
const NM = process.env.NM || path.join(process.cwd(), 'node_modules'); const require = createRequire(path.join(NM, 'x.js')); const jsQR = require('jsqr');
const srv = await startServers(), browser = await launch(), { step, done } = runner();
let host, g1;
try {
  await makePdf('/tmp/t3.pdf', 3);
  const reqs = []; 
  host = await hostSession(browser, srv.url, 'Host'); host.on('request', r => reqs.push(r.url()));
  await step('the third-party donation image and widget are not requested at start (deferred / opt-out respected)', async () => {
    await sleep(500); assert.ok(!reqs.some(u => /buymeacoffee/.test(u)), 'requests: ' + reqs.filter(u => /buymeacoffee/.test(u)));
    assert.equal(await host.evaluate(() => !!document.querySelector('script[data-name="BMC-Widget"]')), false);
    await sleep(3200); assert.equal(await host.evaluate(() => !!document.querySelector('script[data-name="BMC-Widget"]')), true, 'widget appears after the app was idle');
    const off = await newPage(browser, srv.url, { name: 'Opt', init: "localStorage.setItem('coop-no-widget','1')" }); await sleep(3800);
    assert.equal(await off.evaluate(() => !!document.querySelector('script[data-name="BMC-Widget"]')), false, 'opt-out stops it'); await off.close();
  });
  await step('invite dialog: the QR code decodes to the share link, which carries key and host fingerprint', async () => {
    await host.evaluate(() => CoopExtras.showInvite()); await waitFor(host, () => !!document.querySelector('#inv-qr svg'));
    const pix = await host.evaluate(async () => { const svg = document.querySelector('#inv-qr svg'); svg.setAttribute('width', 420); svg.setAttribute('height', 420);
      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg)); await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 420; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 420, 420); g.drawImage(img, 0, 0, 420, 420);
      return { data: Array.from(g.getImageData(0, 0, 420, 420).data), url: document.getElementById('inv-qr').dataset.url, fp: hostSigner.id.fp, key: relayKeyB64 }; });
    const r = jsQR(Uint8ClampedArray.from(pix.data), 420, 420); assert.ok(r, 'a QR code was found'); assert.equal(r.data, pix.url);
    assert.match(r.data, new RegExp('rk=' + pix.key)); assert.match(r.data, new RegExp('fp=' + pix.fp));
    assert.match(await host.evaluate(() => document.querySelector('[aria-label="Invite"]').innerText), /(\d{5} ){5}\d{5}/, 'safety number is shown');
    await host.keyboard.press('Escape'); assert.equal(await host.evaluate(() => !!document.querySelector('#inv-qr')), false);
  });
  g1 = await guestJoin(browser, srv.url, await host.evaluate(() => myPeerId), 'Ana');
  await step('low-bandwidth mode: no cursor or activity traffic, slower heartbeat; normal traffic unaffected', async () => {
    await g1.evaluate(() => { window.__sent = []; const b = window.broadcast; window.broadcast = m => { window.__sent.push(m.type); return b(m); }; });
    const move = async () => { await g1.mouse.move(300, 500); await g1.mouse.move(340, 540, { steps: 6 }); await g1.mouse.move(380, 560, { steps: 6 }); await sleep(300); };
    await openFile(host, '/tmp/t3.pdf'); await waitFor(g1, () => pdfDoc && pdfDoc.numPages === 3, null, 30000);
    await move(); const normal = await g1.evaluate(() => window.__sent.filter(t => t === 'CURSOR_MOVE').length); assert.ok(normal > 0, 'cursor messages are sent normally');
    await g1.evaluate(() => { CoopExtras.setLowBw(true); window.__sent = []; }); await move();
    const low = await g1.evaluate(() => ({ cur: window.__sent.filter(t => t === 'CURSOR_MOVE' || t === 'ACTIVITY').length, lb: lowBw() })); assert.deepEqual(low, { cur: 0, lb: true });
    await g1.evaluate(() => { setTool('pen'); }); 
    await g1.evaluate(() => CoopExtras.setLowBw(false));
  });
  await step('comments: filters, unread badge on the button, opening a thread marks it read', async () => {
    await host.evaluate(() => { document.getElementById('hs-annot').checked = true; updateHostSettings(); }); await waitFor(g1, () => canAnnotate());
    await g1.evaluate(() => { for (let i = 0; i < 3; i++) { const it = CoopComments.newItem({ id: 'u' + i, k: 'pt', x: .2 + i * .2, y: .3, c: '#f59e0b', by: myPeerId.replace(/[^\w-]/g, ''), name: 'Ana', text: 'note ' + i, ts: Date.now() }); applyAnnot('add', i === 2 ? 2 : 1, it); broadcast({ type: 'ANNOT', op: 'add', page: i === 2 ? 2 : 1, item: it }); } });
    await waitFor(host, () => CoopComments.stats(annots).threads === 3, null, 8000);
    await sleep(1800);
    assert.match(await host.evaluate(() => document.getElementById('btn-comments').textContent), /Comments \(3\) • 3 new/);
    await host.click('#btn-comments'); await waitFor(host, () => document.querySelectorAll('.cm-item').length === 3);
    await host.evaluate(() => document.querySelector('[data-f="page"]').click()); assert.equal(await host.evaluate(() => document.querySelectorAll('.cm-item').length), 2, 'this page only (page 1)');
    await host.evaluate(() => document.querySelector('[data-f="mine"]').click()); assert.equal(await host.evaluate(() => document.querySelectorAll('.cm-item').length), 0, 'host wrote none');
    await host.evaluate(() => document.querySelector('[data-f="new"]').click()); assert.equal(await host.evaluate(() => document.querySelectorAll('.cm-item').length), 3);
    await host.evaluate(() => document.getElementById('cm-allread').click()); await sleep(200);
    assert.equal(await host.evaluate(() => document.querySelectorAll('.cm-item').length), 0, 'all read');
    await host.evaluate(() => document.getElementById('cm-x').click()); await sleep(1800);
    assert.match(await host.evaluate(() => document.getElementById('btn-comments').textContent), /^💬 Comments \(3\)$/);
    await g1.evaluate(() => { const it = annots[1][0]; const m = { id: 'rr1', by: 'x', name: 'Zed', text: 'reply', ts: Date.now() }; CoopComments.reply(annots[1], it.id, m); });   // simulate a reply from somebody else arriving
    await host.evaluate(() => { const m = { id: 'rr2', by: 'someone', name: 'Zed', text: 'reply', ts: Date.now() }; applyAnnot('reply', 1, m, annots[1][0].id); }); await sleep(1800);
    assert.match(await host.evaluate(() => document.getElementById('btn-comments').textContent), /1 new/, 'a new reply makes the thread unread again');
  });
  await step('no page errors', async () => { assert.deepEqual([host, g1].flatMap(p => p.errors || []), []); });
} finally { await browser.close(); srv.close(); }
process.exit(done() ? 1 : 0);
