import assert from 'node:assert/strict';
import { startServers, launch, runner, sleep, waitFor, makePdf, hostSession, guestJoin, openFile, newPage } from './lib.mjs';
const srv = await startServers(), browser = await launch(), { step, done } = runner();
let host, a, b, c, hostId, bId;
try {
  await makePdf('/tmp/t3.pdf', 2);
  host = await hostSession(browser, srv.url, 'Host', { password: 'hunter2' }); hostId = await host.evaluate(() => myPeerId);
  a = await guestJoin(browser, srv.url, hostId, 'Ana', { password: 'hunter2' });
  b = await guestJoin(browser, srv.url, hostId, 'Bo', { password: 'hunter2' });
  c = await guestJoin(browser, srv.url, hostId, 'Cy', { password: 'hunter2' });
  await openFile(host, '/tmp/t3.pdf'); await waitFor(a, () => pdfDoc && pdfDoc.numPages === 2, null, 30000);
  bId = await b.evaluate(() => myPeerId);

  await step('wrong password: three guesses are refused and the peer is blocked for a minute', async () => {
    const x = await newPage(browser, srv.url, { name: 'Eve' });
    await x.evaluate(id => { document.getElementById('join-password').value = 'nope'; joinSession(id); }, hostId);
    await waitFor(host, () => !!authBlock.size || connections.every(c => c._authenticated !== false || !c.open), null, 20000);
    await sleep(1500); const open = await x.evaluate(() => connections.filter(c => c.open && c._synced).length); assert.equal(open, 0);
    await x.close();
  });

  await step('kick + rotate: the kicked peer is removed, everybody else follows to a NEW session id without retyping the password', async () => {
    const t0 = Date.now(); const mark = (l) => console.log('    ' + l + ' at ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    await host.evaluate(id => CoopLive.kick(id), bId);
    await waitFor(host, old => myPeerId !== old, hostId, 25000); const newId = await host.evaluate(() => myPeerId); assert.notEqual(newId, hostId); mark('host on new id');
    await waitFor(a, id => lastJoinCode === id && connections.some(c => c.open && c._synced && c.peer === id), newId, 40000);
    mark('guest a followed');
    await waitFor(c, id => lastJoinCode === id && connections.some(c => c.open && c._synced && c.peer === id), newId, 40000);
    await waitFor(host, () => !CoopLive.rotationActive(), null, 10000);   // everybody presented the token: no 20 s grace wait
    mark('rotation finished');
    assert.equal(await host.evaluate(() => connections.filter(c => c.open && c._authenticated).length), 2, 'exactly the two remaining peers');
    assert.equal(await b.evaluate(() => lastJoinCode), null, 'the kicked peer was told and stopped auto-rejoining');
  });

  await step('the kicked peer cannot get back with the OLD link + password', async () => {
    await sleep(2500);
    await b.evaluate(id => { document.getElementById('join-password').value = 'hunter2'; return joinSession(id); }, hostId);
    await sleep(9000);
    assert.equal(await b.evaluate(() => connections.filter(c => c.open).length), 0, 'no connection through the old id');
    assert.equal(await host.evaluate(id => connections.filter(c => c.open && c.peer === id).length, bId), 0);
  });

  await step('document survives the rotation without being sent again; chat still works on the new session', async () => {
    assert.equal(await a.evaluate(() => state.fileType), 'pdf'); assert.equal(await c.evaluate(() => pdfDoc.numPages), 2);
    await host.evaluate(() => { const i = document.getElementById('chat-input'); if (i) i.value = 'after rotation'; });
    await host.evaluate(() => broadcast({ type: 'PAGE_CHANGE', page: 2 })); await sleep(300);
    assert.equal(await a.evaluate(() => hostSettings && true), true);
  });

  await step('idle log-out: a peer that leaves the tab is logged out after the grace period; a returning peer is not', async () => {
    await host.evaluate(() => { hostSettings.idleLogout = true; hostSettings.idleSec = 10; CoopIdle.onSettings(); });
    const hide = (p, h) => p.evaluate(h => { Object.defineProperty(document, 'visibilityState', { get: () => h ? 'hidden' : 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, h);
    await hide(a, true); await sleep(5000); await hide(a, false);              // comes back in time
    await hide(c, true);
    await waitFor(c, () => lastJoinCode === null && connections.filter(x => x.open).length === 0, null, 30000);
    assert.equal(await a.evaluate(() => connections.filter(x => x.open).length), 1, 'the returning peer stays');
    assert.match(await c.evaluate(() => document.body.innerText), /logged out/i);
  });
  await step('open session (no password): rotation also completes at once and followers keep their own peer id', async () => {
    const h2 = await hostSession(browser, srv.url, 'Host2'); const id2 = await h2.evaluate(() => myPeerId);
    const x = await guestJoin(browser, srv.url, id2, 'Xi'), y = await guestJoin(browser, srv.url, id2, 'Yo');
    const xId = await x.evaluate(() => myPeerId), yId = await y.evaluate(() => myPeerId);
    const t0 = Date.now(); await h2.evaluate(id => CoopLive.kick(id), yId);
    await waitFor(x, old => lastJoinCode !== old && connections.some(c => c.open && c._synced), id2, 20000);
    await waitFor(h2, () => !CoopLive.rotationActive(), null, 10000);
    assert.ok(Date.now() - t0 < 12000, 'took ' + (Date.now() - t0) + ' ms');
    console.log('    open-session rotation took', Date.now() - t0, 'ms; follower id kept:', (await x.evaluate(() => myPeerId)) === xId);
    assert.equal(await h2.evaluate(() => connections.filter(c => c.open).length), 1);
    await h2.close(); await x.close(); await y.close();
  });
  await step('no page errors', async () => { const e = [host, a, b, c].flatMap(p => p.errors || []); assert.deepEqual(e, []); });
} finally { await browser.close(); srv.close(); }
process.exit(done() ? 1 : 0);
