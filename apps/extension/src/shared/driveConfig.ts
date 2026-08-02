/**
 * Google OAuth client ID for chrome.identity (Chrome extension type).
 *
 * PLACEHOLDER ONLY — never commit a real client ID tied to production quotas
 * unless you intentionally publish it (client IDs are public in extensions,
 * but each distributor should create their own). There is no client secret
 * for the Chrome-extension OAuth flow; do not invent or paste one here.
 *
 * Replace the placeholder before Connect Google will work. See root README
 * “Google Drive setup” for Google Cloud Console steps.
 *
 * Extension ID (stable via manifest `key`): akpchobfndfddajiihkkdpnihihdicjc
 * — use that as the OAuth client Item ID, not the product website.
 *
 * Consent screen (not the client Application ID): home/privacy/terms at
 * https://mypipcam.earnyour.com (authorized domain: earnyour.com).
 */
export const GOOGLE_OAUTH_CLIENT_ID =
  'YOUR_CLIENT_ID.apps.googleusercontent.com'

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
