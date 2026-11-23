// Coop Reader relay — WebSocket + authenticated HTTP mailbox transport.
// WebSocket is used by browsers/WASM/Kindle GUI browsers. HTTP mailboxes are
// used by KOReader, which has HTTP but no browser-style WebSocket support.

const MAX_CLIENTS = 25;
const MAX_FRAME_CHARS = 600000;
const MAX_BINARY_BYTES = 1000000;           // Workers WebSocket messages are limited to 1 MiB
const HTTP_PEER_TTL_MS = 45000;
const PIN_TTL_MS = 4 * 60 * 60 * 1000;
const PIN_FAIL_MAX = 10;                      // wrong PIN guesses allowed per address ...
const PIN_FAIL_WINDOW_MS = 10 * 60 * 1000;    // ... per 10 minutes
const MAX_MAILBOX_MESSAGES = 250;
// Chunked file transfer ("blobs"): small authenticated requests that are resumable and easy on low-memory devices.
const BLOB_CHUNK = 98304;                       // default chunk (96 KiB): what Kindles use. Clients may negotiate 32 KiB .. 1 MiB.
const BLOB_CHUNK_MIN = 32768, BLOB_CHUNK_MAX = 1048576;   // 1 MiB keeps every storage value under the 2 MB Durable Object limit
const BLOB_TTL_MS = 2 * 60 * 60 * 1000;
const META_FLUSH_EVERY = 8;                     // chunk uploads between metadata writes (free plan: 100k row writes per day)
const ICE_CACHE_MS = 30 * 60 * 1000;
const REVOKED_TTL_MS = 24 * 60 * 60 * 1000;
// Limits come from wrangler.toml [vars]. 0 means "no limit". There is NO per-file cap by default; a room quota protects the
// free plan's storage (1 GB per Durable Object, 5 GB per account): the oldest files of the room are evicted first, a file larger than the quota is refused.
function limitsOf(env) {
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
  return { maxBlob: n(env && env.MAX_BLOB_MB, 0) * 1048576, roomQuota: n(env && env.ROOM_QUOTA_MB, 900) * 1048576 };
}
function frameForClient(from, body) {   // binary frames, relay -> client: 0x02 | fromLen | from | body
  const f = new TextEncoder().encode(String(from)), out = new Uint8Array(2 + f.length + body.byteLength);
  out[0] = 2; out[1] = f.length; out.set(f, 2); out.set(new Uint8Array(body.buffer ? body.buffer : body, body.byteOffset || 0, body.byteLength), 2 + f.length);
  return out;
}
function parseClientFrame(buf) {        // client -> relay: 0x01 | toLen | to | body
  const u = new Uint8Array(buf);
  if (u.length < 3 || u[0] !== 1 || 2 + u[1] > u.length) return null;
  return { to: new TextDecoder().decode(u.subarray(2, 2 + u[1])), body: u.subarray(2 + u[1]) };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders },
  });
}

async function readJson(req) {
  const length = Number(req.headers.get('Content-Length') || 0);
  if (length > MAX_FRAME_CHARS + 2048) throw new Error('request too large');
  const body = await req.text();
  if (body.length > MAX_FRAME_CHARS + 2048) throw new Error('request too large');
  return body ? JSON.parse(body) : {};
}

function makeToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function validId(value) {
  return typeof value === 'string' && /^[\w-]{1,64}$/.test(value);
}

const DOC_CHUNK_SIZE = 65536;

async function storeDocInStorage(storage, meta, arrayBuffer) {
  const totalChunks = Math.ceil(arrayBuffer.byteLength / DOC_CHUNK_SIZE);
  const u8 = new Uint8Array(arrayBuffer);
  const oldMeta = await storage.get('doc:meta');
  if (oldMeta && oldMeta.totalChunks) {
    for (let i = 0; i < oldMeta.totalChunks; i++) {
      try { await storage.delete(`doc:chunk:${i}`); } catch (_) {}
    }
  }
  for (let i = 0; i < totalChunks; i++) {
    const chunk = u8.slice(i * DOC_CHUNK_SIZE, (i + 1) * DOC_CHUNK_SIZE);
    await storage.put(`doc:chunk:${i}`, chunk.buffer);
  }
  const fullMeta = { ...meta, totalChunks };
  await storage.put('doc:meta', fullMeta);
  return fullMeta;
}

