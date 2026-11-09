#!/bin/sh
# Coop Reader - KPM Install Hook
# Installs KUAL extension and optional KOReader plugin
# Works when run from any directory

LOG_FILE="/mnt/us/kpm_install.log"

# Tee output to both stdout and log file
log() {
    echo "$1"
    echo "$1" >> "$LOG_FILE"
}

echo "" > "$LOG_FILE"
log "=========================================="
log "Coop Reader KPM Installation"
log "Timestamp: $(date 2>/dev/null || echo 'N/A')"
log "=========================================="

# Display real-time progress on Kindle E-Ink display
print_eips() {
    row=$1
    text=$2
    if which eips >/dev/null 2>&1; then
        eips 0 "$row" "$text" 2>/dev/null || true
    fi
    log "[eips $row] $text"
}

if which eips >/dev/null 2>&1; then
    eips -c 2>/dev/null || true
fi

print_eips 0 "=============================="
print_eips 1 "  INSTALLING COOP READER"
print_eips 2 "=============================="

# Determine script location and search for source files
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
log "Script directory: $SCRIPT_DIR"
log "Current directory: $(pwd)"

EXT_DIR="/mnt/us/extensions/coop-reader"
KOR_DIR="/mnt/us/koreader/plugins/coopreader.koplugin"

# Search for source directories in multiple locations
find_src() {
    local_name="$1"
    local_subpath="$2"
    for base in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$(pwd)" "$(pwd)/.." "/mnt/us/coop-reader" "/mnt/us"; do
        if [ -d "$base/$local_subpath" ]; then
            # This function is called through command substitution; keep stdout
            # reserved for the path so log text cannot corrupt the result.
            log "Found $local_name at: $base/$local_subpath" >&2
            printf '%s\n' "$base/$local_subpath"
            return 0
        fi
    done
    log "WARNING: $local_name not found in any searched location" >&2
    return 1
}

KUAL_SRC="$(find_src 'KUAL config' 'kual')"
APP_SRC="$(find_src 'App files' 'app')"
DAEMON_SRC="$(find_src 'Daemon' 'daemon')"
KOR_SRC="$(find_src 'KOReader plugin' 'koreader-plugin/coopreader.koplugin')"

# If kual source is missing, also look for config.xml directly
if [ -z "$KUAL_SRC" ]; then
    for base in "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$(pwd)" "$(pwd)/.."; do
        if [ -f "$base/config.xml" ]; then
            KUAL_SRC="$base"
            log "Found KUAL config.xml at: $base"
            break
        fi
    done
fi

print_eips 4 "[1/4] Creating KUAL extension..."

# Create KUAL extension directory structure
mkdir -p "$EXT_DIR/bin" "$EXT_DIR/app"
log "Created extension directory: $EXT_DIR"

# Copy KUAL config files
if [ -n "$KUAL_SRC" ] && [ -d "$KUAL_SRC" ]; then
    log "Copying KUAL files from: $KUAL_SRC"
    # Copy config.xml and menu.json to extension root
    for f in config.xml menu.json; do
        if [ -f "$KUAL_SRC/$f" ]; then
            cp -f "$KUAL_SRC/$f" "$EXT_DIR/$f"
            log "  Copied $f"
        fi
    done
    # Copy bin scripts
    if [ -d "$KUAL_SRC/bin" ]; then
        cp -rf "$KUAL_SRC/bin/"* "$EXT_DIR/bin/" 2>/dev/null || true
        log "  Copied bin/ scripts"
    fi
else
    log "KUAL source not found, generating minimal config..."
    # Generate minimal KUAL config.xml
    cat > "$EXT_DIR/config.xml" << 'XMLEOF'
<?xml version="1.0" encoding="UTF-8"?>
<extension>
  <information>
    <name>Coop Reader</name>
    <version>1.0.0</version>
    <author>coop-reader</author>
    <id>coop-reader</id>
  </information>
  <menus>
    <menu type="json">menu.json</menu>
  </menus>
</extension>
XMLEOF

    # Generate minimal menu.json
    cat > "$EXT_DIR/menu.json" << 'JSONEOF'
{
  "items": [
    {
      "name": "Coop Reader",
      "priority": 1,
      "items": [
        {
          "name": "Launch Coop Reader",
          "priority": 1,
          "action": "bin/launch.sh"
        },
        {
          "name": "Quick Clear Ghosting (EIPS)",
          "priority": 2,
          "action": "bin/refresh.sh"
        },
        {
          "name": "Stop Coop Reader & Sleep Normal",
          "priority": 3,
          "action": "bin/stop.sh"
        }
      ]
    }
  ]
}
JSONEOF

    # Generate minimal launch.sh
    cat > "$EXT_DIR/bin/launch.sh" << 'LAUNCHEOF'
#!/bin/sh
BASE_DIR="/mnt/us/extensions/coop-reader"
PID_FILE="/tmp/coop_reader.pid"
PORT=8765
HTTP_URL="http://127.0.0.1:${PORT}/index.html"
FALLBACK_URL="file://${BASE_DIR}/app/index.html"

if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null || true
fi

http_ready() {
    if which curl >/dev/null 2>&1 && curl -fsS --max-time 1 "$HTTP_URL" >/dev/null 2>&1; then return 0; fi
    if which wget >/dev/null 2>&1 && wget -q -T 1 -O /dev/null "$HTTP_URL" 2>/dev/null; then return 0; fi
    return 1
}

