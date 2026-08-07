# MyPipCam Chrome Extension

Local Loom-style **this-tab** recorder with a live draggable camera PiP, left control dock,
countdown, plus library and trim editor.

## Develop

```bash
cd apps/extension
npm install
npm run dev
```

Load the unpacked extension from `apps/extension/dist` after a build, or use the CRXJS
dev workflow (Vite will print the path). Prefer `npm run build` for a stable unpacked load.

## Build

```bash
cd apps/extension
npm install
npm run build
```

Output: `apps/extension/dist/` (load this folder in Chrome).

## Recording UX (Loom-in-browser)

1. Open a normal **http(s)** tab you want to demo.
2. Pick a mode in the popup: **Tab + Cam**, **Tab only**, or **Cam only**.
3. Click **Start recording** — Loom-style preflight:
   - **Camera first** (Tab + Cam / Cam): choose camera (+ mic), Allow if needed, Next.
   - **Then share tab** (Tab + Cam / Tab): confirm the active tab and click **Share tab & start**
     (mints `tabCapture` on that click).
4. A center-screen **3 → 2 → 1** countdown runs on the page.
5. After countdown: capture starts. Drag the **circular camera bubble** anywhere; use the
   left **vertical dock** (timer / stop / pause / discard).
6. Bubble **⋯** menu cycles size (or scroll-wheel resize). Stop saves to the local library.

Capture uses Chrome **tab capture** for tab modes (on-page bubble is in the recording).
**Cam only** records the camera stream in the offscreen document. MediaRecorder never
starts until the countdown finishes (Cancel / discard aborts without saving).

### Feature checklist

| Feature | Status |
| --- | --- |
| Draggable circular cam bubble on page | **Done** |
| Thin white border + soft shadow + ⋯ menu | **Done** |
| Left vertical dock (timer / stop / pause / discard) | **Done** |
| 3→2→1 countdown before MediaRecorder | **Done** |
| Tab + Cam / Tab only / Cam only modes | **Done** (tab = current Chrome tab, not full OS screen) |
| Mic picker | **Done** |
| Camera picker before share (Loom order) | **Done** (popup preflight) |
| Local library + trim / silence / transcribe / API keys | **Done** |
| Google Drive upload / multi-browser library / share links | **Done** (optional; requires OAuth client ID) |
| Full OS screen / multi-app (non-Chrome) overlay | **Partial** — use **Advanced** `getDisplayMedia` path; no OS-level float |
| Viewer comments / emoji reactions on hosted video | **Not in v1** |
| Loom AI “Make edits” / “Take action” | **Not in v1** |
| Viewer analytics | **Not in v1** |

## Google Drive / OAuth

Optional. Set `VITE_GOOGLE_OAUTH_CLIENT_ID` in gitignored `.env.local` (copy from `.env.example`), then rebuild (see root [README](../../README.md#google-drive-optional-cloud-library)).

- **OAuth client type:** Chrome extension — prefer two clients: store Item ID `moalajbpehfocfeecpleceplighfhim` (Client A, store zip only) and unpacked+`key` Item ID `akpchobfndfddajiihkkdpnihihdicjc` (Client B in `.env.local`). Not the website. See [CHROME_WEBSTORE.md](../../docs/marketing/CHROME_WEBSTORE.md).
- **Consent screen URLs** (product funnel): home `https://mypipcam.earnyour.com`, privacy `https://mypipcam.earnyour.com/privacy`, terms `https://mypipcam.earnyour.com/terms`; authorized domain `earnyour.com`.
- Auth uses `chrome.identity` in the **background service worker** (Settings → `CONNECT_GOOGLE`; other pages may use `GET_DRIVE_TOKEN`). Interactive `getAuthToken` starts in the SW message listener so the click gesture is preserved. The site does not replace the extension client ID.
- If Connect fails, Settings shows the real `chrome.runtime.lastError` / OAuth text. Client-mismatch errors include the live extension ID to paste as the Google Cloud OAuth **Item ID**.

### Limits

| Mode | Behavior |
| --- | --- |
| **Tab + Cam** (primary) | Live in-page PiP + tab capture. http(s) only. |
| **Tab only** | Tab capture, no camera bubble. |
| **Cam only** | Camera (+ mic) recorded offscreen; bubble still previewed on page. |
| **Screen / window** (Advanced) | Optional compositor UI. Chrome cannot float a true OS-level camera over other apps. |

## Advanced screen / window path

Popup → **Advanced** opens the legacy recorder page for `getDisplayMedia` (screen /
window / tab) with canvas compositing. Prefer the primary popup flow for browser demos.
