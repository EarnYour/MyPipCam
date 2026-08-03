# Remotion scaffold — MyPipCam highlight reel

Lightweight Remotion project that composites `../clips/*.mp4` with luminous glass popups and an end card.

## Setup

```bash
cd docs/marketing/long-form-demo/remotion
npm install
mkdir -p public
# Symlink extracted clips into Remotion public/
ln -sfn ../../clips/*.mp4 public/ 2>/dev/null || \
  for f in ../../clips/*.mp4; do ln -sfn "$f" "public/$(basename "$f")"; done
```

## Preview

```bash
npm start
# Studio → compositions: OverlayDemo | HighlightReel
```

## Render

```bash
# Short glass popup sample (~3s)
npm run render:overlays

# Full highlight scaffold (~6.5 min of stitched clips + end card)
npm run render:highlight
```

Outputs land in `remotion/out/`.

### Notes

- Remotion company license applies for commercial use — confirm before monetized YouTube ads if required.
- For a polished 8–12 min cut, prefer CapCut/FCP using [`../EDIT_PLAN.md`](../EDIT_PLAN.md) and drop Remotion-rendered overlay plates as layers.
- Do not point Remotion at the 4.8 GB source MOV; only use `clips/`.
