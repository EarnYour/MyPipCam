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

- **Do not commit** `apps/extension/keys/*.pem`, `.env` files, OAuth client secrets, or API keys. The manifest `key` field is a **public** key used only to stabilize the extension ID; the matching **private** key must stay local and gitignored.
- Google Drive uses `chrome.identity` with a **Chrome-extension OAuth client ID** only. There is **no** client secret in the extension. Paste your own client ID into `apps/extension/src/shared/driveConfig.ts` (keep the placeholder in public forks until you create credentials).
- OpenAI API keys are stored in `chrome.storage.local` on the user’s machine and are never synced by this code. Treat a compromised extension profile as a secret-disclosure risk.
- Broad `host_permissions` (`http(s)://*/*`) exist so the recording overlay can be injected into the tab being captured. The PiP camera iframe is gated with a short-lived channel token registered by the content script so arbitrary sites cannot drive the extension-origin camera via `web_accessible_resources` alone.

### macOS app

- The app is sandboxed (`app-sandbox`) with camera, microphone, and user-selected file access (security-scoped bookmarks) only.
- Library recording IDs are validated as UUID-shaped path segments before filesystem operations.

### Secrets and large binaries

- `.env`, keys, MediaPipe/FFmpeg vendored binaries under `apps/extension/public/`, and local Xcode derived data folders are gitignored. Do not force-add them.
