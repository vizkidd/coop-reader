import test from 'node:test';
import assert from 'node:assert/strict';
import Worker, { Room } from '../src/relay-worker.js';

class MemoryStorage {
  constructor() { this.values = new Map(); this.writes = 0; }
  async get(k) { return this.values.get(k); }
  async put(k, v) { this.writes++; this.values.set(k, structuredClone(v)); }
  async delete(k) { return this.values.delete(k); }
  async deleteAll() { this.values.clear(); }
  async list({ prefix = '' } = {}) { return new Map([...this.values.entries()].filter(([k]) => k.startsWith(prefix))); }
}
// `stores` outlives Room objects, so a new Room over the same storage simulates a Durable Object eviction.
function makeEnv(vars = {}, stores = new Map()) {
  const rooms = new Map();
  const ROOMS = {
    idFromName: n => n,
    get(id) {
      if (!stores.has(id)) stores.set(id, new MemoryStorage());
      if (!rooms.has(id)) rooms.set(id, new Room({ storage: stores.get(id) }, vars));
      return { fetch: r => rooms.get(id).fetch(r) };
    },
  };
  return { env: { ROOMS, ...vars }, stores, evict: () => rooms.clear() };
}
async function call(env, path, { method = 'GET', body, token, raw } = {}) {
  const h = new Headers(); if (body !== undefined) h.set('Content-Type', 'application/json'); if (token) h.set('Authorization', `Bearer ${token}`);
  const res = await Worker.fetch(new Request(`https://relay.test${path}`, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (_) {}
  return { res, data, text };
}
const host = async (env, room) => (await call(env, `/room/${room}/http/join`, { method: 'POST', body: { id: room, role: 'host', name: 'H' } })).data.token;
const guest = async (env, room, id = 'g1') => (await call(env, `/room/${room}/http/join`, { method: 'POST', body: { id, role: 'guest', name: id } })).data.token;

test('no per-file cap: multi-hundred-MB descriptions are accepted; chunk size is negotiated and reported', async () => {
  const { env } = makeEnv(); const t = await host(env, 'r1');
  const size = 700 * 1048576, chunk = 1048576, chunks = Math.ceil(size / chunk);
  const m = await call(env, '/room/r1/blob/f1/meta?id=r1', { method: 'POST', token: t, body: { name: 'big.pdf', size, chunks, chunk, fp: 'fp1' } });
  assert.equal(m.res.status, 200); assert.equal(m.data.chunk, chunk);
  const gt = await guest(env, 'r1');
  const info = await call(env, '/room/r1/blob/f1/meta?id=g1', { token: gt });
  assert.equal(info.data.chunk, chunk); assert.equal(info.data.size, size); assert.equal(info.data.done, false);
  // legacy clients (no chunk field) still get the 96 KiB default
  const legacy = await call(env, '/room/r1/blob/f2/meta?id=r1', { method: 'POST', token: t, body: { name: 'a.pdf', size: 300000, chunks: Math.ceil(300000 / 98304), fp: 'x' } });
  assert.equal(legacy.data.chunk, 98304);
  // a wrong chunk count for the stated chunk size is refused
  const bad = await call(env, '/room/r1/blob/f3/meta?id=r1', { method: 'POST', token: t, body: { name: 'a', size: 300000, chunks: 3, chunk: 1048576, fp: 'x' } });
  assert.equal(bad.res.status, 400);
  const tiny = await call(env, '/room/r1/blob/f4/meta?id=r1', { method: 'POST', token: t, body: { name: 'a', size: 1000, chunks: 1000, chunk: 1, fp: 'x' } });
  assert.equal(tiny.res.status, 400, 'chunk sizes below the minimum are refused');
});

test('upload with 256 KiB chunks round-trips; metadata writes are batched', async () => {
  const { env, stores } = makeEnv(); const t = await host(env, 'r2'), gt = await guest(env, 'r2');
  const chunk = 262144, size = chunk * 20 + 1234, chunks = 21, data = new Uint8Array(size).map((_, i) => (i * 7) & 255);
  await call(env, '/room/r2/blob/f/meta?id=r2', { method: 'POST', token: t, body: { name: 'b.bin', size, chunks, chunk, fp: 'fp' } });
  const before = stores.get('r2').writes;
  for (let i = 0; i < chunks; i++) {
    const part = data.slice(i * chunk, Math.min(size, (i + 1) * chunk));
    const r = await call(env, `/room/r2/blob/f/${i}?id=r2`, { method: 'PUT', token: t, raw: part });
    assert.equal(r.res.status, 200, r.text);
  }
  const writes = stores.get('r2').writes - before;
  assert.ok(writes <= chunks + 4, `expected ~1 write per chunk plus a few metadata writes, got ${writes}`);
  assert.equal((await call(env, '/room/r2/blob/f/meta?id=g1', { token: gt })).data.done, true);
  const last = await Worker.fetch(new Request(`https://relay.test/room/r2/blob/f/20?id=g1`, { headers: { Authorization: `Bearer ${gt}` } }), env);
  assert.equal((await last.arrayBuffer()).byteLength, 1234);
  const wrong = await call(env, '/room/r2/blob/f/3?id=r2', { method: 'PUT', token: t, raw: new Uint8Array(10) });
  assert.equal(wrong.res.status, 400);
});

test('operators can cap file size and room storage with [vars]; the oldest files are evicted first', async () => {
  const { env } = makeEnv({ MAX_BLOB_MB: '5', ROOM_QUOTA_MB: '8' }); const t = await host(env, 'r3');
  const meta = (fid, mb) => call(env, `/room/r3/blob/${fid}/meta?id=r3`, { method: 'POST', token: t, body: { name: fid, size: mb * 1048576, chunks: mb, chunk: 1048576, fp: fid } });
  assert.equal((await meta('big', 6)).res.status, 413);
  assert.equal((await meta('big', 6)).data.code, 'too-large');
  assert.equal((await meta('a', 4)).res.status, 200); assert.equal((await meta('b', 4)).res.status, 200);
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await meta('c', 4)).res.status, 200, 'third file fits after evicting the oldest');
  const gt = await guest(env, 'r3');
  assert.equal((await call(env, '/room/r3/blob/a/meta?id=g1', { token: gt })).res.status, 404, 'oldest evicted');
  assert.equal((await call(env, '/room/r3/blob/c/meta?id=g1', { token: gt })).res.status, 200);
  const unlimited = makeEnv({ MAX_BLOB_MB: '0', ROOM_QUOTA_MB: '0' }); const ut = await host(unlimited.env, 'r4');
  assert.equal((await call(unlimited.env, '/room/r4/blob/x/meta?id=r4', { method: 'POST', token: ut, body: { name: 'x', size: 20000 * 1048576, chunks: 20000, chunk: 1048576, fp: 'x' } })).res.status, 200);
});

