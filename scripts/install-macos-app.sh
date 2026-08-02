#!/usr/bin/env bash
# Build a signed Release MyPipCam.app and install it to /Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MACOS="$ROOT/apps/macos"

# Override with your own Apple Development Team when forking:
#   MYPIPCAM_DEV_TEAM=ABCDE12345 ./scripts/install-macos-app.sh
DEV_TEAM="${MYPIPCAM_DEV_TEAM:-977CN6XFAH}"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick ('magick') is required for icon generation. Install it (e.g. brew install imagemagick) and re-run." >&2
  exit 1
fi
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
  "icon_16x16@2x.png:32"
  "icon_32x32.png:32"
  "icon_32x32@2x.png:64"
  "icon_128x128.png:128"
  "icon_128x128@2x.png:256"
  "icon_256x256.png:256"
  "icon_256x256@2x.png:512"
  "icon_512x512.png:512"
  "icon_512x512@2x.png:1024"
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
    { "filename" : "icon_16x16@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon_32x32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "icon_32x32@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon_128x128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "icon_128x128@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon_256x256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "icon_256x256@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon_512x512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "icon_512x512@2x.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
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
  DEVELOPMENT_TEAM="$DEV_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  build

if [[ ! -d "$APP_SRC" ]]; then
  echo "Build succeeded but app not found at $APP_SRC" >&2
  exit 1
fi

echo "==> Installing to ${APP_DST} ..."
# Quit any running instance and wait for it to actually exit — a fixed sleep
# raced the shutdown and `rm -rf` could delete the bundle out from under a
# still-running app, leaving a half-installed .app behind.
if pkill -x MyPipCam 2>/dev/null; then
  for _ in $(seq 1 40); do
    pgrep -x MyPipCam >/dev/null 2>&1 || break
    sleep 0.25
  done
  if pgrep -x MyPipCam >/dev/null 2>&1; then
    echo "==> MyPipCam still running after 10s; forcing quit"
    pkill -9 -x MyPipCam 2>/dev/null || true
    sleep 0.5
  fi
fi

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
