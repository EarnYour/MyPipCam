# Chrome Web Store — Privacy practices (copy-paste)

Use this on the item’s **Privacy** tab (and related **Store listing** / **Settings** fields).  
Answers match the shipped extension (`apps/extension/manifest.config.ts` + store zip): MyPipCam records the current tab with optional camera PiP, keeps a local library/editor, and optionally uses Google Drive, OpenAI Whisper (user’s key), and share watch links.

**Privacy policy URL (required):**

```
https://mypipcam.earnyour.com/privacy
```

**Support URL (Store listing — required):**

```
https://mypipcam.earnyour.com
```

**Contact email for support / privacy:** `steven@earnyour.com`

**In-product bug reports:** Library → Settings → **Report a bug** (GitHub issue preferred, email optional; prefilled version / install channel — no secrets).

---

## Paste these now

Chrome’s **Unable to publish** modal asks for a justification for **exactly** these permissions on the **Privacy practices** tab. Paste one block per field, then **Save draft**. Also: check the **Developer Program Policies** certification on Privacy, and set + **verify** publisher contact email on **Settings**.

### activeTab

```
Used when the user starts a recording from the toolbar popup or keyboard shortcut so MyPipCam can work with the tab they are viewing (capture coordination and temporary overlay). Access is tied to that user gesture; we do not use activeTab to scrape sites or collect browsing history.
```

### alarms

```
Used only to keep the Manifest V3 service worker briefly active during recording/upload workflows and to periodically flush optional pending Google Drive auto-uploads. Not used to schedule ads, track browsing, or run unrelated background jobs.
```

### identity

```
Used solely for optional “Connect Google” via chrome.identity.getAuthToken so the user can upload recordings to their own Google Drive (drive.file scope). Core record, library, and editor work without signing in. Not used for advertising or cross-site tracking.
```

### notifications

```
Shows a local Chrome notification if recording fails to start so the user sees the error after the popup closes. Not used for marketing, promotional, or unrelated push messages.
```

### offscreen

```
Creates an MV3 offscreen document (USER_MEDIA) to hold MediaStreams and run MediaRecorder for tab + optional camera capture while the service worker may sleep. Used only during an active user-started recording session.
```

### scripting

```
Injects the recording overlay (countdown, camera PiP chrome, pause/stop controls) into the http(s) tab the user chose to record. Runs only in support of a user-started recording; not used to scrape forms, rewrite pages, or modify unrelated browsing.
```

### storage

```
Saves recorder preferences, library/folder metadata, in-progress session state, optional OpenAI API key (device-local only), and Drive folder settings via chrome.storage. Needed for a reliable local library without uploading by default. Not used for ad profiling.
```

### tabCapture

```
Required for chrome.tabCapture.getMediaStreamId so MyPipCam can record the active tab’s video/audio (Loom-style tab recording). Capture starts only after the user starts recording from the popup, HUD, or keyboard shortcut.
```

### tabs

```
Identifies and focuses the tab being recorded, opens Library/editor/HUD pages, and coordinates start/stop messaging with the correct tab (including the mypipcam.earnyour.com open-library bridge). We do not collect or sell browsing history.
```

### unlimitedStorage

```
Raises the extension storage quota so longer/higher-quality recordings and library metadata can stay in IndexedDB / chrome.storage on the user’s device without the default quota cutting clips short. Data stays local unless the user uses optional Drive or share features.
```

**After pasting:** Privacy tab → check all Limited Use / “I do not sell…” boxes **and** the Developer Program Policies certification → Save draft. Settings → contact email `steven@earnyour.com` → verify via Google’s email link.

---

## 1. Single purpose description

Paste exactly:

```
MyPipCam records the current Chrome tab with an optional live camera picture-in-picture, saves clips to a local library with a built-in editor, and optionally uploads to the user’s Google Drive or creates share watch links.
```

---

## 2. Permission justifications (extra fields Chrome may also show)

Paste each block into the matching field if listed. The ten permissions from “Unable to publish” are in **Paste these now** above.

### identity.email

```
MyPipCam does not call chrome.identity.getProfileUserInfo and does not need the user’s email for core features. Optional Google Drive connect uses chrome.identity OAuth for Drive access only; any account email shown in Google’s sign-in UI is handled by Google, not collected into EarnYour Marketing servers.
```

### displayCapture

```
Used for optional Advanced screen/window/tab capture via getDisplayMedia when the user chooses that mode instead of (or in addition to) standard tabCapture. The browser’s picker appears; capture runs only for the surface the user selects and only after they start recording.
```

### audioCapture

```
Used to include tab audio and/or the user’s microphone in a recording when those options are enabled. Microphone access is requested through getUserMedia only when the user starts a recording that needs mic audio; denying permission disables mic capture without breaking tab-only recording.
```

### camera

```
Used for the live camera picture-in-picture bubble and to composite webcam video into Tab+Cam recordings. Requested via getUserMedia only when the user starts a camera-enabled recording or opens the camera PiP; denying camera simply disables that feature.
```

### microphone

```
Used to capture the user’s microphone into the recording when mic is enabled. Requested only when the user starts a recording that needs microphone audio. Not used for background listening or unrelated browsing.
```

### cookies

```
MyPipCam does not use the chrome.cookies API and does not read or write website cookies for analytics or advertising. Host permissions exist only to inject the recording overlay (countdown, PiP chrome, stop controls) into the tab being recorded. Optional Google sign-in uses chrome.identity/OAuth, not cookie scraping of third-party sites.
```

### website content

