/**
 * Google OAuth client ID for chrome.identity.
 *
 * Client IDs are public in extensions; there is no client secret for the
 * Chrome-extension OAuth flow — never paste one here.
 *
 * Stable extension ID (when dist manifest includes `key`):
 *   akpchobfndfddajiihkkdpnihihdicjc
 * Use that as the Google Cloud OAuth client Item ID — not the product website.
 *
 * If chrome://extensions shows a different ID (e.g. okpchcbnnbdssajmkophnfnklgjcsncl),
 * you loaded unpacked without the manifest `key`. Either:
 *   - Reload from a build whose dist/manifest.json includes `key`, OR
 *   - Set the OAuth client Item ID to the ID currently shown on chrome://extensions.
 *
 * Consent screen (not the client Application ID): home/privacy/terms at
 * https://mypipcam.earnyour.com (authorized domain: earnyour.com).
 */
export const GOOGLE_OAUTH_CLIENT_ID =
  'YOUR_CLIENT_ID.apps.googleusercontent.com'

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
