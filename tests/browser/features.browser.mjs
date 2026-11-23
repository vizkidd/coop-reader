import assert from 'node:assert/strict';
import { startServers, launch, runner, sleep, waitFor, makePdf, hostSession, guestJoin, openFile } from './lib.mjs';
const srv = await startServers(), browser = await launch(), { step, done } = runner();
let host, g1, g2, hostId;
const allowAnnot = () => host.evaluate(() => { document.getElementById('hs-annot').checked = true; updateHostSettings(); });
try {
  await makePdf('/tmp/t3.pdf', 3);
  host = await hostSession(browser, srv.url, 'Host'); hostId = await host.evaluate(() => myPeerId);
  g1 = await guestJoin(browser, srv.url, hostId, 'Ana'); g2 = await guestJoin(browser, srv.url, hostId, 'Bo');
  await openFile(host, '/tmp/t3.pdf');
  await waitFor(g1, () => pdfDoc && pdfDoc.numPages === 3 && document.querySelectorAll('#pdf-text-layer span').length > 5, null, 30000);
  await waitFor(g2, () => pdfDoc && pdfDoc.numPages === 3, null, 30000);
  await allowAnnot(); await waitFor(g1, () => canAnnotate());

  await step('PDF text layer is rendered and selectable', async () => {
    const n = await g1.evaluate(() => document.querySelectorAll('#pdf-text-layer span').length); assert.ok(n >= 20, 'spans: ' + n);
  });
  await step('selecting text offers "Comment on selection"; sending it shows up at the host stamped with the real author', async () => {
    await g1.evaluate(() => { const sp = document.querySelector('#pdf-text-layer span'); const r = document.createRange(); r.selectNodeContents(sp); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await waitFor(g1, () => document.getElementById('cm-selbtn').style.display === 'block', null, 5000);
    const bb = await g1.evaluate(() => { const r = document.getElementById('cm-selbtn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await g1.mouse.click(bb.x, bb.y); await waitFor(g1, () => !!document.getElementById('cm-ta'));
    await g1.type('#cm-ta', 'Why this wording?'); await g1.click('#cm-pop [data-a="send"]');
    await waitFor(host, () => (annots[1] || []).some(a => a.t === 'cm'), null, 8000);
    const it = await host.evaluate(() => annots[1].find(a => a.t === 'cm'));
    assert.equal(it.k, 'tx'); assert.ok(it.q.length >= 1); assert.match(it.quote, /Page 1/); assert.equal(it.th[0].text, 'Why this wording?'); assert.equal(it.name, 'Ana');
    assert.equal(it.by, await g1.evaluate(() => myPeerId.replace(/[^\w-]/g, '')));
  });
  await step('click-to-show: the pin is closed by default; clicking it opens the thread with avatar/name; replies sync both ways', async () => {
    await waitFor(host, () => document.querySelectorAll('.cm-pin').length === 1);
    assert.equal(await host.evaluate(() => document.getElementById('cm-pop').hidden), true);
    await host.click('.cm-pin'); await waitFor(host, () => !document.getElementById('cm-pop').hidden);
    assert.match(await host.evaluate(() => document.getElementById('cm-pop').innerText), /Ana[\s\S]*Why this wording/);
    await host.type('#cm-ta', 'Because of the style guide'); await host.click('#cm-pop [data-a="send"]');
    await waitFor(g1, () => annots[1].find(a => a.t === 'cm').th.length === 2, null, 8000);
    await waitFor(g2, () => annots[1].find(a => a.t === 'cm').th.length === 2, null, 8000);
    const th = await g2.evaluate(() => annots[1].find(a => a.t === 'cm').th.map(m => m.name));
    assert.deepEqual(th, ['Ana', 'Host']);
  });
  await step('peers cannot forge authorship, delete other people\'s replies, or resolve foreign threads', async () => {
    const id = await host.evaluate(() => annots[1].find(a => a.t === 'cm').id), hostMsg = await host.evaluate(() => annots[1].find(a => a.t === 'cm').th[1].id);
    await g2.evaluate((id, mid) => { broadcast({ type: 'ANNOT', op: 'rdel', page: 1, id, item: mid }); broadcast({ type: 'ANNOT', op: 'resolve', page: 1, id, item: 1 });
      broadcast({ type: 'ANNOT', op: 'reply', page: 1, id, item: { id: 'forged1', by: 'someone-else', name: 'CEO', text: 'I approve', ts: 1 } }); }, id, hostMsg);
    await sleep(1200);
    const it = await host.evaluate(() => annots[1].find(a => a.t === 'cm'));
    assert.equal(it.th.length, 3, 'forged reply is accepted as a reply from Bo, nothing else changed'); assert.equal(it.rs, 0); assert.ok(it.th.some(m => m.id === hostMsg));
    const forged = it.th.find(m => m.id === 'forged1'); assert.equal(forged.name, 'Bo'); assert.notEqual(forged.by, 'someone-else');
  });
  await step('point comment with the 💬 tool', async () => {
    await g2.evaluate(() => setTool('note'));
    await g2.evaluate(() => window.scrollTo(0, 0));
    const box = await g2.evaluate(() => { const r = document.getElementById('pdf-canvas').getBoundingClientRect(); return { x: r.left + r.width * .6, y: 700, ny: (700 - r.top) / r.height }; });
    await g2.mouse.click(box.x, box.y); await waitFor(g2, () => !!document.getElementById('cm-ta'));
    await g2.type('#cm-ta', 'Check this figure'); await g2.click('#cm-pop [data-a="send"]');
    await waitFor(host, () => (annots[1] || []).filter(a => a.t === 'cm').length === 2, null, 8000);
    const it = await host.evaluate(() => annots[1].find(a => a.k === 'pt')); assert.ok(Math.abs(it.x - .6) < .03 && Math.abs(it.y - box.ny) < .03);
    await g2.evaluate(() => setTool(null));
  });
  await step('zoom: pins follow the page but keep their on-screen size', async () => {
    const m = () => host.evaluate(() => { const p = document.querySelectorAll('.cm-pin')[1].getBoundingClientRect(), c = document.getElementById('pdf-canvas').getBoundingClientRect(); return { w: p.width, h: p.height, fx: (p.left + p.width / 2 - c.left) / c.width, fy: (p.top + p.height / 2 - c.top) / c.height, cw: c.width }; });
    const a = await m(); await host.evaluate(() => { zoomIn(); zoomIn(); zoomIn(); }); await waitFor(host, () => !pdfRendering, null, 10000); await sleep(600);
    const b = await m(); assert.ok(b.cw > a.cw * 1.25, 'page grew'); assert.equal(Math.round(b.w), Math.round(a.w), 'pin width unchanged'); assert.ok(Math.abs(a.fx - b.fx) < 0.01 && Math.abs(a.fy - b.fy) < 0.01, 'pin stays on the same spot of the page');
  });
  await step('dense comments cluster into a numbered badge; clicking lists the threads', async () => {
    await host.evaluate(() => { for (let i = 0; i < 12; i++) { const it = CoopComments.newItem({ id: 'd' + i, k: 'pt', x: .3 + i * .0006, y: .3, c: '#f59e0b', by: 'x', name: 'Dense', text: 'note ' + i, ts: 1 }); applyAnnot('add', 1, it); } CoopCommentsUI.onChanged(); });
    await host.evaluate(() => { fitToWidth && fitToWidth(true); }); await sleep(900);
    await waitFor(host, () => !!document.querySelector('.cm-cluster'), null, 8000);
    assert.equal(await host.evaluate(() => document.querySelector('.cm-cluster').textContent.trim()), '12');
    await host.click('.cm-cluster'); await waitFor(host, () => document.querySelectorAll('#cm-pop .cm-item').length === 12);
  });
  await step('legacy saved notes are upgraded to threads', async () => {
    const r = await host.evaluate(() => { const it = cleanItem({ id: 'old1', t: 'note', x: .2, y: .2, text: 'legacy', name: 'Old', by: 'o' }); return { t: it.t, th: it.th.length }; });
    assert.deepEqual(r, { t: 'cm', th: 1 });
  });

  await step('pinch zoom (two touches): live preview, sharp re-render on release, focal point stays under the fingers', async () => {
    await g2.evaluate(() => { userZoomed = false; fitToWidth(true); }); await sleep(900);
    const cdp = await g2.createCDPSession(); await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const before = await g2.evaluate(() => { const c = document.getElementById('pdf-canvas').getBoundingClientRect(), v = viewerContainer.getBoundingClientRect(); return { z: currentZoom, w: c.width, fx: v.left + v.width / 2, fy: 600, nx: (v.left + v.width / 2 - c.left) / c.width, ny: (600 - c.top) / c.height }; });
    const P = (d) => [{ x: before.fx - d, y: before.fy, id: 1 }, { x: before.fx + d, y: before.fy, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: P(40) });
    for (let d = 40; d <= 120; d += 10) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: P(d) }); await sleep(30); }
    const live = await g2.evaluate(() => document.getElementById('pdf-canvas').style.transform); assert.match(live, /scale\(/, 'live preview transform during the gesture');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitFor(g2, () => !pdfRendering && !document.getElementById('pdf-canvas').style.transform, null, 10000); await sleep(400);
    const after = await g2.evaluate((b) => { const c = document.getElementById('pdf-canvas').getBoundingClientRect(); return { z: currentZoom, nx: (b.fx - c.left) / c.width, ny: (b.fy - c.top) / c.height }; }, before);
    assert.ok(after.z > before.z * 2.4 && after.z < before.z * 3.6, `zoom ${before.z} -> ${after.z}`);
    assert.ok(Math.abs(after.nx - before.nx) < .02 && Math.abs(after.ny - before.ny) < .02, `focal drift ${after.nx - before.nx}, ${after.ny - before.ny}`);
  });
  await step('double tap toggles zoom', async () => {
    const cdp = await g2.createCDPSession(); const z0 = await g2.evaluate(() => currentZoom);
    await g2.evaluate(() => { window.__log = []; for (const ty of ['touchstart', 'touchend']) viewerContainer.addEventListener(ty, e => window.__log.push([ty, Math.round(e.timeStamp), e.changedTouches[0].clientX | 0, e.changedTouches[0].clientY | 0, e.target.id || e.target.className || e.target.tagName]), true); });
    const tap = async () => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1235, y: 700, id: 1 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
    await g2.evaluate(() => window.scrollTo(0, 0)); await tap(); await sleep(100); await tap(); await waitFor(g2, z => Math.round(currentZoom * 100) !== z, Math.round(z0 * 100), 30000).catch(async e => { console.log('    diag', JSON.stringify(await g2.evaluate(() => [currentZoom, window.__fitZoomValue, window.__log, scrollY, tool, state.fileType]))); throw e; }); await waitFor(g2, () => !pdfRendering, null, 8000);
    const z1 = await g2.evaluate(() => currentZoom); assert.notEqual(Math.round(z1 * 100), Math.round(z0 * 100));
  });
  await step('Apple-Pencil style input: stylus touches are cancelled so the page never scrolls, strokes use every coalesced sample', async () => {
    await g1.evaluate(() => { setTool('pen'); window.__prevented = 0; document.addEventListener('touchmove', e => { if (e.defaultPrevented) window.__prevented++; }, { passive: true }); });
    const r = await g1.evaluate(() => { const mk = (type, touchType) => { const t = new Touch({ identifier: 1, target: document.getElementById('annot-svg'), clientX: 200, clientY: 200 }); Object.defineProperty(t, 'touchType', { value: touchType }); return new TouchEvent(type, { touches: [t], changedTouches: [t], cancelable: true, bubbles: true }); };
      const a = mk('touchstart', 'stylus'), b = mk('touchmove', 'stylus'), c = mk('touchmove', 'direct'); document.getElementById('annot-svg').dispatchEvent(a); document.getElementById('annot-svg').dispatchEvent(b); document.getElementById('annot-svg').dispatchEvent(c);
      return { stylusStart: a.defaultPrevented, stylusMove: b.defaultPrevented, fingerMove: c.defaultPrevented }; });
    assert.deepEqual(r, { stylusStart: true, stylusMove: true, fingerMove: false });
    // pen strokes: dispatch pointer events with coalesced samples
    const before = await g1.evaluate(() => (annots[1] || []).filter(a => a.t === 'pen').length);
    await g1.evaluate(() => { const svg = document.getElementById('annot-svg'), r = document.getElementById('pdf-canvas').getBoundingClientRect(); const ev = (type, x, y) => new PointerEvent(type, { pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
      svg.dispatchEvent(ev('pointerdown', r.left + 100, r.top + 100)); for (let i = 1; i <= 40; i++) svg.dispatchEvent(ev('pointermove', r.left + 100 + i * 6, r.top + 100 + Math.sin(i / 4) * 30)); svg.dispatchEvent(ev('pointerup', r.left + 340, r.top + 100)); });
    await waitFor(g1, (n) => (annots[1] || []).filter(a => a.t === 'pen').length === n + 1, before, 5000);
    await waitFor(host, (n) => (annots[1] || []).filter(a => a.t === 'pen').length === n + 1, before, 8000);
    const pen = await host.evaluate(() => annots[1].filter(a => a.t === 'pen').pop()); assert.ok(pen.pts.length > 10);
    assert.equal(await g1.evaluate(() => CoopInput.penSeen()), true, 'after a pen is seen, fingers stop drawing');
    await g1.evaluate(() => setTool(null));
  });
  await step('no page errors', async () => { assert.deepEqual([host, g1, g2].flatMap(p => p.errors || []), []); });
} finally { await browser.close(); srv.close(); }
process.exit(done() ? 1 : 0);
