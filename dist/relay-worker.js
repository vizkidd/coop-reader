// Coop Reader relay — WebSocket + authenticated HTTP mailbox transport.
// WebSocket is used by browsers/WASM/Kindle GUI browsers. HTTP mailboxes are
// used by KOReader, which has HTTP but no browser-style WebSocket support.

const MAX_CLIENTS = 25;
const MAX_FRAME_CHARS = 600000;
const HTTP_PEER_TTL_MS = 45000;
const PIN_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_MAILBOX_MESSAGES = 250;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
    this.storage = state.storage;
    this.clients = new Map();       // id -> WebSocket
    this.tokens = new Map();        // websocket id -> connection token
    this.httpPeers = new Map();     // id -> { token, role, name, lastSeen, queue }
    this.hostId = null;
    this.latestState = { page: 1, updated: Date.now() };
    this.latestDoc = null;
    this.ready = Promise.all([
      this.storage.get('latestState').then(saved => {
        if (saved && typeof saved === 'object') this.latestState = saved;
      }).catch(() => {}),
      this.storage.get('doc:meta').then(savedDoc => {
        if (savedDoc && typeof savedDoc === 'object') this.latestDoc = savedDoc;
      }).catch(() => {})
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
    const peer = this.httpPeers.get(peerId);
    if (!peer) return null;
    const auth = req.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '') || '';
    if (!token || token !== peer.token) return null;
    peer.lastSeen = Date.now();
    return peer;
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

    const pinMatch = url.pathname.match(/^\/pin\/([0-9a-zA-Z_-]{3,12})$/);
    if (pinMatch && req.method === 'GET') {
      const pin = pinMatch[1];
      const entry = await this.storage.get('pin:' + pin);
      if (entry && entry.ts >= Date.now() - PIN_TTL_MS) {
        return jsonResponse({ ok: true, pin, room: entry.room, key: entry.key || '', expiresAt: entry.ts + PIN_TTL_MS });
      }
      if (entry) await this.storage.delete('pin:' + pin);
      return jsonResponse({ ok: false, error: 'PIN not found or expired' }, 404);
    }

    if (!roomMatch) {
      return jsonResponse({ ok: true, app: 'coop-reader relay', protocol: 2, features: ['websocket', 'http-mailbox', 'pin-codes'] });
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
        const token = existing ? existing.token : makeToken();
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
        this.latestState = { page, updated: Date.now() };
        await this.persistLatestState();
        this.sendFrame(from, '*', { type: 'PAGE_CHANGE', page });
        return jsonResponse({ ok: true, page, ...this.getPeerCounts() });
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e.message || e) }, 400);
      }
    }

    // Document upload endpoint (from host or peer sharing)
    if (tail === '/doc' && req.method === 'POST') {
      try {
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
        this.sendFrame(this.hostId || 'host', '*', docMsg);

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
    if (this.httpPeers.has(id)) return new Response('id already registered as HTTP peer', { status: 409, headers: CORS_HEADERS });
    if (this.tokens.has(id) && this.tokens.get(id) !== tok) return new Response('id in use', { status: 409, headers: CORS_HEADERS });
    if (!this.clients.has(id) && (this.clients.size + this.httpPeers.size) >= MAX_CLIENTS) return new Response('room full', { status: 429, headers: CORS_HEADERS });

    this.tokens.set(id, tok);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const old = this.clients.get(id);
    if (old) { try { old.close(1000, 'replaced'); } catch (_) {} }
    this.clients.set(id, server);
    if (id === this.roomId) {
      this.hostId = id;
      await this.announceExistingPeersToHost();
    }

    server.addEventListener('message', async (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_CHARS) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
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
    });

    server.addEventListener('close', () => {
      if (this.clients.get(id) !== server) return;
      this.clients.delete(id);
      if (this.tokens.get(id) === tok) this.tokens.delete(id);
      if (this.hostId === id) this.hostId = null;
      this.broadcastLeft(id, 'websocket');
    });
    server.addEventListener('error', () => {
      if (this.clients.get(id) === server) {
        this.clients.delete(id);
        if (this.tokens.get(id) === tok) this.tokens.delete(id);
        if (this.hostId === id) this.hostId = null;
        this.broadcastLeft(id, 'websocket');
      }
    });

    return new Response(null, { status: 101, webSocket: client });
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
    if (url.pathname.startsWith('/pin/')) {
      const pinId = env.ROOMS.idFromName('__GLOBAL_PIN_REGISTRY__');
      return env.ROOMS.get(pinId).fetch(req);
    }
    const match = url.pathname.match(/^\/room\/([\w-]{1,64})(\/.*)?$/);
    if (!match) return jsonResponse({ ok: true, app: 'coop-reader relay', protocol: 2, features: ['websocket', 'http-mailbox', 'pin-codes'] });
    const roomId = match[1];
    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(req);
  },
};
