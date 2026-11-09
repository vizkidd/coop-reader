#!/bin/sh
# Start the local Coop Reader service or launch directly via file:// if Python is not present.
set -u
BASE_DIR="/mnt/us/extensions/coop-reader"
if [ ! -d "$BASE_DIR" ]; then
    BASE_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
fi

PID_FILE="/tmp/coop_reader.pid"
PORT=8765
HTTP_URL="http://127.0.0.1:${PORT}/index.html"
FALLBACK_URL="file://${BASE_DIR}/app/index.html"
LOG_FILE="/tmp/coop_daemon.log"

PY_BIN=""
if which python3 >/dev/null 2>&1; then PY_BIN="python3"
elif which python >/dev/null 2>&1; then PY_BIN="python"; fi

if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null || true
fi

http_ready() {
    if which curl >/dev/null 2>&1; then
        curl -fsS --max-time 1 "${HTTP_URL}" >/dev/null 2>&1 && return 0
    fi
    if which wget >/dev/null 2>&1; then
        wget -q -T 1 -O /dev/null "${HTTP_URL}" 2>/dev/null && return 0
    fi
    return 1
}

# 1. Attempt to start Python daemon if Python is available
if [ -n "$PY_BIN" ] && [ -f "$BASE_DIR/bin/coop_daemon.py" ]; then
    if ! http_ready; then
        rm -f "$PID_FILE"
        "$PY_BIN" "$BASE_DIR/bin/coop_daemon.py" --port "$PORT" --root "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        # Wait up to 3 seconds for Python daemon to bind
        tries=0
        while [ "$tries" -lt 3 ]; do
            if http_ready; then break; fi
            tries=$((tries + 1))
            sleep 1
        done
    fi
fi

# 2. If Python is absent, try BusyBox httpd or lightweight static server
if ! http_ready; then
    if which busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -q '^httpd$'; then
        busybox httpd -p "$PORT" -h "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    elif which httpd >/dev/null 2>&1; then
        httpd -p "$PORT" -h "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
    fi
fi

# 3. Determine final launch URL: HTTP if local server is listening, else file://
if http_ready; then
    LAUNCH_URL="$HTTP_URL"
    echo "Coop Reader launching via HTTP: $LAUNCH_URL" >> "$LOG_FILE"
else
    LAUNCH_URL="$FALLBACK_URL"
    echo "Coop Reader launching via file:// fallback (no local HTTP daemon needed): $LAUNCH_URL" >> "$LOG_FILE"
fi

# 4. Open Kindle browser / Mesquite
if which lipc-set-prop >/dev/null 2>&1; then
    cat <<REDIRECT_EOF > /tmp/coop_redirect.html
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=${LAUNCH_URL}">
<script>window.location.replace("${LAUNCH_URL}");</script></head>
<body>Loading Coop Reader...</body></html>
REDIRECT_EOF
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
