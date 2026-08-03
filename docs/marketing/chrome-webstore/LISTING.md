# Chrome Web Store — Store Listing (copy-paste)

**Product name:** MyPipCam (not MyPixCam)  
**Brand:** EarnYour Marketing · [mypipcam.earnyour.com](https://mypipcam.earnyour.com)  
**Dashboard store ID (from your screenshot):** `mciohjfbcaahfjceneoogjxmajbfghmm`

> After store publish, update Google Cloud OAuth **Chrome extension → Item ID** to  
> `mciohjfbcaahfjceneoogjxmajbfghmm` (Connect Google / Drive will fail until this matches).  
> Local unpacked ID remains `akpchobfndfddajiihkkdpnihihdicjc` when the manifest `key` is present.

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
```
mailto:steven@earnyour.com
```

(Alternate if the form requires https only: `https://mypipcam.earnyour.com` — contact is also on the site footer.)

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

## Privacy tab — single-purpose & permission justifications

### Single purpose
```
MyPipCam records the current Chrome tab with an optional live camera picture-in-picture, saves clips to a local library, and optionally uploads to Google Drive or creates share watch links.
```

### Permission justifications (draft — paste/adapt per permission)

**tabCapture**  
Required to capture the active tab’s audio/video so MyPipCam can record Loom-style tab recordings. Capture starts only when you click record in the extension UI.

**activeTab / tabs**  
Used to identify the tab you chose to record, focus/open Library or recording UI, and coordinate start/stop with the correct tab. We do not browse your history for advertising.

**scripting + host permissions (http://\*/\*, https://\*/\*)**  
Needed to inject the recording overlay (countdown, camera PiP frame, stop controls) into the page being recorded. The overlay runs only in the context of a recording you start; it is not used to scrape or modify unrelated browsing.

**storage / unlimitedStorage**  
Stores recording metadata, preferences, and local video blobs in the extension so your library works offline without uploading by default. Unlimited storage allows longer/higher-quality clips in IndexedDB.

**offscreen**  
Holds MediaStreams and runs the MediaRecorder pipeline outside the service worker so tab + camera capture can continue reliably under Manifest V3.

**identity**  
Used only for optional “Connect Google” OAuth so you can upload recordings to your own Google Drive. Not required for local record/library/editor.

**alarms**  
Used for lightweight background tasks such as sync/retry timing related to optional Drive or library maintenance — not for tracking browsing.

**notifications**  
Optional user-facing alerts (for example when a long recording finishes or an upload completes). No marketing spam.

**Camera / Microphone (user media)**  
Requested only when you start Tab+Cam (or enable mic). Used to composite your webcam (and optional mic audio) into the recording. Denied permissions simply disable those features.

---

## After publish — OAuth reminder

1. Chrome Web Store item ID: `mciohjfbcaahfjceneoogjxmajbfghmm`
2. Google Cloud Console → APIs & Services → Credentials → Chrome extension OAuth client  
3. Set **Item ID** to `mciohjfbcaahfjceneoogjxmajbfghmm`  
4. Rebuild the extension with `VITE_GOOGLE_OAUTH_CLIENT_ID` set, upload a new store package if needed, and retest **Connect Google**

See also: `../CHROME_WEBSTORE.md`
