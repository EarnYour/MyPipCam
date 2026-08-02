# AGENTS.md — MyPipCam bootstrap for AI agents & humans

Read this first after cloning. Prefer these commands over inventing a root workspace setup — there is **no root `package.json`**.

Product: **MyPipCam** (EarnYour Marketing) · Site: [mypipcam.earnyour.com](https://mypipcam.earnyour.com) · Brand: [earnyour.com](https://earnyour.com)

Deeper product docs: [README.md](README.md) · Human PR norms: [CONTRIBUTING.md](CONTRIBUTING.md) · Secrets policy: [SECURITY.md](SECURITY.md)

---

## Project map

| Path | What | Stack |
| --- | --- | --- |
| `apps/extension` | Chrome MV3 extension — tab/camera PiP record, library, editor, optional Drive | Vite + CRXJS + React + TypeScript |
| `apps/macos` | Floating always-on-top camera bubble for OBS / desktop | SwiftUI, Xcode |
| `apps/web` | Marketing site + `/w/{shareId}` watch pages + share/view API | Static + Vercel serverless + Supabase |
| `scripts/install-macos-app.sh` | Build Release `.app` → `/Applications/MyPipCam.app` | bash + ImageMagick + `xcodebuild` |

Apps are independent. Always `cd` into the app you are building.

---

## Prerequisites

| Need | When |
| --- | --- |
| **Node.js 20+** (22 OK) + npm | Extension and web |
| **Google Chrome** (or Chromium) | Load unpacked extension |
| **macOS 14+ + Xcode 16+** | macOS app only |
| **ImageMagick** (`magick` on PATH) | Only `./scripts/install-macos-app.sh` (icon generation) |
| **Vercel CLI** (optional) | Local/prod deploy of `apps/web` |
| **Supabase project** (optional) | Share links / view counts |
| **Google Cloud OAuth client** (optional) | Drive upload / Connect Google |

Clone path examples below use `/path/to/MyPipCam` — substitute your real clone directory.

---

## Default path (Chrome extension) — do this first

Most agent work targets the extension.

```bash
cd /path/to/MyPipCam/apps/extension
npm install
cp .env.example .env.local
# Optional: set VITE_GOOGLE_OAUTH_CLIENT_ID (see Env vars). Placeholder still builds.
npm run build
```

Load in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select **`apps/extension/dist`** (the folder, not `src`)
4. Pin **MyPipCam**, open an **http(s)** page, click the icon → start recording

Dev watch (rebuilds into `dist`; reload the extension after changes):

```bash
cd /path/to/MyPipCam/apps/extension
npm run dev
```

`postinstall` / `prepare-assets` copies FFmpeg + MediaPipe into `public/` (gitignored). Do not commit those vendored binaries.

### Stable extension ID

Packed/unpacked builds that include the manifest `key` use:

`akpchobfndfddajiihkkdpnihihdicjc`

If `dist/manifest.json` lacks `key`, Chrome assigns a **different** ID. Google Cloud OAuth **Item ID** must match the ID shown on `chrome://extensions`. Prefer a rebuild so `key` is present.

Library URL (stable ID):

`chrome-extension://akpchobfndfddajiihkkdpnihihdicjc/src/library/index.html`

---

## Env vars (placeholders only — never commit real values)

### Extension — `apps/extension/.env.local`

Copy from [`apps/extension/.env.example`](apps/extension/.env.example):

```bash
VITE_GOOGLE_OAUTH_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
```

- Chrome-extension OAuth **client ID** only (no `client_secret`).
- Read at **build time** via Vite / `driveConfig.ts`. Rebuild after changing.
- Without a real ID, core record/library/editor still works; **Connect Google** will fail until configured.

Google Cloud (optional Drive): enable Drive API → OAuth consent (home/privacy/terms on `mypipcam.earnyour.com`, authorized domain `earnyour.com`) → credentials type **Chrome extension** → Item ID = live extension ID from `chrome://extensions`. Full steps: [README.md § Google Drive](README.md#google-drive-optional-cloud-library).

### Web — Vercel / local serverless

Copy from [`apps/web/.env.example`](apps/web/.env.example). Set on Vercel for **Production and Preview** (not in git):

```bash
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

- **`SUPABASE_SERVICE_ROLE_KEY` is server-only.** Never put it in the extension, `VITE_*`, or client JS.
- After RLS lockdown, **anon alone cannot** create shares or record views.
- Tables: `mypipcam_shares`, `mypipcam_views` (+ RPC `mypipcam_record_view`).

Optional local:

```bash
cd /path/to/MyPipCam/apps/web
npm install
npm run dev   # vercel dev — needs Vercel link + env
```

Deploy (root directory for the Vercel project is `apps/web`):

```bash
cd /path/to/MyPipCam/apps/web
npm install
vercel --prod
# or from monorepo root with Vercel root dir = apps/web
```

---

## macOS app

**Xcode debug:**

1. Open `apps/macos/MyPipCam.xcodeproj`
2. Signing & Capabilities → your Apple Development Team (replace sample team ID when forking)
3. Run (⌘R); grant Camera (and Mic if you open the mic picker)

**Install to Applications** (needs ImageMagick + Xcode CLT):

```bash
cd /path/to/MyPipCam
./scripts/install-macos-app.sh
```

Shared on-disk library with Chrome (optional): both pick the same folder, e.g. `~/Movies/MyPipCam`. See README.

---

## Common pitfalls

| Pitfall | Fix |
| --- | --- |
| Wrong cwd / inventing a root `npm install` | No root package.json — `cd apps/extension` or `apps/web` |
| Loading `apps/extension` or `src` in Chrome | Load **`apps/extension/dist`** only |
| OAuth “bad client id” / auth page fail | Google Cloud Item ID ≠ live extension ID; rebuild so manifest `key` is present; set `.env.local` and rebuild |
| Changed `.env.local` but Connect still fails | Must `npm run build` (or `dev`) and **Reload** the extension |
| MV3 service worker “asleep” / stale behavior | On `chrome://extensions` → extension card → **Reload**; reopen popup |
| Share API 401/RLS errors | Set `SUPABASE_SERVICE_ROLE_KEY` on Vercel Production **and** Preview |
| Putting `service_role` in the extension | Never — server-only on Vercel |
| Camera prompt every Mac rebuild | Use a real Signing Team; avoid ad-hoc unsigned rebuilds |
| Committing secrets / binaries | See “Do not commit” below |

---

## Do not commit

- `.env`, `.env.local`, any real API keys / OAuth secrets
- `*.pem`, `client_secret*.json`, `apps/extension/keys/`
- `node_modules/`, `dist/`, `.vercel/`
- Vendored `apps/extension/public/ffmpeg/`, `apps/extension/public/mediapipe/`
- Xcode `DerivedData/`, `build/`, `*.xcuserstate`

`.env.example` files are the only env templates that belong in git.

---

## What NOT to invent

- Do not add a root npm workspace / turbo / pnpm-workspace unless explicitly asked.
- Do not hardcode OAuth client IDs or Supabase keys in source or docs (placeholders only).
- Do not add telemetry without updating [PRIVACY.md](PRIVACY.md).
- Do not write exploits or attack remote systems; keep changes local and defensive.

---

## Verify checklist

After setup, confirm:

- [ ] `cd apps/extension && npm install && npm run build` exits 0
- [ ] `apps/extension/dist/manifest.json` exists; Chrome loads that folder
- [ ] Popup opens on an http(s) tab; Tab+Cam / Tab only can start (permissions granted)
- [ ] (Optional) `.env.local` has a real client ID → rebuild → Reload → Settings → Connect Google works
- [ ] (Optional) `cd apps/web && npm install` ; share API only if Supabase + Vercel env set
- [ ] (Optional) macOS: Xcode Run or `./scripts/install-macos-app.sh` shows the camera bubble
- [ ] `git status` shows no `.env.local` / `*.pem` staged

---

## Agent quick start (copy-paste)

```bash
git clone https://github.com/swmartinezdot33/MyPipCam.git
cd MyPipCam/apps/extension
npm install
cp .env.example .env.local
npm run build
# Chrome → chrome://extensions → Developer mode → Load unpacked → …/apps/extension/dist
```

Then read [README.md](README.md) only if you need Drive, shared library folder, or macOS details.
