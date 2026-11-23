import assert from 'node:assert/strict';
import { startServers, launch, runner, sleep, waitFor, makePdf, hostSession, guestJoin, openFile, startRelay } from './lib.mjs';
const srv = await startServers(), relay = await startRelay(), browser = await launch(), { step, done } = runner();
const COUNT = `window.__bin = 0; window.__txt = 0; const _s = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (typeof d === 'string') { if (d !== 'ping') window.__txt++; } else window.__bin++; return _s.call(this, d); };`;
let host, g;
try {
  await makePdf('/tmp/relay.pdf', 3, 3 * 1024 * 1024);
  const net = { relay: relay.url, mode: 'auto' };
  host = await hostSession(browser, srv.url, 'Host', { net, init: COUNT }); const hostId = await host.evaluate(() => myPeerId), key = await host.evaluate(() => relayKeyB64);
  await waitFor(host, () => hostWs && hostWs.readyState === 1, null, 15000);
  await step('relay announces binary frames and the app picks that up', async () => { await waitFor(host, () => relayCaps.binary === true, null, 10000); });

  await step('a guest on a "relay only" network joins through the relay server', async () => {
    g = await guestJoin(browser, srv.url, hostId, 'Ana', { net: { relay: relay.url, mode: 'ws' }, init: COUNT, key });
    assert.equal(await g.evaluate(() => connections[0]._ws === true), true);
    assert.match(await g.evaluate(() => routeLabel(connections[0])), /relay/);
  });
  await step('a PDF crosses the relay as raw binary frames (no base64), integrity checked', async () => {
    await waitFor(g, () => relayCaps.binary === true, null, 10000);
    const before = await host.evaluate(() => window.__bin);
    await openFile(host, '/tmp/relay.pdf');
    await waitFor(g, () => cachedFileBytes && cachedFileBytes.size > 3e6 && pdfDoc && pdfDoc.numPages === 3, null, 60000);
    assert.equal(await g.evaluate(() => cachedFp), await host.evaluate(() => cachedFp));
    const sent = (await host.evaluate(() => window.__bin)) - before; assert.ok(sent > 40, 'binary frames sent by the host: ' + sent);
  });
  await step('idle relay sockets use raw ping (answered without waking the relay) instead of JSON traffic', async () => {
    const t0 = await g.evaluate(() => window.__txt); await sleep(25000);
    const t1 = await g.evaluate(() => window.__txt); assert.ok(t1 - t0 <= 2, 'JSON frames while idle: ' + (t1 - t0));
  });
  await g.close();

  // background upgrade: a guest stuck on the relay moves to a direct route once one is possible
  await step('relay -> direct: a guest that fell back to the relay is upgraded automatically (and the relay socket is released)', async () => {
    const u = await guestJoin(browser, srv.url, hostId, 'Bo', { key, net, init: `${COUNT}; (function(){ const orig = null; window.__blockConnect = true; document.addEventListener('DOMContentLoaded', () => { const c = Peer.prototype.connect; window.__origConnect = c; Peer.prototype.connect = function () { if (window.__blockConnect) { return { open: false, on() {}, send() {}, close() {}, peer: arguments[0], metadata: {} }; } return c.apply(this, arguments); }; }); })()`, timeout: 60000 });
    assert.equal(await u.evaluate(() => connections.some(c => c.open && c._ws)), true, 'fell back to the relay');
    await u.evaluate(() => { window.__blockConnect = false; CoopLive.planner.reset(); CoopLive.planner.nextAt = Date.now(); });
    await waitFor(u, () => connections.some(c => c.open && !c._ws && !c._virtual && c._synced), null, 40000);
    assert.equal(await u.evaluate(() => relayV === null), true);
    assert.equal(await host.evaluate(() => connections.filter(c => c.open && c._authenticated).length), 1, 'host swapped the connection instead of adding one');
    await sleep(1500); assert.deepEqual(u.errors || [], []);
  });
  await step('no page errors', async () => { assert.deepEqual(host.errors || [], []); });
} finally { await browser.close(); srv.close(); relay.close(); }
process.exit(done() ? 1 : 0);
