/**
 * Google OAuth client ID for chrome.identity.
 *
 * Set via `VITE_GOOGLE_OAUTH_CLIENT_ID` in `apps/extension/.env.local` (gitignored).
 * See `.env.example`. Never commit a client_secret — Chrome-extension OAuth has none.
 *
 * Prefer two Google Cloud Chrome-extension clients (do not flip one Item ID):
 *   Client A (store zip): Item ID meiehjfjcaahfjcdneoegjkmajbfghmm
 *   Client B (local .env.local): Item ID akpchobfndfddajiihkkdpnihihdicjc
 * One env var per build is enough — point local env at Client B; bake Client A
 * only when packaging the store zip. See docs/marketing/CHROME_WEBSTORE.md.
 *
 * Consent screen URLs: https://mypipcam.earnyour.com (authorized domain: earnyour.com).
 */
function readOAuthClientId(): string {
  const fromImportMeta =
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env?.VITE_GOOGLE_OAUTH_CLIENT_ID === 'string'
      ? import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID.trim()
      : ''
  if (fromImportMeta) return fromImportMeta

  // Config-time: vite.config loadEnv → process.env before manifest.config imports this.
  // import.meta.env is only injected into Vite-transformed modules, not Node config imports.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process
  const fromProcess = proc?.env?.VITE_GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''
  return fromProcess
}

const fromEnv = readOAuthClientId()

export const GOOGLE_OAUTH_CLIENT_ID =
  fromEnv && !fromEnv.startsWith('YOUR_CLIENT_ID')
    ? fromEnv
    : 'YOUR_CLIENT_ID.apps.googleusercontent.com'

/**
 * Extension ID when `manifest.key` is present (unpacked / local dist).
 * Store listing ID is separate — see CHROME_WEB_STORE_EXTENSION_ID.
 */
export const STABLE_EXTENSION_ID = 'akpchobfndfddajiihkkdpnihihdicjc'

/** Live Chrome Web Store item ID (zip without `key`). OAuth Item ID for store builds. */
export const CHROME_WEB_STORE_EXTENSION_ID = 'meiehjfjcaahfjcdneoegjkmajbfghmm'

/** Preferred scope: only files/folders this app creates or the user opens with it. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** App library folder name created under the user’s My Drive. */
export const DRIVE_LIBRARY_FOLDER_NAME = 'MyPipCam'

/** How this build was installed — store vs local dist vs other unpacked. */
export type ExtensionInstallChannel = 'store' | 'unpacked-stable' | 'dev-other'

export function isOAuthClientConfigured(): boolean {
  return (
    Boolean(GOOGLE_OAUTH_CLIENT_ID) &&
    !GOOGLE_OAUTH_CLIENT_ID.startsWith('YOUR_CLIENT_ID')
  )
}

/** Live extension ID (chrome.runtime.id), falling back to the stable packed ID. */
export function currentExtensionId(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      return chrome.runtime.id
    }
  } catch {
    /* ignore */
  }
  return STABLE_EXTENSION_ID
}

function hasChromeWebStoreUpdateUrl(): boolean {
  try {
    const manifest = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
      update_url?: string
    }
    const url = manifest.update_url ?? ''
    return /clients2\.google\.com/i.test(url)
  } catch {
    return false
  }
}

/**
 * Classify this install. Store users must never be treated as “wrong ID”
 * just because they are not the local unpacked ID.
 */
export function extensionInstallChannel(id?: string): ExtensionInstallChannel {
  const live = (id || currentExtensionId()).trim()
  if (live === CHROME_WEB_STORE_EXTENSION_ID || hasChromeWebStoreUpdateUrl()) {
    return 'store'
  }
  if (live === STABLE_EXTENSION_ID) return 'unpacked-stable'
  return 'dev-other'
}

/** Store listing or stable unpacked+key — both are expected production/dev IDs. */
export function isKnownExtensionId(id?: string): boolean {
  const channel = extensionInstallChannel(id)
  return channel === 'store' || channel === 'unpacked-stable'
}

/** Preferred ID label for the current channel (for Advanced health UI). */
export function expectedExtensionId(id?: string): string {
  return extensionInstallChannel(id) === 'store'
    ? CHROME_WEB_STORE_EXTENSION_ID
    : STABLE_EXTENSION_ID
}
