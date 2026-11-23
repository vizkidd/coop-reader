# `coop-reader` — collaborative document reader

Read documents together in real time. Everything runs in the browser (static files, no backend of your own required): the host opens a file, shares a link or code, and everyone follows along. Connections are peer-to-peer (WebRTC via PeerJS), with optional relay fallbacks for difficult networks.

> **Privacy note:** documents are sent to participating clients, not stored by the relay. Browser/WASM and Kindle GUI WebSocket relay messages use AES-GCM end-to-end encryption. **The KOReader HTTP-mailbox bridge is currently different:** its limited page/profile/presence messages travel to the relay over HTTPS with a bearer token, but are not end-to-end encrypted, so the relay operator can read those bridge messages. KOReader does not receive document bytes through this bridge. Do not use the KOReader bridge for sensitive reading-session metadata until end-to-end encryption is added.

------------------------------------------------------------------------

## Features

### Sessions

- **Create / join** with a session code or a share link (`/coop-reader/<session-id>`).
- **Optional password** (salted hash). The share link can include it.
- **Auto-reconnect:** peers rejoin automatically after drops, reloads, or switching apps; heartbeat detects dead connections.
- **Profile dialog at start** (name + picture, camera or file), shown next to cursors, chat and comments.

### Documents

| Format | Support |
|----|----|
| PDF | Full rendering (PDF.js), outline-based contents |
| Images (PNG, JPG, WEBP, GIF) | Full |
| DOCX | Text and tables, split into pages; heading-based contents |
| XLSX | Cell values per sheet as text pages; one contents entry per sheet |
| EPUB | Text in reading order; chapter-based contents |
| TXT / MD / CSV | Plain text pages |
| MOBI / AZW3 | **Best-effort text extraction only**; DRM-protected files are not supported |

DOCX, XLSX, EPUB and MOBI/AZW3 are shown as extracted text, not with their original layout. Python parsing (Pyodide) is loaded only when one of these formats is opened.

### Reading together

- Page sync across everyone; **detach** to browse on your own, then **re-sync** to the host's page.
- Contents panel and previous/next chapter buttons.
- Zoom (buttons, **pinch**, double-tap, trackpad pinch), fit to width/height, fullscreen (with a fallback for iPhone), swipe and keyboard navigation.
- Live cursors for mouse and touch, shown relative to the page so they line up across devices.

### Annotations and comments

- Pen, highlight and **comments**, with colour choice and an eraser (peers erase only their own; the host can clear a page). Pencil-safe: a stylus never scrolls the page.
- **Comments are anchored**: click a spot, or select text and press *Comment on selection*. Click a pin or highlighted text to open its **thread** (avatar, name, time, replies, resolve). Dense areas merge into a numbered badge; pins keep their size while following zoom. The **Comments** list jumps to any thread.
- Synced live to everyone, including late joiners.
- **Export:** annotated **PDF** (drawings, highlights, numbered notes, plus a comments page that supports Latin, Greek, Cyrillic, Vietnamese and Devanagari text; CJK, Arabic and emoji print as “?”) and annotated **PNG** (with a comment legend). For DOCX/XLSX/EPUB/MOBI/TXT, which cannot hold them, you can download an **annotations report (.md)** instead.
- Host / solo annotations are saved in your browser (local storage) and restored when you reopen the same file. **Annotations data (.json)** can be downloaded and re-imported with **Import**. Peers always receive the host's copy; opening a different file starts clean.

### Voice and chat

- Text chat.
- Voice chat between peers (WebRTC audio). Speaking, typing and activity indicators with a fading avatar bubble.
- Voice needs a direct or TURN connection; it is **not** available through the peer-relay or relay-server routes.

### Host controls (👥 panel and menu)

- See each peer's connection route and current page.
- **Mute**, **ping** and **kick** peers. Kicking also **moves everyone else to a new session id** (old link, password, relay room and PIN stop working). Option: log out peers who leave the reader tab; option: allow peers to turn pages.
- **Send file** to one peer: it arrives as a private Save / Dismiss prompt and never changes anyone's shared document.
- Toggle: peers may **download**, **open files**, **annotate and comment**.
- Toggle speaking / typing / activity indicators for everyone.
- Peers get a reduced interface (no host or sharing controls). This is a **UI-level** restriction: a peer's browser still receives the file, so download limits are not cryptographically enforced.

### Connectivity (menu → 🌐 Network)

