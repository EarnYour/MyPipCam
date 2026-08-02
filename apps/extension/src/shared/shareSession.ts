import type { RecordMode } from './types'

/** Pending Loom start handed from popup → share interstitial. */
export const SHARE_SESSION_KEY = 'loomShareSession'
export const SHARE_PAGE = 'src/share/index.html'

export type ShareSession = {
  returnTabId: number
  returnTabTitle: string
  recordMode: RecordMode
  micDeviceId: string | null
  cameraDeviceId: string | null
  includeMic: boolean
  at: number
}

export async function writeShareSession(session: ShareSession): Promise<void> {
  try {
    await chrome.storage.session.set({ [SHARE_SESSION_KEY]: session })
  } catch {
    await chrome.storage.local.set({ [SHARE_SESSION_KEY]: session })
  }
}

export async function readShareSession(): Promise<ShareSession | null> {
  try {
    const session = await chrome.storage.session.get(SHARE_SESSION_KEY)
    const fromSession = session[SHARE_SESSION_KEY] as ShareSession | undefined
    if (fromSession && typeof fromSession.returnTabId === 'number') return fromSession
  } catch {
    /* ignore */
  }
  try {
    const local = await chrome.storage.local.get(SHARE_SESSION_KEY)
    const fromLocal = local[SHARE_SESSION_KEY] as ShareSession | undefined
    if (fromLocal && typeof fromLocal.returnTabId === 'number') return fromLocal
  } catch {
    /* ignore */
  }
  return null
}

export async function clearShareSession(): Promise<void> {
  try {
    await chrome.storage.session.remove(SHARE_SESSION_KEY)
  } catch {
    /* ignore */
  }
  try {
    await chrome.storage.local.remove(SHARE_SESSION_KEY)
  } catch {
    /* ignore */
  }
}

export async function openShareGuidanceTab(): Promise<chrome.tabs.Tab> {
  const url = chrome.runtime.getURL(SHARE_PAGE)
  return chrome.tabs.create({ url, active: true })
}
