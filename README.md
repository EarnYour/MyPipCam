# MyPipCam

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Monorepo for **MyPipCam**: Loom-style camera PiP on macOS and in Chrome.

**Created by [EarnYour Marketing](https://earnyour.com)** and published freely on GitHub under the [MIT License](LICENSE). See [NOTICE](NOTICE) for attribution.

**Product site / funnel:** [mypipcam.earnyour.com](https://mypipcam.earnyour.com)

**Tip jar (optional):** [Support MyPipCam on Stripe](https://donate.stripe.com/7sY9AVb6S9uadWwek4cAo09) — pay what you want; keeps the project free and open source.

| Path | What |
| --- | --- |
| [`apps/macos`](apps/macos) | macOS companion — floating always-on-top camera bubble for OBS / desktop recording |
| [`apps/extension`](apps/extension) | Chrome extension — screen + camera PiP recording, local library, trim/cut editor |
| [`apps/web`](apps/web) | Product site + share watch pages (`/w/{shareId}`) and view-count API |

**Legal & safety:** [Terms of Use](TERMS.md) · [Privacy](PRIVACY.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

**AI / IDE agents:** start with **[AGENTS.md](AGENTS.md)** (install, env, load unpacked, pitfalls, verify checklist).

## Quick start

There is no root `package.json` — build each app from its directory.

### Chrome extension (primary)

```bash
cd /path/to/MyPipCam/apps/extension
npm install
cp .env.example .env.local   # optional: set VITE_GOOGLE_OAUTH_CLIENT_ID for Drive
npm run build
```

Then Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → select `apps/extension/dist`.

### Web (optional)

```bash
cd /path/to/MyPipCam/apps/web
npm install
# Set SUPABASE_* in Vercel (see apps/web/.env.example) for share/view API
vercel --prod
```

### macOS app (optional)

```bash
# Xcode: open apps/macos/MyPipCam.xcodeproj → Run
# Or install Release to Applications (needs ImageMagick + Xcode):
./scripts/install-macos-app.sh
```

Details, Drive OAuth, shared library folder, and pitfalls: [AGENTS.md](AGENTS.md) · [CONTRIBUTING.md](CONTRIBUTING.md).

## How the pieces fit together

- **Chrome extension** is the Loom-like capture path: record **this Chrome tab** with a live draggable camera PiP on the page (tab capture), browse clips in a local library, trim/cut, and download. An Advanced path still supports screen/window capture.
- **macOS app** is the desktop companion: a real always-on-top camera window, plus **Record** (ScreenCaptureKit screen/window capture with PiP) that saves into the shared library folder Chrome uses.
- **Shared library folder** (optional): both apps can point at the same local folder so Chrome writes recordings to disk and the Mac app browses/plays them. Until a folder is chosen, the extension keeps clips in IndexedDB only.

You can use either alone, or both (e.g. Mac bubble for OBS + extension for quick browser recordings).

---

## Shared recording library folder

Pick one folder on disk (suggested: `~/Movies/MyPipCam`). Chrome and the Mac app both use it as the source of truth for recordings — no cloud sync required.

### On-disk layout

```text
<LibraryRoot>/
  .mypipcam-library   # marker (version 1)
  recordings/
    <uuid>/
      meta.json       # id, title, createdAt, durationMs, mimeType, sizeBytes (+ optional Drive fields)
      video.webm      # or video.mp4
      thumb.jpg       # optional
      transcript.json # optional
```

`meta.json` may also include `driveFileId`, `driveWebViewLink`, and `driveShared` when the clip is uploaded to Google Drive.

### Chrome extension

1. Open **Library** → **Settings** (or use the banner when no folder is set).
2. Under **Recording library**, click **Choose folder…** and select (or create) the folder — e.g. `Movies/MyPipCam`.
3. When prompted, optionally **move existing browser recordings** into the folder (one-shot IndexedDB → disk migration).
4. New recordings are written under `recordings/<uuid>/`. If the offscreen recorder cannot write (permission), clips queue in IndexedDB and flush when you reopen Library.

### macOS app

1. Choose **Choose Recording Library…** (menu bar or bubble menu) and select the **same** folder.
2. **Open Recording Library** opens the native library window when a folder is set (browse, play, rename, delete, Reveal in Finder).
3. Use **Open in Chrome…** when you need the extension editor / transcription workflow.

Transcription still uses an **OpenAI** API key in extension Settings only (Deepgram / AssemblyAI placeholders were removed).

---

## Google Drive (optional cloud library)

Chrome extension only. Local folder + Mac shared-folder support are unchanged. Drive is an optional layer: upload after save, list/play from Drive on other browsers, and create Loom-style **MyPipCam watch links** with view counts.

### Why a custom watch page (not Drive analytics)

Google Drive does **not** expose reliable “anyone with the link” view analytics to third-party apps. MyPipCam therefore shares a link to **`https://mypipcam.earnyour.com/w/{shareId}`**. Opening that page counts as a view; the page embeds the Drive preview when a `driveFileId` is available. The Library shows **👁 N views** / last viewed (refreshed on Library load).

### Scope tradeoff

MyPipCam uses **`https://www.googleapis.com/auth/drive.file`** (app-created / app-opened files only). On Connect, the extension creates (or reuses) a **`MyPipCam`** folder in your My Drive and stores its folder ID in `chrome.storage.sync`.

| Approach | Pros | Cons |
| --- | --- | --- |
| **`drive.file` + app folder** (chosen) | Minimal access; works for multi-device via folder ID sync | Cannot pick an arbitrary existing folder you didn’t open with the app |
| Full Drive / `drive.readonly` | Folder picker for any folder | Broader access than needed |

### Google Cloud Console setup

Auth still uses **`chrome.identity`** with a **Chrome extension** OAuth client. The product website is for the **OAuth consent screen** (and public legal links)—it is **not** the OAuth client “Application ID” and does **not** replace the extension client ID.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create (or select) a project.
2. Enable **Google Drive API** (APIs & Services → Library → “Google Drive API” → Enable).
3. Configure the **OAuth consent screen** (External is fine for personal use). Add yourself as a test user while the app is in Testing.
   - **Application home page:** `https://mypipcam.earnyour.com`
   - **Application privacy policy link:** `https://mypipcam.earnyour.com/privacy` (host or mirror [`PRIVACY.md`](PRIVACY.md) there)
   - **Application terms of service link** (optional): `https://mypipcam.earnyour.com/terms` (host or mirror [`TERMS.md`](TERMS.md) there)
   - **Authorized domains:** add `earnyour.com`
4. Create **two** credentials (recommended): **APIs & Services → Credentials → Create credentials → OAuth client ID** — Application type **Chrome extension** (not “Web application”) for each.
5. Item ID / Application ID = the **extension ID** for that build — **not** the website hostname:

| Client | Suggested name | Item ID | Use |
| --- | --- | --- | --- |
| **A — store** | `MyPipCam Store` | `meiehjfjcaahfjcdneoegjkmajbfghmm` | Store zip / published listing only |
| **B — local** | `MyPipCam Local` | `akpchobfndfddajiihkkdpnihihdicjc` | Daily `.env.local` + unpacked `dist` (manifest `key` present) |

   Unpacked *without* `key` gets a random third ID; OAuth will fail until you reload a build that keeps `key`. Do not flip one client’s Item ID between store and local. Full dual-client workflow: [docs/marketing/CHROME_WEBSTORE.md](docs/marketing/CHROME_WEBSTORE.md). Connect Google surfaces the live extension ID in Settings when auth fails for a mismatch.
6. Copy **Client B**’s **Client ID** (ends with `.apps.googleusercontent.com`) for local work.
7. Put it in gitignored env (never commit the real ID):

```bash
cp apps/extension/.env.example apps/extension/.env.local
# edit .env.local — Client B (local Item ID), not the store client:
VITE_GOOGLE_OAUTH_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
```

`driveConfig.ts` reads `VITE_GOOGLE_OAUTH_CLIENT_ID` at build time; the committed fallback is a placeholder. The manifest `oauth2.client_id` imports that value automatically. Bake Client A only when packaging the store zip.

8. Rebuild and reload:

```bash
cd apps/extension
npm run build
```

Then **Reload** the extension on `chrome://extensions` (ID should be `akpchobfndfddajiihkkdpnihihdicjc`).

### Using Drive in the extension

1. **Library → Settings → Google Drive → Connect Google** — sign in; a `MyPipCam` folder is created/found on Drive.
2. Leave **Auto-upload new recordings to Drive** on (default) so new clips upload after local save (retries when you open Library).
3. Per clip: **Upload to Drive** (if not uploaded), **Share** / **Copy link** — copies the MyPipCam watch URL (also enables Drive anyone-with-link so the embed can play).
4. Cards show a **Drive** badge when the file is on Drive; shared clips also show **👁 views** / last viewed. **Drive only** means it exists remotely but not in this browser’s local library.

### Share view tracking (web API)

| Piece | Role |
| --- | --- |
| `apps/web` watch page | `/w/{shareId}` embeds Drive preview + `POST /api/shares/:id/view` |
| Supabase tables | `mypipcam_shares`, `mypipcam_views` (see `apps/web/.env.example`) |
| Extension Library | Creates share via `POST /api/shares`, copies watch URL, refreshes stats |

**Vercel env vars** (project `mypipcam`, Production + Preview) — server-only, never commit:

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role from Supabase → Settings → API>
```

With RLS locked down, **`SUPABASE_SERVICE_ROLE_KEY` is required** on Vercel. `SUPABASE_ANON_KEY` alone cannot create shares or record views. Set both Production and Preview (Dashboard or `vercel env add`).

Deploy from the monorepo root (Vercel root directory is `apps/web`):

```bash
cd /path/to/MyPipCam
vercel --prod
```

### Multi-device / multi-browser sync

1. Connect Google Drive on computer A (same Google account as Chrome sync).
2. Folder ID is stored in **`chrome.storage.sync`**, so other Chrome profiles signed into that Google account receive the same folder ID.
3. On computer B: open Library → Connect Google (if needed) → recordings uploaded from A appear (play downloads from Drive).
4. Local disk library and Mac app stay independent; Drive does not replace them.

---

## Chrome extension

### Load unpacked

1. Build:

```bash
cd apps/extension
npm install
npm run build
```

2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode**
4. **Load unpacked** → select `apps/extension/dist`
5. Pin **MyPipCam**, open a normal http(s) page, click the icon → pick mode → **Start recording**
   — **3→2→1** countdown, then a draggable camera bubble + left control dock (no big recorder window).

Shortcut: **⌘⇧U** (Mac) / **Ctrl+Shift+U** (Windows/Linux) — start or stop.

**Extension IDs:** store (live) `meiehjfjcaahfjcdneoegjkmajbfghmm` · unpacked (`key`) `akpchobfndfddajiihkkdpnihihdicjc`  
**Store listing:** [chromewebstore.google.com/detail/meiehjfjcaahfjcdneoegjkmajbfghmm](https://chromewebstore.google.com/detail/meiehjfjcaahfjcdneoegjkmajbfghmm)  
Library page (store): `chrome-extension://meiehjfjcaahfjcdneoegjkmajbfghmm/src/library/index.html`  
Library page (unpacked): `chrome-extension://akpchobfndfddajiihkkdpnihihdicjc/src/library/index.html`  
**Open in Chrome…** (macOS) opens the HTTPS bridge `https://mypipcam.earnyour.com/open-library?ext=…` with either ID so the extension opens Library via `chrome.tabs` — direct `chrome-extension://` navigation is often blocked by ad blockers (`ERR_BLOCKED_BY_CLIENT`).  
(The macOS app **Open Recording Library** menu opens this URL.)

If auto-detect picks the wrong install, use **Set Extension ID…** and paste the ID from `chrome://extensions` (Developer mode), then **Save & Open Library**. The app recognizes both the store and unpacked IDs under Chrome/Edge/Brave/Arc profiles.

### What it does

| Surface | Role |
| --- | --- |
| Popup | Tab+Cam / Tab only / Cam only, mic picker, start/stop, library, Advanced |
| In-page chrome | Countdown, draggable cam bubble (⋯), left dock (timer / stop / pause / discard) |
| Offscreen | Hidden MediaRecorder for tab or camera capture |
| Advanced recorder | Optional screen/window capture + canvas PiP compositor |
| Library | Browse, play, rename, delete, download, open editor, Drive upload/share |
| Editor | Trim in/out, optional middle cut-out, export via ffmpeg.wasm |

### Develop

```bash
cd apps/extension
npm install
npm run dev
```

Then load the unpacked path Vite/CRXJS prints (or rebuild and reload `dist`).

---

## macOS app

A Loom-style floating camera bubble for macOS. Point it at your webcam (or OBS Virtual Camera), drag it around, and use **Record** to capture the desktop (or a window) with the PiP included — or keep using OBS if you prefer.

### Features

- Circular always-on-top camera bubble
- Drag anywhere to move
- Scroll while hovering to resize
- Camera picker (OBS Virtual Camera, FaceTime, Continuity Camera, etc.)
- Microphone picker (built-in / USB / Bluetooth mics) — choice is remembered and used for desktop recording
- Border color presets + soft Loom-like drop shadow
- Mirror toggle
- Menu bar icon to show/quit (no Dock icon)
- **Record…** — dots menu / menu bar: pick camera, mic, Screen or Window, then ScreenCaptureKit-record; saves MP4 into the shared library folder (`recordings/<uuid>/`). Choose **microphone or system audio** (not both — a single AAC track cannot mix them cleanly). Tab capture stays in the Chrome extension. Google Drive upload still runs through the extension when Connect Google + auto-upload are enabled.
- **Open Recording Library** — opens the native library window when a shared folder is set (prompts to choose otherwise)
- **Choose Recording Library…** / **Reveal Library in Finder** — pick or show the on-disk folder shared with Chrome
- **Open in Chrome…** — secondary path for editor / transcription / Drive sync (via `mypipcam.earnyour.com/open-library` bridge)
- **Set Extension ID…** — paste ID from `chrome://extensions` if the bridge cannot reach the extension
- **Install Chrome Extension…** — opens `chrome://extensions` + reveals `apps/extension/dist` with load steps

### Setup (clean install with App Icon)

Install a normal **Applications** app (screen icon with orange PiP dot):

```bash
cd /path/to/MyPipCam
./scripts/install-macos-app.sh
```

That builds a signed **Release** `.app`, copies it to `/Applications/MyPipCam.app`, and opens it. Find it in **Applications** / **Launchpad**, or run `open -a MyPipCam`.

### Setup (Xcode debug)

1. Open `apps/macos/MyPipCam.xcodeproj` in Xcode
2. Under **Signing & Capabilities**, pick **your** Apple Development Team (replace the sample team ID in the Xcode project if you are forking). Keep a Team selected so Camera permission survives rebuilds.
3. Press **Run** (⌘R)
4. Allow camera access when prompted (once). Camera choice and appearance settings are remembered across launches.
5. Open the mic menu (toolbar mic icon or right-click → **Microphone**) and allow microphone access if prompted — selection is remembered for next launch. The bubble itself does not capture audio; pick the same mic in OBS (or use the Chrome extension recorder) for the final mix.
6. In OBS: **Start Virtual Camera**
7. Hover the bubble → camera icon → choose **OBS Virtual Camera** (last choice is restored next launch; OBS is preferred only when nothing is saved)

### Camera permission (sticky across launches)

macOS Privacy (TCC) ties Camera access to the app’s **code signature**, not only the bundle ID (`com.stevenmartinez.MyPipCam`).

- **Same signed build / Development Team:** Grant once → relaunches should start silently without re-prompting. Selected camera + bubble settings persist in UserDefaults.
- **Ad-hoc / unsigned / empty Team:** Each rebuild can look like a new app to TCC, so macOS may ask for Camera again. Prefer a Signing Team in Xcode.
- **If access was denied:** the app will not spam the system dialog. Use **Open System Settings** on the bubble, or go to **System Settings → Privacy & Security → Camera** and enable **MyPipCam**.
- Launch from one consistent location (Xcode Run, or one built `.app`) — different paths can create separate TCC entries.

### OBS recording tip

Record your display/screen in OBS as usual. MyPipCam sits on top of your desktop as a real window, so it appears in the recording with you inside the circle.

**Audio:** The macOS bubble is video-only (no in-app mic capture or file recording). Choose your mic in MyPipCam for preference parity with the extension; configure the same input in OBS (or record with the Chrome extension) for the actual soundtrack.

### Controls

| Action | How |
| --- | --- |
| Show / Hide Bubble | Menu bar icon (also Hide in bubble ⋯ / right-click; Show restores after Hide, Cmd+W, or Cmd+H) |
| Move | Drag the bubble |
| Resize | Scroll while hovering, or right-click → Size |
| Switch camera | Hover → video icon, or right-click → Camera |
| Switch microphone | Hover → mic icon, or right-click → Microphone |
| Border color | Hover → palette icon, or right-click → Appearance… |
| Shadow / mirror | Right-click the bubble / Appearance popover |
| Quit | Hover → ✕, menu bar icon → Quit, or right-click → Quit |
| Open at Login | Menu bar icon → Open at Login, or right-click the bubble |
| Open Recording Library | Menu bar or bubble context menu → native window (shared folder) |
| Choose / Reveal Library | Menu bar or bubble context menu → pick or show folder in Finder |
| Open in Chrome… | Menu bar or bubble context menu → extension library/editor |
| Install Chrome Extension… | Menu bar or bubble context menu → load-unpacked helper |

### Requirements

- macOS 14+
- Xcode 16+
- Camera permission
- Microphone permission (for the mic picker; optional if you never open that menu)
- OBS Virtual Camera (optional, if that's your source)

### Shared recording library (Mac)

Both the macOS app and the Chrome extension can point at the **same local folder** so recordings on disk are visible in both.

1. In Chrome MyPipCam **Settings**, choose a library folder (suggested: `~/Movies/MyPipCam`).
2. In the Mac app menu bar (or bubble context menu), choose **Choose Recording Library…** and pick that **same** folder. First open suggests `~/Movies/MyPipCam`.
3. **Open Recording Library** opens the native Mac window (list / play / rename / delete / Reveal in Finder).
4. Use **Open in Chrome…** when you need the extension editor or transcription UI.

On-disk layout:

```text
<LibraryRoot>/
  .mypipcam-library
  recordings/
    <uuid>/
      meta.json
      video.webm   # or video.mp4
      thumb.jpg        # optional
      transcript.json  # optional
```

---

## Out of scope (for now)

- Drawing tools, reaction stickers, auto-zoom
- Chrome Web Store publish
- Native Mac Google Drive SDK (Chrome Drive library is enough for multi-browser sync)

---

## License & credits

MyPipCam is open source under the [MIT License](LICENSE). Copyright © 2026 [EarnYour Marketing](https://earnyour.com) and contributors. Published freely on GitHub — see [NOTICE](NOTICE).

Not affiliated with Loom, OpenAI, Google, Apple, or Chrome.
