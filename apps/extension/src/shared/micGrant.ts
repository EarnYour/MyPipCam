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

export async function readMicGrantResult(): Promise<MicGrantResult | null> {
  try {
    const session = await chrome.storage.session.get(MIC_GRANT_STORAGE_KEY)
    const fromSession = session[MIC_GRANT_STORAGE_KEY] as MicGrantResult | undefined
    if (fromSession && typeof fromSession === 'object' && typeof fromSession.status === 'string') {
      return fromSession
    }
  } catch {
    /* ignore */
  }
  try {
    const local = await chrome.storage.local.get(MIC_GRANT_STORAGE_KEY)
    const fromLocal = local[MIC_GRANT_STORAGE_KEY] as MicGrantResult | undefined
    if (fromLocal && typeof fromLocal === 'object' && typeof fromLocal.status === 'string') {
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
