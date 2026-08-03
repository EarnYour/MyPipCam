# MyPipCam long-form demo — edit plan

**Goal:** Make people want to install MyPipCam (free Loom alternative).  
**Source:** first ~42 min of `2026-08-02 17-59-54.mov` (see [`SOURCE.md`](./SOURCE.md)).  
**Formats:**

| Cut | Target length | Use |
| --- | --- | --- |
| **A — Highlight reel** (primary) | **8–12 min** | YouTube main upload |
| **B — Chaptered long-form** | **18–25 min** | “Full walkthrough” with chapters |
| Shorts (optional) | 30–60s | Hooks from clips 01 / 05 / 06 |

Thumbnail / messaging alignment: **Replace Loom for free**  
(see `docs/marketing/mypipcam-youtube-thumbnail-live-demo-yt.jpg`).

---

## Brand

| Token | Hex |
| --- | --- |
| Orange | `#ff5e29` |
| Mint | `#7ddf9a` |
| Cream | `#fafaf7` |
| Ink | `#111312` |

Links:

- Site: https://mypipcam.earnyour.com  
- Releases: https://github.com/EarnYour/MyPipCam/releases  
- Tip (optional, soft): Stripe tip jar only if it feels natural — never hard-sell after “free forever”

---

## Cut A — 8–12 min highlight (beat sheet)

Target pacing: energetic, popup-forward, glass overlays. Trim talking-head filler hard.

| # | Beat | Est. | Source (approx) | Overlay / popup | Lower-third |
| --- | --- | --- | --- | --- | --- |
| 1 | **Cold hook** | 0:00–0:35 | 0:00–0:45 | Glass title card: “Replace Loom for free” | MyPipCam · Free forever |
| 2 | **Problem** | 0:35–1:20 | 5:00–6:30 | Popup: “No Loom bill” · “No seat tax” | Why I built this |
| 3 | **Install** | 1:20–2:20 | 29:45–31:30 | Steps popup: Download zip → Load unpacked | Install in under a minute |
| 4 | **Record (Chrome)** | 2:20–3:40 | 24:40–25:30 | Callout: “Tab + Cam PiP” | Record this tab |
| 5 | **PiP flex** | 3:40–4:40 | 27:35–28:30 | Callout: Shape · Size · Always on top | macOS camera bubble |
| 6 | **Library** | 4:40–5:40 | 39:15–40:10 | Popup: “Local first · Drive optional” | Your recordings, your disk |
| 7 | **Editor** | 5:40–7:00 | 36:50–38:00 | Callout: Cut · Silence · Export | Trim without SaaS |
| 8 | **Desktop path** | 7:00–7:40 | 23:50–24:25 | Soft: “Leave Chrome? Still covered” | Desktop + PiP |
| 9 | **CTA** | 7:40–8:30+ | 40:30–41:30 + end card | End card glass: site + releases | Install free · Link in description |

Stretch to 10–12 min by keeping more Install + Editor B-roll and one clean “share link / view counts” moment from Library detail (~24:40).

---

## Cut B — chaptered long-form (18–25 min)

Keep more talking-head context from 0–23 min, but **jump-cut** silence. YouTube chapters:

```
0:00 Hook — Replace Loom for free
0:45 The problem with paid recorders
2:30 Install MyPipCam (Chrome)
4:00 First recording (Tab + Cam)
6:30 Floating PiP on macOS
9:00 Library, Drive, share links
12:00 Editor: cut, silence, export
15:00 Desktop recording path
17:00 What’s free forever
18:00 Install now (CTA)
```

---

## CTA beats (must land)

1. **0:05** — Brand + promise on screen (don’t wait for VO).  
2. **After Install** — “Pin it → record any https tab.”  
3. **After Library** — “No subscription. Files stay yours.”  
4. **End card (8s hold)** — URL large, GitHub releases secondary, QR optional.

Spoken CTA (suggested):

> MyPipCam is free — Chrome extension and Mac app. Grab it at mypipcam.earnyour.com or the GitHub releases link below. Replace Loom for free.

---

## Lower-third copy bank

| ID | Line 1 | Line 2 |
| --- | --- | --- |
| LT-brand | MyPipCam | Free Loom-style recorder |
| LT-free | Free forever | No subscription |
| LT-chrome | Chrome extension | Tab + camera PiP |
| LT-mac | macOS app | Always-on-top bubble |
| LT-lib | Local library | Optional Google Drive |
| LT-edit | Built-in editor | Trim · cut · export |
| LT-cta | Install free | mypipcam.earnyour.com |

---

## Popup moments (fun, luminous glass)

Use short (1.5–2.5s) glass cards — spring in, soft glow, fade out. Never cover the PiP face.

| When | Popup text | Accent |
| --- | --- | --- |
| Hook | Replace Loom for free | Orange glow |
| Problem | No Loom bill | Mint border |
| Install | Free · Open source | Orange |
| Record | Live camera PiP | Mint |
| macOS | Drag it anywhere | Orange |
| Library | Files on your Mac | Mint |
| Editor | Export locally | Orange |
| CTA | Install → mypipcam.earnyour.com | Orange + mint |

Design tokens / CSS: [`OVERLAY_DESIGN.md`](./OVERLAY_DESIGN.md) · HTML kit: [`overlays/`](./overlays/).

---

## Fun edit notes

- **Jump-cut** talking-head every 2–4s when energy dips.  
- **Punch-in** 110% on popup hits.  
- **Whoosh / soft tick** on glass popups (keep subtle).  
- Cover OBS “hall of mirrors” with a glass card or hard cut to Library.  
- Captions on always (YouTube + social mute). Style: cream fill, ink stroke, orange keyword highlights (“free”, “PiP”, “install”).  
- Music: light lo-fi / tech bed under screen demos; duck hard under VO.

---

## YouTube metadata (align with thumbnail)

**Title options**

1. Replace Loom for Free — MyPipCam Live Demo  
2. I Built a Free Loom Alternative (No Subscription)  
3. Quit Paying for Loom — Free Screen Recorder with Camera PiP  

**Description skeleton**

```
Replace Loom for free with MyPipCam — Chrome extension + macOS camera bubble.
Record tab + cam PiP, keep a local library, optional Google Drive, trim in the editor.

Install (free):
→ https://mypipcam.earnyour.com
→ https://github.com/EarnYour/MyPipCam/releases

0:00 Hook
…
Chapters as above

Not affiliated with Loom. “Loom-style” is descriptive only.
By EarnYour Marketing.
```

**Tags:** loom alternative, free screen recorder, picture in picture, chrome extension, macos, mypipcam, camera pip, local screen recording

---

## Render paths

1. **CapCut / FCP** (fastest polish) — import `clips/` + `markers-capcut.csv`; drop PNG/HTML overlay exports.  
2. **Remotion** — [`remotion/`](./remotion/) composites clips + glass popups; see README there.  
3. **ffmpeg concat** — rough assembly without overlays: `scripts/concat-highlight.sh`.

Do **not** render the full 42-minute source in-agent; assemble from `clips/` + selective pulls from the MOV.
