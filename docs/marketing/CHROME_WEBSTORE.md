# Chrome Web Store upload

## Package

Use **`MyPipCam-chrome-webstore.zip`** (built from `apps/extension/dist` with the manifest **`key` field removed**).

### Why strip `key`?

Chrome Web Store **rejects** first uploads that include a `"key"` field in `manifest.json` (`'key' field is not allowed in manifest.`).

Local / unpacked builds **keep** `key` so Chrome assigns a **stable extension ID** (`akpchobfndfddajiihkkdpnihihdicjc`). The store package must not include it.

**Live Chrome Web Store item ID:** `moalajbpehfocfeecpleceplighfhim` (Published — public; confirmed from Developer Dashboard).

**Public listing URLs:**
- `https://chromewebstore.google.com/detail/moalajbpehfocfeecpleceplighfhim`
- `https://chrome.google.com/webstore/detail/mypipcam/moalajbpehfocfeecpleceplighfhim`

| Build | Extension ID | When |
| --- | --- | --- |
| **Chrome Web Store** (published / zip without `key`) | `moalajbpehfocfeecpleceplighfhim` | Production users → OAuth **Client A** Item ID |
| **Unpacked local** (dist with manifest `key`) | `akpchobfndfddajiihkkdpnihihdicjc` | Dev → OAuth **Client B** Item ID |

If `dist/manifest.json` has **no** `key` and you load unpacked, Chrome invents a **third** random ID (e.g. something like `jakcphobnlddjaalpcpdhfelcpcdfoib`). That ID is useless for OAuth — reload **`apps/extension/dist`** after a normal `npm run build` so `key` is present and the ID stays `akpchobfndfddajiihkkdpnihihdicjc`.

macOS **Open in Chrome…** and `https://mypipcam.earnyour.com/open-library?ext=…` accept either ID via the `ext=` query param. `externally_connectable` matches the product site origin (not a specific extension ID).

---

## Google Cloud OAuth — two Chrome-extension clients (recommended)

Do **not** flip a single client’s Item ID between store and local. Create **two** OAuth clients of type **Chrome extension** in the same Google Cloud project. One `VITE_GOOGLE_OAUTH_CLIENT_ID` is baked per build; local `.env.local` points at the local client; the store zip is built with the store client.

| Client | Name (suggested) | Item ID | Used by |
| --- | --- | --- | --- |
| **A — store / production** | `MyPipCam Store` | `moalajbpehfocfeecpleceplighfhim` | Store zip / published listing |
| **B — local / unpacked** | `MyPipCam Local` | `akpchobfndfddajiihkkdpnihihdicjc` | `apps/extension/.env.local` + local `dist` |

### Create Client B (local) — do this for Drive today

1. [Google Cloud Console](https://console.cloud.google.com/) → MyPipCam project  
2. **APIs & Services** → **Credentials**  
3. **Create credentials** → **OAuth client ID**  
4. Application type: **Chrome extension**  
5. Name: e.g. `MyPipCam Local`  
6. **Item ID** = exactly `akpchobfndfddajiihkkdpnihihdicjc` → **Create**  
7. Copy that client’s **Client ID** (ends with `.apps.googleusercontent.com`)  
8. Put it only in gitignored local env:

```bash
# apps/extension/.env.local
VITE_GOOGLE_OAUTH_CLIENT_ID=<Client B client ID>
```

9. Rebuild and reload:

```bash
cd apps/extension && npm run build
```

Then on `chrome://extensions`: confirm ID is `akpchobfndfddajiihkkdpnihihdicjc` → **Reload** → Library → Settings → **Connect Google**.

Leave **Client A** (store Item ID `moalajbpehfocfeecpleceplighfhim`) alone — store prep stays ready.

### Create / keep Client A (store) — leave ready; do not put in `.env.local` while developing

1. Same **Credentials** page → open (or create) a **Chrome extension** client for production  
2. **Item ID** = exactly `moalajbpehfocfeecpleceplighfhim` → **Save**  
3. Note that client’s **Client ID** somewhere private (password manager / release notes) — **not** committed  
4. When packaging the store zip, temporarily set:

```bash
# only for the store package build — do not leave this as your daily .env.local
VITE_GOOGLE_OAUTH_CLIENT_ID=<Client A client ID>
```

Then `npm run build`, copy `dist` → temp, **remove** `"key"` from `manifest.json`, zip with manifest at root → upload. After that, put Client B back in `.env.local` for local work.

Alternatively: keep Client A’s ID only in CI / a release script env; daily `.env.local` always stays Client B.

### Temporary single-client workaround (not preferred)

If you only have one Chrome-extension client today: set its **Item ID** back to `akpchobfndfddajiihkkdpnihihdicjc`, rebuild/reload local — Drive works locally. Before store users need Connect Google, switch that Item ID (or better: create Client A) to `moalajbpehfocfeecpleceplighfhim` and rebuild the store zip with that client’s ID. Dual clients avoid this flip-flop.

---

## After publish (live)

1. Live store extension ID: `moalajbpehfocfeecpleceplighfhim` (Developer Dashboard header / item ID).  
2. Public URL: `https://chromewebstore.google.com/detail/moalajbpehfocfeecpleceplighfhim`  
3. Ensure **Client A** Item ID is that store ID and the published package was built with Client A’s client ID.  
4. Keep local `.env.local` on **Client B** so unpacked Connect Google keeps working.

## Rebuild the zip

```bash
cd apps/extension && npm run build
# ensure VITE_GOOGLE_OAUTH_CLIENT_ID = Client A for this package only
# copy dist → temp, remove "key" from manifest.json, zip with manifest at root
# → docs/marketing/MyPipCam-chrome-webstore.zip
```

Then in the dashboard: **re-Select file** and upload the new zip.
