import {
  DRIVE_SCOPE,
  STABLE_EXTENSION_ID,
  currentExtensionId,
  isOAuthClientConfigured,
} from './driveConfig'

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
    `Confirm chrome://extensions shows ID ${currentExtensionId()} (expected ${STABLE_EXTENSION_ID} with manifest key).`
  )
}

function itemIdHint(): string {
  const live = currentExtensionId()
  return (
    `Google Cloud → APIs & Services → Credentials → your Chrome-extension OAuth client → ` +
    `Item ID must be exactly "${live}"` +
    (live === STABLE_EXTENSION_ID
      ? ''
      : ` (packed builds use ${STABLE_EXTENSION_ID}; reload from dist so manifest key is present)`) +
    `. Not the website hostname.`
  )
}

/**
 * Turn chrome.identity / OAuth lastError text into an actionable Settings message.
 * Always keeps the raw Chrome error so debugging is possible.
 */
export function explainDriveAuthError(raw: string, code?: string): string {
  const msg = (raw || '').trim() || 'Unknown Google auth error'
  // Already enriched (e.g. DriveAuthError message passed through SW → UI).
  if (/Item ID must be exactly/i.test(msg) || /Click Connect Google again/i.test(msg)) {
    return msg
  }
  const lower = msg.toLowerCase()

  const looksLikeBadClient =
    /bad client|invalid.?oauth|client.?id|authorization page could not be loaded|oauth2 request failed|invalid_client|unauthorized_client|redirect_uri|origin/i.test(
      lower,
    )

  if (looksLikeBadClient || code === 'bad_client') {
    return `${msg} — ${itemIdHint()}`
  }

  if (/user gesture|interaction required|must be called/i.test(lower)) {
    return (
      `${msg} — Click Connect Google again (interactive sign-in must start from that click). ` +
      `If it keeps failing, reload the extension on chrome://extensions.`
    )
  }

  if (/did not approve|access denied|user.?denied|canceled|cancelled/i.test(lower)) {
    return `${msg} — Sign-in was cancelled or denied. Click Connect Google to try again.`
  }

  if (/not granted or revoked|invalid.?grant/i.test(lower)) {
    return (
      `${msg} — Disconnect (or clear site data for accounts.google.com), then Connect Google again. ` +
      itemIdHint()
    )
  }

  if (/timeout|timed out/i.test(lower)) {
    return `${msg} — Google sign-in took too long. Try Connect Google again.`
  }

  return msg
}

/**
 * Interactive or silent OAuth token via chrome.identity (prefer service worker).
 * Call this as early as possible after a user gesture for interactive:true.
 */
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
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const err = chromeLastError()
        if (err) {
          const code = /bad client|invalid.?oauth|authorization page/i.test(err)
            ? 'bad_client'
            : interactive
              ? 'auth_failed'
              : 'not_signed_in'
          reject(new DriveAuthError(explainDriveAuthError(err, code), code))
          return
        }
        if (!token || typeof token !== 'string') {
          reject(
            new DriveAuthError(
              explainDriveAuthError(
                interactive
                  ? 'No auth token returned (sign-in may have been cancelled or blocked).'
                  : 'Not signed in to Google Drive.',
                'no_token',
              ),
              'no_token',
            ),
          )
          return
        }
        resolve(token)
      })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      reject(new DriveAuthError(explainDriveAuthError(raw, 'auth_failed'), 'auth_failed'))
    }
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

/** Interactive Connect / consent can take well over 30s; SW + client must wait. */
export const INTERACTIVE_CONNECT_TIMEOUT_MS = 120_000

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

/** Reject if `promise` does not settle within `ms` (always unblocks sendResponse). */
export function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new DriveAuthError(
          explainDriveAuthError(timeoutMessage, 'timeout'),
          'timeout',
        ),
      )
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
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

/**
 * Message the SW. Silent probes stay short; interactive OAuth must wait for the
 * consent UI (often 60s+). Pass timeoutMs 0 to wait until Chrome closes the port.
 */
export async function sendDriveAuthMessage<T>(
  payload: object,
  timeoutMs: number,
): Promise<T> {
  const send = chrome.runtime.sendMessage(payload) as Promise<T | undefined>
  let res: T | undefined
  if (timeoutMs > 0) {
    try {
      res = await raceTimeout(
        send,
        timeoutMs,
        'Google sign-in timed out waiting for the background service worker. Complete the consent window sooner, or reload the extension on chrome://extensions and try again.',
      )
    } catch (err) {
      // Distinguish our race timeout from Chrome lastError / sendMessage failures.
      if (err instanceof DriveAuthError && err.code === 'timeout') throw err
      const raw = err instanceof Error ? err.message : String(err)
      throw new DriveAuthError(
        explainDriveAuthError(
          raw ||
            'No response from background. Reload the extension on chrome://extensions.',
          'no_background',
        ),
        'no_background',
      )
    }
  } else {
    res = await send
  }
  if (res == null) {
    throw new DriveAuthError(
      explainDriveAuthError(
        'No response from background. Reload the extension on chrome://extensions.',
        'no_background',
      ),
      'no_background',
    )
  }
  return res
}

/** Open a named port so the MV3 service worker stays awake during OAuth. */
export function openDriveConnectKeepAlive(): chrome.runtime.Port | null {
  try {
    return chrome.runtime.connect({ name: 'drive-connect' })
  } catch {
    return null
  }
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

  // Interactive: no short timeout (user may be in the Google consent window).
  const res = await sendDriveAuthMessage<DriveTokenResponse>(
    {
      type: 'GET_DRIVE_TOKEN',
      interactive: Boolean(interactive),
    },
    interactive ? 0 : 2000,
  )
  if (!res.ok) {
    throw new DriveAuthError(
      explainDriveAuthError(res.error || 'Auth failed', res.code),
      res.code,
    )
  }
  return res.token
}

/** Drop a cached token (e.g. after 401) so the next getAuthToken refreshes. */
export async function invalidateAccessToken(token: string): Promise<void> {
  if (identityApiAvailable()) {
    await invalidateAccessTokenDirect(token)
    return
  }
  await sendDriveAuthMessage<DriveOk | DriveErr>(
    {
      type: 'INVALIDATE_DRIVE_TOKEN',
      token,
    },
    2000,
  )
}

/** Revoke + clear cached tokens (Disconnect). */
export async function clearDriveAuth(): Promise<void> {
  if (identityApiAvailable()) {
    await clearDriveAuthDirect()
    return
  }
  const res = await sendDriveAuthMessage<DriveOk | DriveErr>(
    { type: 'CLEAR_DRIVE_AUTH' },
    5000,
  )
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
  const res = await sendDriveAuthMessage<DriveBoolOk | DriveErr>(
    { type: 'HAS_DRIVE_AUTH' },
    2000,
  )
  if (!res.ok) return false
  return res.value
}

export { DRIVE_SCOPE }
