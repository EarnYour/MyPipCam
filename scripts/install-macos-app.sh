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
xcodebuild \
  -project MyPipCam.xcodeproj \
  -scheme MyPipCam \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  -destination 'generic/platform=macOS' \
  DEVELOPMENT_TEAM=977CN6XFAH \
  CODE_SIGN_STYLE=Automatic \
  build

if [[ ! -d "$APP_SRC" ]]; then
  echo "Build succeeded but app not found at $APP_SRC" >&2
  exit 1
fi

echo "==> Installing to ${APP_DST} ..."
# Quit running instance if any
pkill -x MyPipCam 2>/dev/null || true
sleep 0.3

# Replace existing install
rm -rf "${APP_DST}"
cp -R "${APP_SRC}" "${APP_DST}"

# Refresh Launch Services / icon cache hints
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "${APP_DST}" 2>/dev/null || true

echo ""
echo "Installed: ${APP_DST}"
echo "Open with: open -a MyPipCam"
echo "Or find MyPipCam in Applications / Launchpad (screen icon with orange PiP dot)."
echo ""
open -a MyPipCam
