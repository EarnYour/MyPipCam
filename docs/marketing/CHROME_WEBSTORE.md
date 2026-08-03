# Chrome Web Store upload

## Package

Use **`MyPipCam-chrome-webstore.zip`** (built from `apps/extension/dist` with the manifest **`key` field removed**).

### Why strip `key`?

Chrome Web Store **rejects** first uploads that include a `"key"` field in `manifest.json` (`'key' field is not allowed in manifest.`).

Local / unpacked builds can keep `key` so Chrome assigns a **stable extension ID** (`akpchobfndfddajiihkkdpnihihdicjc`). The store package must not include it.

**Live Chrome Web Store item ID:** `meiehjfjcaahfjcdneoegjkmajbfghmm` (confirmed; differs from local unpacked ID).

| Build | Extension ID | When |
| --- | --- | --- |
| **Chrome Web Store** (published / zip without `key`) | `meiehjfjcaahfjcdneoegjkmajbfghmm` | Production users; set Google Cloud OAuth **Item ID** to this for the store build |
| **Unpacked local** (dist with manifest `key`) | `akpchobfndfddajiihkkdpnihihdicjc` | Dev; may use a separate OAuth client or the same client with this Item ID while testing unpacked |

macOS **Open in Chrome…** and `https://mypipcam.earnyour.com/open-library?ext=…` accept either ID via the `ext=` query param. `externally_connectable` matches the product site origin (not a specific extension ID).

## Google Cloud OAuth — Item ID for the store build

Connect Google / Drive fails until the Chrome-extension OAuth client’s **Item ID** matches the extension that is actually running.

**Click path (store build):**

1. Open [Google Cloud Console](https://console.cloud.google.com/) → select the MyPipCam project  
2. **APIs & Services** → **Credentials**  
3. Under **OAuth 2.0 Client IDs**, open the client whose type is **Chrome extension**  
   (or **Create credentials** → **OAuth client ID** → Application type **Chrome extension**)  
4. Set **Item ID** to exactly: `meiehjfjcaahfjcdneoegjkmajbfghmm`  
5. **Save**  
6. Put that client’s **Client ID** in `apps/extension/.env.local` as `VITE_GOOGLE_OAUTH_CLIENT_ID`, rebuild the store package, and retest **Connect Google** from the store-installed extension

Unpacked local may still use Item ID `akpchobfndfddajiihkkdpnihihdicjc` (key-derived). If you develop with unpacked and ship to the store, keep Item ID aligned with whichever build you are testing — or use two OAuth clients.

## After you upload

1. Live store extension ID: `meiehjfjcaahfjcdneoegjkmajbfghmm` (confirm on the Chrome Web Store Developer Dashboard item URL / ID).
2. Set Google Cloud **Item ID** as above.
3. Rebuild or redeploy anything that hardcodes only the unpacked ID if you intentionally target the store build (bridge `ext=` and macOS detection already know both).

## Rebuild the zip

```bash
cd apps/extension && npm run build
# copy dist → temp, remove "key" from manifest.json, zip with manifest at root
# → docs/marketing/MyPipCam-chrome-webstore.zip
```

Then in the dashboard: **re-Select file** and upload the new zip.
