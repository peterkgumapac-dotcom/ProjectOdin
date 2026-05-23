#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="ODIN Notch"
FRIEND_BUNDLE_IDENTIFIER="com.gumapac.odinnotch.friendtest"
APP="$ROOT/build/$APP_NAME.app"
DIST="$ROOT/dist"
STAGING="$(mktemp -d)"
DMG="$DIST/$APP_NAME-friend-test.dmg"

cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT

BUNDLE_IDENTIFIER="$FRIEND_BUNDLE_IDENTIFIER" \
BUNDLE_VERSION="$(date +%Y%m%d%H%M)" \
SHORT_VERSION="0.1.0-friend" \
bash "$ROOT/scripts/build-app.sh" >/dev/null

rm -rf "$DIST"
mkdir -p "$DIST"

cp -R "$APP" "$STAGING/$APP_NAME.app"
xattr -d com.apple.FinderInfo "$STAGING/$APP_NAME.app" 2>/dev/null || true
xattr -d 'com.apple.fileprovider.fpfs#P' "$STAGING/$APP_NAME.app" 2>/dev/null || true
xattr -d com.apple.provenance "$STAGING/$APP_NAME.app" 2>/dev/null || true
find "$STAGING/$APP_NAME.app" -exec xattr -c {} \; 2>/dev/null || true
xattr -c "$STAGING/$APP_NAME.app" 2>/dev/null || true
ln -s /Applications "$STAGING/Applications"

hdiutil create \
  -volname "$APP_NAME Friend Test" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  "$DMG"

codesign --force --sign - "$DMG" >/dev/null 2>&1 || true

echo "Created: $DMG"
echo "Bundle identifier: $FRIEND_BUNDLE_IDENTIFIER"
echo "This friend-test build uses clean local preferences on your Mac."
