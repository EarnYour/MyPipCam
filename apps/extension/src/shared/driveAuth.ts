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

type DriveTokenOk = { ok: true; token: string }
type DriveTokenErr = { ok: false; error: string; code?: string }
type DriveTokenResponse = DriveTokenOk | DriveTokenErr

type DriveBoolOk = { ok: true; value: boolean }
type DriveOk = { ok: true }
type DriveErr = { ok: false; error: string; code?: string }

function chromeLastError(): string | undefined {
  return chrome.runtime.lastError?.message
}

/** chrome.identity is reliable in the MV3 service worker; not always on extension pages. */
function identityApiAvailable(): boolean {
  return typeof chrome.identity?.getAuthToken === 'function'
}

function missingIdentityMessage(): string {
  return (
    'chrome.identity is unavailable. Reload MyPipCam from apps/extension/dist ' +
    '(manifest must include the "identity" permission and oauth2). ' +
    'Confirm chrome://extensions shows the expected extension ID.'
  )
}

/** Interactive or silent OAuth token via chrome.identity (service worker only). */
export async function getAccessTokenDirect(interactive = true): Promise<string> {
  if (!isOAuthClientConfigured()) {
    throw new DriveAuthError(
      'Google OAuth client ID is not configured. Paste your client ID into driveConfig.ts (see README).',
      'client_id_missing',
    )
  }
  if (!identityApiAvailable()) {
    throw new DriveAuthError(missingIdentityMessage(), 'identity_unavailable')
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

export async function invalidateAccessTokenDirect(token: string): Promise<void> {
  if (!identityApiAvailable()) return
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve())
  })
}

export async function clearDriveAuthDirect(): Promise<void> {
  if (!identityApiAvailable()) {
    throw new DriveAuthError(missingIdentityMessage(), 'identity_unavailable')
  }
  const token = await getAccessTokenDirect(false).catch(() => null)
  if (token) {
    try {
      await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`)
    } catch {
      /* best-effort revoke */
    }
    await invalidateAccessTokenDirect(token)
  }

  return new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => resolve())
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, ms)
    promise
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

export async function hasDriveAuthDirect(): Promise<boolean> {
  if (!isOAuthClientConfigured() || !identityApiAvailable()) return false
  // getAuthToken(interactive:false) can hang in some Chrome/identity states.
  return withTimeout(
    getAccessTokenDirect(false)
      .then(() => true)
      .catch(() => false),
    1200,
    false,
  )
}

async function sendDriveAuthMessage<T>(payload: object): Promise<T> {
  const res = (await withTimeout(
    chrome.runtime.sendMessage(payload) as Promise<T | undefined>,
    2000,
    undefined,
  )) as T | undefined
  if (res == null) {
    throw new DriveAuthError(
      'No response from background. Reload the extension on chrome://extensions.',
      'no_background',
    )
  }
  return res
}

/**
 * Interactive or silent OAuth token.
 * Uses chrome.identity in the service worker; extension pages message the SW
 * (`GET_DRIVE_TOKEN`) so Connect works even when chrome.identity is undefined on the page.
 */
export async function getAccessToken(interactive = true): Promise<string> {
  if (!isOAuthClientConfigured()) {
    throw new DriveAuthError(
      'Google OAuth client ID is not configured. Paste your client ID into driveConfig.ts (see README).',
      'client_id_missing',
    )
  }

  if (identityApiAvailable()) {
    return getAccessTokenDirect(interactive)
  }

  const res = await sendDriveAuthMessage<DriveTokenResponse>({
    type: 'GET_DRIVE_TOKEN',
    interactive: Boolean(interactive),
  })
  if (!res.ok) {
    throw new DriveAuthError(res.error || 'Auth failed', res.code)
  }
  return res.token
}

/** Drop a cached token (e.g. after 401) so the next getAuthToken refreshes. */
export async function invalidateAccessToken(token: string): Promise<void> {
  if (identityApiAvailable()) {
    await invalidateAccessTokenDirect(token)
    return
  }
  await sendDriveAuthMessage<DriveOk | DriveErr>({
    type: 'INVALIDATE_DRIVE_TOKEN',
    token,
  })
}

/** Revoke + clear cached tokens (Disconnect). */
export async function clearDriveAuth(): Promise<void> {
  if (identityApiAvailable()) {
    await clearDriveAuthDirect()
    return
  }
  const res = await sendDriveAuthMessage<DriveOk | DriveErr>({
    type: 'CLEAR_DRIVE_AUTH',
  })
  if (!res.ok) {
    throw new DriveAuthError(res.error || 'Could not disconnect', res.code)
  }
}

/** True if a non-interactive token is available (user previously connected). */
export async function hasDriveAuth(): Promise<boolean> {
  if (!isOAuthClientConfigured()) return false
  if (identityApiAvailable()) {
    return hasDriveAuthDirect()
  }
  const res = await sendDriveAuthMessage<DriveBoolOk | DriveErr>({
    type: 'HAS_DRIVE_AUTH',
  })
  if (!res.ok) return false
  return res.value
}

export { DRIVE_SCOPE }
