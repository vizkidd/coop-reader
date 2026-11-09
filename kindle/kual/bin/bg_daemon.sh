#!/bin/sh
# Coop Reader - Background Sync Daemon for Kindle (KUAL / KPM)
# Runs without Python; works with BusyBox httpd, curl/wget, and POSIX shell.
set -u

BASE_DIR="/mnt/us/extensions/coop-reader"
if [ ! -d "$BASE_DIR" ]; then
    BASE_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
fi

PID_FILE="/tmp/coop_bg_daemon.pid"
PORT=8765
HTTP_URL="http://127.0.0.1:${PORT}/index.html"
LOG_FILE="/tmp/coop_bg_daemon.log"
SESSION_FILE="/tmp/coop_session.txt"
DOCS_DIR="/mnt/us/documents/coop-reader"
mkdir -p "$DOCS_DIR" 2>/dev/null || true

# If already running, do not spawn duplicate
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Coop Reader background daemon already running (PID $OLD_PID)"
        exit 0
    fi
fi

# Prevent sleep / screen saver while background sync daemon is active
if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null || true
fi

# 1. Start local HTTP daemon if not already running
PY_BIN=""
if which python3 >/dev/null 2>&1; then PY_BIN="python3"
elif which python >/dev/null 2>&1; then PY_BIN="python"; fi

http_ready() {
    if which curl >/dev/null 2>&1; then
        curl -fsS --max-time 1 "${HTTP_URL}" >/dev/null 2>&1 && return 0
    fi
    if which wget >/dev/null 2>&1; then
        wget -q -T 1 -O /dev/null "${HTTP_URL}" 2>/dev/null && return 0
    fi
    return 1
}

if ! http_ready; then
    if [ -n "$PY_BIN" ] && [ -f "$BASE_DIR/bin/coop_daemon.py" ]; then
        "$PY_BIN" "$BASE_DIR/bin/coop_daemon.py" --port "$PORT" --root "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "/tmp/coop_reader.pid"
        sleep 1
    elif which busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -q '^httpd$'; then
        busybox httpd -p "$PORT" -h "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "/tmp/coop_reader.pid"
        sleep 1
    elif which httpd >/dev/null 2>&1; then
        httpd -p "$PORT" -h "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "/tmp/coop_reader.pid"
        sleep 1
    fi
fi

# 2. Main background sync polling loop
(
    RELAY_URL="https://coop-relay.coop-reader.workers.dev"
    LAST_DOC=""

    echo "Coop Reader Background Daemon started at $(date 2>/dev/null || echo 'now')" >> "$LOG_FILE"

    while true; do
        ROOM_ID=""
        if [ -f "$SESSION_FILE" ]; then
            ROOM_ID=$(head -n 1 "$SESSION_FILE" | tr -d '\r\n ' 2>/dev/null || true)
        fi

        if [ -n "$ROOM_ID" ]; then
            STATE_JSON=""
            if which curl >/dev/null 2>&1; then
                STATE_JSON=$(curl -fsS --max-time 5 "${RELAY_URL}/room/${ROOM_ID}/state" 2>/dev/null || true)
            elif which wget >/dev/null 2>&1; then
                STATE_JSON=$(wget -q -T 5 -O - "${RELAY_URL}/room/${ROOM_ID}/state" 2>/dev/null || true)
            fi

            if [ -n "$STATE_JSON" ]; then
                DOC_NAME=$(echo "$STATE_JSON" | grep -o '"filename":"[^"]*"' | head -n 1 | cut -d'"' -f4 2>/dev/null || true)
                if [ -n "$DOC_NAME" ] && [ "$DOC_NAME" != "$LAST_DOC" ]; then
                    echo "Background sync detected new doc: $DOC_NAME" >> "$LOG_FILE"
                    TARGET_PATH="$DOCS_DIR/$DOC_NAME"
                    if which curl >/dev/null 2>&1; then
                        curl -fsS --max-time 30 "${RELAY_URL}/room/${ROOM_ID}/doc" -o "$TARGET_PATH" 2>/dev/null || true
                    elif which wget >/dev/null 2>&1; then
                        wget -q -T 30 -O "$TARGET_PATH" "${RELAY_URL}/room/${ROOM_ID}/doc" 2>/dev/null || true
                    fi
                    if [ -f "$TARGET_PATH" ] && [ -s "$TARGET_PATH" ]; then
                        LAST_DOC="$DOC_NAME"
                        echo "Downloaded $DOC_NAME to $TARGET_PATH" >> "$LOG_FILE"
                        if which eips >/dev/null 2>&1; then
                            eips 0 0 "Coop Reader: Downloaded $DOC_NAME" 2>/dev/null || true
                        fi
                    fi
                fi
            fi
        fi

        sleep 5
    done
) >> "$LOG_FILE" 2>&1 &

BG_PID=$!
echo $BG_PID > "$PID_FILE"
echo "Coop Reader Background Sync Daemon started with PID $BG_PID" >> "$LOG_FILE"

if which eips >/dev/null 2>&1; then
    eips 0 0 "Coop Reader: Background Sync Active" 2>/dev/null || true
fi

exit 0
