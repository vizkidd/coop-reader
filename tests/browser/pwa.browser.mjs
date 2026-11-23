import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServers, launch, runner, sleep, waitFor, newPage, cdnFile } from './lib.mjs';
const srv = await startServers(), browser = await launch(), { step, done } = runner();
try {
  const page = await newPage(browser, srv.url, { name: 'Offline', sw: true });
  await step('the service worker installs, takes control and caches the app shell', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await waitFor(page, () => navigator.serviceWorker.controller !== null, null, 10000);
    const names = await page.evaluate(async () => { const c = await caches.open('coop-2.1.1'); return (await c.keys()).map(r => new URL(r.url).pathname); });
    for (const f of ['/index.html', '/js/coop-trust.js', '/js/coop-live.js', '/js/vendor/qrcode.js', '/worker.js']) assert.ok(names.includes(f) || (f === '/index.html' && names.includes('/')), f + ' cached: ' + names.join(','));
  });
  await step('pinned CDN libraries are cached the first time they are used', async () => {
    // the sandbox has no internet: answer the service worker\'s own network requests from the npm copies
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/sw.js'));
    const sw = await swTarget.createCDPSession(); await sw.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    sw.on('Fetch.requestPaused', async e => { const f = cdnFile(e.request.url);
      try { if (f) await sw.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/javascript' }], body: fs.readFileSync(f).toString('base64') }); else await sw.send('Fetch.continueRequest', { requestId: e.requestId }); } catch (_) {} });
    await page.reload({ waitUntil: 'load' }); await sleep(800);
    assert.equal(await page.evaluate(() => typeof Peer + '/' + typeof pdfjsLib), 'function/object');
    const cdn = await page.evaluate(async () => { const c = await caches.open('coop-2.1.1'); return (await c.keys()).map(r => r.url).filter(u => !u.startsWith(location.origin)); });
    assert.ok(cdn.some(u => /peerjs/.test(u)) && cdn.some(u => /pdf\.min\.js/.test(u)), cdn.join(','));
  });
  await step('offline: with the web server stopped and the network off, the app still starts from the cache', async () => {
    srv.close(); await page.setOfflineMode(true); await sleep(300);
    await page.reload({ waitUntil: 'load' }); await sleep(800);
    const r = await page.evaluate(() => ({ title: document.title, start: typeof startHost, peer: typeof Peer, pdf: typeof pdfjsLib, ctl: !!navigator.serviceWorker.controller, trust: typeof CoopTrust }));
    assert.deepEqual(r, { title: await page.title(), start: 'function', peer: 'function', pdf: 'object', ctl: true, trust: 'object' });
    assert.match(r.title, /Coop|Reader/i);
    assert.deepEqual(page.errors || [], []);
  });
} finally { await browser.close(); try { srv.close(); } catch (_) {} }
process.exit(done() ? 1 : 0);
