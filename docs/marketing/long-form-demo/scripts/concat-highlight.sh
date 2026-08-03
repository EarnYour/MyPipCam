#!/usr/bin/env bash
# Rough ffmpeg concat of highlight clips (no glass overlays).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIPDIR="$ROOT/clips"
OUT="$ROOT/out"
mkdir -p "$OUT"

LIST="$OUT/concat-list.txt"
: > "$LIST"
for f in \
  01-hook-talking-head \
  02-problem-talking-head \
  06-install-github-pip \
  04-library-detail \
  05-macos-pip-menu \
  08-editor-export \
  09-library-grid-cta
do
  echo "file '$CLIPDIR/$f.mp4'" >> "$LIST"
done

ffmpeg -hide_banner -y -f concat -safe 0 -i "$LIST" -c copy \
  "$OUT/highlight-rough-concat.mp4"

echo "Wrote $OUT/highlight-rough-concat.mp4"