async function loadDocFromStorage(storage, meta) {
  if (!meta || !meta.totalChunks) {
    return await storage.get('doc:bytes');
  }
  const chunks = [];
  let totalLength = 0;
  for (let i = 0; i < meta.totalChunks; i++) {
    const chunk = await storage.get(`doc:chunk:${i}`);
    if (!chunk) return null;
    const u8 = new Uint8Array(chunk);
    chunks.push(u8);
    totalLength += u8.byteLength;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged.buffer;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.storage = state.storage;
    this.clients = new Map();       // id -> WebSocket
    this.tokens = new Map();        // websocket id -> connection token
    this.httpPeers = new Map();     // id -> { token, role, name, lastSeen, queue }
    this.blobMeta = new Map();      // fid -> metadata cache (flushed every META_FLUSH_EVERY chunks)
    this.revokedAt = 0; this.banned = new Set();
    this.hostId = null;
    this.hibernation = typeof state.acceptWebSocket === 'function';
    if (this.hibernation) {
      // WebSocket Hibernation: the object may be evicted while sockets stay open (no duration charges while idle).
      // In-memory maps are rebuilt from the sockets' attachments when the object wakes up.
      for (const ws of state.getWebSockets()) {
        const a = ws.deserializeAttachment && ws.deserializeAttachment();
        if (!a || !a.id) continue;
        this.clients.set(a.id, ws); this.tokens.set(a.id, a.tok);
        if (a.room) this.roomId = a.room;
        if (a.id === a.room) this.hostId = a.id;
      }
      try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (_) {}   // transport keepalive without waking the object
    }
    this.latestState = { page: 1, updated: Date.now() };
    this.latestDoc = null;
    this.ready = Promise.all([
      this.storage.get('latestState').then(saved => {
        if (saved && typeof saved === 'object') this.latestState = saved;
      }).catch(() => {}),
      this.storage.get('doc:meta').then(savedDoc => {
        if (savedDoc && typeof savedDoc === 'object') this.latestDoc = savedDoc;
      }).catch(() => {}),
      this.storage.get('revoked').then(v => { if (typeof v === 'number') this.revokedAt = v; }).catch(() => {}),
      this.storage.get('banned').then(v => { if (Array.isArray(v)) this.banned = new Set(v); }).catch(() => {}),
    ]);
  }

  async persistLatestState() {
    try { await this.storage.put('latestState', this.latestState); } catch (_) {}
  }

  getPeerCounts() {
    return { clients: this.clients.size, httpClients: this.httpPeers.size, totalPeers: this.clients.size + this.httpPeers.size };
  }

  getRoomState(roomId) {
    return {
      ok: true,
      room: roomId,
      page: this.latestState.page || 1,
      updated: this.latestState.updated || Date.now(),
      doc: this.latestDoc || null,
      hostId: this.hostId,
      hostOnline: !!(this.hostId && (this.clients.has(this.hostId) || this.httpPeers.has(this.hostId))),
      ...this.getPeerCounts(),
      peers: [
        ...Array.from(this.clients.keys(), id => ({ id, transport: 'websocket', role: id === this.hostId ? 'host' : 'guest' })),
        ...Array.from(this.httpPeers.entries(), ([id, p]) => ({ id, name: p.name || '', transport: 'http', role: p.role })),
      ],
    };
  }

  queueHttp(id, frame) {
    const peer = this.httpPeers.get(id);
    if (!peer) return false;
    const raw = JSON.stringify(frame);
    if (raw.length > MAX_FRAME_CHARS) return false;
    if (peer.queue.length >= MAX_MAILBOX_MESSAGES) peer.queue.splice(0, peer.queue.length - MAX_MAILBOX_MESSAGES + 1);
    peer.queue.push(frame);
    // Outbound delivery is not a heartbeat. Only authenticated poll/send calls
    // refresh lastSeen, so dead HTTP clients cannot stay registered forever.
    return true;
  }

  sendFrame(from, to, payload) {
    const frame = { from, p: payload, transport: this.httpPeers.has(from) ? 'http' : 'websocket' };
    if (typeof to !== 'string' || !to) return false;

    // Exact peer delivery first (including a Kindle HTTP host whose id is the room id).
    const ws = this.clients.get(to);
    if (ws) {
      try { ws.send(JSON.stringify(frame)); return true; } catch (_) { return false; }
    }
    if (this.queueHttp(to, frame)) return true;

    const isBroadcast = to === '*' || to === 'broadcast';
    // A room target means the host if one is registered. Without a host, fan out
    // to current room peers so the room can recover when a host is late to join.
    if (isBroadcast || to === this.roomId) {
      let sent = false;
      if (this.hostId && this.hostId !== from) {
        const hostWs = this.clients.get(this.hostId);
        if (hostWs) { try { hostWs.send(JSON.stringify(frame)); sent = true; } catch (_) {} }
        else if (this.queueHttp(this.hostId, frame)) sent = true;
      }
      if (!sent || isBroadcast) {
        for (const [id, client] of this.clients.entries()) {
          if (id === from || id === this.hostId) continue;
          try { client.send(JSON.stringify(frame)); sent = true; } catch (_) {}
        }
        for (const [id] of this.httpPeers.entries()) {
          if (id === from || id === this.hostId) continue;
          if (this.queueHttp(id, frame)) sent = true;
        }
      }
      return sent;
    }
    return false;
  }

  broadcastLeft(id, transport) {
    const peerTransport = transport || (this.httpPeers.has(id) ? 'http' : 'websocket');
    const frame = JSON.stringify({ from: id, left: true, transport: peerTransport });
    for (const [peerId, ws] of this.clients.entries()) {
      if (peerId === id) continue;
      try { ws.send(frame); } catch (_) {}
    }
    for (const [peerId] of this.httpPeers.entries()) {
      if (peerId === id) continue;
      this.queueHttp(peerId, { from: id, left: true, transport: peerTransport });
    }
  }

  purgeStaleHttp() {
    const now = Date.now();
    for (const [id, peer] of this.httpPeers.entries()) {
      if (peer.lastSeen < now - HTTP_PEER_TTL_MS) {
        this.httpPeers.delete(id);
        if (this.hostId === id) this.hostId = null;
        this.broadcastLeft(id, 'http');
      }
    }
  }

  async announceExistingPeersToHost() {
    if (!this.hostId) return;
    for (const id of this.clients.keys()) {
      if (id === this.hostId) continue;
      this.sendFrame(id, this.hostId, { type: 'RELAY_HELLO', peerId: id, transport: 'websocket' });
    }
    for (const [id, peer] of this.httpPeers.entries()) {
      if (id === this.hostId) continue;
      this.sendFrame(id, this.hostId, { type: 'RELAY_HELLO', peerId: id, name: peer.name || '', transport: 'http' });
    }
  }

  async authenticateHttp(req, peerId) {
    this.purgeStaleHttp();
    let peer = this.httpPeers.get(peerId);
    if (!peer && validId(peerId)) {   // the object was evicted since the join: restore the registration (queued messages are lost, /state resyncs)
      const saved = await this.storage.get('hpeer:' + peerId);
      if (saved && saved.token && Date.now() - saved.ts < PIN_TTL_MS) {
        peer = { token: saved.token, role: saved.role, name: saved.name || '', lastSeen: Date.now(), queue: [] };
        this.httpPeers.set(peerId, peer);
        if (peer.role === 'host') this.hostId = peerId;
      }
    }
    if (!peer) return null;
    const auth = req.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '') || '';
    if (!token || token !== peer.token) return null;
    peer.lastSeen = Date.now();
    return peer;
  }

  // Websocket peers authenticate with ?id=&t=<connection token>; HTTP peers with ?id= and a Bearer token.
  async authMember(req, url) {
    const id = url.searchParams.get('id') || '';
    if (!validId(id)) return null;
    if (await this.authenticateHttp(req, id)) return id;
    const t = url.searchParams.get('t') || '';
    if (t && this.clients.has(id) && this.tokens.get(id) === t) return id;
    return null;
  }

  async deleteBlob(fid, meta) {
    for (let i = 0; i < meta.chunks; i++) await this.storage.delete('bchunk:' + fid + ':' + i);
    await this.storage.delete('bmeta:' + fid);
    this.blobMeta.delete(fid);
  }

  async getBlobMeta(fid) {
    if (this.blobMeta.has(fid)) return this.blobMeta.get(fid);
    const m = await this.storage.get('bmeta:' + fid);
    if (m) this.blobMeta.set(fid, m);
    return m || null;
  }

  async putBlobMeta(fid, meta, force) {
    this.blobMeta.set(fid, meta);
    meta.dirty = (meta.dirty || 0) + 1;
    if (force || meta.dirty >= META_FLUSH_EVERY) { meta.dirty = 0; await this.storage.put('bmeta:' + fid, meta); }
  }

  async purgeBlobs(keepFid, incoming) {
    const { roomQuota } = limitsOf(this.env);
    const list = await this.storage.list({ prefix: 'bmeta:' });
    const now = Date.now(); let total = 0; const live = [];
    for (const [k, m0] of list) {
      const fid = k.slice(6), m = this.blobMeta.get(fid) || m0;
      if (now - m.ts > BLOB_TTL_MS) await this.deleteBlob(fid, m);
      else { live.push([fid, m]); if (fid !== keepFid) total += m.size; }
    }
    live.sort((a, b) => a[1].ts - b[1].ts);
    if (roomQuota) for (const [fid, m] of live) {
      if (total + (incoming || 0) <= roomQuota) break;
      if (fid === keepFid) continue;
      await this.deleteBlob(fid, m); total -= m.size;
    }
  }

  async handleBlob(req, url, fid, part) {
    const id = await this.authMember(req, url);
    if (!id) return jsonResponse({ ok: false, error: 'not registered in this room' }, 401);
    const haveOf = m => (m.got.match(/1/g) || []).length;
    const chunkOf = m => m.chunk || BLOB_CHUNK;
    if (req.method === 'GET') {
      const meta = await this.getBlobMeta(fid);
      if (!meta) return jsonResponse({ ok: false, error: 'unknown or expired file' }, 404);
      const have = haveOf(meta);
      if (part === 'meta') return jsonResponse({ ok: true, fid, name: meta.name, size: meta.size, chunks: meta.chunks, chunk: chunkOf(meta), fp: meta.fp, ext: meta.ext, have, done: have === meta.chunks });
      const idx = Number(part);
      if (!(idx >= 0 && idx < meta.chunks) || meta.got[idx] !== '1') return jsonResponse({ ok: false, error: 'chunk not available' }, 404);
      const bytes = await this.storage.get('bchunk:' + fid + ':' + idx);
      if (!bytes) return jsonResponse({ ok: false, error: 'chunk missing' }, 404);
      return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ...CORS_HEADERS } });
    }
    if (id !== this.roomId) return jsonResponse({ ok: false, error: 'only the host can publish files' }, 403);
    if (req.method === 'POST' && part === 'meta') {
      let b; try { b = await readJson(req); } catch (e) { return jsonResponse({ ok: false, error: String(e.message || e) }, 400); }
      const size = Number(b.size), chunks = Number(b.chunks), fp = String(b.fp || '').slice(0, 80);
      const chunk = b.chunk == null ? BLOB_CHUNK : Math.floor(Number(b.chunk));
      const { maxBlob, roomQuota } = limitsOf(this.env);
      if (!(size > 0) || !(chunk >= BLOB_CHUNK_MIN && chunk <= BLOB_CHUNK_MAX) || chunks !== Math.ceil(size / chunk)) return jsonResponse({ ok: false, error: 'bad size, chunk size or chunk count', code: 'bad-meta' }, 400);
      if (maxBlob && size > maxBlob) return jsonResponse({ ok: false, error: 'file too large for this relay (limit ' + Math.floor(maxBlob / 1048576) + ' MB)', code: 'too-large' }, 413);
      if (roomQuota && size > roomQuota) return jsonResponse({ ok: false, error: 'file larger than the room quota (' + Math.floor(roomQuota / 1048576) + ' MB); use a direct connection', code: 'quota' }, 413);
      await this.purgeBlobs(fid, size);
      const old = await this.getBlobMeta(fid);
      if (old && old.size === size && old.chunks === chunks && old.fp === fp && chunkOf(old) === chunk) {   // same file: resume / reuse
        old.ts = Date.now(); await this.putBlobMeta(fid, old, true);
        const have = haveOf(old); return jsonResponse({ ok: true, have, done: have === chunks, got: old.got, chunk });
      }
      if (old) await this.deleteBlob(fid, old);
      const name = String(b.name || 'document').replace(/[^\w.\- ()]/g, '_').slice(0, 128);
      const meta = { name, size, chunks, chunk, fp, ext: String(b.ext || '').replace(/[^\w]/g, '').slice(0, 8), ts: Date.now(), got: '0'.repeat(chunks) };
      await this.putBlobMeta(fid, meta, true);
      return jsonResponse({ ok: true, have: 0, done: false, got: meta.got, chunk });
    }
    if (req.method === 'PUT' && /^\d+$/.test(part)) {
      const bytes = await req.arrayBuffer();   // read the body before touching storage so get/put stay atomic
      const meta = await this.getBlobMeta(fid);
      if (!meta) return jsonResponse({ ok: false, error: 'announce the file (meta) first' }, 404);
      const idx = Number(part), cs = chunkOf(meta);
      if (!(idx >= 0 && idx < meta.chunks)) return jsonResponse({ ok: false, error: 'chunk index out of range' }, 400);
      const expected = idx < meta.chunks - 1 ? cs : meta.size - (meta.chunks - 1) * cs;
      if (bytes.byteLength !== expected) return jsonResponse({ ok: false, error: 'bad chunk length (expected ' + expected + ')' }, 400);
      try { await this.storage.put('bchunk:' + fid + ':' + idx, bytes); }
      catch (e) { return jsonResponse({ ok: false, error: 'relay storage is full: ' + String(e.message || e), code: 'storage' }, 507); }
      meta.got = meta.got.slice(0, idx) + '1' + meta.got.slice(idx + 1); meta.ts = Date.now();
      const have = haveOf(meta);
      await this.putBlobMeta(fid, meta, have === meta.chunks);
      return jsonResponse({ ok: true, have, done: have === meta.chunks });
    }
    return jsonResponse({ ok: false, error: 'unsupported blob request' }, 405);
  }

  // ---- host controls: end the session / remove one participant -----------------------------------------
  // In hibernation mode the runtime's own socket objects (state.getWebSockets) are the ones that must be closed.
  liveSockets(id) {
    if (this.hibernation) { try { return id ? this.state.getWebSockets(id) : this.state.getWebSockets(); } catch (_) {} }
    const ws = id ? this.clients.get(id) : null; return id ? (ws ? [ws] : []) : [...this.clients.values()];
  }
  closeAllSockets(code, reason) {
    for (const ws of this.liveSockets()) { try { ws.close(code, reason); } catch (_) {} }
    this.clients.clear();
  }
  async revokeRoom() {
    this.closeAllSockets(4001, 'session ended');
    this.httpPeers.clear(); this.tokens.clear(); this.hostId = null; this.blobMeta.clear();
    await this.storage.deleteAll();
    this.revokedAt = Date.now(); this.banned = new Set();
    await this.storage.put('revoked', this.revokedAt);
  }
  async banPeer(pid) {
    this.banned.add(pid); await this.storage.put('banned', [...this.banned].slice(-200));
    for (const ws of this.liveSockets(pid)) { try { ws.close(4003, 'removed by host'); } catch (_) {} }
    this.clients.delete(pid); this.tokens.delete(pid);
    if (this.httpPeers.delete(pid)) await this.storage.delete('hpeer:' + pid);
    this.broadcastLeft(pid);
  }

  sendBinary(from, to, body) {
    const frame = frameForClient(from, body);
    const ws = this.clients.get(to);
    if (ws) { try { ws.send(frame); return true; } catch (_) { return false; } }
    if (to === '*' || to === 'broadcast') {
      let sent = false;
      for (const [id, c] of this.clients.entries()) { if (id === from) continue; try { c.send(frame); sent = true; } catch (_) {} }
      return sent;
    }
    if (to === this.roomId && this.hostId && this.hostId !== from) { const h = this.clients.get(this.hostId); if (h) { try { h.send(frame); return true; } catch (_) {} } }
    return false;
  }

  async fetch(req) {
    await this.ready;
    const url = new URL(req.url);
    const roomMatch = url.pathname.match(/^\/room\/([\w-]{1,64})(\/.*)?$/);
    this.roomId = roomMatch ? roomMatch[1] : '';
    const tail = roomMatch ? (roomMatch[2] || '') : '';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    // PIN registry is a dedicated Durable Object. Persist PINs rather than keeping
    // them in a transient Map, so short codes survive DO eviction/restart.
    if (url.pathname === '/pin/create' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const room = body.room || '';
        const key = body.key || '';
        if (!validId(room)) return jsonResponse({ ok: false, error: 'valid room required' }, 400);
        const now = Date.now();
        const entries = await this.storage.list({ prefix: 'pin:' });
        for (const [storageKey, value] of entries) {
          if (!value || value.ts < now - PIN_TTL_MS) await this.storage.delete(storageKey);
        }
        for (const [storageKey, value] of entries) {
          if (value && value.ts >= now - PIN_TTL_MS && value.room === room && (value.key || '') === key) {
            return jsonResponse({ ok: true, pin: storageKey.slice(4), room, key, expiresAt: value.ts + PIN_TTL_MS });
          }
        }
        let pin = '';
        for (let i = 0; i < 100; i++) {
          const candidate = String(1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
          if (!(await this.storage.get('pin:' + candidate))) { pin = candidate; break; }
        }
        if (!pin) pin = String(100000 + crypto.getRandomValues(new Uint32Array(1))[0] % 900000);
        await this.storage.put('pin:' + pin, { room, key, ts: now });
        return jsonResponse({ ok: true, pin, room, key, expiresAt: now + PIN_TTL_MS });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    if (url.pathname === '/__pin/revoke' && req.method === 'POST') {   // only reachable through the Worker (it calls the stub directly)
      const b = await readJson(req).catch(() => ({}));
      for (const [k, v] of await this.storage.list({ prefix: 'pin:' })) if (v && v.room === b.room) await this.storage.delete(k);
      return jsonResponse({ ok: true });
    }
    const pinMatch = url.pathname.match(/^\/pin\/([0-9a-zA-Z_-]{3,12})$/);
    if (pinMatch && req.method === 'GET') {
      const pin = pinMatch[1];
      // A 4-digit PIN is easy to enumerate: allow only a few wrong guesses per client address per window.
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const fkey = 'pinfail:' + ip;
      let fail = (await this.storage.get(fkey)) || { n: 0, ts: Date.now() };
      if (Date.now() - fail.ts > PIN_FAIL_WINDOW_MS) fail = { n: 0, ts: Date.now() };
      if (fail.n >= PIN_FAIL_MAX) return jsonResponse({ ok: false, error: 'Too many wrong PINs. Try again in a few minutes.' }, 429);
      const entry = await this.storage.get('pin:' + pin);
      if (entry && entry.ts >= Date.now() - PIN_TTL_MS) {
        return jsonResponse({ ok: true, pin, room: entry.room, key: entry.key || '', expiresAt: entry.ts + PIN_TTL_MS });
      }
      if (entry) await this.storage.delete('pin:' + pin);
      fail.n += 1;
      await this.storage.put(fkey, fail);
      return jsonResponse({ ok: false, error: 'PIN not found or expired' }, 404);
    }

    if (!roomMatch) {
      return jsonResponse({ ok: true, app: 'coop-reader relay', protocol: 4, features: ['websocket', 'ws-binary', 'ws-hibernation', 'http-mailbox', 'pin-codes', 'blobs', 'blob-chunk-negotiation', 'revoke', 'ban', 'ice'], blobChunk: { default: BLOB_CHUNK, min: BLOB_CHUNK_MIN, max: BLOB_CHUNK_MAX } });
    }

    this.purgeStaleHttp();

    if (tail === '/host-status' && req.method === 'GET') {
      return jsonResponse({ ok: true, ...this.getRoomState(this.roomId) });
    }

    // HTTP mailbox registration for KOReader.
    if (tail === '/http/join' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const id = body.id;
        const role = body.role === 'host' ? 'host' : 'guest';
        if (!validId(id)) return jsonResponse({ ok: false, error: 'valid peer id required' }, 400);
        const existing = this.httpPeers.get(id);
        const suppliedToken = body.token || '';
        if (existing && suppliedToken !== existing.token) return jsonResponse({ ok: false, error: 'peer id already in use; reconnect with its bearer token' }, 409);
        if (existing && role !== existing.role) return jsonResponse({ ok: false, error: 'peer role cannot be changed while registered' }, 409);
        if (role === 'host' && id !== this.roomId) return jsonResponse({ ok: false, error: 'host id must match room id' }, 400);
        if (role === 'guest' && id === this.roomId) return jsonResponse({ ok: false, error: 'guest id cannot equal room id' }, 400);
        if (!existing && (this.clients.size + this.httpPeers.size) >= MAX_CLIENTS) return jsonResponse({ ok: false, error: 'room full' }, 429);
        if (role === 'host' && this.hostId && this.hostId !== id && (this.clients.has(this.hostId) || this.httpPeers.has(this.hostId))) {
          return jsonResponse({ ok: false, error: 'room already has an active host' }, 409);
        }
        if (this.revokedAt && Date.now() - this.revokedAt < REVOKED_TTL_MS) return jsonResponse({ ok: false, error: 'this session has ended', code: 'revoked' }, 410);
        if (this.banned.has(id)) return jsonResponse({ ok: false, error: 'not allowed in this session', code: 'banned' }, 403);
        const token = existing ? existing.token : makeToken();
        await this.storage.put('hpeer:' + id, { token, role, name: String(body.name || '').slice(0, 64), ts: Date.now() });
        this.httpPeers.set(id, {
          token,
          role,
          name: String(body.name || '').slice(0, 64),
          lastSeen: Date.now(),
          queue: existing ? existing.queue : [],
        });
        if (role === 'host') {
          this.hostId = id;
          await this.announceExistingPeersToHost();
        } else if (this.hostId) {
          this.sendFrame(id, this.hostId, { type: 'RELAY_HELLO', peerId: id, name: String(body.name || '').slice(0, 64), transport: 'http' });
        }
        return jsonResponse({ ...this.getRoomState(this.roomId), token, id, role });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 400);
      }
    }

    const httpPollMatch = tail.match(/^\/http\/poll$/);
    if (httpPollMatch && req.method === 'GET') {
      const peerId = url.searchParams.get('id') || '';
      const peer = await this.authenticateHttp(req, peerId);
      if (!peer) return jsonResponse({ ok: false, error: 'HTTP peer not registered or token expired' }, 401);
      const messages = peer.queue.splice(0, 100);
      return jsonResponse({ ...this.getRoomState(this.roomId), id: peerId, messages });
    }

    if (tail === '/http/send' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const id = body.id || '';
        const peer = await this.authenticateHttp(req, id);
        if (!peer) return jsonResponse({ ok: false, error: 'HTTP peer not registered or token expired' }, 401);
        if (!body.p || typeof body.p !== 'object') return jsonResponse({ ok: false, error: 'message payload required' }, 400);
        const encoded = JSON.stringify(body.p);
        if (encoded.length > MAX_FRAME_CHARS) return jsonResponse({ ok: false, error: 'message too large' }, 413);
        const type = body.p.type;
        if (type === 'PAGE_CHANGE' && peer.role !== 'host') {
          return jsonResponse({ ok: false, error: 'only the host may publish PAGE_CHANGE' }, 403);
        }
        if (type === 'PAGE_CHANGE' && Number(body.p.page) > 0) {
          this.latestState = { page: Math.floor(Number(body.p.page)), updated: Date.now() };
          await this.persistLatestState();
        }
        const to = body.to || this.roomId;
        const sent = this.sendFrame(id, to, body.p);
        return jsonResponse({ ok: true, delivered: sent, ...this.getPeerCounts() });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 400);
      }
    }

    if (tail === '/http/leave' && (req.method === 'POST' || req.method === 'DELETE')) {
      try {
        const body = req.method === 'POST' ? await readJson(req) : {};
        const id = url.searchParams.get('id') || body.id || '';
        const peer = await this.authenticateHttp(req, id);
        if (!peer) return jsonResponse({ ok: false, error: 'HTTP peer not registered or token expired' }, 401);
        this.httpPeers.delete(id);
        await this.storage.delete('hpeer:' + id);
        if (this.hostId === id) this.hostId = null;
        this.broadcastLeft(id, 'http');
        return jsonResponse({ ok: true });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 400);
      }
    }

    // Status endpoint is also used by diagnostics; membership is counted only
    // after a client has completed /http/join or a WebSocket upgrade.
    if (tail === '/state' && req.method === 'GET') {
      return jsonResponse(this.getRoomState(this.roomId));
    }

    // Backward-compatible page sync endpoint. New clients should use /http/send.
    if (tail === '/sync' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const from = String(body.from || url.searchParams.get('from') || '');
        const page = Math.floor(Number(body.page || url.searchParams.get('page')));
        if (!Number.isFinite(page) || page < 1) return jsonResponse({ ok: false, error: 'valid page required' }, 400);
        const httpSender = this.httpPeers.get(from);
        const websocketHost = from === this.roomId && this.clients.has(this.roomId);
        const httpHost = from === this.roomId && httpSender && httpSender.role === 'host';
        if (!websocketHost && !httpHost) return jsonResponse({ ok: false, error: 'only the registered room host may publish page changes' }, 403);
        const total = Math.max(0, Math.floor(Number(body.total) || 0)), pct = Number(body.pct), fp = String(body.fp || '').replace(/[^\w-]/g, '').slice(0, 80);
        const extra = { total, fp }; if (Number.isFinite(pct) && pct >= 0 && pct <= 1) extra.pct = pct;
        this.latestState = { page, ...extra, updated: Date.now() };
        await this.persistLatestState();
        this.sendFrame(from, '*', { type: 'PAGE_CHANGE', page, ...extra });
        return jsonResponse({ ok: true, page, ...this.getPeerCounts() });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 400);
      }
    }

    if (tail === '/revoke' && req.method === 'POST') {   // host ends the session: sockets closed, files wiped, id burned for 24 h
      const hid = await this.authMember(req, url);
      if (!hid || hid !== this.roomId) return jsonResponse({ ok: false, error: 'only the host can end the session' }, 403);
      await this.revokeRoom();
      return jsonResponse({ ok: true });
    }
    if (tail === '/ban' && req.method === 'POST') {
      const hid = await this.authMember(req, url);
      if (!hid || hid !== this.roomId) return jsonResponse({ ok: false, error: 'only the host can remove people' }, 403);
      let b; try { b = await readJson(req); } catch (e) { return jsonResponse({ ok: false, error: String(e.message || e) }, 400); }
      if (!validId(b.peer) || b.peer === this.roomId) return jsonResponse({ ok: false, error: 'valid peer id required' }, 400);
      await this.banPeer(b.peer);
      return jsonResponse({ ok: true });
    }

    const blobMatch = tail.match(/^\/blob\/([\w-]{1,64})(?:\/(meta|\d{1,7}))?$/);
    if (blobMatch) return this.handleBlob(req, url, blobMatch[1], blobMatch[2] || '');

    // Legacy single-slot document upload (browser GUI). Now requires a registered room member.
    if (tail === '/doc' && req.method === 'POST') {
      try {
        const uploaderId = await this.authMember(req, url);
        if (!uploaderId) return jsonResponse({ ok: false, error: 'not registered in this room' }, 401);
        const rawFilename = url.searchParams.get('filename') || req.headers.get('X-Filename') || 'document';
        const filename = decodeURIComponent(rawFilename).replace(/[^\w.\- ]/g, '_').slice(0, 128);
        const contentType = req.headers.get('Content-Type') || 'application/octet-stream';
        const bytes = await req.arrayBuffer();
        if (!bytes || bytes.byteLength === 0) {
          return jsonResponse({ ok: false, error: 'empty document body' }, 400);
        }
        if (bytes.byteLength > 30 * 1024 * 1024) {
          return jsonResponse({ ok: false, error: 'document too large (max 30MB)' }, 413);
        }
        const docMeta = {
          filename,
          size: bytes.byteLength,
          mime: contentType,
          updated: Date.now(),
        };
        const savedMeta = await storeDocInStorage(this.storage, docMeta, bytes);
        this.latestDoc = savedMeta;

        // Broadcast DOC_OPEN to all active WebSocket clients and HTTP mailbox queues
        const docMsg = {
          type: 'DOC_OPEN',
          filename: savedMeta.filename,
          size: savedMeta.size,
          updated: savedMeta.updated,
          url: `/room/${encodeURIComponent(this.roomId)}/doc`,
        };
        this.sendFrame(uploaderId, '*', docMsg);

        return jsonResponse({ ok: true, doc: savedMeta });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // Document download endpoint
    if (tail === '/doc' && req.method === 'GET') {
      try {
        const meta = this.latestDoc || (await this.storage.get('doc:meta'));
        if (!meta) {
          return jsonResponse({ ok: false, error: 'no document uploaded for this room' }, 404);
        }
        const bytes = await loadDocFromStorage(this.storage, meta);
        if (!bytes) {
          return jsonResponse({ ok: false, error: 'document content missing or expired' }, 404);
        }
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': meta.mime || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.filename)}"`,
            'Content-Length': String(bytes.byteLength || meta.size),
            'X-Filename': encodeURIComponent(meta.filename),
            ...CORS_HEADERS,
          },
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 500);
      }
    }

    // Document metadata query
    if (tail === '/doc/meta' && req.method === 'GET') {
      const meta = this.latestDoc || (await this.storage.get('doc:meta'));
      if (!meta) return jsonResponse({ ok: true, hasDoc: false });
      return jsonResponse({ ok: true, hasDoc: true, doc: meta });
    }

    // WebSocket transport for WASM and GUI clients.
    if (req.headers.get('Upgrade') !== 'websocket') {
      return jsonResponse({ ok: false, error: 'unknown endpoint; WebSocket upgrade or HTTP mailbox expected' }, 404);
    }

    const q = url.searchParams;
    const id = q.get('id') || '';
    const tok = q.get('t') || '';
    if (!validId(id) || !/^[\w-]{8,96}$/.test(tok)) return new Response('bad id/token', { status: 400, headers: CORS_HEADERS });
    if (this.revokedAt && Date.now() - this.revokedAt < REVOKED_TTL_MS && this.roomId !== '_test') return new Response('session ended', { status: 410, headers: CORS_HEADERS });
    if (this.banned.has(id)) return new Response('removed by host', { status: 403, headers: CORS_HEADERS });
    if (this.httpPeers.has(id)) return new Response('id already registered as HTTP peer', { status: 409, headers: CORS_HEADERS });
    if (this.tokens.has(id) && this.tokens.get(id) !== tok) return new Response('id in use', { status: 409, headers: CORS_HEADERS });
    if (!this.clients.has(id) && (this.clients.size + this.httpPeers.size) >= MAX_CLIENTS) return new Response('room full', { status: 429, headers: CORS_HEADERS });

    this.tokens.set(id, tok);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (this.hibernation) {
      this.state.acceptWebSocket(server, [id]);
      server.serializeAttachment({ id, tok, room: this.roomId });
    } else {
      server.accept();
    }

    const old = this.clients.get(id);
    if (old) { try { old.close(1000, 'replaced'); } catch (_) {} }
    this.clients.set(id, server);
    if (id === this.roomId) {
      this.hostId = id;
      await this.announceExistingPeersToHost();
    }

    if (!this.hibernation) {   // plain accept(): handlers are attached here (tests and older runtimes)
      server.addEventListener('message', event => this.onSocketMessage(server, id, event.data));
      server.addEventListener('close', () => this.onSocketGone(server, id, tok));
      server.addEventListener('error', () => this.onSocketGone(server, id, tok));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket handlers (hibernation API entry points + shared implementation) --------------------------
  attachmentOf(ws) { try { return ws.deserializeAttachment() || {}; } catch (_) { return {}; } }
  async webSocketMessage(ws, data) { await this.ready; const a = this.attachmentOf(ws); if (a.room && !this.roomId) this.roomId = a.room; return this.onSocketMessage(ws, a.id, data); }
  async webSocketClose(ws, code) {
    await this.ready; const a = this.attachmentOf(ws); this.onSocketGone(ws, a.id, a.tok);
    try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, 'closed'); } catch (_) {}   // complete the close handshake
  }
  async webSocketError(ws) { await this.ready; const a = this.attachmentOf(ws); this.onSocketGone(ws, a.id, a.tok); }

  async onSocketMessage(server, id, data) {
    if (!id) return;
    if (typeof data !== 'string') {   // binary frame (protocol 4): 0x01 | toLen | to | body  ->  0x02 | fromLen | from | body
      const f = parseClientFrame(data);
      if (!f || f.body.byteLength > MAX_BINARY_BYTES) return;
      const sentB = this.sendBinary(id, f.to, f.body);
      if (!sentB && f.to !== this.roomId && f.to !== '*' && f.to !== 'broadcast') { try { server.send(JSON.stringify({ err: 'gone', to: f.to })); } catch (_) {} }
      return;
    }
    if (data === 'ping') { try { server.send('pong'); } catch (_) {} return; }   // runtimes without auto-response
    if (data.length > MAX_FRAME_CHARS) return;
    let message;
    try { message = JSON.parse(data); } catch (_) { return; }
    if (!message || typeof message.to !== 'string' || !message.p || typeof message.p !== 'object') return;
    if (message.p.type === 'PAGE_CHANGE') {
      if (id !== this.hostId) {
        try { server.send(JSON.stringify({ err: 'forbidden', reason: 'only the host may publish PAGE_CHANGE' })); } catch (_) {}
        return;
      }
      const page = Math.floor(Number(message.p.page));
      if (page > 0) {
        this.latestState = { page, updated: Date.now() };
        await this.persistLatestState();
      }
    }
    const sent = this.sendFrame(id, message.to, message.p);
    if (!sent && message.to !== this.roomId && message.to !== '*' && message.to !== 'broadcast') {
      try { server.send(JSON.stringify({ err: 'gone', to: message.to })); } catch (_) {}
    }
  }

  onSocketGone(server, id, tok) {
    if (!id || this.clients.get(id) !== server) return;
    this.clients.delete(id);
    if (this.tokens.get(id) === tok) this.tokens.delete(id);
    if (this.hostId === id) this.hostId = null;
    this.broadcastLeft(id, 'websocket');
  }
}

