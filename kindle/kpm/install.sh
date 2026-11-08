#!/bin/sh
# Coop Reader - KPM Install Hook
# Installs KUAL extension and optional KOReader plugin

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="/mnt/us/extensions/coop-reader"
KOR_DIR="/mnt/us/koreader/plugins/coopreader.koplugin"

echo "[Coop Reader] Installing KPM package..."

# 1. Install KUAL extension
mkdir -p "$EXT_DIR"
mkdir -p "$EXT_DIR/bin"
mkdir -p "$EXT_DIR/app"

cp -rf "$APP_DIR/../kual/"* "$EXT_DIR/" 2>/dev/null || true
cp -rf "$APP_DIR/../app/"* "$EXT_DIR/app/" 2>/dev/null || true
cp -rf "$APP_DIR/../daemon/"* "$EXT_DIR/bin/" 2>/dev/null || true

chmod +x "$EXT_DIR/bin/"*.sh 2>/dev/null || true
chmod +x "$EXT_DIR/bin/"*.py 2>/dev/null || true

# 2. Check and install KOReader plugin if KOReader directory exists
if [ -d "/mnt/us/koreader/plugins" ]; then
    echo "[Coop Reader] KOReader detected, installing KOReader sync plugin..."
    mkdir -p "$KOR_DIR"
    cp -rf "$APP_DIR/../koreader-plugin/coopreader.koplugin/"* "$KOR_DIR/" 2>/dev/null || true
fi

# 3. Create document sample / welcome document in /mnt/us/documents/coop-reader
mkdir -p "/mnt/us/documents/coop-reader"
if [ ! -f "/mnt/us/documents/coop-reader/welcome.txt" ]; then
    cat << 'EOF' > "/mnt/us/documents/coop-reader/welcome.txt"
Welcome to Coop Reader on Kindle!
----------------------------------
Read books and documents together in real-time across Kindles, PCs, and phones.
Features:
- Live page synchronization with host
- Tap-to-read comments and annotations
- Text chat with full e-ink contrast
- E-ink ghosting clear (EIPS flash)
- Works with PDF, EPUB, MOBI, AZW3, TXT, DOCX, XLSX
EOF
fi

echo "[Coop Reader] Installation completed successfully!"
exit 0

