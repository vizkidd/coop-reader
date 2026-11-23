// Serves the REAL relay worker over localhost HTTP (in-memory storage) so the Lua tests can talk to it.
import http from 'node:http';
import Worker, { Room } from '../../src/relay-worker.js';
class MemoryStorage { constructor() { this.v = new Map(); } async get(k) { return this.v.get(k); } async put(k, x) { this.v.set(k, structuredClone(x)); } async delete(k) { return this.v.delete(k); } async deleteAll() { this.v.clear(); }
  async list({ prefix = '' } = {}) { return new Map([...this.v].filter(([k]) => k.startsWith(prefix))); } }
const rooms = new Map();
const env = { ROOMS: { idFromName: n => n, get(id) { if (!rooms.has(id)) rooms.set(id, new Room({ storage: new MemoryStorage() }, {})); const r = rooms.get(id); return { fetch: q => r.fetch(q) }; } } };
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await Worker.fetch(new Request('http://relay.test' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
server.listen(0, '127.0.0.1', () => console.log('PORT=' + server.address().port));
