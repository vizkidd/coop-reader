#!/bin/sh
# Copies the bundled KOReader plugin into KOReader. Safe to run repeatedly (it replaces the old copy).
. "$(dirname "$0")/lib.sh"

if [ ! -d "$PLUGIN_SRC" ]; then
    show_lines "Coop Reader: plugin files are missing" "from this extension. Re-copy the extension."
    exit 1
fi
if [ ! -d "$KO_DIR" ]; then
    show_lines "Coop Reader: KOReader was not found" "at $KO_DIR" "Install KOReader first, then run this again."
    exit 1
fi

mkdir -p "$KO_DIR/plugins" || { show_lines "Cannot write to $KO_DIR/plugins"; exit 1; }
rm -rf "$PLUGIN_DST.new"
if ! cp -r "$PLUGIN_SRC" "$PLUGIN_DST.new"; then
    show_lines "Coop Reader: copying the plugin failed" "(is the Kindle storage full?)"
    rm -rf "$PLUGIN_DST.new"
    exit 1
fi
rm -rf "$PLUGIN_DST"
mv "$PLUGIN_DST.new" "$PLUGIN_DST"

if [ -f "$PLUGIN_DST/main.lua" ] && [ -f "$PLUGIN_DST/coop_core.lua" ]; then
    show_lines "Coop Reader plugin $(plugin_version "$PLUGIN_DST") installed" \
               "Restart KOReader, then open:" \
               "Menu > Tools > Coop Reader"
    exit 0
fi
show_lines "Coop Reader: installation looks incomplete" "See $LOG"
exit 1
