# `coop-reader` (P2P WASM Collaborative Document Reader)

A secure, serverless, peer-to-peer (P2P) document and media reader running entirely within browser WebAssembly (WASM) environments. This application allows multiple users to read documents synchronously together while ensuring **the source document never leaves the host system's local memory or browser sandbox**.

---

## ✨ Key Features

* **Serverless & Secure P2P Architecture**: Utilizes WebRTC data channels via PeerJS. Files are securely transferred directly into peers' local WASM sandboxes without hitting any central server storage.
* **Multi-Format Support**:
  * **Documents & Spreadsheets**: PDF, DOCX, XLSX, EPUB, AZW3, MOBI (powered by Pyodide Python runtime and PDF.js).
  * **Images**: PNG, JPG, JPEG, WEBP, GIF.
* **Direct URL Joining**: Shareable deep links (`/coop-reader/<session-id>`) for instant session joining, with robust error handling for offline or non-existent rooms.
* **Real-Time Synchronization**: Synchronizes active page states, views, and navigation across all connected participants instantly.
* **Multi-User Cursors**: Live visual cursor tracking showing where other participants are looking within the document container.
* **Comprehensive Reader Controls**:
  * Direct page jump input.
  * Zoom In / Zoom Out.
  * Fit to Width & Fit to Height layout views.
  * Fullscreen toggle.
  * Toggle-able touch/mouse swipe gestures and keyboard navigation (Arrow keys, Spacebar, Page Up/Down).
* **Automated CI/CD**: Pre-configured GitHub Actions workflow for seamless deployment to GitHub Pages.

---

## 🚀 Quick Start (Local Development)

1. **Clone the Repository**:
   ```bash
   git clone [https://github.com/vizkidd/coop-reader.git](https://github.com/vizkidd/coop-reader.git)
   cd coop-reader

```

2. **Project Structure**:
```text
coop-reader/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── src/
│   ├── index.html
│   └── 404.html
├── package.json
└── README.md

```


3. **Run Locally**:
Using `http-server` (or any static local server):
```bash
npm install
npm run dev

```

Open `http://localhost:3000` in your browser.

---

## 📖 Usage Guide

1. **Host a Session**:
* Open the app and click **Create Session**.
* Copy the generated Host Code or use the **Copy** button to copy the direct join link.
* Upload a supported file (`.pdf`, `.docx`, `.xlsx`, `.epub`, `.jpg`, etc.). The file is processed locally and safely sent to connected peers' WASM sandboxes.


2. **Join a Session**:
* Open a shareable link (`https://vizkidd.github.io/coop-reader/<session-id>`) or paste the session code into the input field and click **Join**.
* Read along as the host controls the document, or use local controls (zoom, fit width/height, fullscreen) as preferred.

---

## 🛠️ Tech Stack

* **WebAssembly Runtime**: [Pyodide](https://pyodide.org/) (Python ecosystem running in browser via WebAssembly).
* **Networking & Signaling**: [PeerJS](https://peerjs.com/) (WebRTC P2P DataChannels).
* **Rendering Engine**: [PDF.js](https://mozilla.github.io/pdf.js/) for canvas-based visual PDF rendering.
* **Parsing Libraries**: `pypdf`, `python-docx`, `openpyxl`.
* **Hosting**: GitHub Pages with GitHub Actions automation.

```
