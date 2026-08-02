/** Session storage key + helpers for the mic permission grant window. */

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
    const stored = await chrome.storage.session.get(MIC_GRANT_STORAGE_KEY)
    const value = stored[MIC_GRANT_STORAGE_KEY] as MicGrantResult | undefined
    if (!value || typeof value !== 'object' || typeof value.status !== 'string') return null
    return value
  } catch {
    return null
  }
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
  await chrome.storage.session.set({ [MIC_GRANT_STORAGE_KEY]: payload })
}
