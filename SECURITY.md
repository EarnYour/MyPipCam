# Security Policy

MyPipCam is open-source software stewarded by [EarnYour Marketing](https://earnyour.com).

**Product site:** [https://mypipcam.earnyour.com](https://mypipcam.earnyour.com)

## Supported versions

Security fixes are applied to the latest code on the default branch of this repository. There is no separate LTS track.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Prefer one of:

1. **GitHub private vulnerability advisory** — use [Report a vulnerability](https://github.com/swmartinezdot33/MyPipCam/security/advisories/new) on this repository (update the org/repo path if you are looking at a fork).
2. **Steward contact** — [mypipcam.earnyour.com](https://mypipcam.earnyour.com) or [earnyour.com](https://earnyour.com) (EarnYour Marketing). Mention “MyPipCam security” so the report is routed correctly.

Include:

- Affected component (Chrome extension and/or macOS app) and version / commit if known
- Steps to reproduce or a proof-of-concept
- Impact assessment (what an attacker could do)

We will acknowledge reports as soon as practical and coordinate disclosure after a fix is available.

## Security notes for distributors and contributors

### Chrome extension

- **Do not commit** `apps/extension/keys/*.pem`, `.env` / `.env.local`, OAuth **client secrets**, OpenAI keys, or Supabase **service_role** keys. The manifest `key` field is a **public** key used only to stabilize the extension ID; the matching **private** `.pem` must stay local and gitignored.
- Google Drive uses `chrome.identity` with a **Chrome-extension OAuth client ID** only (no client secret). Set `VITE_GOOGLE_OAUTH_CLIENT_ID` in gitignored `apps/extension/.env.local` (see `.env.example`). The committed fallback is a `YOUR_CLIENT_ID…` placeholder.
- OpenAI API keys are stored in `chrome.storage.local` on the user’s machine and are never synced by this code. Treat a compromised extension profile as a secret-disclosure risk.
- Broad `host_permissions` (`http(s)://*/*`) exist so the recording overlay can be injected into the tab being captured. The PiP camera iframe is gated with a short-lived channel token registered by the content script so arbitrary sites cannot drive the extension-origin camera via `web_accessible_resources` alone.

### Share / view API (`apps/web`)

- Tables `mypipcam_shares` / `mypipcam_views` are **not** writable by the Supabase `anon` key. The Vercel API must use **`SUPABASE_SERVICE_ROLE_KEY`** (server-only). Never expose service_role to the browser or commit it.
- Watch pages only talk to `/api/shares/*` on mypipcam.earnyour.com — not directly to Supabase from the client.

### macOS app

- The app is sandboxed (`app-sandbox`) with camera, microphone, and user-selected file access (security-scoped bookmarks) only.
- Library recording IDs are validated as UUID-shaped path segments before filesystem operations.
- Forks should replace the sample Apple Development Team ID in the Xcode project with their own.

### Secrets and large binaries

- `.env`, `.env.local`, keys, MediaPipe/FFmpeg vendored binaries under `apps/extension/public/`, `.vercel/`, and local Xcode derived data folders are gitignored. Do not force-add them.

### Public release checklist

- [ ] No `*.pem` / `client_secret*.json` in the tree or git history
- [ ] Extension OAuth ID only via `.env.local` / CI secrets, not hardcoded
- [ ] Vercel has `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (not committed)
- [ ] GitHub → Settings → Code security → private vulnerability advisories enabled
- [ ] Confirm `git status` is clean of `.env.local` before every push
