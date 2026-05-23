#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${APP_NAME:-ODIN Notch}"
BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER:-com.gumapac.odinnotch}"
BUNDLE_VERSION="${BUNDLE_VERSION:-1}"
SHORT_VERSION="${SHORT_VERSION:-0.1.0}"
SPARKLE_FEED_URL="${SPARKLE_FEED_URL:-}"
SPARKLE_PUBLIC_ED_KEY="${SPARKLE_PUBLIC_ED_KEY:-}"
APP_DIR="$ROOT/build/$APP_NAME.app"
EXECUTABLE="$ROOT/.build/release/ODINNotch"

clear_signing_blocking_xattrs() {
  local target="$1"
  [[ -e "$target" ]] || return 0

  xattr -rd com.apple.FinderInfo "$target" 2>/dev/null || true
  xattr -rd 'com.apple.fileprovider.fpfs#P' "$target" 2>/dev/null || true
  xattr -rd com.apple.provenance "$target" 2>/dev/null || true
  dot_clean -m "$target" 2>/dev/null || true

  while IFS= read -r -d '' item; do
    xattr -d com.apple.FinderInfo "$item" 2>/dev/null || true
    xattr -d 'com.apple.fileprovider.fpfs#P' "$item" 2>/dev/null || true
    xattr -d com.apple.provenance "$item" 2>/dev/null || true
    xattr -c "$item" 2>/dev/null || true
  done < <(find "$target" -depth -print0)

  xattr -d com.apple.FinderInfo "$target" 2>/dev/null || true
  xattr -d 'com.apple.fileprovider.fpfs#P' "$target" 2>/dev/null || true
  xattr -d com.apple.provenance "$target" 2>/dev/null || true
}

cd "$ROOT"
swift build -c release --disable-automatic-resolution

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources" "$APP_DIR/Contents/Frameworks"
cp "$EXECUTABLE" "$APP_DIR/Contents/MacOS/$APP_NAME"

SPARKLE_FRAMEWORK="$ROOT/Vendor/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
if [[ ! -d "$SPARKLE_FRAMEWORK" ]]; then
  SPARKLE_FRAMEWORK="$(find "$ROOT/.build" -path "*/Sparkle.framework" -type d | head -n 1 || true)"
fi
if [[ -n "$SPARKLE_FRAMEWORK" ]]; then
  rm -rf "$APP_DIR/Contents/Frameworks/Sparkle.framework"
  ditto --noextattr --noacl "$SPARKLE_FRAMEWORK" "$APP_DIR/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_DIR/Contents/MacOS/$APP_NAME" 2>/dev/null || true
else
  echo "warning: Sparkle.framework was not found after swift build; update checks may not run from the app bundle" >&2
fi

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>ODIN Notch</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_IDENTIFIER</string>
  <key>CFBundleName</key>
  <string>ODIN Notch</string>
  <key>CFBundleDisplayName</key>
  <string>ODIN Notch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$SHORT_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUNDLE_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSCalendarsUsageDescription</key>
  <string>ODIN Notch can show your upcoming meetings when calendar support is enabled.</string>
  <key>NSRemindersUsageDescription</key>
  <string>ODIN Notch can show your reminders when task support is enabled.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>ODIN Notch may use local app automation to control music and open shortcuts you choose.</string>
</dict>
</plist>
PLIST

if [[ -n "$SPARKLE_FEED_URL" && -n "$SPARKLE_PUBLIC_ED_KEY" ]]; then
  /usr/libexec/PlistBuddy -c "Add :SUFeedURL string $SPARKLE_FEED_URL" "$APP_DIR/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_ED_KEY" "$APP_DIR/Contents/Info.plist"
fi

xattr -d com.apple.FinderInfo "$APP_DIR" 2>/dev/null || true
xattr -d 'com.apple.fileprovider.fpfs#P' "$APP_DIR" 2>/dev/null || true
xattr -d com.apple.provenance "$APP_DIR" 2>/dev/null || true
xattr -rd com.apple.FinderInfo "$APP_DIR" 2>/dev/null || true
xattr -rd 'com.apple.fileprovider.fpfs#P' "$APP_DIR" 2>/dev/null || true
xattr -rd com.apple.provenance "$APP_DIR" 2>/dev/null || true
find "$APP_DIR" -exec xattr -c {} \; 2>/dev/null || true
xattr -cr "$APP_DIR" 2>/dev/null || true
dot_clean -m "$APP_DIR" 2>/dev/null || true
xattr -c "$APP_DIR" 2>/dev/null || true
clear_signing_blocking_xattrs "$APP_DIR"
if [[ -d "$APP_DIR/Contents/Frameworks/Sparkle.framework" ]]; then
  xattr -dr com.apple.quarantine "$APP_DIR/Contents/Frameworks/Sparkle.framework" 2>/dev/null || true
  clear_signing_blocking_xattrs "$APP_DIR/Contents/Frameworks/Sparkle.framework"
  codesign --force --sign - "$APP_DIR/Contents/Frameworks/Sparkle.framework"
fi

# Final metadata sweep must happen immediately before app signing. Sparkle's
# nested .app/.xpc/.nib bundles can keep FinderInfo/FileProvider metadata after
# a framework copy/sign pass, and codesign rejects that as resource-fork
# detritus.
xattr -rd com.apple.provenance "$APP_DIR" 2>/dev/null || true
xattr -rd com.apple.FinderInfo "$APP_DIR" 2>/dev/null || true
xattr -rd 'com.apple.fileprovider.fpfs#P' "$APP_DIR" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR"

echo "$APP_DIR"
