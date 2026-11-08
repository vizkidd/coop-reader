#!/bin/sh
# Coop Reader - KPM Launch Hook

EXT_DIR="/mnt/us/extensions/coop-reader"
if [ -f "$EXT_DIR/bin/launch.sh" ]; then
    exec sh "$EXT_DIR/bin/launch.sh" "$@"
else
    # Fallback to local launcher if run directly from package dir
    APP_DIR="$(cd "$(dirname "$0")" && pwd)"
    exec sh "$APP_DIR/../kual/bin/launch.sh" "$@"
fi

