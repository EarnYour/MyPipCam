/**
 * MyPipCam watch-page share links (view tracking).
 * Drive stores the file; this site counts opens of /w/{shareId}.
 *
 * Production host is fixed (not an env var). Do not use earnyour typos
 * like weareyour.com, or a bare mypipcam.com — watch pages live on
 * https://mypipcam.earnyour.com/w/{shareId}.
 */
export const SHARE_SITE_ORIGIN = 'https://mypipcam.earnyour.com'

export const SHARE_API_BASE = `${SHARE_SITE_ORIGIN}/api`

export function watchUrlForShareId(shareId: string): string {
  return `${SHARE_SITE_ORIGIN}/w/${shareId}`
}
