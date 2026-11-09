#!/bin/sh
# Coop Reader - KPM Launch Hook

EXT_DIR="/mnt/us/extensions/coop-reader"
APP_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# If extension is not yet installed, auto-install now
if [ ! -f "$EXT_DIR/bin/launch.sh" ]; then
    if [ -f "$APP_DIR/install.sh" ]; then
        echo "[Coop Reader] Setting up extension..."
        sh "$APP_DIR/install.sh"
    fi
fi

if [ -f "$EXT_DIR/bin/launch.sh" ]; then
    exec sh "$EXT_DIR/bin/launch.sh" "$@"
elif [ -f "$APP_DIR/../kual/bin/launch.sh" ]; then
    exec sh "$APP_DIR/../kual/bin/launch.sh" "$@"
else
    echo "[Coop Reader] Error: could not find launcher script in $EXT_DIR/bin/launch.sh"
    exit 1
fi
