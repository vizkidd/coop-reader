#!/bin/sh
# Starts KOReader (which runs the Coop Reader plugin). Keeps the plugin up to date first.
# Optional argument = what the Coop Reader GUI should open first: panel | host | join | join:<PIN> | settings | test
# (written to koreader/settings/coopreader.intent, read once by the plugin at start-up).
. "$(dirname "$0")/lib.sh"
INTENT="$1"
LAUNCHER="$KO_DIR/koreader.sh"

if [ ! -f "$LAUNCHER" ]; then
    show_lines "Coop Reader: KOReader was not found" "at $KO_DIR" "Install KOReader first (see the README)."
    exit 1
fi

new_v="$(plugin_version "$PLUGIN_SRC")"
cur_v="$(plugin_version "$PLUGIN_DST")"
if [ ! -f "$PLUGIN_DST/main.lua" ] || [ "$new_v" != "$cur_v" ]; then
    sh "$EXT_DIR/bin/install-plugin.sh" || exit 1
fi

case "$INTENT" in
    ""|panel|host|join|settings|test|join:[0-9]*)
        if [ -n "$INTENT" ]; then
            mkdir -p "$KO_DIR/settings" 2>/dev/null
            echo "$INTENT" > "$KO_DIR/settings/coopreader.intent" 2>/dev/null
        fi ;;
    *) show_lines "Coop Reader: unknown action '$INTENT'"; exit 1 ;;
esac
echo "$(date '+%H:%M:%S') starting KOReader ($INTENT)" >> "$LOG" 2>/dev/null
exec sh "$LAUNCHER"
