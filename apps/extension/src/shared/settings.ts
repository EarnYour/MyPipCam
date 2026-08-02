import {
  DEFAULT_PIP_SETTINGS,
  type PipSettings,
} from './types'

const KEY = 'pipSettings'

export async function loadPipSettings(): Promise<PipSettings> {
  const result = await chrome.storage.sync.get(KEY)
  return { ...DEFAULT_PIP_SETTINGS, ...(result[KEY] as Partial<PipSettings> | undefined) }
}

export async function savePipSettings(patch: Partial<PipSettings>): Promise<PipSettings> {
  const current = await loadPipSettings()
  const next = { ...current, ...patch }
  await chrome.storage.sync.set({ [KEY]: next })
  return next
}

export async function listVideoInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'videoinput')
}
