import {
  DEFAULT_PIP_SETTINGS,
  type PipSettings,
} from './types'
import { sanitizeCssColor } from './security'

const KEY = 'pipSettings'

export async function loadPipSettings(): Promise<PipSettings> {
  const result = await chrome.storage.sync.get(KEY)
  const raw = { ...DEFAULT_PIP_SETTINGS, ...(result[KEY] as Partial<PipSettings> | undefined) }
  return {
    ...raw,
    borderColor: sanitizeCssColor(raw.borderColor, DEFAULT_PIP_SETTINGS.borderColor),
  }
}

export async function savePipSettings(patch: Partial<PipSettings>): Promise<PipSettings> {
  const current = await loadPipSettings()
  const next = { ...current, ...patch }
  if (patch.borderColor !== undefined) {
    next.borderColor = sanitizeCssColor(patch.borderColor, current.borderColor)
  }
  await chrome.storage.sync.set({ [KEY]: next })
  return next
}

/**
 * Briefly request media access so enumerateDevices() returns real labels/ids.
 * Stops all tracks immediately. Returns false if the user denied or devices are unavailable.
 */
export async function unlockMediaDeviceLabels(
  kind: 'audio' | 'video' | 'both' = 'audio',
): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: kind === 'audio' || kind === 'both',
      video: kind === 'video' || kind === 'both',
    })
    for (const t of stream.getTracks()) t.stop()
    return true
  } catch {
    return false
  }
}

async function enumerateSelectable(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  const ofKind = devices.filter((d) => d.kind === kind && Boolean(d.deviceId))
  const physical = ofKind.filter(
    (d) => d.deviceId !== 'default' && d.deviceId !== 'communications',
  )
  // Prefer real devices; if Chrome only exposes the virtual default, keep it so the picker isn't empty.
  return physical.length > 0
    ? physical
    : ofKind.filter((d) => d.deviceId !== 'communications')
}

function needsLabelUnlock(devices: MediaDeviceInfo[]): boolean {
  return devices.length === 0 || devices.some((d) => !d.label)
}

export async function listVideoInputs(options?: {
  unlock?: boolean
}): Promise<MediaDeviceInfo[]> {
  const unlock = options?.unlock !== false
  let list = await enumerateSelectable('videoinput')
  if (unlock && needsLabelUnlock(list)) {
    await unlockMediaDeviceLabels('video')
    list = await enumerateSelectable('videoinput')
  }
  return list
}

/**
 * List physical microphones. When unlock is true (default), briefly calls getUserMedia
 * if labels/ids are missing, then re-enumerates. Prefer calling again when the mic
 * dropdown opens so a later permission grant refreshes the list.
 */
export async function listAudioInputs(options?: {
  unlock?: boolean
}): Promise<MediaDeviceInfo[]> {
  const unlock = options?.unlock !== false
  let list = await enumerateSelectable('audioinput')
  if (unlock && needsLabelUnlock(list)) {
    await unlockMediaDeviceLabels('audio')
    list = await enumerateSelectable('audioinput')
  }
  return list
}

export type MicOption = { deviceId: string; label: string }

export function toMicOptions(devices: MediaDeviceInfo[]): MicOption[] {
  return devices.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label?.trim() || `Microphone ${i + 1}`,
  }))
}
