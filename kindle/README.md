# Coop Reader for Kindle (KOReader)

Read together with other Kindles and the Coop Reader web app. The Kindle side is a **KOReader plugin**
(`coopreader.koplugin`); a small **KUAL menu** installs it and starts KOReader. Nothing else has to be installed on
the Kindle: **no Python, no daemon.**

## What you get

| | Web app | KOReader plugin |
|---|---|---|
| Host or join a session (PIN / room code) | yes | yes |
| Opening a book follows the host | yes | **yes** (finds your copy, or downloads it) |
| Page sync | yes (detach/re-sync) | **yes, toggle any time** |
| Reflowable books line up across devices | yes | yes (position as a fraction of the book) |
| Chat with notifications | yes | **yes** (toast on every message, unread counter) |
| Room members, host info, disconnect | yes | **yes** |
| Comments from the web app | shown on the page | listed (and shown as a notification) |
| Annotating, voice, PDF forms | yes | not on the Kindle |
| Runs in the background | - | **yes** while KOReader runs and the Kindle is awake |

Sessions with a **password** are not supported on the Kindle yet (ask the host for an open session or use the PIN).
Kindle sessions go through the relay over HTTPS; unlike browser-to-browser sessions they are **not end-to-end encrypted**,
because the Kindle cannot do the browser's encryption. Books travel through the relay in verified 96 KiB chunks
(no size limit; kept for up to 2 hours, and only used when a direct Wi-Fi transfer is not possible).

## Install (the reliable way: USB)

1. Connect the Kindle by USB. Unzip **`coop-reader-kindle-usb.zip`** into the **root** of the Kindle drive.
   It creates `extensions/coop-reader/` (the KUAL menu) and `koreader/plugins/coopreader.koplugin/` (the plugin).
2. Eject. Open **KUAL → Coop Reader → Open KOReader (with Coop Reader)**.
3. In KOReader: **Menu → Tools → Coop Reader**.

Other packages in `dist/`: `coop-reader-kual.zip` (extension only; its menu can install the plugin for you:
*Install / update the KOReader plugin*) and `coopreader.koplugin.zip` (plugin only, unzip into `koreader/plugins/`).
KPM is **not** needed or used.

If KUAL shows nothing: restart KUAL, and check that the folder is exactly `extensions/coop-reader/config.xml`
(not `extensions/coop-reader/coop-reader/...`). If KOReader is not installed yet, install it first.

## KUAL menu (Coop Reader submenu)

- **Open KOReader (with Coop Reader)** - starts KOReader, updating the plugin first when the bundled one is newer
- **Status and diagnostics** - writes `coop-reader-status.txt` (plugin version, Wi-Fi, date, relay reachability, last log lines)
- **Install / update the KOReader plugin** and **Remove the KOReader plugin**
- **Open the browser app (experimental)** - the older browser version; the plugin is the complete client
- **Clear screen ghosting**

## Using it

- **Host:** Coop Reader → *Host a session*. The screen shows a **Kindle PIN** and a room code. Open a book: everyone follows.
- **Join:** *Join a session*, enter the host's PIN (Kindle or web app) or room code.
- **Controls:** a small **"Coop" button** sits at the bottom-right of the screen while connected
  (**tap** = panel, **hold** = chat). The same actions are in the top menu and can be bound to gestures
  (*Settings → Taps and gestures → Coop Reader: panel / chat*). The button can be turned off in *Settings*.
- **Panel:** chat, who's here, page sync on/off, book sync on/off, share this book now (host), get the host's book,
  comments, disconnect.
- **Settings:** follow the host's book, download missing books automatically (or ask), device name, relay address,
  reconnect to the last session at startup.
- **Background:** the session lives in the plugin, not in a book, so it continues when you open another book, return to
  the file list or let the screen sleep (syncing pauses while the Kindle sleeps and catches up on wake).
  Polling adapts: about every 3 s while you read, slowing to 20 s when idle.

## Troubleshooting

1. **Coop Reader → Test connection** (inside KOReader) shows DNS, relay reachability and whether the relay supports book transfer.
2. A wrong Kindle **date/time** breaks HTTPS: fix it in the Kindle settings.
3. **"PIN not found"**: PINs live 4 hours; the host must still be hosting and use the same relay. After 10 wrong PINs the
   relay pauses lookups from your network for 10 minutes.
4. **Books not arriving**: the relay must be the current `relay-worker.js` (redeploy with `npx wrangler deploy`); the
   connection test warns if it is too old. There is no size limit on the Kindle side; the relay's own quota (default 900 MB per room) only matters for the fallback.
5. **Debug log**: Coop Reader → Debug log, or `/tmp/coopreader_debug.log`.

## How it works

The plugin talks to the relay's HTTP mailbox (`/http/join`, `/http/send`, `/http/poll`) and its chunked file API
(`/blob/<fid>/meta`, `/blob/<fid>/<n>`). Documents are offered (`DOC_OPEN`), requested on demand (`DOC_REQUEST`), uploaded
by the host in chunks, announced (`DOC_READY`) and downloaded and checked against a fingerprint
(`size-crc32(first 64 KiB)-crc32(last 64 KiB)`, identical in the browser and the plugin) before opening.
All non-UI logic is in `coop_core.lua` and is tested against the real relay (`npm run test:lua`).

## Build and test

```sh
npm run build        # copies the web app to dist/ and builds the Kindle packages
npm run test:all     # relay tests, Lua plugin tests against the real relay, browser end-to-end test
```

## What could not be tested here

The plugin was exercised under Lua 5.4 with stand-ins for KOReader's UI modules and the real relay code, and the KUAL
scripts against a simulated Kindle folder. They have **not** been run on a physical Kindle: KOReader's widget APIs, the
on-screen button's placement and the exact KUAL behaviour on your firmware are the places to look first if something is off.


## GUI, KUAL and KPM (v2.1)
* **Home screen** inside KOReader: *Coop Reader* in the Tools menu, or assign the gesture action *Coop Reader: panel*. Big touch buttons: Host a session · Join with PIN · Recent sessions · Settings · Test connection · How it works.
* **KUAL** entries open straight into a screen: *home screen*, *Host a session*, *Join a session*, *Settings*, *Test the connection*. They write one line (`panel|host|join|join:<PIN>|settings|test`) to `koreader/settings/coopreader.intent`; the plugin reads and deletes it once at start-up.
* **KPM** (firmware where KUAL is not available): `dist/kpm/coop-reader/` is the package source (`manifest.json`, `install.sh`, `launch.sh`, `uninstall.sh`, payload). Pack it with KindleModding's `kpm-helper` (see `kindle/kpm/README.md`). `launch.sh [host|join|join:<PIN>|settings|test]` opens the same GUI.
* **Direct Wi-Fi transfer**: when a Kindle host shares a book, readers on the same network fetch it straight from the host's Kindle (read-only HTTP, random per-session token, only books that were shared, stops on disconnect). If that does not work the reader is told and the relay is used. Switch it off in *Settings*.
* The plugin follows a **session rotation** (host removed someone) and reports an **ended/removed** session instead of retrying forever.
