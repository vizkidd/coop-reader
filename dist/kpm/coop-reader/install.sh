#!/bin/sh
# KPM install hook: puts the KOReader plugin in place (and the KUAL extension when KUAL is present).
DIR="$(cd "$(dirname "$0")" && pwd)"
US="${US_ROOT:-/mnt/us}"; KO="${KO_DIR:-$US/koreader}"
if [ ! -d "$KO" ]; then
    echo "KOReader was not found at $KO. Install KOReader first (https://github.com/koreader/koreader/releases), then run this install again."
    exit 1
fi
mkdir -p "$KO/plugins" && rm -rf "$KO/plugins/coopreader.koplugin" && cp -r "$DIR/payload/coopreader.koplugin" "$KO/plugins/" || { echo "could not copy the plugin"; exit 1; }
if [ -d "$US/extensions" ] && [ -d "$DIR/payload/kual/coop-reader" ]; then
    rm -rf "$US/extensions/coop-reader" && cp -r "$DIR/payload/kual/coop-reader" "$US/extensions/" && chmod +x "$US/extensions/coop-reader/bin/"*.sh
fi
echo "Coop Reader installed. Start it from the KPM entry 'Coop Reader' (or KOReader > Tools > Coop Reader)."
exit 0
