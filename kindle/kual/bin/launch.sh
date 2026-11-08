#!/bin/sh
# Coop Reader - Kindle Launcher Script

BASE_DIR="/mnt/us/extensions/coop-reader"
if [ ! -d "$BASE_DIR" ]; then
    BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
fi

PID_FILE="/tmp/coop_reader.pid"
PORT=8765
TARGET_URL="http://127.0.0.1:${PORT}/index.html"
FALLBACK_FILE_URL="file://${BASE_DIR}/app/index.html"

# 1. Prevent screensaver while reading together
if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null || true
fi

# 2. Start Python daemon if not already running
DAEMON_RUNNING=0
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        DAEMON_RUNNING=1
    fi
fi

if [ "$DAEMON_RUNNING" -eq 0 ]; then
    PY_BIN=""
    if which python3 >/dev/null 2>&1; then
        PY_BIN="python3"
    elif which python >/dev/null 2>&1; then
        PY_BIN="python"
    fi

    if [ -n "$PY_BIN" ] && [ -f "$BASE_DIR/bin/coop_daemon.py" ]; then
        $PY_BIN "$BASE_DIR/bin/coop_daemon.py" --port "$PORT" --root "$BASE_DIR/app" >/tmp/coop_daemon.log 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    elif [ -n "$PY_BIN" ] && [ -f "$BASE_DIR/daemon/coop_daemon.py" ]; then
        $PY_BIN "$BASE_DIR/daemon/coop_daemon.py" --port "$PORT" --root "$BASE_DIR/app" >/tmp/coop_daemon.log 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    fi
fi

# 3. Choose launch URL: if local daemon is listening, use HTTP, else fallback to file://
LAUNCH_URL="$TARGET_URL"
if ! netstat -tlpn 2>/dev/null | grep -q ":$PORT "; then
    LAUNCH_URL="$FALLBACK_FILE_URL"
fi

# 4. Open Kindle browser / Mesquite
# Try lipc-set-prop first (standard Kindle Paperwhite / Oasis method)
if which lipc-set-prop >/dev/null 2>&1; then
    # Create HTML redirect in /tmp for reliable browser navigation
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

# 5. Clear E-Ink screen ghosting
if which eips >/dev/null 2>&1; then
    sleep 2
    eips -c 2>/dev/null || true
fi

exit 0

