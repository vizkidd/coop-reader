// coop-reader WebSocket & HTTP relay — Cloudflare Worker + Durable Object (free plan works).
// Deploy:  npx wrangler deploy   → copy the wss:// URL into the app: menu → Network → Relay server.
// Rooms are keyed by the host's session code; supports both WebSockets (browsers) and HTTP sync (Kindle / KOReader).

const MAX_CLIENTS = 25;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

export class Room {
  constructor(state, env) {
    this.clients = new Map();
    this.tokens = new Map();
    this.pins = new Map(); // PIN -> { room, key, ts }
    this.latestState = { page: 1, updated: Date.now() };
    this.httpClients = new Map();
  }

  async fetch(req) {
    const url = new URL(req.url);
    const roomMatch = url.pathname.match(/^\/room\/([\w-]{1,64})/);
    const roomId = roomMatch ? roomMatch[1] : '';

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. PIN Management (Handled by the central __PIN_REGISTRY__ room)
    if (url.pathname === '/pin/create' && req.method === 'POST') {
      try {
        const body = await req.json();
        const room = body.room || '';
        const key = body.key || '';
        if (!room) return jsonResponse({ ok: false, error: 'room required' }, 400);

        // Generate 4-digit numeric PIN (1000 - 9999)
        let pin = '';
        for (let i = 0; i < 10; i++) {
          const candidate = String(Math.floor(1000 + Math.random() * 9000));
          if (!this.pins.has(candidate)) {
            pin = candidate;
            break;
          }
        }
        if (!pin) pin = String(Math.floor(100000 + Math.random() * 900000));

        this.pins.set(pin, { room, key, ts: Date.now() });

        // Clean up PINs older than 4 hours
        const fourHoursAgo = Date.now() - 4 * 60 * 60 * 1000;
        for (const [k, v] of this.pins.entries()) {
          if (v.ts < fourHoursAgo) this.pins.delete(k);
        }

        return jsonResponse({ ok: true, pin, room, key });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    const pinMatch = url.pathname.match(/^\/pin\/([0-9a-zA-Z_-]{3,12})$/);
    if (pinMatch) {
      const pin = pinMatch[1];
      const entry = this.pins.get(pin);
      if (entry) {
        return jsonResponse({ ok: true, pin, room: entry.room, key: entry.key });
      }
      return jsonResponse({ ok: false, error: 'PIN not found or expired' }, 404);
    }

    // 2. HTTP Room State Query (For Kindle / KOReader polling)
    if (url.pathname.endsWith('/state')) {
      // Clean stale HTTP clients (no activity for 30 seconds)
      const staleThreshold = Date.now() - 30000;
      for (const [k, v] of this.httpClients.entries()) {
        if (v.lastSeen < staleThreshold) this.httpClients.delete(k);
      }
      return jsonResponse({
        ok: true,
        page: this.latestState.page,
        updated: this.latestState.updated,
        clients: this.clients.size,
        httpClients: this.httpClients.size,
        totalPeers: this.clients.size + this.httpClients.size,
      });
    }

    // 3. HTTP Page Synchronization (For Kindle / KOReader pushing page changes)
    if (url.pathname.endsWith('/sync') && req.method === 'POST') {
      try {
        let page = 1;
        let from = 'kindle';
        if (req.headers.get('Content-Type')?.includes('application/json')) {
          const b = await req.json();
          page = parseInt(b.page, 10) || 1;
          from = b.from || from;
        } else {
          page = parseInt(url.searchParams.get('page'), 10) || 1;
          from = url.searchParams.get('from') || from;
        }

        this.httpClients.set(from, { lastSeen: Date.now(), page });
        this.latestState = { page, updated: Date.now() };

        // Broadcast to all active WebSocket clients in this room (Chrome on MacOS)
        const frame = JSON.stringify({
          from: roomId || from,
          p: { type: 'PAGE_CHANGE', page },
        });

        for (const ws of this.clients.values()) {
          try { ws.send(frame); } catch {}
        }

        return jsonResponse({ ok: true, page });
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }

    // 4. WebSocket Upgrade (For desktop browsers & web app peers)
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('coop-reader relay: websocket expected', { status: 426, headers: CORS_HEADERS });
    }

    const q = url.searchParams, id = q.get('id') || '', tok = q.get('t') || '';
    if (!/^[\w-]{1,64}$/.test(id) || !/^[\w-]{8,64}$/.test(tok)) return new Response('bad id/token', { status: 400 });
    if (this.tokens.has(id) && this.tokens.get(id) !== tok) return new Response('id in use', { status: 409 });
    if (!this.clients.has(id) && this.clients.size >= MAX_CLIENTS) return new Response('room full', { status: 429 });

    this.tokens.set(id, tok);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const old = this.clients.get(id);
    if (old) { try { old.close(1000, 'replaced'); } catch {} }
    this.clients.set(id, server);

    server.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > 600000) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }

      // Keep track of latest page change if present in frame
      if (m.p && typeof m.p === 'object' && m.p.type === 'PAGE_CHANGE') {
        const pg = parseInt(m.p.page, 10);
        if (pg) this.latestState = { page: pg, updated: Date.now() };
      }

      if (typeof m.to !== 'string') return;
      const t = this.clients.get(m.to);
      if (t) {
        try { t.send(JSON.stringify({ from: id, p: m.p })); } catch {}
      } else {
        // If target is the room ID itself, or a Kindle HTTP host not on WebSocket, broadcast to other clients in room
        const isRoomTarget = (m.to === roomId || m.to.startsWith('kroom') || m.to === '*' || m.to === 'broadcast');
        if (isRoomTarget) {
          for (const [cid, ws] of this.clients.entries()) {
            if (cid !== id) {
              try { ws.send(JSON.stringify({ from: id, p: m.p })); } catch {}
            }
          }
        } else {
          server.send(JSON.stringify({ err: 'gone', to: m.to }));
        }
      }
    });

    server.addEventListener('close', () => {
      if (this.clients.get(id) !== server) return;
      this.clients.delete(id);
      for (const ws of this.clients.values()) {
        try { ws.send(JSON.stringify({ from: id, left: true })); } catch {}
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Route PIN requests to dedicated central Durable Object
    if (url.pathname.startsWith('/pin')) {
      const pinId = env.ROOMS.idFromName('__GLOBAL_PIN_REGISTRY__');
      return env.ROOMS.get(pinId).fetch(req);
    }

    // Route room requests
    const m = url.pathname.match(/^\/room\/([\w-]{1,64})(\/.*)?$/);
    if (!m) {
      return jsonResponse({
        ok: true,
        app: 'coop-reader relay',
        features: ['websocket', 'http-sync', 'pin-codes'],
      });
    }

    const roomId = m[1];
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(req);
  },
};
