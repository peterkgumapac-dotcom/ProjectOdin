#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="ODIN Notch"
APP="$ROOT/build/$APP_NAME.app"
DIST="$ROOT/dist"
STAGING="$(mktemp -d)"
DMG="$DIST/$APP_NAME-dev.dmg"

cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT

bash "$ROOT/scripts/build-app.sh" >/dev/null

rm -rf "$DIST"
mkdir -p "$DIST"

ditto --noextattr --noacl "$APP" "$STAGING/$APP_NAME.app"
xattr -d com.apple.FinderInfo "$STAGING/$APP_NAME.app" 2>/dev/null || true
xattr -d 'com.apple.fileprovider.fpfs#P' "$STAGING/$APP_NAME.app" 2>/dev/null || true
xattr -d com.apple.provenance "$STAGING/$APP_NAME.app" 2>/dev/null || true
find "$STAGING/$APP_NAME.app" -exec xattr -c {} \; 2>/dev/null || true
xattr -c "$STAGING/$APP_NAME.app" 2>/dev/null || true
ln -s /Applications "$STAGING/Applications"

hdiutil create \
  -volname "$APP_NAME Dev" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  "$DMG"

codesign --force --sign - "$DMG" >/dev/null 2>&1 || true

echo "Created: $DMG"
echo "This is a dev build for trusted testers. If macOS blocks launch, right-click the app and choose Open."
