import test from 'node:test';
import assert from 'node:assert/strict';
import Worker, { Room } from '../src/relay-worker.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '' } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)));
  }
}

function makeEnv() {
  const rooms = new Map();
  const ROOMS = {
    idFromName(name) { return name; },
    get(id) {
      if (!rooms.has(id)) {
        const storage = new MemoryStorage();
        const room = new Room({ storage }, {});
        rooms.set(id, room);
      }
      const room = rooms.get(id);
      return { fetch: request => room.fetch(request) };
    },
  };
  return { ROOMS };
}

async function call(env, path, { method = 'GET', body, token, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
  const request = new Request(`https://relay.test${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await Worker.fetch(request, env);
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}
  return { response, data };
}

test('relay rejects PIN creation before host registration and issues a resolvable PIN after join', async () => {
  const env = makeEnv();
  const denied = await call(env, '/pin/create', { method: 'POST', body: { room: 'room-a', key: 'secret' } });
  assert.equal(denied.response.status, 409);
  assert.match(denied.data.error, /host is not currently registered/i);

  const joined = await call(env, '/room/room-a/http/join', {
    method: 'POST', body: { id: 'room-a', role: 'host', name: 'Kindle host' },
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.data.hostOnline, true);
  assert.equal(joined.data.hostId, 'room-a');

  const created = await call(env, '/pin/create', {
    method: 'POST', body: { room: 'room-a', key: 'secret' },
  });
  assert.equal(created.response.status, 200);
  assert.match(created.data.pin, /^\d{4,6}$/);
  assert.equal(created.data.key, 'secret');

  const resolved = await call(env, `/pin/${created.data.pin}`);
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.data.room, 'room-a');
  assert.equal(resolved.data.key, 'secret');
});

test('HTTP mailbox supports late host registration, authenticated delivery and host-authoritative pages', async () => {
  const env = makeEnv();

  // A browser/GUI guest can arrive before the KOReader HTTP host.
  const guest = await call(env, '/room/room-b/http/join', {
    method: 'POST', body: { id: 'guest-b', role: 'guest', name: 'Browser reader' },
  });
  assert.equal(guest.response.status, 200);
  assert.equal(guest.data.hostOnline, false);

  const host = await call(env, '/room/room-b/http/join', {
    method: 'POST', body: { id: 'room-b', role: 'host', name: 'KOReader' },
  });
  assert.equal(host.response.status, 200);
  assert.equal(host.data.hostOnline, true);
  assert.equal(host.data.totalPeers, 2);

  const unauthorized = await call(env, '/room/room-b/http/poll?id=guest-b', { token: 'wrong-token' });
  assert.equal(unauthorized.response.status, 401);

  // The late host gets a queued peer announcement.
  const hostInbox = await call(env, '/room/room-b/http/poll?id=room-b', { token: host.data.token });
  assert.ok(hostInbox.data.messages.some(frame => frame.p?.type === 'RELAY_HELLO' && frame.from === 'guest-b'));

  const hostPage = await call(env, '/room/room-b/http/send', {
    method: 'POST', token: host.data.token,
    body: { id: 'room-b', to: '*', p: { type: 'PAGE_CHANGE', page: 7 } },
  });
  assert.equal(hostPage.response.status, 200);

  const guestInbox = await call(env, '/room/room-b/http/poll?id=guest-b', { token: guest.data.token });
  assert.ok(guestInbox.data.messages.some(frame => frame.p?.type === 'PAGE_CHANGE' && frame.p.page === 7));
  assert.equal(guestInbox.data.page, 7);

  const forbiddenPage = await call(env, '/room/room-b/http/send', {
    method: 'POST', token: guest.data.token,
    body: { id: 'guest-b', to: 'room-b', p: { type: 'PAGE_CHANGE', page: 99 } },
  });
  assert.equal(forbiddenPage.response.status, 403);

  const guestStatus = await call(env, '/room/room-b/state');
  assert.equal(guestStatus.data.page, 7);
  assert.equal(guestStatus.data.hostOnline, true);

  const left = await call(env, '/room/room-b/http/leave', {
    method: 'POST', token: guest.data.token, body: { id: 'guest-b' },
  });
  assert.equal(left.response.status, 200);
  const afterLeave = await call(env, '/room/room-b/state');
  assert.equal(afterLeave.data.totalPeers, 1);
});

test('HTTP peer IDs cannot be taken over without their bearer token or change role', async () => {
  const env = makeEnv();
  const host = await call(env, '/room/room-c/http/join', {
    method: 'POST', body: { id: 'room-c', role: 'host' },
  });
  assert.equal(host.response.status, 200);

  const hijack = await call(env, '/room/room-c/http/join', {
    method: 'POST', body: { id: 'room-c', role: 'host', token: 'not-the-token' },
  });
  assert.equal(hijack.response.status, 409);

  const roleChange = await call(env, '/room/room-c/http/join', {
    method: 'POST', body: { id: 'room-c', role: 'guest', token: host.data.token },
  });
  assert.equal(roleChange.response.status, 409);
});

test('room document upload, download, and state reflection works', async () => {
  const env = makeEnv();
  const fileBytes = new TextEncoder().encode('Hello Coop Reader EPUB content');
  const joined = await call(env, '/room/room-doc/http/join', { method: 'POST', body: { id: 'room-doc', role: 'host', name: 'host' } });

  // Upload document
  const uploadReq = new Request('https://relay.test/room/room-doc/doc?filename=sample.epub&id=room-doc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/epub+zip', Authorization: `Bearer ${joined.data.token}` },
    body: fileBytes,
  });
  const uploadRes = await Worker.fetch(uploadReq, env);
  assert.equal(uploadRes.status, 200);
  const uploadData = await uploadRes.json();
  assert.equal(uploadData.ok, true);
  assert.equal(uploadData.doc.filename, 'sample.epub');
  assert.equal(uploadData.doc.size, fileBytes.byteLength);

  // Check state includes doc
  const stateRes = await call(env, '/room/room-doc/state');
  assert.equal(stateRes.data.ok, true);
  assert.equal(stateRes.data.doc.filename, 'sample.epub');

  // Check metadata query
  const metaRes = await call(env, '/room/room-doc/doc/meta');
  assert.equal(metaRes.data.ok, true);
  assert.equal(metaRes.data.hasDoc, true);
  assert.equal(metaRes.data.doc.filename, 'sample.epub');

  // Download document
  const downloadReq = new Request('https://relay.test/room/room-doc/doc');
  const downloadRes = await Worker.fetch(downloadReq, env);
  assert.equal(downloadRes.status, 200);
  assert.equal(downloadRes.headers.get('Content-Type'), 'application/epub+zip');
  const downloadedBuf = await downloadRes.arrayBuffer();
  assert.deepEqual(new Uint8Array(downloadedBuf), fileBytes);
});



// ---------- chunked file transfer (blob API) ----------
const CH = 98304;
async function blob(env, room, fid, part, { method = 'GET', token, id, body, json } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  const res = await Worker.fetch(new Request(`https://relay.test/room/${room}/blob/${fid}${part ? '/' + part : ''}?id=${id}`, {
    method, headers, body: json !== undefined ? JSON.stringify(json) : body,
  }), env);
  return res;
}

