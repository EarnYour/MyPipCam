#!/usr/bin/env bash
# Re-extract highlight clips from the OBS source MOV.
set -euo pipefail

SRC="${MYPIPCAM_DEMO_SRC:-$HOME/Movies/2026-08-02 17-59-54.mov}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIPDIR="$ROOT/clips"
mkdir -p "$CLIPDIR"

if [[ ! -f "$SRC" ]]; then
  echo "Source not found: $SRC" >&2
  echo "Set MYPIPCAM_DEMO_SRC=/path/to/file.mov" >&2
  exit 1
fi

extract() {
  local name="$1" start="$2" dur="$3"
  echo "→ $name  ss=$start  t=$dur"
  ffmpeg -hide_banner -y -ss "$start" -i "$SRC" -t "$dur" \
    -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 160k \
    -movflags +faststart \
    "$CLIPDIR/$name.mp4"
}

# Hook/problem: skip ~4:20 of silent sit-down open; speech starts ~263s
extract "01-hook-talking-head" "263" "32"
extract "02-problem-talking-head" "318" "36"
extract "03-screen-enters" "1430" "35"
extract "04-library-detail" "1480" "45"
extract "05-macos-pip-menu" "1655" "40"
extract "06-install-github-pip" "1785" "50"
extract "07-library-settings-drive" "2095" "40"
extract "08-editor-export" "2210" "45"
extract "09-library-grid-cta" "2355" "40"

ls -lh "$CLIPDIR"
echo "Done."
