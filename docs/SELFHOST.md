# Self-hosting Coop Reader (no third-party servers)

Four pieces; you can self-host any subset. Everything is configured in one file, `config.js` (next to `index.html`), and can still be overridden per browser in the app's *Network* and *Signalling server* dialogs.

| Piece | Default | What it sees | Self-host with |
|---|---|---|---|
| Web app (static files) | GitHub Pages | nothing about sessions | any HTTPS static host (copy `dist/`) |
| Signalling (WebRTC handshake) | PeerJS cloud `0.peerjs.com` | peer ids, IP addresses, SDP | `peer` server (below) |
| STUN / TURN | public STUN, optional TURN | IP addresses; TURN also relays encrypted media/data | coturn, or Cloudflare Realtime TURN via the relay's `/ice` |
| Relay worker | the project's Cloudflare Worker | encrypted frames (web), plaintext JSON (Kindle HTTP), PINs | `wrangler deploy` on your account (`docs/RELAY.md`) |

## 1. Web app
```sh
npm run build          # produces dist/ (the web app, the Kindle packages, the KPM package source)
# upload dist/ (without the *.zip files if you like) to any HTTPS host
```
HTTPS is required for WebRTC, the clipboard, the service worker (offline start) and OPFS (large files). `localhost` counts as secure for development.

## 2. Signalling server (PeerJS)
```sh
npm i -g peer
peerjs --port 9000 --path /coop --key peerjs            # development
```
Production: run it behind a TLS-terminating reverse proxy that forwards WebSocket upgrades, e.g. nginx:
```nginx
location /coop/ {
  proxy_pass http://127.0.0.1:9000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```
`config.js`:
```js
window.COOP_CONFIG = { peer: { host: 'example.org', port: 443, path: '/coop', key: 'peerjs', secure: true } };
```
(The browser test-suite runs against exactly this `peer` server.)

## 3. TURN (needed for guests behind symmetric NAT / strict firewalls)
Option A – coturn (generic guidance, not exercised by this repository's tests):
```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.org
lt-cred-mech
user=coop:CHANGE-ME
fingerprint
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
```
`config.js`: `ice: [{ urls: 'stun:turn.example.org:3478' }, { urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'], username: 'coop', credential: 'CHANGE-ME' }]`.
A static credential is visible to every participant; for public use prefer short-lived credentials (coturn `use-auth-secret` + a small endpoint, or option B).

Option B – Cloudflare Realtime TURN through the relay worker: set `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` as worker secrets; the app fetches short-lived credentials from `GET /ice` automatically.

## 4. Relay worker
`npx wrangler deploy` (see `wrangler.toml` for `MAX_BLOB_MB`, `ROOM_QUOTA_MB`, TURN secrets). Then `config.js`: `relay: 'wss://relay.example.org'` and for Kindles set the same address in the KOReader plugin (*Settings > Relay*).

## 5. Fully private deployment checklist
* [ ] `config.js` points at your signalling server, relay and ICE servers (no `0.peerjs.com`, no `workers.dev` default).
* [ ] `noWidget: true` in `config.js` (the donation widget is the only third-party script; fonts are not loaded from a CDN, the pinned CDN libraries — PeerJS, pdf.js, pdf-lib, docx-preview, Pyodide — can be mirrored and the URLs in `index.html`/`sw.js` changed).
* [ ] Relay secrets set, `MAX_BLOB_MB`/`ROOM_QUOTA_MB` chosen for your plan.
* [ ] Test: two browsers on different networks, one with the network dialog set to *Relay server only*.
