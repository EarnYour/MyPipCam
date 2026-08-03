# Long-form demo production package

Cut plan + glass overlays + highlight clips for the MyPipCam install-focused YouTube demo.

| Doc | Purpose |
| --- | --- |
| [`EDIT_PLAN.md`](./EDIT_PLAN.md) | Beat sheet, CTAs, lower-thirds, YouTube title/description |
| [`CUT_SHEET.md`](./CUT_SHEET.md) | Source timestamps + scene detect + CapCut markers |
| [`OVERLAY_DESIGN.md`](./OVERLAY_DESIGN.md) | Glassmorphism tokens (CSS/SVG/Remotion) |
| [`SOURCE.md`](./SOURCE.md) | ffprobe notes for the OBS MOV |
| [`markers-capcut.csv`](./markers-capcut.csv) | CapCut / FCP-friendly chapter markers |
| [`overlays/preview.html`](./overlays/preview.html) | Live glass popup preview |
| [`remotion/`](./remotion/) | Optional Remotion composite scaffold |
| [`clips/`](./clips/) | Extracted highlight MP4s (~48 MB total) |

## Quick start (recommended: CapCut)

1. Open CapCut → new 1920×1080 project @ 30 or 60 fps.  
2. Import everything in `clips/`.  
3. Order per **Cut A** in [`EDIT_PLAN.md`](./EDIT_PLAN.md).  
4. Use [`markers-capcut.csv`](./markers-capcut.csv) as a paper-edit guide (source MOV times).  
5. Open `overlays/preview.html` → screenshot popups / end card → place as overlays.  
6. Captions on; end card hold 6–10s with site + releases URL.

## Remotion path

```bash
cd remotion && npm install
# symlink clips into public/ — see remotion/README.md
npm start
npm run render:highlight
```

## Re-extract / rough concat

```bash
./scripts/extract-clips.sh
./scripts/concat-highlight.sh   # no overlays, sanity check
```

Source MOV stays local (`~/Movies/...`) — never commit it.

## YouTube (messaging)

- **Title:** Replace Loom for Free — MyPipCam Live Demo  
- **Thumb:** `../mypipcam-youtube-thumbnail-live-demo-yt.jpg`  
- Full metadata copy in [`EDIT_PLAN.md`](./EDIT_PLAN.md)
