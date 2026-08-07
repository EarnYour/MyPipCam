# Chrome Web Store — Store Listing (copy-paste)

**Product name:** MyPipCam (not MyPixCam)  
**Brand:** EarnYour Marketing · [mypipcam.earnyour.com](https://mypipcam.earnyour.com)  
**Dashboard store ID (live / Published — public):** `meiehjfjcaahfjcdneoegjkmajbfghmm`  
**Public listing:** [chromewebstore.google.com/detail/meiehjfjcaahfjcdneoegjkmajbfghmm](https://chromewebstore.google.com/detail/meiehjfjcaahfjcdneoegjkmajbfghmm) · [chrome.google.com/webstore/detail/mypipcam/meiehjfjcaahfjcdneoegjkmajbfghmm](https://chrome.google.com/webstore/detail/mypipcam/meiehjfjcaahfjcdneoegjkmajbfghmm)

> Prefer **two** Chrome-extension OAuth clients:  
> **Client A** Item ID = store `meiehjfjcaahfjcdneoegjkmajbfghmm` (store zip only).  
> **Client B** Item ID = unpacked `akpchobfndfddajiihkkdpnihihdicjc` (daily `.env.local`).  
> Do not flip one client’s Item ID between store and local — see [`../CHROME_WEBSTORE.md`](../CHROME_WEBSTORE.md).

Upload graphics from this folder (see filenames below). Package zip: `../MyPipCam-chrome-webstore.zip`.

---

## Store Listing form

### Item name
```
MyPipCam
```

### Summary (max 132 characters)

Paste exactly:

```
Free Loom-style tab recorder with live camera PiP. Local library, editor, optional Drive & share links.
```

Character count: **109** / 132

### Description

Paste into the Description field (under 16,000 characters):

```
MyPipCam is a free, Loom-style Chrome extension for recording the current tab with a live, draggable camera picture-in-picture — plus a local library, simple editor, optional Google Drive sync, and share links with view counts.

Replace Loom for free. Record demos, walkthroughs, bug reports, and async updates without a subscription.

═══════════════════════════════════
WHAT YOU GET
═══════════════════════════════════

• Tab + camera PiP recording — capture this Chrome tab with a floating webcam bubble you can drag and resize
• Tab-only mode — skip the camera when you just need the screen
• Countdown, pause, and mid-take controls — stay in flow while you record
• Local library — keep recordings on your device; open, rename, and manage clips in one place
• Built-in editor — trim and export without leaving the extension
• Optional Google Drive — Connect Google to upload into a MyPipCam folder and sync across browsers on the same account
• Share links with view counts — share a mypipcam.earnyour.com/w/… watch page; views show back in your Library
• Optional macOS companion — floating always-on-top camera bubble for OBS / desktop (separate free app from the same project)
• Keyboard shortcut — start/stop recording (default Ctrl+Shift+U / ⌘⇧U; editable in chrome://extensions/shortcuts)
• Free & open source — MIT License, built by EarnYour Marketing

═══════════════════════════════════
HOW TO INSTALL & START
═══════════════════════════════════

1. Click Add to Chrome and pin MyPipCam
2. Open any http(s) page you want to record
3. Click the MyPipCam icon → choose Tab + Cam or Tab only
4. Grant camera/mic when prompted (only what you need)
5. Record, stop, then open Library to review, edit, or share

Product site & install help: https://mypipcam.earnyour.com  
Source & releases: https://github.com/EarnYour/MyPipCam  
Privacy: https://mypipcam.earnyour.com/privacy  
Terms: https://mypipcam.earnyour.com/terms

═══════════════════════════════════
PRIVACY (HIGH LEVEL)
═══════════════════════════════════

• Recordings stay on your device by default (browser storage or a library folder you choose)
• Camera and microphone are used only when you start a recording that needs them
• Google Drive and share-link features are optional — connect only if you want cloud upload / watch pages
• We do not sell your video content
• Full policy: https://mypipcam.earnyour.com/privacy

═══════════════════════════════════
SUPPORT
═══════════════════════════════════

Email: steven@earnyour.com  
Site: https://mypipcam.earnyour.com  
GitHub issues: https://github.com/EarnYour/MyPipCam/issues

MyPipCam is inspired by picture-in-picture screen-recording workflows. It is not affiliated with Loom; “Loom-style” is descriptive only.
```

### Category
**Productivity**

(Chrome Web Store “Workflow & Planning” is fine if Productivity is unavailable in your dashboard locale; Productivity is the best fit for a recorder/library tool.)

### Language
**English**

### Homepage URL
```
https://mypipcam.earnyour.com
```

### Support URL

Paste exactly (https preferred — dashboard rejects empty Support URL):

```
https://mypipcam.earnyour.com
```

Support email (also in description / site): `steven@earnyour.com`  
(`mailto:steven@earnyour.com` only if the field accepts mailto and https is already set elsewhere.)

### YouTube video URL (optional)
```
<!-- PASTE_YOUR_YOUTUBE_URL_HERE — e.g. https://www.youtube.com/watch?v=XXXXXXXXXXX -->
```

Leave blank in the dashboard until you have a public demo video. Marketing thumbnail source (not a YouTube URL): `../mypipcam-youtube-thumbnail-live-demo-yt.jpg`.

---

## Graphics checklist (this folder)

| Field | File | Size |
| --- | --- | --- |
| Store icon | `icon-128.png` | 128×128 |
| Screenshot 1 | `screenshot-01-record-pip.png` | 1280×800 |
| Screenshot 2 | `screenshot-02-popup.png` | 1280×800 |
| Screenshot 3 | `screenshot-03-library.png` | 1280×800 |
| Screenshot 4 | `screenshot-04-share.png` | 1280×800 |
| Screenshot 5 | `screenshot-05-macos.png` | 1280×800 |
| Small promo tile | `promo-small-440x280.png` | 440×280 **(required)** |
| Marquee promo tile | `promo-marquee-1400x560.png` | 1400×560 (optional, for featuring) |
| Large tile (legacy) | `promo-large-920x680.png` | 920×680 — only if your dashboard still asks; official docs currently list Small + Marquee only |

Official Chrome image guide: https://developer.chrome.com/docs/webstore/images

---

## Privacy tab + Settings (required to publish)

**Full copy-paste answers (every permission Chrome listed in “Unable to publish”):** see [`PRIVACY_PRACTICES.md`](./PRIVACY_PRACTICES.md).

| Field | Value |
| --- | --- |
| Privacy policy URL | `https://mypipcam.earnyour.com/privacy` |
| Support URL | `https://mypipcam.earnyour.com` |
| Single purpose | See PRIVACY_PRACTICES.md §1 |
| Permission justifications | See PRIVACY_PRACTICES.md §2 (`storage`, `identity`, `tabCapture`, `camera`, `microphone`, `cookies`, `personal results`, `website content`, `displayCapture`, `audioCapture`, `identity.email`, plus any others shown) |
| Remote code | **No** — see PRIVACY_PRACTICES.md §3 |
| Data usage certification | Check all Limited Use / “I do not sell…” boxes — §4 |

### Settings — you must click (manual)

1. Dashboard → **Settings** → set publisher **contact email** to `steven@earnyour.com` → open Google’s email → **Verify**.
2. Dashboard → **Settings** → **Identity verification** → **Start** / begin the ID flow → finish Google’s verification.
3. Item → **Privacy** → paste justifications + policy URL + certify Developer Program Policies / User Data checkboxes.
4. Item → **Store listing** → Support URL = `https://mypipcam.earnyour.com` → Save → Publish.

### Certify Developer Program Policies

On the Privacy tab (and/or publish confirmation), check the certification that the item complies with the [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/) and User Data / Limited Use rules. Publishing is blocked until this is checked.

### Single purpose (short)

```
MyPipCam records the current Chrome tab with an optional live camera picture-in-picture, saves clips to a local library with a built-in editor, and optionally uploads to the user’s Google Drive or creates share watch links.
```

---

## After publish — OAuth reminder

**Live store ID:** `meiehjfjcaahfjcdneoegjkmajbfghmm`  
**Public listing:** `https://chromewebstore.google.com/detail/meiehjfjcaahfjcdneoegjkmajbfghmm`  
**Unpacked (manifest `key`) ID:** `akpchobfndfddajiihkkdpnihihdicjc`

Use **two** clients — do not put the store client ID into daily `.env.local`.

### Store Client A (production)

1. [Google Cloud Console](https://console.cloud.google.com/) → MyPipCam project  
2. **APIs & Services** → **Credentials**  
3. Open (or create) a **Chrome extension** OAuth client named e.g. `MyPipCam Store`  
4. **Item ID** = `meiehjfjcaahfjcdneoegjkmajbfghmm` → **Save**  
5. For the **store zip only**: set `VITE_GOOGLE_OAUTH_CLIENT_ID` to Client A → `npm run build` → strip manifest `key` → zip → upload → retest **Connect Google** from the store install  
6. Restore Client B in `.env.local` for local work

### Local Client B (dev)

1. Same Credentials page → **Create** another **Chrome extension** client (`MyPipCam Local`)  
2. **Item ID** = `akpchobfndfddajiihkkdpnihihdicjc` → **Create**  
3. Put Client B’s ID in `apps/extension/.env.local` → rebuild → Reload unpacked → **Connect Google**

See also: [`../CHROME_WEBSTORE.md`](../CHROME_WEBSTORE.md)
