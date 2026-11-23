import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './helpers/load.mjs';
const { CoopCodec: C } = loadScript('coop-codec.js');

test('stroke codec round-trips to 4 decimals and is much smaller than [[x,y]] JSON', () => {
  const pts = []; let x = 0.1, y = 0.2;
  for (let i = 0; i < 400; i++) { x += 0.0021 + Math.sin(i / 9) * 0.001; y += 0.0017 * Math.cos(i / 7); pts.push([+x.toFixed(4), +y.toFixed(4)]); }
  const flat = C.encodePts(pts), back = C.decodePts(flat);
  assert.equal(back.length, pts.length);
  back.forEach((p, i) => { assert.ok(Math.abs(p[0] - pts[i][0]) < 1e-4); assert.ok(Math.abs(p[1] - pts[i][1]) < 1e-4); });
  const before = JSON.stringify(pts).length, after = JSON.stringify(flat).length;
  assert.ok(after < before * 0.45, `expected <45% got ${(after / before * 100).toFixed(0)}%`);
});

test('control messages are deflated only when it pays off', async () => {
  const big = { type: 'ANNOT_ALL', all: { 1: Array.from({ length: 60 }, (_, i) => ({ id: 'a' + i, t: 'note', text: 'hello world '.repeat(8) })) } };
  const p = await C.packControl(big);
  assert.equal(p.msg.type, 'Z'); assert.ok(p.saved > 1000);
  assert.deepEqual(await C.unpackControl(p.msg), big);
  const small = { type: 'PING' };
  assert.equal((await C.packControl(small)).msg, small);
  assert.deepEqual(await C.unpackControl(small), small);   // plain messages pass through
});

test('chunk policy stops compressing incompressible data after three misses', async () => {
  const pol = C.createChunkPolicy();
  const rnd = () => { const u = new Uint8Array(65536); for (let i = 0; i < u.length; i += 65536) crypto.getRandomValues(u.subarray(i, i + 65536)); return u; };
  for (let i = 0; i < 3; i++) assert.equal((await pol.encode(rnd())).z, 0);
  assert.equal(pol.disabled, true);
  const pol2 = C.createChunkPolicy();
  const txt = new TextEncoder().encode('lorem ipsum '.repeat(6000));
  const r = await pol2.encode(txt); assert.equal(r.z, 1); assert.ok(r.d.length < txt.length / 5);
});

test('packed messages carry binary without base64 and survive a round trip', () => {
  const data = new Uint8Array(70000).map((_, i) => i & 255);
  const msg = { type: 'FILE_CHUNK', index: 7, data, extra: { nested: new Uint8Array([1, 2, 3]) } };
  const wire = C.packMessage(msg);
  assert.ok(wire.length < 70000 + 200, 'overhead must stay tiny (' + wire.length + ')');
  const back = C.unpackMessage(wire);
  assert.equal(back.index, 7); assert.deepEqual([...back.data.subarray(0, 4)], [0, 1, 2, 3]); assert.equal(back.data.length, 70000);
  assert.deepEqual([...back.extra.nested], [1, 2, 3]);
});

test('packed message references cannot point outside the frame', () => {
  const wire = C.packMessage({ a: new Uint8Array(4) });
  const h = new TextDecoder().decode(wire.subarray(4, 4 + new DataView(wire.buffer).getUint32(0)));
  const evil = new TextEncoder().encode(h.replace('[0,4]', '[0,9999]'));
  const out = new Uint8Array(4 + evil.length + 4); new DataView(out.buffer).setUint32(0, evil.length); out.set(evil, 4);
  assert.throws(() => C.unpackMessage(out));
});

test('relay frames round-trip and reject garbage', () => {
  const body = new Uint8Array([9, 8, 7]);
  const f = C.frameToRelay('peer-1', body), p = C.parseClientFrame(f);
  assert.equal(p.to, 'peer-1'); assert.deepEqual([...p.body], [9, 8, 7]);
  const g = C.frameFromRelay(C.frameForClient('web-abc', body));
  assert.equal(g.from, 'web-abc'); assert.deepEqual([...g.body], [9, 8, 7]);
  assert.equal(C.parseClientFrame(new Uint8Array([5, 1, 2])), null);
  assert.equal(C.frameFromRelay(new Uint8Array([2, 200, 1])), null);
});
