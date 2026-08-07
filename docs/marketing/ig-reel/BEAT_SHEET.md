# MyPipCam IG/FB Reel — beat sheet

**Source:** `/Users/stevenmartinez/Movies/2026-08-07 11-47-24.mov` (~218s, 1920×1080)  
**Output:** `docs/marketing/ig-reel/output/MyPipCam-ig-fb-reel.mp4` · **1080×1920** · 30fps · ~63.5s  
**Transcript:** `docs/marketing/ig-reel/transcript/source.{txt,srt,vtt,json}`

Primary CTA: [Chrome Web Store](https://chromewebstore.google.com/detail/mypipcam/meiehjfjcaahfjcdneoegjkmajbfghmm)  
Secondary: [GitHub](https://github.com/EarnYour/MyPipCam) · [Site](https://mypipcam.earnyour.com)

---

## Cut map (reel time → source → overlay)

| # | Reel | Dur | Source in | Source out | Clip file | Overlay | Caption focus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0:00–0:02 | 2.0s | — | — | IntroCard | Brand open | — |
| 1 | 0:02–0:14 | 12s | 0:07.40 | 0:19.40 | `01-hook.mp4` | **Popup** glass — “Replace Loom for free” | Excited → live free → no subscription |
| 2 | 0:14–0:25 | 11s | 1:24.92 | 1:35.92 | `02-install.mp4` (+10s in) | **Side push** left — “Add to Chrome” | Open in Chrome → Add to Chrome |
| 3 | 0:25–0:35 | 10s | 1:58.84 | 2:08.84 | `03-record.mp4` | **Popup** — “Pin it · Hit record” | Pin → like Loom → start recording |
| 4 | 0:35–0:48 | 13s | 2:14.00 | 2:27.00 | `04-library.mp4` | **Side push** right — “Local library” | Library → Drive → local folder |
| 5 | 0:48–0:59 | 11s | 2:52.28 | 3:03.28 | `05-share-cta.mp4` | **Popup** mint — “Share · view counts” | Share → Loom features → no sub |
| 6 | 0:59–1:03.5 | 4.5s | — | — | EndCard | Store + GitHub CTA | — |

**Total:** ~63.5s (hard cuts; filler / GitHub digression / follow-ask trimmed).

---

## Overlay inventory

| Beat | Type | Copy |
| --- | --- | --- |
| Hook | Popup (orange) | Replace Loom for free · Published Chrome extension · Everything Loom does · No subscription |
| Install | Push-over left (mint) | Add to Chrome · Open Web Store · Any OS with Chrome · One click |
| Record | Popup (orange) | Pin it · Hit record · Toolbar · Start recording · Tab + camera ready |
| Library | Push-over right (orange) | Local library · Drive optional · Local folder |
| Share | Popup (mint) | Share · view counts · Sharing links · Who viewed · Free plugin |
| End | End card | Chrome Web Store primary · site · GitHub/macOS secondary |

Constraint: max one overlay family on screen at a time, plus burned-in captions.

---

## Claims kept (from this recording only)

- Just published a Chrome extension; live for free on Chrome
- Replaces Loom / does what Loom does; no subscription
- Optional GitHub / macOS app path mentioned, but demo focuses on the extension
- Install: Add to Chrome, pin to toolbar, start recording
- Library: Google Drive connect + local folder picker
- Share links + view activity when on Drive
- CTA: download the free plugin

Not claimed in VO (so not overlaid as fact): “Tab + Cam PiP” product jargon beyond what’s implied by Loom-like recording; editor features.

---

## Re-render

```bash
cd docs/marketing/ig-reel/remotion
npm install
npm run render
# → ../output/MyPipCam-ig-fb-reel.mp4
```

Studio preview: `npm start` → composition `IgFbReel`.
