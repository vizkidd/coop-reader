# Coop Reader for Kindle (Jailbroken)

Port of **Coop Reader** for jailbroken Amazon Kindle e-readers. Allows Kindle users to read documents and books together in real time in the same session—with other Kindles, computers, or smartphones.

Packageable and installable directly via **Kindle Package Manager (KPM)**, **KUAL (Kindle Unified Application Launcher)**, or as a **KOReader Sync Plugin**.

---

## 📖 Key Features & Translation Matrix

| Feature | Desktop/Web Coop Reader | Kindle Port Implementation |
|---|---|---|
| **Distribution / Package** | Static web files / GitHub Pages | **KPM Package (`.kpkg`)** + **KUAL extension** + **KOReader plugin** |
| **Sessions & Rooms** | P2P PeerJS + WebSocket Relay | E2E-encrypted WebSocket Relay (`wss://`) + Local daemon bridge |
| **Room Join / Auth** | Link / Code (`id.key`) + Salted SHA-256 | Code entry dialog with on-screen Kindle keyboard & salted hash |
| **Documents Supported** | PDF, EPUB, MOBI, AZW3, DOCX, XLSX, TXT | **Direct Kindle `/mnt/us/documents/` browsing** + remote peer file transfers + PDF.js / text pagination |
| **Reading Sync** | Real-time page sync & Detach | Bidirectional page sync, **[Follow Host]** re-sync, Kindle hardware button integration |
| **Turn Navigation** | Mouse click / Swipes | **Kindle Page Buttons** (Oasis/Voyage/K4/K5) + **Left/Right 22% touch zones** |
| **Ghosting Reduction** | None needed on LCD/OLED | **Hardware EIPS refresh (`/usr/sbin/eips -c`)** + Pure invert flash |
| **Annotations / Notes** | Canvas drawing + numbered notes | High-contrast E-Ink pin notes with tap-to-read drawer and live sync |
| **Text Chat** | Web chat drawer | High-contrast E-Ink chat modal with virtual keyboard support |
| **Voice Chat** | WebRTC audio mesh | **Voice Presence Indicator**: Kindles lack microphone hardware; displays who is speaking in real time with listening mode |
| **Power Management** | Screen Wake Lock API | **Kindle LIPC power daemon hook (`lipc-set-prop com.lab126.powerd preventScreenSaver 1`)** |
| **Battery & Health** | Browser battery API | Hardware battery monitoring via LIPC (`battLevel`) / gasgauge |

---

## 🛠 Architecture & Components

```text
kindle/
├── kpm/                     # Kindle Package Manager (KPM) package definitions
│   ├── manifest.json        # KPM manifest_version: 2 specification
│   ├── install.sh           # Lifecycle install hook (sets up KUAL & KOReader)
│   ├── uninstall.sh         # Lifecycle cleanup hook
│   └── launch.sh            # Package execution launcher
├── kual/                    # KUAL Extension
│   ├── config.xml           # KUAL extension configuration
│   ├── menu.json            # KUAL menu entries
│   └── bin/
│       ├── launch.sh        # Starts daemon and Mesquite/Browser
│       ├── stop.sh          # Stops daemon and restores screensaver
│       └── refresh.sh       # Hardware EIPS screen refresh
├── daemon/                  # Lightweight Kindle background service
│   └── coop_daemon.py       # Python HTTP server, LIPC bridge, EIPS & /mnt/us/ library API
├── app/                     # E-Ink optimized Web application
│   ├── index.html           # High-contrast UI with touch zones & modals
│   ├── kindle-theme.css     # Pure black & white styling, no continuous animations
│   └── kindle-app.js        # Safe ES5/ES6 client logic, relay crypto & synchronization
├── koreader-plugin/         # KOReader co-reading sync plugin
│   └── coopreader.koplugin/
│       ├── _meta.lua
│       └── main.lua
└── build-kpm.sh             # Build script to generate .kpkg, KUAL .zip, and KOReader .zip
```

---

## 🚀 Installation Guide

### Option 1: Install via Kindle Package Manager (KPM)
*(Recommended for Kindles with KPM installed)*

1. Copy `dist/coop-reader.kpkg` to your Kindle, or install directly using KPM:
   ```bash
   ;kpm install /mnt/us/coop-reader.kpkg
   ```
   Or via SSH / `kterm`:
   ```bash
   kpm install coop-reader.kpkg
   ```
2. Launch directly from KPM or via KUAL under **Extensions → Coop Reader → Launch Coop Reader**.

### Option 2: Install via KUAL (Manual USB Transfer)
1. Build or download `dist/coop-reader-kual.zip`.
2. Connect your jailbroken Kindle to your computer via USB.
3. Unzip `coop-reader-kual.zip` into the `extensions/` directory on your Kindle drive:
   ```text
   /mnt/us/extensions/coop-reader/
       ├── config.xml
       ├── menu.json
       ├── bin/
       └── app/
   ```
