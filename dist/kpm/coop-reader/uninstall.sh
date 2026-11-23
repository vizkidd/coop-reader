#!/bin/sh
US="${US_ROOT:-/mnt/us}"; KO="${KO_DIR:-$US/koreader}"
rm -rf "$KO/plugins/coopreader.koplugin" "$US/extensions/coop-reader" "$KO/settings/coopreader.intent"
echo "Coop Reader removed (your settings file koreader/settings/coopreader.json was kept)."
exit 0