Connections try these routes in order and move to a better one in the background when it becomes possible: 1. **Direct** WebRTC (same network / STUN). 2. **TURN relay** if you configure one (or deploy the relay with Cloudflare TURN secrets: `/ice`) (credentials URL or ICE JSON). Needed across Wi-Fi / mobile data in many cases. 3. **Peer relay:** another connected peer dials the stuck newcomer and forwards data (one hop; the helper can see the traffic). 4. **WebSocket relay server** (browser/WASM and Kindle GUI messages are end-to-end encrypted; the random key travels in the invite link, or in the host code as `id.key`, and is never sent to the relay — joining through the relay needs the full link or code). The KOReader HTTP-mailbox bridge instead uses HTTPS plus a per-peer bearer token and currently sends only page/profile/presence messages in plaintext to the relay. Deploy `relay-worker.js` (below), or rely on the built-in default address, which is used **only if it answers a reachability check**.

Options: - **Automatic** (default) or **Relay server only** mode. - **Private mode:** forces all WebRTC through TURN to hide your IP from other participants (requires TURN; connections fail without it). - Peers see how each person is connected: ⚡ direct, 🔒 TURN, 🔗 via peer, 🌐 relay server. - **Connection health:** a banner warns about an unreachable signaling server, a disconnected relay, a lost host connection, and relay routes (no voice), with retry buttons. **Log** (in the menu) shows a copyable connection log. Relay connections send keepalives, so silent drops are detected and reconnected.

### Mobile

Screen stays awake during a session, password entry uses an in-page dialog, and iPhone/Android quirks (fullscreen, backgrounding, touch panning) are handled.

------------------------------------------------------------------------

## Not implemented

- Editing XLSX, DOCX or PDF forms.
- Voice through relay routes.
- Original layout for DOCX / EPUB / MOBI.

------------------------------------------------------------------------

## Kindle and KOReader

Jailbroken Kindles (and any KOReader device) can read in the same session as the web app, through the relay.
The Kindle client is a **KOReader plugin**; a KUAL menu installs and launches it. **No Python or other extras are
needed on the Kindle.** See [kindle/README.md](kindle/README.md) for install steps, features and troubleshooting.

- Opening a book is synced: when the host opens a book everyone else gets it (matching copy found on the device, or
  downloaded on demand through the relay and verified). Page sync is optional and can be switched on/off at any time.
- Page position is shared as a fraction of the book for reflowable formats, so Kindle and web pages line up.
- Chat in both directions with on-screen notifications; room members and the host's book can be viewed on the Kindle.
- Sessions keep running in the background while KOReader runs (also while you switch books or sit in the file list).

## Files

``` text
index.html        the app (all UI and networking)
worker.js         Pyodide document parser (DOCX / XLSX / EPUB / MOBI / TXT)
404.html          redirects deep links (/<session-id>) back to the app (GitHub Pages)
relay-worker.js   optional relay (Cloudflare Worker + Durable Object): WebSocket rooms, HTTP mailbox for Kindles, PINs, chunked file transfer
wrangler.toml     config for deploying the relay
kindle/           KOReader plugin, KUAL extension, browser app and build script
tests/            relay, Lua plugin and end-to-end tests (npm run test:all)
```

Keep `index.html`, `worker.js` and `404.html` in the same folder.

## Run locally

``` bash
npx http-server -p 3000      # or any static server
```

Open `http://localhost:3000`. A secure context (https or localhost) is required for WebRTC, clipboard and microphone.

## Why a relay, and the free plan
See **docs/SECURITY.md** (who may command whom, signed host commands), **docs/SELFHOST.md** (run everything yourself), **docs/RELAY.md** (why it exists, what it costs on Cloudflare's free plan, how to tune it) and **docs/REVIEW.md** (bugs fixed, feature map, roadmap).

## Large files
No file size limit: documents are streamed in slices and spooled to disk on the receiving device; PDFs are opened with range requests. Only formats that must be parsed completely in memory (DOCX/XLSX/EPUB) depend on available RAM.

## Tests
`npm test` (unit), `npm run test:lua`, `npm run test:browser` and `npm run test:browser:relay` (real Chromium + the real Workers runtime, need the dev dependencies), `npm run test:all`.

## Deploy the relay (optional, recommended)

``` bash
npx wrangler deploy          # run in the folder with relay-worker.js and wrangler.toml
```

Copy the printed `wss://…workers.dev` address into **Network → Relay server** and press **Test**. Share links carry a custom relay address so peers need no setup.

------------------------------------------------------------------------

## Tech stack

- **Networking:** [PeerJS](https://peerjs.com/) (WebRTC) with optional STUN/TURN and a WebSocket relay.
- **PDF rendering:** [PDF.js](https://mozilla.github.io/pdf.js/); **PDF export:** [pdf-lib](https://pdf-lib.js.org/) with fontkit and Noto Sans for Unicode comments (all loaded from a CDN on first export).
- **Parsing:** [Pyodide](https://pyodide.org/) with `python-docx` and `openpyxl`.
- **Relay:** Cloudflare Workers + Durable Objects.
- **Hosting:** static files (GitHub Pages).