4. Eject your Kindle, open **KUAL**, tap **Coop Reader**, and choose **Launch Coop Reader**.

### Option 3: KOReader Plugin (For Reading inside KOReader)
1. Extract `dist/coopreader.koplugin.zip` into:
   ```text
   /mnt/us/koreader/plugins/coopreader.koplugin/
   ```
2. Restart KOReader.
3. In KOReader, tap the top menu → **Tools / Network** → **Coop Reader Sync** → **Join Reading Session...**.

---

## 💡 How to Read Together on Kindle

### Starting a Session (Host)
1. Launch **Coop Reader** from KUAL or KPM.
2. Tap **[Session]** in the top navigation bar.
3. Tap **[Create Session]**.
4. Coop Reader will display your unique share code (e.g. `kroom482.abcdef...`).
5. Share this code with your reading partner (they can join on another Kindle, computer, or phone).
6. Tap **[Docs]** to select any book from your Kindle's `/mnt/us/documents/` folder. The document and pages will sync to all connected peers!

### Joining a Session (Peer)
1. Open Coop Reader on your Kindle (via KUAL, KPM, or KOReader).
2. **Simplified 4-Digit PIN Joining**:
   - On the host's screen (Chrome on macOS / `vizkidd.github.io/coop-reader`), locate the **Kindle PIN** (e.g. `4821`).
   - On your Kindle, simply type `4821` on the number pad! No need to type long 80-character base64 session codes or hashes.
   - Alternatively, you can still paste or type full session codes.
3. Your Kindle will automatically verify Wi-Fi connectivity, resolve the PIN, and lock in sync with the host's page turns!
4. To read ahead or flip backward without disturbing others, tap **[Follow Host]** to toggle **Detached Mode**, then tap it again to instantly jump back to the host's current page.

### 🐞 Debugging & Diagnostics in KOReader
If you run into issues while testing or reading:
1. Tap the top menu in KOReader → **Tools / Network** → **Coop Reader Sync**.
2. **Test Relay Connection**: Tests end-to-end HTTP/HTTPS reachability to the relay server and reports status code and latency.
3. **View Debug Log**: Opens an on-screen scrollable log viewer showing timestamped network events, Wi-Fi states, and page sync requests.
4. Log files are also persisted on device at `/tmp/coopreader_debug.log`.

---

## ⚡ E-Ink Optimizations & Hardware Tuning

1. **No-Ghosting High Contrast Palette**:
   - Background is `#ffffff` and text is `#000000` with 2px solid crisp borders.
   - Grayscale anti-aliasing and drop-shadows are eliminated to prevent washed-out text on E-Ink panels.
2. **Zero Animation Loops**:
   - All continuous CSS animations (spinners, pulsing box-shadows) are replaced with static text badges (`[ SYNCED ]`, `[ DETACHED ]`) to eliminate E-Ink waveform refresh loops and save battery.
3. **Hardware EIPS Ghosting Clearance**:
   - Tap **[Refresh]** in the header or use the KUAL shortcut to invoke `/usr/sbin/eips -c` for an instant hardware screen clear.
4. **Kindle Hardware Button Integration**:
   - Physical page turn buttons on Kindle Oasis, Kindle Voyage, and Kindle 4/5 trigger `PAGE_CHANGE` directly.
5. **Screen Sleep Prevention**:
   - The launcher and daemon automatically instruct Kindle's power daemon (`lipc-set-prop com.lab126.powerd preventScreenSaver 1`) to keep the display awake and WiFi connection alive while in an active reading session.
6. **Low RAM Footprint**:
   - Traditional web readers load heavy Pyodide WebAssembly bundles (~100 MB), which crash Kindle's 512MB RAM. Coop Reader Kindle Edition uses lightweight stream text extraction and the local Python daemon.

---

## 🌟 Suggested Feature Improvements & Future Roadmap

1. **1-Bit Fast-Waveform Page Flipping (A2 Mode)**:
   - On Kindle devices supporting `ioctl` ioctl updates to `/dev/fb0`, trigger fast 1-bit black/white waveform mode during rapid co-reading flips, followed by a 16-level grayscale refresh when pausing on a page.
2. **Offline Ad-Hoc / Local Wi-Fi Mesh**:
   - Allow two Kindles in the same room to read together via local Wi-Fi router or direct ad-hoc hotspot without needing an active internet connection or external relay.
3. **Synchronized Vocabulary Builder**:
   - When a user highlights or looks up a word in the shared book, add the word and definition to a shared "Session Vocab" drawer so both readers can learn together.
4. **Shared Book Hash Verification (Zero-Bandwidth File Sync)**:
   - If both readers already have the same EPUB or PDF in `/mnt/us/documents/`, calculate a fast MD5/SHA-256 hash. Instead of transferring megabytes over slow Kindle Wi-Fi, the session instantly matches the local file and only syncs lightweight page turn events.

