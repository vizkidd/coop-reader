#!/bin/sh
. "$(dirname "$0")/lib.sh"
if [ -d "$PLUGIN_DST" ]; then
    rm -rf "$PLUGIN_DST"
    show_lines "Coop Reader plugin removed" "(settings are kept in koreader/settings/coopreader.json)"
else
    show_lines "Coop Reader plugin is not installed"
fi
exit 0
