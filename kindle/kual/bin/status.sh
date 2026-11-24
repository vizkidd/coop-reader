#!/bin/sh
# Writes a plain-text report to /mnt/us/coop-reader-status.txt and shows the key lines on screen.
. "$(dirname "$0")/lib.sh"
REPORT="$US_ROOT/coop-reader-status.txt"
RELAY="${COOP_RELAY:-https://coop-relay.vizkidd.workers.dev}"

# use the relay configured inside the plugin, if any
CFG="$KO_DIR/settings/coopreader.json"
if [ -f "$CFG" ]; then
    r="$(sed -n 's/.*"relay_base_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CFG" | head -n 1)"
    [ -n "$r" ] && RELAY="$r"
fi

{
    echo "Coop Reader status - $(date)"
    echo
    if [ -f "$KO_DIR/koreader.sh" ]; then echo "KOReader:        found ($KO_DIR)"; else echo "KOReader:        NOT FOUND at $KO_DIR"; fi
    if [ -f "$PLUGIN_DST/main.lua" ]; then echo "Plugin:          installed, version $(plugin_version "$PLUGIN_DST")"; else echo "Plugin:          NOT installed (menu: Install / update the KOReader plugin)"; fi
    echo "Bundled plugin:  version $(plugin_version "$PLUGIN_SRC")"
    echo "Relay:           $RELAY"
    if command -v lipc-get-prop >/dev/null 2>&1; then echo "Wi-Fi:           $(lipc-get-prop com.lab126.wifid cmState 2>/dev/null || echo unknown)"; fi
    echo "Device date:     $(date '+%Y-%m-%d %H:%M')  (a wrong date breaks HTTPS)"
    status=""
    if command -v curl >/dev/null 2>&1; then
        status="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "$RELAY/" 2>&1)"
        echo "Relay check:     curl -> $status"
    elif command -v wget >/dev/null 2>&1; then
        if wget -q -T 8 -O /dev/null "$RELAY/" 2>/dev/null; then status=200; echo "Relay check:     wget -> reachable"; else echo "Relay check:     wget failed (BusyBox wget often lacks HTTPS)"; fi
    else
        echo "Relay check:     no curl/wget here - use KOReader > Tools > Coop Reader > Test connection"
    fi
    echo
    if [ -f "$CFG" ]; then echo "Settings file:   $CFG"; fi
    if [ -f /tmp/coopreader_debug.log ]; then
        echo; echo "--- last plugin log lines ---"
        tail -n 25 /tmp/coopreader_debug.log
    fi
} > "$REPORT" 2>&1

show_lines "Coop Reader status (full report: coop-reader-status.txt)" \
    "$(sed -n 3p "$REPORT")" "$(sed -n 4p "$REPORT")" "$(sed -n 6p "$REPORT")" "$(sed -n 7p "$REPORT")" "$(sed -n 8p "$REPORT")" "$(sed -n 9p "$REPORT")"
exit 0
