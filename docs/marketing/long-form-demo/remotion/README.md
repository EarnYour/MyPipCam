# Remotion — MyPipCam highlight reel

Composites `../clips/*.mp4` (Cut A order) with luminous glass popups, lower-thirds, brand intro, and end card.

## Setup

```bash
cd docs/marketing/long-form-demo/remotion
npm install   # copies clips → public/clips/ (Remotion needs real files, not symlinks)
```

## Preview

```bash
npm start
# Studio → HighlightReel | OverlayDemo
```

## Render

```bash
# Full highlight → H.264
npm run render:highlight
```

Output: `../output/MyPipCam-highlight-demo.mp4`

```bash
# Short glass popup sample (~3s)
npm run render:overlays
```

### Notes

- Duration ≈ **4m40s** after cutting go-live talking head (clips 01/02) and the Windows-build digression at the start of clip 06; glass holds ~4–5s with push-over splits on Record / Editor.
- Motion curves: Chronixel Style Vault (Night Drive HUD / Dark Dashboard glass) + `nmsn` Remotion easing + [`OVERLAY_DESIGN.md`](../OVERLAY_DESIGN.md).
- Remotion company license applies for commercial use — confirm before monetized YouTube ads if required.
- Do not point Remotion at the 4.8 GB source MOV; only use `clips/`.
- Clip 06 uses `startFrom: 32×FPS` so the reel never includes the Windows-build VO.
