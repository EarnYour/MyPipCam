import { DRIVE_SCOPE, isOAuthClientConfigured } from './driveConfig'

export class DriveAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'DriveAuthError'
  }
}

function chromeLastError(): string | undefined {
  return chrome.runtime.lastError?.message
}

/** Interactive or silent OAuth token via chrome.identity. */
export async function getAccessToken(interactive = true): Promise<string> {
  if (!isOAuthClientConfigured()) {
    throw new DriveAuthError(
      'Google OAuth client ID is not configured. Paste your client ID into driveConfig.ts (see README).',
      'client_id_missing',
    )
  }

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chromeLastError()
      if (err) {
        reject(new DriveAuthError(err, interactive ? 'auth_failed' : 'not_signed_in'))
        return
      }
      if (!token || typeof token !== 'string') {
        reject(new DriveAuthError('No auth token returned.', 'no_token'))
        return
      }
      resolve(token)
    })
  })
}

/** Drop a cached token (e.g. after 401) so the next getAuthToken refreshes. */
export async function invalidateAccessToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve())
  })
}

/** Revoke + clear cached tokens (Disconnect). */
export async function clearDriveAuth(): Promise<void> {
  const token = await getAccessToken(false).catch(() => null)
  if (token) {
    try {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`)
    } catch {
      /* best-effort revoke */
    }
    await invalidateAccessToken(token)
  }

  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => resolve())
  })
}

/** True if a non-interactive token is available (user previously connected). */
export async function hasDriveAuth(): Promise<boolean> {
  if (!isOAuthClientConfigured()) return false
  try {
    await getAccessToken(false)
    return true
  } catch {
    return false
  }
}

export { DRIVE_SCOPE }
