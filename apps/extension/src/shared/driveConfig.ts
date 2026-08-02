/**
 * Google OAuth client ID for chrome.identity.
 *
 * Set via `VITE_GOOGLE_OAUTH_CLIENT_ID` in `apps/extension/.env.local` (gitignored).
 * See `.env.example`. Never commit a client_secret — Chrome-extension OAuth has none.
 *
 * Stable extension ID (when dist manifest includes `key`):
 *   akpchobfndfddajiihkkdpnihihdicjc
 * Use that as the Google Cloud OAuth client Item ID — not the product website.
 *
 * Consent screen URLs: https://mypipcam.earnyour.com (authorized domain: earnyour.com).
 */
const fromEnv =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env?.VITE_GOOGLE_OAUTH_CLIENT_ID === 'string'
    ? import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID.trim()
    : ''

export const GOOGLE_OAUTH_CLIENT_ID =
  fromEnv && !fromEnv.startsWith('YOUR_CLIENT_ID')
    ? fromEnv
    : 'YOUR_CLIENT_ID.apps.googleusercontent.com'

/**
 * Extension ID when `manifest.key` is present (packed / dist build).
 * Google Cloud → OAuth client (Chrome extension) → Item ID must equal this
 * (or whatever chrome://extensions shows if you loaded without `key`).
 */
export const STABLE_EXTENSION_ID = 'akpchobfndfddajiihkkdpnihihdicjc'

/** Preferred scope: only files/folders this app creates or the user opens with it. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** App library folder name created under the user’s My Drive. */
export const DRIVE_LIBRARY_FOLDER_NAME = 'MyPipCam'

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
