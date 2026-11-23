#!/bin/sh
# Clears e-ink ghosting.
if command -v eips >/dev/null 2>&1; then
    eips -c 2>/dev/null
    eips '' 2>/dev/null
fi
exit 0
