/** Storage helpers for the mic permission grant page. */

export const MIC_GRANT_STORAGE_KEY = 'micGrantResult'

export type MicGrantStatus = 'pending' | 'granted' | 'denied' | 'error'

export type MicGrantDevice = { deviceId: string; label: string }

export type MicGrantResult = {
  status: MicGrantStatus
  reason?: string
  at: number
  devices?: MicGrantDevice[]
}

export const MIC_GRANT_PAGE = 'src/permissions/mic.html'

/**
 * The grant page writes its result moments before the popup reads it. Anything
 * older is stale: the user may since have changed mic permission in Chrome's
 * site settings, and a live permissions probe must win over an old snapshot.
 */
const MIC_GRANT_TTL_MS = 10 * 60 * 1000

function isFreshGrantResult(value: unknown): value is MicGrantResult {
  if (!value || typeof value !== 'object') return false
  const result = value as MicGrantResult
  if (typeof result.status !== 'string') return false
  return typeof result.at === 'number' && Date.now() - result.at < MIC_GRANT_TTL_MS
}

export async function readMicGrantResult(): Promise<MicGrantResult | null> {
  try {
    const session = await chrome.storage.session.get(MIC_GRANT_STORAGE_KEY)
    const fromSession = session[MIC_GRANT_STORAGE_KEY]
    if (isFreshGrantResult(fromSession)) {
      return fromSession
    }
  } catch {
    /* ignore */
  }
  try {
    const local = await chrome.storage.local.get(MIC_GRANT_STORAGE_KEY)
    const fromLocal = local[MIC_GRANT_STORAGE_KEY]
    if (isFreshGrantResult(fromLocal)) {
      return fromLocal
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function writeMicGrantResult(
  status: MicGrantStatus,
  options?: { reason?: string; devices?: MicGrantDevice[] },
): Promise<void> {
  const payload: MicGrantResult = {
    status,
    at: Date.now(),
    ...(options?.reason ? { reason: options.reason } : {}),
    ...(options?.devices ? { devices: options.devices } : {}),
  }
  await Promise.all([
    chrome.storage.session.set({ [MIC_GRANT_STORAGE_KEY]: payload }),
    chrome.storage.local.set({ [MIC_GRANT_STORAGE_KEY]: payload }),
  ])
}
