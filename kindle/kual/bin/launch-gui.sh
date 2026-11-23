#!/bin/sh
# Opens the experimental browser app. Needs no Python or local server: the page is opened straight from the
# extension folder (file://) and talks to the relay itself. KOReader has the full feature set.
. "$(dirname "$0")/lib.sh"
URL="file://$EXT_DIR/app/index.html"

if command -v lipc-set-prop >/dev/null 2>&1; then
    cat > /tmp/coop_redirect.html <<REDIRECT_EOF
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=${URL}">
<script>window.location.replace("${URL}");</script></head>
<body>Loading Coop Reader...</body></html>
REDIRECT_EOF
    lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser#going?url=file:///tmp/coop_redirect.html" 2>/dev/null || \
    lipc-set-prop com.lab126.browser gotoURL "$URL" 2>/dev/null || \
    lipc-set-prop com.lab126.appmgrd start "app://com.lab126.browser" 2>/dev/null
    echo "$(date '+%H:%M:%S') browser app: $URL" >> "$LOG" 2>/dev/null
else
    show_lines "Coop Reader: the Kindle browser cannot be started here" "Use 'Open KOReader' instead."
fi
exit 0
