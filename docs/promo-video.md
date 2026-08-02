# MyPipCam promo video — script, shot list & regeneration

The funnel at [mypipcam.earnyour.com](https://mypipcam.earnyour.com) embeds a ~46s
animated promo at `apps/web/assets/promo.mp4` (poster:
`apps/web/assets/promo-poster.jpg`), shown in the "See MyPipCam in 45 seconds"
section.

## How the current MP4 was made

The video was authored and rendered with **HeyGen HyperFrames** (HTML → video):
the hosted HeyGen MCP `compose`/`render` tools are disabled for CLI/IDE agents,
so the local HyperFrames toolchain was used instead
(`npx skills add heygen-com/hyperframes`, then `hyperframes check` +
`hyperframes render`). The composition is a single self-contained `index.html`
(GSAP timeline, brand palette `#ff5e29` / `#7ddf9a` / `#fafaf7` / `#111312`,
Syne + Figtree, 1920×1080 @ 46s) — no avatars, no narration, kinetic captions
over animated flat UI mockups.

The composition source is archived at
[`docs/promo/hyperframes-composition.html`](promo/hyperframes-composition.html).
It references `./vendor/gsap.min.js` and `./fonts/*.woff2` (vendored locally at
build time from the `gsap`, `@fontsource/syne`, and `@fontsource/figtree` npm
packages — the render browser has no network). To iterate on it, scaffold a
HyperFrames project (`npx hyperframes init`), drop the composition in, re-vendor
those files, then:

```bash
npx hyperframes check          # lint + browser audit
npx hyperframes preview        # Studio timeline preview
npx hyperframes render --quality high --output mypipcam-promo.mp4
```

Poster frame: `ffmpeg -ss 2.6 -i promo.mp4 -frames:v 1 promo-poster.jpg`

## HeyGen Studio script (for an avatar/VO version)

If you want a narrated version with a HeyGen avatar, connect the HeyGen MCP
(`https://mcp.heygen.com/mcp/v1/` — in Cursor add it under Settings → MCP, auth
via your HeyGen account; never commit the API key) or paste this into HeyGen
Studio.

**Voiceover (~45s, friendly, product-led):**

> Meet MyPipCam — free, open-source tab recording with your face in the shot.
> Click the extension, pick Tab + Cam, and hit record. After a quick
> three-two-one, a live camera bubble lands right on your page — drag it
> wherever you like; the controls never end up in your video. Hit stop and
> your clip is in your library — on your machine, not somebody's cloud. Share
> a link, and MyPipCam counts the views for you. Optional Google Drive sync,
> camera filters, and links that expire after thirty days. MyPipCam — get it
> free on GitHub.

## Shot list

| # | Time | Scene | On screen | Caption |
|---|------|-------|-----------|---------|
| 1 | 0–6s | Hook | Cream bg, logo mark (dark screen + orange PiP circle + mint dot), headline | "Record your tab. **Face included.**" · "Free & open source" |
| 2 | 6–14s | Start | Browser mockup; cursor clicks extension icon; popup drops: Tab + Cam selected, Camera/Mic toggles flick on; orange **Start recording** clicked | "Click the extension → pick Tab + Cam → Start recording" |
| 3 | 14–23s | Countdown + PiP | Big 3→2→1 on the page; round camera bubble (orange ring) pops in and gets dragged; slim left dock (timer, stop, pause, discard) | "A live camera bubble on your page — controls are never baked into your video" |
| 4 | 23–30s | Library | Stop clicked → Library grid: cards with thumbnails, durations, Drive badges, view counts; first card highlighted | "Every recording, saved locally — yours." |
| 5 | 30–38s | Share + views | Detail view; **Share** clicked → "Link copied ✓" toast + `mypipcam.earnyour.com/w/…` chip; mint views chip pulses | "12 views · last viewed 2 min ago · link expires in 30 days" |
| 6 | 38–46s | CTA | Logo, "MyPipCam", pills **Get it on GitHub** / **Install free**, URLs | "github.com/EarnYour/MyPipCam · mypipcam.earnyour.com" · "By EarnYour Marketing · MIT licensed" |

Brand rules: primary `#ff5e29`, secondary `#7ddf9a`, bg `#fafaf7`, ink
`#111312`; Syne for display, Figtree for body; rounded pill buttons; no
purple/AI-gradient aesthetic; no stock footage.