DAEMON_RUNNING=0
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        DAEMON_RUNNING=1
    fi
fi

if [ "$DAEMON_RUNNING" -eq 0 ]; then
    PY_BIN=""
    if which python3 >/dev/null 2>&1; then PY_BIN="python3"
    elif which python >/dev/null 2>&1; then PY_BIN="python"; fi
    if [ -n "$PY_BIN" ] && [ -f "$BASE_DIR/bin/coop_daemon.py" ]; then
        $PY_BIN "$BASE_DIR/bin/coop_daemon.py" --port "$PORT" --root "$BASE_DIR/app" >/tmp/coop_daemon.log 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    elif which busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -q '^httpd$'; then
        busybox httpd -p "$PORT" -h "$BASE_DIR/app" >/tmp/coop_daemon.log 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    elif which httpd >/dev/null 2>&1; then
        httpd -p "$PORT" -h "$BASE_DIR/app" >/tmp/coop_daemon.log 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    fi
fi

LAUNCH_URL="$FALLBACK_URL"
if http_ready; then
    LAUNCH_URL="$HTTP_URL"
fi

if which lipc-set-prop >/dev/null 2>&1; then
    cat << EOF > /tmp/coop_redirect.html
<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;url=${LAUNCH_URL}">
<script>window.location.replace("${LAUNCH_URL}");</script>
</head>
<body>Loading Coop Reader...</body>
</html>
EOF
    lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser#going?url=file:///tmp/coop_redirect.html" 2>/dev/null || \
    lipc-set-prop com.lab126.browser gotoURL "$LAUNCH_URL" 2>/dev/null || \
    lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser" 2>/dev/null || true
elif which mesquite >/dev/null 2>&1; then
    mesquite -l com.lab126.coopreader -c "$LAUNCH_URL" >/dev/null 2>&1 &
fi

if which eips >/dev/null 2>&1; then
    sleep 2
    eips -c 2>/dev/null || true
fi
exit 0
LAUNCHEOF

    cat > "$EXT_DIR/bin/refresh.sh" << 'REFEOF'
#!/bin/sh
if which eips >/dev/null 2>&1; then
    eips -c 2>/dev/null || true
    eips '' 2>/dev/null || true
fi
exit 0
REFEOF

    cat > "$EXT_DIR/bin/stop.sh" << 'STOPEOF'
#!/bin/sh
PID_FILE="/tmp/coop_reader.pid"
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
fi
if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null || true
fi
rm -f /tmp/coop_redirect.html 2>/dev/null || true
if which eips >/dev/null 2>&1; then eips -c 2>/dev/null || true; fi
exit 0
STOPEOF
fi

print_eips 5 "[2/4] Copying app files..."

# Copy app files
if [ -n "$APP_SRC" ] && [ -d "$APP_SRC" ]; then
    cp -rf "$APP_SRC/"* "$EXT_DIR/app/" 2>/dev/null || true
    log "Copied app files from: $APP_SRC"
else
    log "WARNING: App source directory not found"
fi

# Copy daemon files to bin/
if [ -n "$DAEMON_SRC" ] && [ -d "$DAEMON_SRC" ]; then
    for f in "$DAEMON_SRC/"*.py; do
        [ -f "$f" ] && cp -f "$f" "$EXT_DIR/bin/" && log "Copied daemon: $(basename "$f")"
    done
fi

print_eips 6 "[3/4] Setting permissions..."
chmod +x "$EXT_DIR/bin/"*.sh 2>/dev/null || true
chmod +x "$EXT_DIR/bin/"*.py 2>/dev/null || true

# Install KOReader plugin if KOReader is present
print_eips 7 "[4/4] Checking KOReader plugin..."
if [ -d "/mnt/us/koreader/plugins" ] && [ -n "$KOR_SRC" ] && [ -d "$KOR_SRC" ]; then
    mkdir -p "$KOR_DIR"
    cp -rf "$KOR_SRC/"* "$KOR_DIR/" 2>/dev/null || true
    log "KOReader plugin installed to: $KOR_DIR"
    print_eips 8 "KOReader plugin: INSTALLED"
else
    if [ ! -d "/mnt/us/koreader/plugins" ]; then
        log "KOReader not found at /mnt/us/koreader - skipping plugin"
    elif [ -z "$KOR_SRC" ]; then
        log "KOReader plugin source not found - skipping"
    fi
    print_eips 8 "KOReader plugin: SKIPPED"
fi

# Create welcome document
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

# Verify installation
log ""
log "=== Installation Verification ==="
for f in config.xml menu.json bin/launch.sh; do
    if [ -f "$EXT_DIR/$f" ]; then
        log "  OK: $f"
    else
        log "  MISSING: $f"
    fi
done
log "Extension directory contents:"
ls -la "$EXT_DIR/" >> "$LOG_FILE" 2>&1
ls -la "$EXT_DIR/bin/" >> "$LOG_FILE" 2>&1
log ""

log "SUCCESS: Installation Complete!"
print_eips 10 "SUCCESS! Restart KUAL to see"
print_eips 11 "Coop Reader in the menu."
print_eips 12 ""
print_eips 13 "If not visible, restart Kindle."

if which eips >/dev/null 2>&1; then
    sleep 4
    eips -c 2>/dev/null || true
fi

exit 0
