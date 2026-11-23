#!/bin/sh
# Builds the Kindle packages into dist/:
#   coop-reader-kindle-usb.zip  unzip at the ROOT of the Kindle drive: installs the KUAL extension AND the KOReader plugin
#   coop-reader-kual.zip        just the KUAL extension (it contains the plugin and can install it from the KUAL menu)
#   coopreader.koplugin.zip     just the KOReader plugin (unzip into koreader/plugins/)
#   kpm/coop-reader/            KPM package folder (manifest + install/launch/uninstall hooks + payload); pack it with KindleModding's kpm-helper (see kindle/kpm/README.md)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DIST="$ROOT_DIR/dist"
STAGE="$DIST/.stage"
PLUGIN="$SCRIPT_DIR/koreader-plugin/coopreader.koplugin"

VERSION="$(sed -n 's/^Core.VERSION = "\(.*\)".*/\1/p' "$PLUGIN/coop_core.lua" | head -n 1)"
echo "=== Building Coop Reader for Kindle (plugin $VERSION) ==="
rm -rf "$STAGE"; mkdir -p "$DIST" "$STAGE"

mkzip() {   # mkzip <out.zip> <dir-to-run-in> <entries...>
    out="$1"; dir="$2"; shift 2
    rm -f "$out"
    if command -v zip >/dev/null 2>&1; then
        (cd "$dir" && zip -qr "$out" "$@" -x '*.DS_Store' -x '*__pycache__*' -x '*/._*')
    else
        python3 - "$out" "$dir" "$@" <<'PY'
import os, sys, zipfile
out, base, entries = sys.argv[1], sys.argv[2], sys.argv[3:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for e in entries:
        for root, dirs, files in os.walk(os.path.join(base, e)):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in files:
                if f == ".DS_Store" or f.startswith("._"): continue
                p = os.path.join(root, f); info = zipfile.ZipInfo.from_file(p, os.path.relpath(p, base))
                with open(p, "rb") as fh: z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
PY
    fi
}

# --- KUAL extension (bundles the plugin and the browser app)
EXT="$STAGE/kual/coop-reader"
mkdir -p "$EXT/bin" "$EXT/app" "$EXT/plugin"
cp "$SCRIPT_DIR/kual/config.xml" "$SCRIPT_DIR/kual/menu.json" "$EXT/"
cp "$SCRIPT_DIR/kual/bin/"*.sh "$EXT/bin/"
cp "$SCRIPT_DIR/app/"* "$EXT/app/"
cp -r "$PLUGIN" "$EXT/plugin/"
chmod +x "$EXT/bin/"*.sh

# --- USB bundle (extract at the root of the Kindle drive)
USB="$STAGE/usb"
mkdir -p "$USB/extensions" "$USB/koreader/plugins"
cp -r "$EXT" "$USB/extensions/"
cp -r "$PLUGIN" "$USB/koreader/plugins/"

mkzip "$DIST/coop-reader-kual.zip" "$STAGE/kual" coop-reader
mkzip "$DIST/coop-reader-kindle-usb.zip" "$STAGE/usb" extensions koreader
mkzip "$DIST/coopreader.koplugin.zip" "$SCRIPT_DIR/koreader-plugin" coopreader.koplugin

# --- KPM package source folder (for newer jailbreaks without KUAL)
KPMDIR="$DIST/kpm/coop-reader"
rm -rf "$DIST/kpm"; mkdir -p "$KPMDIR/payload/kual"
cp "$SCRIPT_DIR/kpm/coop-reader/"* "$KPMDIR/"
sed -i.bak "s/\"version\": \[[0-9, ]*\]/\"version\": [$(echo "$VERSION" | tr . ,)]/" "$KPMDIR/manifest.json" && rm -f "$KPMDIR/manifest.json.bak"
cp -r "$PLUGIN" "$KPMDIR/payload/"
cp -r "$EXT" "$KPMDIR/payload/kual/"
chmod +x "$KPMDIR/"*.sh
cp "$SCRIPT_DIR/kpm/README.md" "$DIST/kpm/README.md"
mkzip "$DIST/coop-reader-kpm-package.zip" "$DIST/kpm" coop-reader README.md

rm -rf "$STAGE"
touch "$DIST/.nojekyll"
echo "=== Done ==="; ls -l "$DIST"/*.zip
