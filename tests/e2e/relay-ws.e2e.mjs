// Real-runtime relay test (workerd). Start the relay first:  npx wrangler dev --port 8799 --local
// then run:  RELAY=http://localhost:8799 node tests/e2e/relay-ws.e2e.mjs      (needs the `ws` package)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const WebSocket = require('ws');
const BASE = process.env.RELAY || 'http://localhost:8799', WS = BASE.replace(/^http/, 'ws');
const room = 'e2e' + Math.random().toString(36).slice(2, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = () => 'tok' + Math.random().toString(36).slice(2, 12) + 'abcd';
function open(id, t = tok()) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS}/room/${room}?id=${id}&t=${t}`); ws.t = t; ws.inbox = []; ws.closed = null;
    ws.on('message', (d, bin) => { if (bin) return ws.inbox.push(new Uint8Array(d)); const t = d.toString(); ws.inbox.push(t === 'pong' ? 'pong' : JSON.parse(t)); });
    ws.on('close', c => { ws.closed = c; }); ws.on('open', () => res(ws)); ws.on('error', rej); ws.on('unexpected-response', (_, r) => rej(new Error('HTTP ' + r.statusCode)));
  });
}
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(25); } };
const frame = (to, body) => { const t = Buffer.from(to); return Buffer.concat([Buffer.from([1, t.length]), t, Buffer.from(body)]); };

const host = await open(room), guest = await open('guest-1');
guest.send(JSON.stringify({ to: room, p: { type: 'RELAY_HELLO' } }));   // guests announce themselves (the relay only announces existing peers to a late host)
await waitFor(() => host.inbox.find(m => m.p && m.p.type === 'RELAY_HELLO' && m.from === 'guest-1'));
console.log('ok  host is told about the guest');

guest.send(JSON.stringify({ to: room, p: { type: 'HELLO', n: 1 } }));
await waitFor(() => host.inbox.find(m => m.p && m.p.type === 'HELLO'));
console.log('ok  text frames are routed');

const payload = new Uint8Array(200000).map((_, i) => i & 255);
guest.send(frame(room, payload));
const bin = await waitFor(() => host.inbox.find(m => m instanceof Uint8Array));
assert.equal(bin[0], 2); const n = bin[1]; assert.equal(Buffer.from(bin.subarray(2, 2 + n)).toString(), 'guest-1');
assert.equal(bin.length - 2 - n, payload.length); assert.deepEqual(bin.subarray(2 + n, 2 + n + 8), payload.subarray(0, 8));
console.log('ok  binary frames are routed with the sender id, no base64');

guest.send('ping'); await waitFor(() => guest.inbox.includes('pong') || guest.inbox.some(m => m === 'pong'), 3000).catch(() => { throw new Error('no pong'); });
console.log('ok  transport ping/pong answered');

console.log('... idle 14 s so the object can hibernate'); await sleep(14000);
host.send(JSON.stringify({ to: 'guest-1', p: { type: 'AFTER_SLEEP' } }));
await waitFor(() => guest.inbox.find(m => m.p && m.p.type === 'AFTER_SLEEP'));
console.log('ok  messages still delivered after hibernation (state rebuilt from attachments)');
guest.send(frame(room, new Uint8Array([7, 7, 7])));
await waitFor(() => host.inbox.filter(m => m instanceof Uint8Array).length >= 2);
console.log('ok  binary routing works after wake-up too');

const forbidden = await fetch(`${BASE}/room/${room}/revoke?id=guest-1&t=${guest.t}`, { method: 'POST', body: '{}' });
assert.equal(forbidden.status, 403); console.log('ok  guests cannot revoke');
const ban = await fetch(`${BASE}/room/${room}/ban?id=${room}&t=${host.t}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peer: 'guest-1' }) });
assert.equal(ban.status, 200); await waitFor(() => guest.readyState >= 2);   // close frame received (local dev proxies may keep the TCP socket half-open)
await assert.rejects(() => open('guest-1'), /403/); console.log('ok  banned peer is disconnected and cannot reconnect');

const g2 = await open('guest-2');
const rev = await fetch(`${BASE}/room/${room}/revoke?id=${room}&t=${host.t}`, { method: 'POST', body: '{}' });
assert.equal(rev.status, 200); await waitFor(() => g2.readyState >= 2 && host.readyState >= 2);
await assert.rejects(() => open('guest-3'), /410/); console.log('ok  revoke closes every socket and burns the room id');
console.log('ALL PASSED'); process.exit(0);
