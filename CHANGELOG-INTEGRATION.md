# Coop Reader integration update

## What changed

- Unified browser/WASM, Kindle GUI, and KOReader participation around the same relay room state. Browser clients continue using WebSockets; KOReader uses an authenticated HTTP mailbox because its Lua runtime does not use the browser WebSocket client.
- Added HTTP mailbox operations under `/room/:room/http/`: `join`, `poll`, `send`, and `leave`. Each registered HTTP peer receives a random bearer token. Polling refreshes membership; outbound queue traffic does not.
- Added host-presence reporting and persistent PIN lookup/creation. A PIN is issued only after a room host is registered, so an offline room cannot produce a misleading PIN.
- Made host page changes authoritative. Guest page turns are reported as `PAGE_INFO`, and detached Kindle readers remain registered while not following the host.
- Added room status, peer/host information, and explicit disconnect controls to Kindle/KOReader session surfaces. Manual disconnect prevents the Kindle GUI from automatically reconnecting.
- Corrected KUAL's JSON menu reference, KPM source-path discovery/logging, KPM repository-install instructions, KOReader ZIP extraction instructions, and the Kindle GUI launcher health check.
- Restricted the local Kindle daemon to loopback, added static-path containment checks, and streamed document responses in bounded chunks.
- Removed the blocking timed donation prompt from session creation/join.

## Relay deployment is required

The updated clients depend on the updated Worker. Deploy it from the project root with:

```sh
npm install
npm run deploy:relay
```

Then configure the resulting Worker URL in the WASM Network settings and the KOReader plugin's **Set Relay Server URL** setting if it is not the default. Updating the source tree does not update an already-deployed Cloudflare Worker.

## Kindle install outputs

Run `npm run build` to regenerate:

- `dist/coop-reader.kpkg` — KPM repository package artifact; KPM installs package IDs from a configured repository.
- `dist/coop-reader-kual.zip` — manual USB/KUAL extension.
- `dist/coopreader.koplugin.zip` — KOReader plugin; extract into the KOReader `plugins` directory.

## Supported integration scope and caveats

- The KOReader plugin currently supports room join/host, PIN/full-code resolution, page sync, detached guest page reporting, profile/presence, host status, and disconnect. Chat, annotations, file transfer, voice, and password-protected browser rooms are not implemented in the KOReader plugin.
- The KOReader HTTP mailbox uses HTTPS and per-peer bearer tokens, but its bridge messages are not end-to-end encrypted. The relay operator can read page/profile/presence metadata. The browser/WASM and Kindle GUI WebSocket message path retains AES-GCM.
- The Kindle GUI PDF renderer loads PDF.js from a CDN unless a local `pdf.min.js` is supplied; offline PDF rendering is not guaranteed.
- The relay tests use a mocked Durable Object storage/namespace. The updated Worker still needs deployment to the target Cloudflare account.
- The daemon, JavaScript, shell scripts, archive contents, and relay protocol tests were checked locally. The KOReader Lua source was manually reviewed, but no Lua interpreter or physical Kindle/KUAL/KOReader device was available for an on-device execution test.
