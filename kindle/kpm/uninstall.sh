#!/bin/sh
# Coop Reader - KPM Uninstall Hook

echo "[Coop Reader] Uninstalling..."

# Stop daemon if running
if [ -f "/tmp/coop_reader.pid" ]; then
    PID=$(cat /tmp/coop_reader.pid)
    kill "$PID" 2>/dev/null || true
    rm -f /tmp/coop_reader.pid
fi

# Re-enable screensaver
if which lipc-set-prop >/dev/null 2>&1; then
    lipc-set-prop com.lab126.powerd preventScreenSaver 0 2>/dev/null || true
fi

# Remove KUAL extension
rm -rf "/mnt/us/extensions/coop-reader" 2>/dev/null || true

# Remove KOReader plugin
rm -rf "/mnt/us/koreader/plugins/coopreader.koplugin" 2>/dev/null || true

echo "[Coop Reader] Uninstalled successfully."
exit 0