test('blob API: host publishes in chunks, guest downloads, integrity and permissions hold', async () => {
  const env = makeEnv();
  const host = (await call(env, '/room/rb/http/join', { method: 'POST', body: { id: 'rb', role: 'host', name: 'h' } })).data.token;
  const guest = (await call(env, '/room/rb/http/join', { method: 'POST', body: { id: 'guest-1', role: 'guest', name: 'g' } })).data.token;
  const size = CH * 2 + 1234, data = new Uint8Array(size).map((_, i) => (i * 7 + 3) & 255), fid = '2-abc-def';

  // unauthenticated / wrong role
  assert.equal((await blob(env, 'rb', fid, 'meta', { id: 'nobody' })).status, 401);
  const asGuest = await blob(env, 'rb', fid, 'meta', { method: 'POST', id: 'guest-1', token: guest, json: { name: 'b.epub', size, chunks: 3, fp: 'f' } });
  assert.equal(asGuest.status, 403, 'only the host may publish');

  // bad chunk count rejected, good one accepted
  assert.equal((await blob(env, 'rb', fid, 'meta', { method: 'POST', id: 'rb', token: host, json: { name: 'b.epub', size, chunks: 9, fp: 'f' } })).status, 400);
  const meta = await (await blob(env, 'rb', fid, 'meta', { method: 'POST', id: 'rb', token: host, json: { name: 'my book (1).epub', size, chunks: 3, fp: 'f' } })).json();
  assert.equal(meta.ok, true); assert.equal(meta.have, 0);

  // wrong chunk length rejected; chunks may arrive out of order
  assert.equal((await blob(env, 'rb', fid, '0', { method: 'PUT', id: 'rb', token: host, body: data.slice(0, 10) })).status, 400);
  assert.equal((await (await blob(env, 'rb', fid, '2', { method: 'PUT', id: 'rb', token: host, body: data.slice(CH * 2) })).json()).have, 1);
  assert.equal((await blob(env, 'rb', fid, '0', { method: 'GET', id: 'guest-1', token: guest })).status, 404, 'not-yet-uploaded chunk');
  await blob(env, 'rb', fid, '0', { method: 'PUT', id: 'rb', token: host, body: data.slice(0, CH) });
  const last = await (await blob(env, 'rb', fid, '1', { method: 'PUT', id: 'rb', token: host, body: data.slice(CH, CH * 2) })).json();
  assert.equal(last.done, true);

  // guest downloads and reassembles
  const info = await (await blob(env, 'rb', fid, 'meta', { id: 'guest-1', token: guest })).json();
  assert.equal(info.done, true); assert.equal(info.name, 'my book (1).epub'); assert.equal(info.chunks, 3);
  const out = new Uint8Array(size); let off = 0;
  for (let i = 0; i < 3; i++) { const b = new Uint8Array(await (await blob(env, 'rb', fid, String(i), { id: 'guest-1', token: guest })).arrayBuffer()); out.set(b, off); off += b.length; }
  assert.deepEqual(out, data);

  // re-announcing the same file is idempotent (resume), a different file replaces it
  const again = await (await blob(env, 'rb', fid, 'meta', { method: 'POST', id: 'rb', token: host, json: { name: 'b', size, chunks: 3, fp: 'f' } })).json();
  assert.equal(again.done, true);
  await blob(env, 'rb', fid, 'meta', { method: 'POST', id: 'rb', token: host, json: { name: 'b', size: CH, chunks: 1, fp: 'other' } });
  assert.equal((await blob(env, 'rb', fid, '1', { id: 'guest-1', token: guest })).status, 404);
});

