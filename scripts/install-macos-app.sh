#!/usr/bin/env bash
# Build a signed Release MyPipCam.app and install it to /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS="$ROOT/apps/macos"
ICONSET="$MACOS/MyPipCam/Assets.xcassets/AppIcon.appiconset"
DERIVED="$MACOS/build-release"
APP_SRC="$DERIVED/Build/Products/Release/MyPipCam.app"
APP_DST="/Applications/MyPipCam.app"

echo "==> Generating App Icon (screen + PiP dot)…"
mkdir -p "$ICONSET"

SVG="$ICONSET/icon-master.svg"
cat > "$SVG" << 'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 128 128" fill="none">
  <rect x="12" y="16" width="104" height="96" rx="16" ry="16" fill="#111312"/>
  <rect x="22" y="26" width="84" height="68" rx="10" ry="10" fill="#fafaf7"/>
  <circle cx="40" cy="76" r="16" fill="#ff5e29"/>
</svg>
EOF

MASTER="$ICONSET/icon_1024.png"
magick -background none "$SVG" -resize 1024x1024 "PNG32:$MASTER"

# filename → pixel size
declare -a PAIRS=(
  "icon_16x16.png:16"
  "diana.k@example.org:32"
  "icon_32x32.png:32"
  "ivan.p@example.net:64"
  "icon_128x128.png:128"
  "wendy.h@example.net:256"
  "icon_256x256.png:256"
  "wendy.h@example.net:512"
  "icon_512x512.png:512"
  "walt.e@example.net:1024"
)

for pair in "${PAIRS[@]}"; do
  name="${pair%%:*}"
  size="${pair##*:}"
  magick "$MASTER" -resize "${size}x${size}" "PNG32:$ICONSET/$name"
done

cat > "$ICONSET/Contents.json" << 'EOF'
{
  "images" : [
    { "filename" : "icon_16x16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "diana.k@example.org", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon_32x32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "ivan.p@example.net", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon_128x128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "wendy.h@example.net", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon_256x256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "wendy.h@example.net", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon_512x512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "walt.e@example.net", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
EOF

echo "==> Building Release…"
cd "$MACOS"
rm -rf "$DERIVED"

# Keep Automatic signing on the same Development Team so TCC stays on one cert family.
# Use the generic "Apple Development" identity (not a full CN) with CODE_SIGN_STYLE=Automatic.
EXPECTED_TEAM="977CN6XFAH"
EXPECTED_CN="Apple Development: Steven Martinez (69Z3369CDJ)"
if ! security find-identity -v -p codesigning 2>/dev/null | grep -Fq "$EXPECTED_CN"; then
  echo "warning: expected identity not in keychain: $EXPECTED_CN" >&2
  echo "warning: xcodebuild will pick another Apple Development cert for team $EXPECTED_TEAM." >&2
fi

OLD_CDHASH=""
if [[ -d "$APP_DST" ]]; then
  OLD_CDHASH="$(codesign -dv --verbose=2 "$APP_DST" 2>&1 | awk -F= '/^CDHash=/{print $2; exit}')"
fi

xcodebuild \
  -project MyPipCam.xcodeproj \
  -scheme MyPipCam \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  -destination 'generic/platform=macOS' \
  DEVELOPMENT_TEAM="$EXPECTED_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Apple Development" \
  CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO \
  ENABLE_HARDENED_RUNTIME=YES \
  build

if [[ ! -d "$APP_SRC" ]]; then
  echo "Build succeeded but app not found at $APP_SRC" >&2
  exit 1
fi

echo "==> Verifying signature…"
codesign --verify --deep --strict "$APP_SRC" 2>&1 || {
  echo "error: Release app failed codesign verify" >&2
  exit 1
}
codesign -dv --verbose=2 "$APP_SRC" 2>&1 | egrep 'Authority|TeamIdentifier|Identifier|CDHash' || true
# Release must not carry get-task-allow (debugger entitlement).
if codesign -d --entitlements - "$APP_SRC" 2>&1 | grep -q 'get-task-allow'; then
  echo "error: Release build unexpectedly includes get-task-allow — refusing install." >&2
  exit 1
fi

NEW_CDHASH="$(codesign -dv --verbose=2 "$APP_SRC" 2>&1 | awk -F= '/^CDHash=/{print $2; exit}')"

echo "==> Installing to ${APP_DST} ..."
# Quit running instance if any
pkill -x MyPipCam 2>/dev/null || true
sleep 0.3

# Replace existing install (ditto preserves more metadata than rm+cp)
rm -rf "${APP_DST}"
ditto "${APP_SRC}" "${APP_DST}"

LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
# Critical: xcodebuild registers the build-release .app with Launch Services. If that copy
# wins over /Applications, Screen Recording TCC binds to the wrong binary and Settings
# toggles appear to "do nothing". Prefer Applications; drop staging/build clones.
"$LSREG" -u "$APP_SRC" 2>/dev/null || true
while IFS= read -r extra; do
  [[ -z "$extra" || "$extra" == "$APP_DST" ]] && continue
  "$LSREG" -u "$extra" 2>/dev/null || true
done < <(mdfind "kMDItemCFBundleIdentifier == 'com.stevenmartinez.MyPipCam'" 2>/dev/null || true)
"$LSREG" -f "$APP_DST" 2>/dev/null || true

echo ""
AUTH="$(codesign -dv --verbose=2 "$APP_DST" 2>&1 | awk -F= '/^Authority=/{print $2; exit}')"
NEW_CDHASH="$(codesign -dv --verbose=2 "$APP_DST" 2>&1 | awk -F= '/^CDHash=/{print $2; exit}')"
echo "Installed: ${APP_DST}"
echo "Signing: ${AUTH:-unknown} · Team ${EXPECTED_TEAM} · CDHash ${NEW_CDHASH:-unknown}"
if [[ -n "$OLD_CDHASH" && -n "$NEW_CDHASH" && "$OLD_CDHASH" != "$NEW_CDHASH" ]]; then
  echo ""
  echo "NOTE: Binary fingerprint changed (typical for Apple Development rebuilds)."
  echo "Screen Recording may need a FRESH system Allow dialog — not only the Settings toggle:"
  echo "  1. Open MyPipCam → Record"
  echo "  2. Click Allow on the macOS Screen Recording prompt"
  echo "  3. If no prompt: System Settings → Privacy & Security → Screen Recording"
  echo "     → remove every MyPipCam entry → Record again"
  echo "  Optional reset: tccutil reset ScreenCapture com.stevenmartinez.MyPipCam"
fi
echo ""
echo "Open with: open /Applications/MyPipCam.app"
echo "Probe capture: open -W /Applications/MyPipCam.app --args --probe-screencapture"
echo "Or find MyPipCam in Applications / Launchpad (screen icon with orange PiP dot)."
echo ""
# Always launch the Applications install (never a build-folder clone).
open "$APP_DST"
