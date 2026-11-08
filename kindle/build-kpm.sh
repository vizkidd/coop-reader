#!/bin/bash
# Coop Reader - Build & Packaging Script for Kindle Package Manager (KPM) & KUAL
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/dist/build_kpm"
DIST_DIR="$ROOT_DIR/dist"

echo "=== Building Coop Reader for Kindle ==="
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

# 1. Package KPM Package (.kpkg format: tarball containing manifest and hook scripts)
echo "--> Creating KPM Package structure..."
mkdir -p "$BUILD_DIR/kpm-payload"

# Copy KPM control files to root of package
cp "$SCRIPT_DIR/kpm/manifest.json" "$BUILD_DIR/"
cp "$SCRIPT_DIR/kpm/install.sh" "$BUILD_DIR/"
cp "$SCRIPT_DIR/kpm/uninstall.sh" "$BUILD_DIR/"
cp "$SCRIPT_DIR/kpm/launch.sh" "$BUILD_DIR/"
chmod +x "$BUILD_DIR"/*.sh

# Copy app, daemon, kual extension, and koreader plugin into package payload
mkdir -p "$BUILD_DIR/app" "$BUILD_DIR/kual" "$BUILD_DIR/daemon" "$BUILD_DIR/koreader-plugin"
cp -r "$SCRIPT_DIR/app/"* "$BUILD_DIR/app/"
cp -r "$SCRIPT_DIR/kual/"* "$BUILD_DIR/kual/"
cp -r "$SCRIPT_DIR/daemon/"* "$BUILD_DIR/daemon/"
cp -r "$SCRIPT_DIR/koreader-plugin/"* "$BUILD_DIR/koreader-plugin/"

chmod +x "$BUILD_DIR/daemon/"*.py 2>/dev/null || true
chmod +x "$BUILD_DIR/kual/bin/"*.sh 2>/dev/null || true

# Create .kpkg tarball
echo "--> Compressing dist/coop-reader.kpkg..."
cd "$BUILD_DIR"
tar -czf "$DIST_DIR/coop-reader.kpkg" *
cd "$ROOT_DIR"

# 2. Package standalone KUAL extension zip (for manual USB installation)
echo "--> Creating standalone KUAL extension zip..."
KUAL_STAGING="$ROOT_DIR/dist/staging_kual/coop-reader"
rm -rf "$ROOT_DIR/dist/staging_kual"
mkdir -p "$KUAL_STAGING/bin" "$KUAL_STAGING/app"

cp -r "$SCRIPT_DIR/kual/"* "$KUAL_STAGING/"
cp -r "$SCRIPT_DIR/app/"* "$KUAL_STAGING/app/"
cp -r "$SCRIPT_DIR/daemon/"* "$KUAL_STAGING/bin/"

chmod +x "$KUAL_STAGING/bin/"*.sh
chmod +x "$KUAL_STAGING/bin/"*.py

cd "$ROOT_DIR/dist/staging_kual"
zip -rq "$DIST_DIR/coop-reader-kual.zip" coop-reader
cd "$ROOT_DIR"

# 3. Package KOReader plugin zip
echo "--> Creating KOReader plugin zip..."
cd "$SCRIPT_DIR/koreader-plugin"
zip -rq "$DIST_DIR/coopreader.koplugin.zip" coopreader.koplugin
cd "$ROOT_DIR"

# Cleanup staging
rm -rf "$BUILD_DIR" "$ROOT_DIR/dist/staging_kual"
touch "$DIST_DIR/.nojekyll"

echo "=== Build Complete! ==="
echo "Artifacts generated in dist/:"
ls -lh "$DIST_DIR"

