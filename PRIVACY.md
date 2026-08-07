# Privacy Policy

**Last updated:** August 2, 2026

This policy describes how **MyPipCam** (Chrome extension and macOS companion app) handles information. MyPipCam is created by [EarnYour Marketing](https://earnyour.com). The Chrome extension is available on the [Chrome Web Store](https://chromewebstore.google.com/detail/mypipcam/meiehjfjcaahfjcdneoegjkmajbfghmm); source is free and open source on GitHub.

**Product site:** [https://mypipcam.earnyour.com](https://mypipcam.earnyour.com) (public privacy page when mirrored: [https://mypipcam.earnyour.com/privacy](https://mypipcam.earnyour.com/privacy)). Source of truth for this policy remains this repository file until the live page is updated.

**Short version:** MyPipCam is local-first. Recordings and secrets stay on your device unless **you** connect optional cloud features (OpenAI, Google Drive, or MyPipCam share links). Share-link view counts are optional and only apply when you use Library → Share. We do **not** sell your recordings or personal data. Contact: [steven@earnyour.com](mailto:steven@earnyour.com).

## 1. Who this applies to

This policy covers the MyPipCam software you install from the Chrome Web Store or build from this repository. It does not cover third-party services you choose to use (OpenAI, Google, Apple, Chrome, etc.). Those have their own privacy policies.

## 2. Local-first by design

MyPipCam is designed so core recording works without an EarnYour Marketing account and without sending data to EarnYour Marketing.

### What typically stays on your device

| Data | Where it lives |
| --- | --- |
| Video / audio recordings | Browser IndexedDB and/or a library folder you choose on disk |
| Thumbnails, edit metadata, optional local transcripts | Same local library |
| OpenAI API key | `chrome.storage.local` in the extension (on-device; not synced) |
| Recorder preferences (devices, appearance, etc.) | Extension: `chrome.storage` · macOS: app preferences (UserDefaults) |
| Google Drive folder ID (after you connect) | `chrome.storage.sync` so your Chrome profile can reuse the same Drive folder |

EarnYour Marketing does **not** receive your recordings, API keys, or camera/mic streams through the MyPipCam code as published in this repository.

## 3. Permissions we ask for

### Chrome extension

- **Camera / microphone** — for PiP camera and recording audio when you start a capture
- **Tab or screen capture** — when you record a tab or use Advanced screen/window capture
- **Storage / file access** — to keep a local library and optionally write to a folder you pick

### macOS app

- **Camera** — to show the floating always-on-top camera bubble (webcam, Continuity Camera, OBS Virtual Camera, etc.)
- **Microphone** — so you can pick a preferred mic; the Mac bubble itself does **not** record audio files. Actual recording audio comes from OBS or the Chrome extension.

macOS may prompt once per signed app identity. Camera and mic access are controlled in **System Settings → Privacy & Security**.

## 4. Optional features that leave your device

Nothing below happens unless you turn it on and authenticate or paste credentials.

### OpenAI transcription

If you enter an OpenAI API key in extension Settings and run transcription, audio (or derived audio) is sent to OpenAI’s API using **your** key. Handling of that media is governed by OpenAI’s terms and privacy policy. The key is stored locally in `chrome.storage.local`.

### Google Drive

If you connect Google Drive, recordings you upload go to **your** Google account under an app-created `MyPipCam` folder (Drive `drive.file` scope). Folder IDs and related settings may sync via Chrome sync storage. Google’s policies apply to uploaded files and OAuth tokens.

### Browser and OS vendors

Chrome and Apple may process permission prompts, crash reports, or other system-level data according to their own products. That is outside MyPipCam’s control.

## 5. Analytics and telemetry

As of the last review of this repository’s published code:

- There is **no** marketing pixel or general product-usage telemetry for browsing the extension UI.
- Optional third-party APIs (OpenAI, Google) are used only for the features you invoke.
- **Share link views (optional):** When you use **Share** in the Library, MyPipCam registers a watch-page link on `mypipcam.earnyour.com`. Opening that page records a view event (count + timestamp). Viewers do not need an account. We may store a short hash of the viewer’s User-Agent (not the raw string, and not IP addresses in this MVP). No visitor names or emails are collected.

## 6. macOS camera bubble behavior

The macOS companion is a real always-on-top window that shows your selected camera feed. It is meant to appear in desktop recordings (for example OBS screen capture). It does not upload that feed to EarnYour Marketing. What appears on your screen can be captured by any screen recorder you run—just like any other window.

## 7. Sharing and “anyone with the link”

**Share** in the Library (1) enables Google Drive “anyone with the link can view” so the video can play, and (2) copies a **MyPipCam watch URL** (`https://mypipcam.earnyour.com/w/…`) that embeds the Drive preview and counts opens. Google’s access model still governs who can stream the file; revoke access in Google Drive / Google Account settings. View counts are stored by the MyPipCam share API (see §5).

## 8. Limited use (Chrome Web Store)

User data handled by MyPipCam (including recordings, optional auth tokens, optional API keys, and optional share view metadata) is used only to provide the product’s single purpose: recording, local library/editing, and optional Drive upload / transcription / share links that you choose. We do not sell or transfer user data to third parties for advertising, and we do not use it to determine creditworthiness or for lending. Optional third parties you connect (Google, OpenAI) process data under their own policies for the feature you invoked.

## 9. Children

MyPipCam is not directed at children. Do not use it to collect personal information from children in violation of applicable law.

## 10. Changes

Privacy practices may change as the project evolves. Updates will be reflected in this file in the repository. Material changes to data leaving the device should be called out clearly.

## 11. Contact

Privacy and support: [steven@earnyour.com](mailto:steven@earnyour.com), [mypipcam.earnyour.com](https://mypipcam.earnyour.com), [earnyour.com](https://earnyour.com), or open a [GitHub issue](https://github.com/EarnYour/MyPipCam/issues). In the Chrome extension: Library → Settings → **Report a bug** (prefilled version / install info; no API keys or Drive tokens).

Security vulnerabilities: see [SECURITY.md](SECURITY.md) (prefer GitHub Security Advisories).
