#!/bin/sh
# Shared helpers for the Coop Reader KUAL scripts. POSIX sh + BusyBox only: no Python, no bash.
US_ROOT="${US_ROOT:-/mnt/us}"
EXT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KO_DIR="${KO_DIR:-$US_ROOT/koreader}"
PLUGIN_SRC="$EXT_DIR/plugin/coopreader.koplugin"
PLUGIN_DST="$KO_DIR/plugins/coopreader.koplugin"
LOG="$US_ROOT/coop-reader.log"

# show_lines "line 1" "line 2" ...  -> written to the log and drawn on the e-ink screen (when eips exists)
show_lines() {
    row=6
    for line in "$@"; do
        echo "$(date '+%H:%M:%S') $line" >> "$LOG" 2>/dev/null
        if command -v eips >/dev/null 2>&1; then
            eips 1 "$row" "$(printf '%.58s' "$line")" >/dev/null 2>&1
        fi
        row=$((row + 1))
    done
}

plugin_version() {   # plugin_version <dir>  -> version string or empty
    sed -n 's/^Core.VERSION = "\(.*\)".*/\1/p' "$1/coop_core.lua" 2>/dev/null | head -n 1
}
