// coop-reader WebSocket relay — Cloudflare Worker + Durable Object (free plan works).
// Deploy:  npx wrangler deploy   → copy the wss:// URL into the app: menu → Network → Relay server.
// Rooms are keyed by the host's session code; the relay only forwards frames and keeps nothing.
const MAX_CLIENTS = 20;

export class Room {
  constructor() { this.clients = new Map(); this.tokens = new Map(); }
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('coop-reader relay: websocket expected', { status: 426 });
    const q = new URL(req.url).searchParams, id = q.get('id') || '', tok = q.get('t') || '';
    if (!/^[\w-]{1,64}$/.test(id) || !/^[\w-]{8,64}$/.test(tok)) return new Response('bad id/token', { status: 400 });
    if (this.tokens.has(id) && this.tokens.get(id) !== tok) return new Response('id in use', { status: 409 }); // stops id hijacking
    if (!this.clients.has(id) && this.clients.size >= MAX_CLIENTS) return new Response('room full', { status: 429 });
    this.tokens.set(id, tok);
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const old = this.clients.get(id); if (old) { try { old.close(1000, 'replaced'); } catch {} }
    this.clients.set(id, server);
    server.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.length > 600000) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (typeof m.to !== 'string') return;
      const t = this.clients.get(m.to);
      if (t) { try { t.send(JSON.stringify({ from: id, p: m.p })); } catch {} }
      else server.send(JSON.stringify({ err: 'gone', to: m.to }));
    });
    server.addEventListener('close', () => {
      if (this.clients.get(id) !== server) return;
      this.clients.delete(id);
      for (const ws of this.clients.values()) { try { ws.send(JSON.stringify({ from: id, left: true })); } catch {} }
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!m) return new Response('coop-reader relay is running', { status: 200 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
};
