# Chrome Web Store upload

## Package

Use **`MyPipCam-chrome-webstore.zip`** (built from `apps/extension/dist` with the manifest **`key` field removed**).

### Why strip `key`?

Chrome Web Store **rejects** first uploads that include a `"key"` field in `manifest.json` (`'key' field is not allowed in manifest.`).

Local / unpacked builds can keep `key` so Chrome assigns a **stable extension ID** (`akpchobfndfddajiihkkdpnihihdicjc`). The store package must not include it.

**Live Chrome Web Store item ID:** `meiehjfjcaahfjcdneoegjkmajbfghmm` (assigned after upload; differs from local unpacked ID).

## After you upload

1. The store assigns a **new extension ID** (different from the local unpacked ID). Live: `meiehjfjcaahfjcdneoegjkmajbfghmm`.
2. Copy that ID from the Chrome Web Store Developer Dashboard.
3. Update Google Cloud OAuth for Drive:
   - Chrome extension client → **Item ID** = `meiehjfjcaahfjcdneoegjkmajbfghmm`
   - Any redirect / extension-ID references used for Connect Google
4. Rebuild or redeploy anything that hardcodes the old ID only if you intentionally target the store build.

## Rebuild the zip

```bash
cd apps/extension && npm run build
# copy dist → temp, remove "key" from manifest.json, zip with manifest at root
# → docs/marketing/MyPipCam-chrome-webstore.zip
```

Then in the dashboard: **re-Select file** and upload the new zip.
