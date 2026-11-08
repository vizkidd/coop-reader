#!/bin/sh
# Coop Reader - Hardware E-Ink Refresh (EIPS)
if which eips >/dev/null 2>&1; then
    eips -c 2>/dev/null || true
    eips '' 2>/dev/null || true
fi
exit 0

