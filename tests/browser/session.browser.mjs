import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServers, launch, runner, sleep, waitFor, makePdf, hostSession, guestJoin, openFile } from './lib.mjs';
const srv = await startServers(), browser = await launch(), { step, done } = runner();
const errs = pages => pages.flatMap(p => p.errors || []);
let host, g1;
try {
  await makePdf('/tmp/t3.pdf', 3);
  await step('host starts a session and a guest joins', async () => {
    host = await hostSession(browser, srv.url, 'Host');
    g1 = await guestJoin(browser, srv.url, await host.evaluate(() => myPeerId), 'Ana');
    assert.equal(await host.evaluate(() => connections.filter(c => c.open).length), 1);
  });
  await step('connection route is reported from the selected ICE pair (not "TURN" just because a relay candidate was gathered)', async () => {
    await waitFor(host, () => connections.some(c => c._route), null, 15000);
    const r = await host.evaluate(() => ({ route: connections[0]._route, label: routeLabel(connections[0]) }));
    assert.ok(['p2p', 'stun'].includes(r.route), JSON.stringify(r)); assert.match(r.label, /direct/);
  });
  await step('a PDF opened by the host arrives at the guest (streamed from a Blob, verified by fingerprint)', async () => {
    await openFile(host, '/tmp/t3.pdf');
    await waitFor(g1, () => cachedFileBytes && state.fileType === 'pdf' && pdfDoc && pdfDoc.numPages === 3, null, 30000);
    assert.equal(await g1.evaluate(() => cachedFp), await host.evaluate(() => cachedFp));
    assert.equal(await g1.evaluate(() => cachedFileBytes instanceof Blob), true);
  });
  await step('rejoining with the same document does NOT download it again (FILE_SKIP)', async () => {
    await g1.evaluate(() => { window.__ref = cachedFileBytes; connections[0].close(); });
    await waitFor(g1, () => connections.some(c => c.open && c._synced), null, 40000);
    await sleep(1500);
    assert.equal(await g1.evaluate(() => cachedFileBytes === window.__ref), true, 'blob object must be unchanged');
  });
  await step('a file tampered with in the middle (head and tail intact, so the short fingerprint matches) is rejected by the signed SHA-256', async () => {
    const before = await g1.evaluate(() => cachedFp);
    await host.evaluate(async (peerId) => {
      const u = new Uint8Array(3 * 1024 * 1024); crypto.getRandomValues(u.subarray(0, 65536)); crypto.getRandomValues(u.subarray(u.length - 65536));
      for (let i = 65536; i < u.length - 65536; i += 4096) u[i] = (i / 4096) & 255;
      const blob = new File([u], 'tamper.pdf'), orig = CoopStore.readSlice;
      CoopStore.readSlice = async (b, off, len) => { const r = await orig(b, off, len); if (off === 25 * 65536) r[100] ^= 255; return r; };   // a malicious helper flips one byte in transit
      await sendFileToConn(connections.find(c => c.peer === peerId), 'tamper.pdf', blob); CoopStore.readSlice = orig;
    }, await g1.evaluate(() => myPeerId));
    await sleep(2500);
    assert.equal(await g1.evaluate(() => cachedFp), before, 'the tampered file must not replace the open document');
  });

  await step('100 MB document: no size limit, spooled to disk, opens with range requests', async () => {
    await makePdf('/tmp/big.pdf', 4, 100 * 1024 * 1024);
    const size = fs.statSync('/tmp/big.pdf').size; assert.ok(size > 100e6);
    const kind = await g1.evaluate(async () => { const s = await CoopStore.createSpool(100e6); const k = s.kind; await s.abort(); return k; });
    console.log('    spool backend in this browser:', kind);
    const t0 = Date.now(); await openFile(host, '/tmp/big.pdf');
    await waitFor(g1, () => cachedFileBytes && cachedFileBytes.size > 100e6 && pdfDoc && pdfDoc.numPages === 4, null, 240000);
    console.log('    transferred in', ((Date.now() - t0) / 1000).toFixed(1), 's');
    assert.equal(await g1.evaluate(() => cachedFp), await host.evaluate(() => cachedFp));
  });
  await step('no page errors during all of that', async () => { const e = errs([host, g1]); assert.deepEqual(e, []); });
} finally { await browser.close(); srv.close(); }
process.exit(done() ? 1 : 0);
