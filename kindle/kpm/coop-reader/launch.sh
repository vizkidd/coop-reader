#!/bin/sh
# KPM launch hook: opens KOReader straight into the Coop Reader home screen (touch GUI).
# Pass an action to jump somewhere else:  launch.sh host | join | join:<PIN> | settings | test
US="${US_ROOT:-/mnt/us}"; KO="${KO_DIR:-$US/koreader}"
[ -f "$KO/koreader.sh" ] || { echo "KOReader not found at $KO"; exit 1; }
case "${1:-panel}" in
    panel|host|join|settings|test|join:[0-9]*) mkdir -p "$KO/settings"; echo "${1:-panel}" > "$KO/settings/coopreader.intent" ;;
esac
exec sh "$KO/koreader.sh"
