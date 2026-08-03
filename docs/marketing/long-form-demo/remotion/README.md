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
# Full highlight (~6.5–7 min of clips + cards) → H.264
npm run render:highlight
```

Output: `../output/MyPipCam-highlight-demo.mp4`

```bash
# Short glass popup sample (~3s)
npm run render:overlays
```

### Notes

- Duration tracks actual clip lengths (~6m20s media + intro/titles/end ≈ 6m40s). Stretch to 8–12 min needs more extracts from the source MOV.
- Remotion company license applies for commercial use — confirm before monetized YouTube ads if required.
- Do not point Remotion at the 4.8 GB source MOV; only use `clips/`.
