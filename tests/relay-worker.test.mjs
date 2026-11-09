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
  
  // Upload document
  const uploadReq = new Request('https://relay.test/room/room-doc/doc?filename=sample.epub', {
    method: 'POST',
    headers: { 'Content-Type': 'application/epub+zip' },
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

