#!/bin/sh
# Start the local Coop Reader daemon and open its HTTP-served UI.
set -u
BASE_DIR="/mnt/us/extensions/coop-reader"
PID_FILE="/tmp/coop_reader.pid"
PORT=8765
TARGET_URL="http://127.0.0.1:${PORT}/index.html"
LOG_FILE="/tmp/coop_daemon.log"
PY_BIN=""
if which python3 >/dev/null 2>&1; then PY_BIN="python3"
elif which python >/dev/null 2>&1; then PY_BIN="python"; fi

if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null || true
fi

http_ready() {
    if which curl >/dev/null 2>&1; then
        curl -fsS --max-time 2 "${TARGET_URL}" >/dev/null 2>&1 && return 0
        curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1 && return 0
    fi
    if which wget >/dev/null 2>&1; then
        wget -q -T 2 -O /dev/null "${TARGET_URL}" 2>/dev/null && return 0
        wget -q -T 2 -O /dev/null "http://127.0.0.1:${PORT}/api/status" 2>/dev/null && return 0
    fi
    if [ -n "$PY_BIN" ]; then
        "$PY_BIN" -c 'import sys; exec("try:\n import urllib.request as u\nexcept ImportError:\n import urllib2 as u"); r=u.urlopen(sys.argv[1], timeout=2); sys.exit(0 if r.getcode()==200 else 1)' "$TARGET_URL" >/dev/null 2>&1 && return 0
    fi
    return 1
}

# Do not trust a PID file alone: Kindle may have reused the PID. Verify HTTP.
if ! http_ready; then
    # Never kill the PID stored in a stale file: Kindle may have reused it
    # for an unrelated process. If the HTTP service is absent, discard the
    # stale marker and start a fresh daemon.
    rm -f "$PID_FILE"

    if [ -n "$PY_BIN" ] && [ -f "$BASE_DIR/bin/coop_daemon.py" ]; then
        "$PY_BIN" "$BASE_DIR/bin/coop_daemon.py" --port "$PORT" --root "$BASE_DIR/app" >>"$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
    else
        echo "Coop Reader requires Python 2.7 or Python 3 on this Kindle." > /tmp/coop_reader_error.txt
        if which eips >/dev/null 2>&1; then
            eips 0 0 "Coop Reader: Python missing" 2>/dev/null || true
            eips 0 1 "See /tmp/coop_daemon.log" 2>/dev/null || true
        fi
        exit 1
    fi
fi

# Wait for the application endpoint, not a netstat string that varies by firmware.
tries=0
while [ "$tries" -lt 10 ]; do
    if http_ready; then break; fi
    tries=$((tries + 1))
    sleep 1
done

if ! http_ready; then
    echo "Coop Reader daemon did not become ready; inspect $LOG_FILE" >> "$LOG_FILE"
    if which eips >/dev/null 2>&1; then
        eips 0 0 "Coop Reader failed to start" 2>/dev/null || true
        eips 0 1 "Check /tmp/coop_daemon.log" 2>/dev/null || true
    fi
    exit 1
fi

if which lipc-set-prop >/dev/null 2>&1; then
    cat <<REDIRECT_EOF > /tmp/coop_redirect.html
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=${TARGET_URL}">
<script>window.location.replace("${TARGET_URL}");</script></head>
<body>Loading Coop Reader...</body></html>
REDIRECT_EOF
    lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser#going?url=file:///tmp/coop_redirect.html" 2>/dev/null || \
    lipc-set-prop com.lab126.browser gotoURL "$TARGET_URL" 2>/dev/null || \
    lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser" 2>/dev/null || true
elif which mesquite >/dev/null 2>&1; then
    mesquite -l com.lab126.coopreader -c "$TARGET_URL" >/dev/null 2>&1 &
fi

if which eips >/dev/null 2>&1; then sleep 2; eips -c 2>/dev/null || true; fi
exit 0
