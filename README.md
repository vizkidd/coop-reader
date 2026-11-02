# `coop-reader` — P2P WASM Collaborative Document Reader

A secure, serverless, peer-to-peer (P2P) document and media reader that runs entirely
inside the browser's WebAssembly sandbox. Multiple users can read the same document
synchronously, in real time, while the source file **never touches a central server** —
it is streamed directly from the host's browser memory to each peer's local WASM
sandbox over WebRTC.

---

## ✨ Key Features

### 🔒 Privacy-first architecture
- **Serverless P2P**: Signaling only exchanges connection metadata; documents travel
  exclusively over WebRTC DataChannels.
- **Zero-knowledge transit**: Files are chunked and streamed directly to peers — no
  uploads to a server, no persistent cloud storage, no third-party reader services.
- **Local WASM parsing**: PDF, DOCX, XLSX, EPUB, and images are parsed in the browser
  by Pyodide + PDF.js. Nothing leaves the tab.

### 📄 Rich format support
| Category | Formats |
|---|---|
| Documents | `.pdf` (PDF.js canvas) |
| Office | `.docx` (python-docx), `.xlsx` (openpyxl) |
| eBooks | `.epub`, `.azw3`, `.mobi` (zip + text extraction) |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` |

### 🔄 Real-time collaboration
- **Synced page navigation** across all connected peers.
- **Live cursors** showing where other readers are pointing.
- **Host relay**: if a peer uploads a new file, the host automatically forwards it to
  every other connected peer.
- **Auto-reconnect** to the signaling server with backoff.

### 🎛️ Cross-platform reader controls
- Prev / Next page, direct page jump (with a thumb-friendly prompt on mobile).
- Zoom in/out, **Fit Width**, **Fit Height**, **Fullscreen**.
- **Touch, mouse, and keyboard** navigation:
  - Swipe left/right to change pages.
  - Arrow keys, Space, Page Up/Down.
  - All gestures gated by an "Gestures & Keys" toggle.

### 💾 Persistence & resilience
- **OPFS (Origin Private File System)** caching — the last opened file is stored
  locally and can be restored with one click after a reload.
- **Heartbeat (PING/PONG)** detects dead peers within 15 seconds.
- **Chunked file transfer (64 KB)** — large PDFs don't freeze the UI or fail mid-send.
- **Host state sync on join** — new peers receive the current page and (if any) the
  active file immediately.

### 📱 Responsive, accessible UI
- **Mobile-first layout**: page navigation moves to a fixed bottom bar inside the
  thumb zone; the rest of the controls collapse into a hamburger menu.
- **Desktop/tablet layout**: inline toolbar with grouped controls.
- **Dark mode** via `prefers-color-scheme`.
- **iOS-safe viewport** (`viewport-fit=cover` + `env(safe-area-inset-*)`) for notched
  phones and the bottom home indicator.
- **Touch targets ≥ 44 × 44 px**; inputs at `16 px` to prevent iOS auto-zoom.
- **Live status pill** with color-coded dot (info / success / warning / error).

### ⚙️ Performance & stability
- **Lazy Pyodide package loading** — `python-docx` and `openpyxl` are only installed
  when a `.docx` / `.xlsx` file is opened, avoiding a ~7 MB penalty on startup.
- **Bounded canvas rendering** — PDF.js is clamped to `maxRenderDpr = 2` and
  `maxCanvasPixels ≈ 4 MP`, preventing iOS Safari from killing the GPU process on
  large scanned PDFs.
- **URL-encoded deep links** — session paths with spaces or special characters survive
  the 404 → `index.html` round-trip.

### 🤖 Automated deployment
- GitHub Actions workflow deploys to GitHub Pages on every push to `main`.

---
