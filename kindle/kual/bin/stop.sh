#!/bin/sh
# Coop Reader - Kindle Stop Script

PID_FILE="/tmp/coop_reader.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
fi

# Re-enable screensaver
if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null || true
fi

# Clean up redirect file
rm -f /tmp/coop_redirect.html 2>/dev/null || true

# Refresh screen
if which eips >/dev/null 2>&1; then
    eips -c 2>/dev/null || true
fi

exit 0