```
When the user records a tab (or Advanced display surface), the visible page content is captured into the recording they create. We also inject a temporary recording overlay into that page so countdown, camera PiP frame, and stop controls work. Content is stored locally in the user’s library by default; it leaves the device only if the user uploads to their Google Drive, sends audio to OpenAI Whisper with their own key, or creates a share watch link.
```

### personal results *(a.k.a. personal communications / personalized results)*

```
MyPipCam does not build ad profiles or return search-style “personal results.” Recordings the user creates may contain whatever appears on their screen or is said on mic (including personal content). Those clips stay on-device unless the user optionally uploads to their Drive, transcribes with their OpenAI key, or shares a watch link. EarnYour Marketing does not sell this content.
```

### Host permission http://*/* and https://*/* *(if listed)*

```
Needed so the recording overlay can run on whatever http(s) tab the user is recording. activeTab alone is not reliable across countdown and restart. We do not use broad host access for ads, scraping, or silent data collection.
```

---

## 3. Remote code

**Select:** `No, I am not using remote code.`

If a text justification is still required:

```
MyPipCam does not download or execute remote JavaScript. All extension logic ships in the package. FFmpeg.wasm and MediaPipe assets load from bundled extension files via chrome.runtime.getURL under a CSP of script-src 'self' 'wasm-unsafe-eval'. Optional HTTPS calls to OpenAI, Google Drive, and the MyPipCam share API exchange media/metadata only and do not execute returned code.
```

---

## 4. Data usage disclosure (checkboxes)

Check types that apply (disclose even for local-only handling):

| Type | Check? | Why |
| --- | --- | --- |
| Personally identifiable information | **Yes** (optional) | Google account used only if user connects Drive (OAuth handled by Google/`chrome.identity`) |
| Health information | No | |
| Financial and payment information | No | |
| Authentication information | **Yes** (optional) | Drive OAuth tokens via `chrome.identity`; optional OpenAI API key in `chrome.storage.local` |
| Personal communications | **Yes** (possible) | User recordings may contain whatever is on screen / mic; stored locally unless user exports/shares |
| Location | No | |
| Web history | No | We do not build a history product; we capture the active recording surface only when the user records |
| User activity | Optional / Yes if forced | Recording start/stop and library actions for the product feature only — not analytics for ads |
| Website content | **Yes** | Tab/screen capture includes visible page pixels/audio in the user’s recording |

Then **certify** all compliance statements Chrome shows (wording varies slightly by dashboard version). Typical certification checkboxes — you must check them all:

```
☐ I do not sell or transfer user data to third parties, outside of the approved use cases
☐ I do not use or transfer user data for purposes that are unrelated to my item’s single purpose
☐ I do not use or transfer user data to determine creditworthiness or for lending purposes
```

Also complete any “Limited Use” / User Data Policy certification checkbox on the same Privacy tab.

**Certification reminder (Developer Program Policies):** On publish / Privacy tab, check the box that certifies the item complies with the [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/) and User Data Policy (including Limited Use). Do not publish until that certification is checked.

---

## 5. Privacy policy field

```
https://mypipcam.earnyour.com/privacy
```

---

## 6. Settings page — manual clicks (you must do these)

Chrome cannot finish these from the repo. In [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole):

### A. Publisher contact email

1. Open the left nav → **Settings** (account/publisher settings, not only the item).
2. Find **Contact email** / publisher email.
3. Set **`steven@earnyour.com`** (or confirm it is already set).
4. Open the verification email from Google and click **Verify**.
5. Return to the dashboard and confirm the email shows as verified.

### B. Identity verification

1. Still under **Settings**, find **Identity verification** / **Verify your identity**.
2. Click **Start** / **Begin verification** (wording varies).
3. Complete Google’s government ID / business verification flow in the browser (manual; keep documents ready).
4. Wait until status is **Verified** (can take time after submission).
5. Retry **Publish** only after verification is accepted (or at least after you have started it if the modal only required beginning the process — the error text was “must start the process”).

### C. Item-level Privacy + Listing fields (after Settings)

1. Item → **Privacy** → paste single purpose + every permission justification from this file.
2. Remote code → **No**.
3. Data usage checkboxes + certification checkboxes.
4. Privacy policy URL → `https://mypipcam.earnyour.com/privacy`
5. Item → **Store listing** → Support URL → `https://mypipcam.earnyour.com`
6. Save draft → **Publish** / **Submit for review**.

---

## 7. What leaves the device (for reviewers / honesty)

| Feature | Leaves device? | Where |
| --- | --- | --- |
| Default record + local library | No | IndexedDB / chosen folder |
| Connect Google + upload | Yes (user choice) | User’s Google Drive |
| OpenAI Whisper transcription | Yes (user choice + user’s API key) | `api.openai.com` |
| Share watch link + view counts | Yes (user choice) | `mypipcam.earnyour.com` share API / Supabase (view count + UA hash; no sale of video content) |

EarnYour Marketing does **not** sell user recordings or use them for ads.

---

## 8. Manifest permissions (source of truth)

From `apps/extension/manifest.config.ts`:

`storage`, `unlimitedStorage`, `tabs`, `scripting`, `activeTab`, `tabCapture`, `offscreen`, `identity`, `alarms`, `notifications`

Plus `host_permissions`: `http://*/*`, `https://*/*`  
Plus `oauth2` → Google Drive `drive.file`  
Camera / mic / display / audio capture are requested at runtime via `getUserMedia` / `getDisplayMedia` / tabCapture streams when the user records.
