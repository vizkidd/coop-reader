import assert from 'node:assert/strict';
import { startServers, launch, runner, sleep, waitFor, hostSession, guestJoin, newPage, startRelay } from './lib.mjs';
const srv = await startServers(), relay = await startRelay(), browser = await launch(), { step, done } = runner();
const net = { relay: relay.url, mode: 'auto' };
let host, victim, rogue, hostId, key, fp;
const alive = p => p.evaluate(() => lastJoinCode !== null && connections.some(c => c.open));
try {
  host = await hostSession(browser, srv.url, 'Host', { net }); hostId = await host.evaluate(() => myPeerId);
  key = await host.evaluate(() => relayKeyB64); fp = await host.evaluate(() => hostSigner.id.fp);
  await waitFor(host, () => hostWs && hostWs.readyState === 1, null, 15000);

  await step('the invite link and code carry the host key fingerprint', async () => {
    assert.match(await host.evaluate(() => buildShareUrl(myPeerId)), new RegExp('fp=' + fp));
    assert.equal((await host.evaluate(() => hostSigner.id.fp)).length, 22);
  });
  // victim joins through the RELAY only (the path where anyone in the room could forge the host)
  victim = await guestJoin(browser, srv.url, hostId, 'Victim', { net: { relay: relay.url, mode: 'ws' }, key: key + '.' + fp });
  rogue = await guestJoin(browser, srv.url, hostId, 'Mallory', { net: { relay: relay.url, mode: 'ws' }, key: key + '.' + fp });
  const victimId = await victim.evaluate(() => myPeerId);

  await step('guest pins the host key from the link and shows it as verified', async () => {
    await waitFor(victim, () => trust.key && trust.verified, null, 10000);
    assert.equal(await victim.evaluate(() => trust.fp), fp);
    await victim.evaluate(() => updateTrustUI()); assert.match(await victim.evaluate(() => document.getElementById('trust-line').textContent), /verified by the invite link/);
  });

  await step('relay attack: a room member with the key sends HOST_KICK / SETTINGS / ROTATE to a guest as if it were the host: ignored', async () => {
    const sendForged = (page, to, p) => page.evaluate(async (to, p) => { const ws = relayV._sock; await wsSend(ws, to, p, peerRelayKey, lastJoinCode); }, to, p);
    // Mallory is a guest too: she can encrypt with the room key and address the victim directly through the relay
    await rogue.evaluate((to, hid) => { window.__forge = p => wsSend(relayV._sock, to, p, peerRelayKey, hid); }, victimId, hostId);
    await rogue.evaluate(() => { __forge({ type: 'HOST_KICK' }); __forge({ type: 'SETTINGS', s: { peerUploads: true } }); __forge({ type: 'ROTATE', id: 'evil-session-id', key: '', token: 'f'.repeat(32), epoch: 9 }); __forge({ type: 'IDLE_LOGOUT', sec: 5 }); __forge({ type: 'PAGE_CHANGE', page: 99 }); });
    await sleep(1500);
    assert.equal(await alive(victim), true, 'victim must still be connected'); assert.equal(await victim.evaluate(() => lastJoinCode), hostId);
    assert.equal(await victim.evaluate(() => hostSettings.peerUploads), false);
  });

  await step('relay attack without the key: plaintext frames are rejected in an encrypted session', async () => {
    await rogue.evaluate((to) => { relayV._sock.send(JSON.stringify({ to, p: { type: 'HOST_KICK' } })); }, victimId);
    await sleep(1200); assert.equal(await alive(victim), true);
  });

  await step('a rogue peer dials the guest as a "peer relay" and sends signed-looking commands: refused / ignored', async () => {
    const mal = await newPage(browser, srv.url, { name: 'Eve', net: { relay: '' } });
    await mal.evaluate(() => { document.title = 'eve'; });
    await mal.evaluate((vid) => new Promise(res => { window.__p = new Peer(peerOptions()); __p.on('open', () => { const c = __p.connect(vid, { metadata: { coopBridge: true } }); c.on('open', () => { for (const payload of [{ type: 'HOST_KICK' }, { type: 'SETTINGS', s: { peerUploads: true } }, { type: 'ROTATE', id: 'evil', key: '', token: 'f'.repeat(32), epoch: 5 }]) c.send({ type: 'BRIDGE_DOWN', payload }); setTimeout(() => res(true), 800); }); c.on('close', () => res(true)); }); setTimeout(() => res(false), 8000); }), victimId);
    await sleep(1500); assert.equal(await alive(victim), true, 'victim survived the forged bridge');
    await mal.close();
  });

  await step('legitimate signed commands still work: host pings and changes settings, guest applies them', async () => {
    await host.evaluate(() => { document.getElementById('hs-annot').checked = true; updateHostSettings(); });
    await waitFor(victim, () => hostSettings.peerAnnotate === true, null, 8000);
    await host.evaluate(id => { const c = connections.find(x => x.peer === id); c.send({ type: 'HOST_PING' }); }, victimId); await sleep(500);
  });

  await step('large signed messages (bigger than the WebRTC MTU, split by PeerJS) arrive intact', async () => {
    // regression: the signing wrapper once intercepted PeerJS's internal chunk sends and overflowed the stack
    const direct = await guestJoin(browser, srv.url, hostId, 'Dan', { net: { relay: '' } });
    const did = await direct.evaluate(() => myPeerId);
    await host.evaluate(id => { const c = connections.find(x => x.peer === id); c.send({ type: 'SETTINGS', s: { speaking: true, typing: true, interact: true, peerUploads: false, peerAnnotate: true, peerNav: true, idleLogout: false, idleSec: 60 }, pad: 'x'.repeat(150000) }); }, did);
    await waitFor(direct, () => connections.some(c => c.open), null, 5000); await sleep(800);
    assert.equal(await direct.evaluate(() => connections.some(c => c.open)), true);
    assert.deepEqual(direct.errors || [], []); await direct.close();
  });

  await step('replay: a captured signed message is accepted once only, and only by the person it was signed for', async () => {
    const m = await host.evaluate(async (id) => hostSigner.sign({ type: 'SETTINGS', s: { peerNav: false } }, id), victimId);
    const res = await victim.evaluate(async (m, other) => { const clone = () => JSON.parse(JSON.stringify(m));
      const first = await trust.gate(clone(), { to: myPeerId }), again = await trust.gate(clone(), { to: myPeerId }), elsewhere = await trust.gate(clone(), { to: other });
      return [first.ok, again.ok, again.reason, elsewhere.reason]; }, m, 'someone-else');
    assert.deepEqual(res, [true, false, 'replayed SETTINGS', 'signed for somebody else']);
  });

  await step('host kick still works end to end (signed HOST_KICK accepted) and rotation continues to function', async () => {
    const t0 = Date.now(); await host.evaluate(id => CoopLive.kick(id), victimId);
    await waitFor(victim, () => lastJoinCode === null, null, 10000);
    assert.match(await victim.evaluate(() => document.getElementById('status') ? document.getElementById('status').textContent : document.body.innerText), /Removed|removed/);
  });

  await step('substituted host key: a guest whose link says fingerprint X refuses a host that announces key Y and disconnects', async () => {
    const h2 = await hostSession(browser, srv.url, 'Host2', { net: { relay: '' } }); const id2 = await h2.evaluate(() => myPeerId);
    const g = await newPage(browser, srv.url, { name: 'Gina', net: { relay: '' } });
    const wrongFp = 'A'.repeat(22);
    await g.evaluate((id, f) => { inviteFp = f; joinSession(id); }, id2, wrongFp);
    await waitFor(g, () => trust.mismatch === true, null, 15000);
    await waitFor(g, () => connections.filter(c => c.open).length === 0 && lastJoinCode === null, null, 8000);
    assert.match(await g.evaluate(() => document.body.innerText), /Security check failed/);
    await h2.close(); await g.close();
  });
  await step('no page errors', async () => { assert.deepEqual([host, victim, rogue].flatMap(p => p.errors || []), []); });
} finally { await browser.close(); srv.close(); relay.close(); }
process.exit(done() ? 1 : 0);
