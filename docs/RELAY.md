# Why there is a relay worker, and how little it is used

**Short answer.** Web ↔ web sessions do **not** need it: they use WebRTC peer-to-peer (PeerJS cloud only exchanges the handshake).
The relay exists because three things cannot be done peer-to-peer from a browser or a Kindle:

| Job | Why P2P cannot do it | Without the relay |
|---|---|---|
| **Kindle / KOReader participants** | They can only make outbound HTTP(S) requests: no WebRTC in KOReader's Lua, nothing that accepts incoming connections. Someone must hold a mailbox both sides can reach. | Kindle cannot join browser sessions at all. Kindle ↔ Kindle on one Wi-Fi could use LAN mode, nothing else. |
| **Short PIN codes** (`4821` instead of a 36-character id) | A PIN is a lookup: a registry has to be reachable by anyone who types it. | Kindles would need to type the full room id. |
| **Last resort for hostile networks** (symmetric NAT, UDP blocked, corporate proxies) | WebRTC fails when no STUN/TURN path exists. A WebSocket over 443 passes almost everywhere. | Those users cannot join (unless a TURN server is configured). |

## What it carries now
Order tried for every connection (`src/js/coop-net.js`):

1. **p2p** direct WebRTC on the same network → 2. **stun** direct through NAT hole punching → 3. **turn** a TURN server relays WebRTC → 4. **peer** another participant forwards → 5. **relay** this worker.

* Steps 1-2 run first with *only* STUN servers (6 s); TURN is not even contacted unless they fail (8 s); a peer helper gets 5 s; only then the relay.
* The connection in use is classified from the ICE pair that is actually selected (`getStats`), scored by round-trip time, loss and failures, and a guest that had to fall back is **moved up automatically** (probe with exponential back-off, swap only when the new route is a better class *and* measurably as good).
* **Books never need the relay** when: the Kindle already has the book (matched by fingerprint, also sideloaded copies), the transfer is P2P between browsers, or both Kindles are on the same Wi-Fi (the sender serves the file over HTTP on the LAN, token protected). The relay stores a book only as the last fallback, for at most 2 hours.
* Browsers cannot use the LAN route (an `https://` page may not fetch `http://192.168…`), which is why a browser host → Kindle on another network still falls back to the relay.

## Free-plan budget (checked against Cloudflare's docs, Nov 2026)
Free plan: 100,000 Worker requests/day · Durable Objects: 100,000 requests/day, 13,000 GB-s duration/day, 100,000 rows written/day, 1 GB per object, 5 GB per account · incoming WebSocket messages count 1/20 of a request, protocol pings are free.

| What used to happen | Cost on the free plan | Now |
|---|---|---|
| Every guest polled `GET /state` every 2.5 s *even with the WebSocket open* | ≈ 34,500 requests/day **per guest** | one safety poll every 30 s while the socket is open (−92 %) |
| Host kept a normal WebSocket open permanently | 128 MB × 86,400 s ≈ 11,000 GB-s/day ≈ 85 % of the day's duration for one room | **WebSocket Hibernation**: the object sleeps between messages; socket keepalive is a raw `ping`/`pong` answered by the runtime |
| App-level `PING` every 15 s through the relay | a wake-up per ping per peer | every 45 s, liveness on guests comes from the socket pong |
| Blob metadata written after every 96 KiB chunk | 2 row writes per chunk | chunk size negotiated up to 1 MiB, metadata every 8 chunks (≈ 1.1 writes/chunk) |
| Files as JSON + base64 + AES + base64 | +78 % bytes | raw binary frames (+0.2 %) for file chunks |
| HTTP (Kindle) registrations lived only in memory | evicted object ⇒ 401 ⇒ re-join storm | persisted, restored on demand |

Back-of-envelope for the requests budget: a Kindle polling every 3 s while reading ≈ 1,200 requests/hour, so ~80 Kindle-hours/day fit; web guests cost almost nothing.

## Limits and how to change them (`wrangler.toml` `[vars]`)
* `MAX_BLOB_MB = "0"` – **no per-file cap** (it used to be 48 MB). Set a number to cap the relay's fallback transfers.
* `ROOM_QUOTA_MB = "900"` – storage per room (free plan: 1 GB per Durable Object). The oldest files are evicted first; a file larger than the quota is refused with a clear message and the app tells the user to use a direct connection. Raise it on the paid plan (10 GB/object). `0` = no quota.
* Transfers that do **not** touch the relay (P2P, LAN) have no limit other than free storage on the receiving device.

## TURN without a third-party account
Set the secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (Cloudflare Realtime TURN, 1,000 GB/month free) and the worker hands out short-lived credentials on `GET /ice`; the app fetches them when a session starts, only when no TURN address was saved by the user. Without the secrets nothing changes. The old default (public "openrelay" credentials) is a risk to depend on: public free TURN services come and go, and I could not test it from the sandbox.

## Protocol 4 additions (all backward compatible; older clients keep working)
* binary WebSocket frames `0x01 | toLen | to | body` ⇄ `0x02 | fromLen | from | body` (file chunks),
* `POST /room/<id>/revoke` (host ends the session: sockets closed, files wiped, the id and its PINs burned for 24 h) and `POST /room/<id>/ban`,
* blob meta carries `chunk` (32 KiB – 1 MiB); `GET /ice`; capabilities in `GET /`.

## Operating it
`npx wrangler deploy`. Unit tests: `npm test`; real-runtime test (hibernation, binary frames, revoke): `npx wrangler dev --port 8799 --local` then `RELAY=http://localhost:8799 node tests/e2e/relay-ws.e2e.mjs`.
