#!/bin/sh
# Coop Reader - KPM Install Hook
# Installs KUAL extension and optional KOReader plugin

LOG_FILE="/mnt/us/kpm_install.log"
exec > "$LOG_FILE" 2>&1

echo "=========================================="
echo "Coop Reader KPM Installation Started"
echo "Timestamp: $(date 2>/dev/null || echo 'N/A')"
echo "=========================================="

# Display real-time progress on Kindle E-Ink display
print_eips() {
    row=$1
    text=$2
    if which eips >/dev/null 2>&1; then
        eips 0 "$row" "$text" 2>/dev/null || true
    fi
    echo "[eips $row] $text"
}

if which eips >/dev/null 2>&1; then
    eips -c 2>/dev/null || true
fi

print_eips 0 "=============================="
print_eips 1 "   INSTALLING COOP READER     "
print_eips 2 "=============================="

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="/mnt/us/extensions/coop-reader"
KOR_DIR="/mnt/us/koreader/plugins/coopreader.koplugin"

print_eips 4 "[1/3] Setting up KUAL extension..."

# Locate source folders (supports both flat kpkg root and nested structures)
KUAL_SRC=""
APP_SRC=""
DAEMON_SRC=""
KOR_SRC=""

if [ -d "$APP_DIR/kual" ]; then KUAL_SRC="$APP_DIR/kual"; elif [ -d "$APP_DIR/../kual" ]; then KUAL_SRC="$APP_DIR/../kual"; fi
if [ -d "$APP_DIR/app" ]; then APP_SRC="$APP_DIR/app"; elif [ -d "$APP_DIR/../app" ]; then APP_SRC="$APP_DIR/../app"; fi
if [ -d "$APP_DIR/daemon" ]; then DAEMON_SRC="$APP_DIR/daemon"; elif [ -d "$APP_DIR/../daemon" ]; then DAEMON_SRC="$APP_DIR/../daemon"; fi
if [ -d "$APP_DIR/koreader-plugin/coopreader.koplugin" ]; then KOR_SRC="$APP_DIR/koreader-plugin/coopreader.koplugin"; elif [ -d "$APP_DIR/../koreader-plugin/coopreader.koplugin" ]; then KOR_SRC="$APP_DIR/../koreader-plugin/coopreader.koplugin"; fi

mkdir -p "$EXT_DIR"
mkdir -p "$EXT_DIR/bin"
mkdir -p "$EXT_DIR/app"

if [ -n "$KUAL_SRC" ]; then
    echo "Copying KUAL files from: $KUAL_SRC"
    cp -rf "$KUAL_SRC/"* "$EXT_DIR/" 2>&1 || true
fi

if [ -n "$APP_SRC" ]; then
    echo "Copying App files from: $APP_SRC"
    cp -rf "$APP_SRC/"* "$EXT_DIR/app/" 2>&1 || true
fi

if [ -n "$DAEMON_SRC" ]; then
    echo "Copying Daemon files from: $DAEMON_SRC"
    cp -rf "$DAEMON_SRC/"* "$EXT_DIR/bin/" 2>&1 || true
fi

print_eips 5 "[2/3] Configuring permissions..."
chmod +x "$EXT_DIR/bin/"*.sh 2>/dev/null || true
chmod +x "$EXT_DIR/bin/"*.py 2>/dev/null || true

# 2. Check and install KOReader plugin if KOReader directory exists
print_eips 6 "[3/3] Checking KOReader plugin..."
if [ -d "/mnt/us/koreader/plugins" ] && [ -n "$KOR_SRC" ]; then
    echo "KOReader detected, copying plugin from: $KOR_SRC"
    mkdir -p "$KOR_DIR"
    cp -rf "$KOR_SRC/"* "$KOR_DIR/" 2>&1 || true
    echo "KOReader plugin installed to $KOR_DIR"
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

echo "Coop Reader installed successfully!"
print_eips 8 "SUCCESS: Installation Complete!"
print_eips 9 "Open KUAL -> Coop Reader to start."

if which eips >/dev/null 2>&1; then
    sleep 3
    eips -c 2>/dev/null || true
fi

exit 0