// Short-lived TURN credentials from Cloudflare Realtime TURN (optional: set TURN_KEY_ID and TURN_KEY_API_TOKEN secrets).
// Without them the endpoint answers with an empty list and clients keep their own settings.
let iceCache = null;
async function iceServers(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return jsonResponse({ ok: true, turn: false, iceServers: [] }, 200, { 'Cache-Control': 'max-age=300' });
  if (iceCache && Date.now() - iceCache.ts < ICE_CACHE_MS) return jsonResponse(iceCache.body, 200, { 'Cache-Control': 'max-age=300' });
  try {
    const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(env.TURN_KEY_ID) + '/credentials/generate-ice-servers', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const list = (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers]).filter(Boolean).map(s => ({
      ...s, urls: [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u)),   // browsers wait for the port-53 URLs to time out
    }));
    iceCache = { ts: Date.now(), body: { ok: true, turn: true, ttl: 86400, iceServers: list } };
    return jsonResponse(iceCache.body, 200, { 'Cache-Control': 'max-age=300' });
  } catch (e) {
    return jsonResponse({ ok: false, turn: false, error: 'could not mint TURN credentials: ' + String(e.message || e), iceServers: [] }, 502);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (url.pathname === '/pin/create' && req.method === 'POST') {
      let body;
      try { body = await readJson(req.clone()); }
      catch (e) { return jsonResponse({ ok: false, error: 'invalid JSON request' }, 400); }
      if (!validId(body.room)) return jsonResponse({ ok: false, error: 'valid room required' }, 400);
      const roomStub = env.ROOMS.get(env.ROOMS.idFromName(body.room));
      const statusUrl = new URL('/room/' + encodeURIComponent(body.room) + '/host-status', url.origin);
      const statusRes = await roomStub.fetch(new Request(statusUrl.toString(), { method: 'GET' }));
      const roomStatus = await statusRes.json().catch(() => ({}));
      if (!roomStatus.hostOnline) return jsonResponse({ ok: false, error: 'room host is not currently registered on this relay' }, 409);
      const pinId = env.ROOMS.idFromName('__GLOBAL_PIN_REGISTRY__');
      return env.ROOMS.get(pinId).fetch(new Request(req.url, {
        method: 'POST', headers: req.headers, body: JSON.stringify(body)
      }));
    }
    if (url.pathname === '/ice' && req.method === 'GET') return iceServers(env);
    {
      const rv = url.pathname.match(/^\/room\/([\w-]{1,64})\/revoke$/);
      if (rv && req.method === 'POST') {   // forward to the room, then burn its PINs in the registry
        const res = await env.ROOMS.get(env.ROOMS.idFromName(rv[1])).fetch(req);
        if (res.status === 200) await env.ROOMS.get(env.ROOMS.idFromName('__GLOBAL_PIN_REGISTRY__')).fetch(new Request(new URL('/__pin/revoke', url.origin).toString(), { method: 'POST', body: JSON.stringify({ room: rv[1] }) })).catch(() => {});
        return res;
      }
    }
    if (url.pathname.startsWith('/pin/')) {
      const pinId = env.ROOMS.idFromName('__GLOBAL_PIN_REGISTRY__');
      return env.ROOMS.get(pinId).fetch(req);
    }
    const match = url.pathname.match(/^\/room\/([\w-]{1,64})(\/.*)?$/);
    if (!match) return jsonResponse({ ok: true, app: 'coop-reader relay', protocol: 4, features: ['websocket', 'ws-binary', 'ws-hibernation', 'http-mailbox', 'pin-codes', 'blobs', 'blob-chunk-negotiation', 'revoke', 'ban', 'ice'], blobChunk: { default: BLOB_CHUNK, min: BLOB_CHUNK_MIN, max: BLOB_CHUNK_MAX } });
    const roomId = match[1];
    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(req);
  },
};