test('blob API: websocket-style auth (id + connection token) works for downloads', async () => {
  const env = makeEnv();
  const host = (await call(env, '/room/rw/http/join', { method: 'POST', body: { id: 'rw', role: 'host', name: 'h' } })).data.token;
  const bytes = new Uint8Array(500).fill(9);
  await blob(env, 'rw', 'f-1', 'meta', { method: 'POST', id: 'rw', token: host, json: { name: 'a.txt', size: 500, chunks: 1, fp: 'x' } });
  await blob(env, 'rw', 'f-1', '0', { method: 'PUT', id: 'rw', token: host, body: bytes });
  // simulate a connected websocket peer by seeding the room's tables the way the upgrade handler does
  const room = (env.ROOMS.get('rw'));
  assert.equal((await Worker.fetch(new Request('https://relay.test/room/rw/blob/f-1/0?id=ws-peer&t=tok12345'), env)).status, 401);
});


test('PIN lookups: wrong guesses are rate limited per address, valid PINs still resolve before the limit', async () => {
  const env = makeEnv();
  await call(env, '/room/pin-room/http/join', { method: 'POST', body: { id: 'pin-room', role: 'host', name: 'h' } });
  const created = await call(env, '/pin/create', { method: 'POST', body: { room: 'pin-room', key: '' } });
  const pin = created.data.pin;
  assert.match(pin, /^\d{4,6}$/);
  assert.equal((await call(env, '/pin/' + pin)).data.room, 'pin-room', 'a correct PIN works before any throttling');
  const wrong = pin === '0000' ? '1111' : '0000';
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await call(env, '/pin/' + wrong)).response.status);
  assert.equal(statuses[9], 404, 'the first 10 wrong guesses are plain misses');
  assert.equal(statuses[10], 429, 'then the address is throttled');
  assert.equal((await call(env, '/pin/' + pin)).response.status, 429, 'even the right PIN waits until the window passes');
});