test('HTTP peers survive a Durable Object eviction (token restored from storage)', async () => {
  const { env, evict } = makeEnv(); const t = await host(env, 'r5'), gt = await guest(env, 'r5', 'kindle-1');
  evict();   // new Room object, same storage
  const poll = await call(env, '/room/r5/http/poll?id=kindle-1', { token: gt });
  assert.equal(poll.res.status, 200, 'registered peer must not be forced to re-join');
  const bad = await call(env, '/room/r5/http/poll?id=kindle-1', { token: 'nope' });
  assert.equal(bad.res.status, 401);
  const hp = await call(env, '/room/r5/http/poll?id=r5', { token: t }); assert.equal(hp.res.status, 200);
});

test('host can end the session: the room id is burned, PINs die, files are wiped', async () => {
  const { env } = makeEnv(); const t = await host(env, 'r6'); const gt = await guest(env, 'r6');
  const pin = await call(env, '/pin/create', { method: 'POST', body: { room: 'r6', key: 'k' } }); assert.equal(pin.res.status, 200);
  assert.equal((await call(env, `/pin/${pin.data.pin}`)).res.status, 200);
  assert.equal((await call(env, '/room/r6/revoke?id=r6', { method: 'POST', token: gt, body: {} })).res.status, 403, 'guests cannot end sessions');
  assert.equal((await call(env, '/room/r6/revoke?id=r6', { method: 'POST', token: t, body: {} })).res.status, 200);
  assert.equal((await call(env, `/pin/${pin.data.pin}`)).res.status, 404, 'the old PIN must stop resolving');
  const again = await call(env, '/room/r6/http/join', { method: 'POST', body: { id: 'late', role: 'guest' } });
  assert.equal(again.res.status, 410); assert.equal(again.data.code, 'revoked');
  assert.equal((await call(env, '/room/r6/http/join', { method: 'POST', body: { id: 'r6', role: 'host' } })).res.status, 410);
});

test('host can remove one participant; that id cannot join again', async () => {
  const { env } = makeEnv(); const t = await host(env, 'r7'); await guest(env, 'r7', 'bad'); const ok = await guest(env, 'r7', 'good');
  assert.equal((await call(env, '/room/r7/ban?id=r7', { method: 'POST', token: t, body: { peer: 'bad' } })).res.status, 200);
  assert.equal((await call(env, '/room/r7/http/join', { method: 'POST', body: { id: 'bad', role: 'guest' } })).res.status, 403);
  assert.equal((await call(env, '/room/r7/http/poll?id=good', { token: ok })).res.status, 200);
  assert.equal((await call(env, '/room/r7/ban?id=r7', { method: 'POST', token: ok, body: { peer: 'r7' } })).res.status, 403);
});

test('/ice: empty without secrets; with secrets it mints credentials, drops port 53 and caches', async () => {
  const none = await call(makeEnv().env, '/ice'); assert.equal(none.data.turn, false); assert.deepEqual(none.data.iceServers, []);
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.match(String(url), /\/v1\/turn\/keys\/KEY1\/credentials\/generate-ice-servers$/); assert.equal(init.headers.Authorization, 'Bearer TOK');
    return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] }), { status: 201 });
  };
  try {
    const { env } = makeEnv({ TURN_KEY_ID: 'KEY1', TURN_KEY_API_TOKEN: 'TOK' });
    const r = await call(env, '/ice'); assert.equal(r.data.turn, true);
    const urls = r.data.iceServers.flatMap(s => s.urls); assert.ok(!urls.some(u => /:53/.test(u))); assert.equal(r.data.iceServers[1].username, 'u');
    await call(env, '/ice'); assert.equal(calls, 1, 'second call served from cache');
  } finally { globalThis.fetch = realFetch; }
});

test('root document advertises protocol 4 features and chunk limits', async () => {
  const r = await call(makeEnv().env, '/'); assert.equal(r.data.protocol, 4);
  for (const f of ['ws-binary', 'ws-hibernation', 'blob-chunk-negotiation', 'revoke', 'ice']) assert.ok(r.data.features.includes(f), f);
  assert.equal(r.data.blobChunk.max, 1048576);
});
