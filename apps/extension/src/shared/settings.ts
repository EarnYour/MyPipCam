import {
  isCameraFilterId,
  normalizeCameraFilter,
  saveCameraFilter,
} from './cameraFilters'
import {
  DEFAULT_PIP_SETTINGS,
  normalizeBorderWidth,
  normalizeCaptureQuality,
  type BubbleShape,
  type PipSettings,
} from './types'
import { sanitizeCssColor } from './security'

const KEY = 'pipSettings'

function clampNorm(n: unknown, min: number, max: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeBubbleShape(value: unknown): BubbleShape {
  return value === 'square' ? 'square' : 'circle'
}

function normalizeLoaded(raw: PipSettings): PipSettings {
  return {
    ...raw,
    cameraDeviceId:
      raw.cameraDeviceId === null || typeof raw.cameraDeviceId === 'string'
        ? raw.cameraDeviceId
        : null,
    micDeviceId:
      raw.micDeviceId === null || typeof raw.micDeviceId === 'string' ? raw.micDeviceId : null,
    recordMode:
      raw.recordMode === 'screen' || raw.recordMode === 'cam' || raw.recordMode === 'screen-cam'
        ? raw.recordMode
        : DEFAULT_PIP_SETTINGS.recordMode,
    bubbleX: clampNorm(raw.bubbleX, 0.05, 0.95, DEFAULT_PIP_SETTINGS.bubbleX),
    bubbleY: clampNorm(raw.bubbleY, 0.05, 0.95, DEFAULT_PIP_SETTINGS.bubbleY),
    bubbleSize: clampNorm(raw.bubbleSize, 0.1, 0.35, DEFAULT_PIP_SETTINGS.bubbleSize),
    bubbleShape: normalizeBubbleShape(raw.bubbleShape),
    borderColor: sanitizeCssColor(raw.borderColor, DEFAULT_PIP_SETTINGS.borderColor),
    borderWidth: normalizeBorderWidth(raw.borderWidth),
    shadow: raw.shadow !== false,
    mirror: raw.mirror !== false,
    backgroundEffect: raw.backgroundEffect === 'blur' ? 'blur' : 'none',
    openLibraryOnFinish: raw.openLibraryOnFinish !== false,
    // Older sync blobs omit the key — keep historical default (cursor on).
    captureCursor: raw.captureCursor !== false,
    captureQuality: normalizeCaptureQuality(raw.captureQuality),
  }
}

function asPartialSettings(value: unknown): Partial<PipSettings> | undefined {
  if (!value || typeof value !== 'object') return undefined
  return value as Partial<PipSettings>
}

/**
 * Load PiP / capture settings.
 * Prefer chrome.storage.sync (cross-device), fall back to local so a sync wipe
 * or offline profile still restores the last appearance after reboot.
 */
export async function loadPipSettings(): Promise<PipSettings> {
  const [syncResult, localResult, localFilter] = await Promise.all([
    chrome.storage.sync.get(KEY),
    chrome.storage.local.get(KEY),
    chrome.storage.local.get('cameraFilter'),
  ])
  const syncPartial = asPartialSettings(syncResult[KEY])
  const localPartial = asPartialSettings(localResult[KEY])
  // Sync wins when present; otherwise use the on-device mirror.
  const stored = syncPartial ?? localPartial
  const raw = { ...DEFAULT_PIP_SETTINGS, ...stored }
  // Filter source of truth is chrome.storage.local (falls back to sync/local blob / default).
  const cameraFilter = isCameraFilterId(localFilter.cameraFilter)
    ? localFilter.cameraFilter
    : normalizeCameraFilter(raw.cameraFilter)

  // Heal: if sync is empty but local has settings, re-upload so sync catches up.
  if (!syncPartial && localPartial) {
    void chrome.storage.sync.set({ [KEY]: { ...raw, cameraFilter } }).catch(() => undefined)
  }

  return normalizeLoaded({ ...raw, cameraFilter })
}

export async function savePipSettings(patch: Partial<PipSettings>): Promise<PipSettings> {
  const current = await loadPipSettings()
  // Drop undefined keys so callers like LOOM_BUBBLE_MOVED cannot wipe size/x/y.
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<PipSettings>
  const next = { ...current, ...clean }
  if (clean.borderColor !== undefined) {
    next.borderColor = sanitizeCssColor(clean.borderColor, current.borderColor)
  }
  if (clean.borderWidth !== undefined) {
    next.borderWidth = normalizeBorderWidth(clean.borderWidth)
  }
  if (clean.bubbleShape !== undefined) {
    next.bubbleShape = normalizeBubbleShape(clean.bubbleShape)
  }
  if (clean.bubbleX !== undefined) {
    next.bubbleX = clampNorm(clean.bubbleX, 0.05, 0.95, current.bubbleX)
  }
  if (clean.bubbleY !== undefined) {
    next.bubbleY = clampNorm(clean.bubbleY, 0.05, 0.95, current.bubbleY)
  }
  if (clean.bubbleSize !== undefined) {
    next.bubbleSize = clampNorm(clean.bubbleSize, 0.1, 0.35, current.bubbleSize)
  }
  if (clean.backgroundEffect !== undefined) {
    next.backgroundEffect = clean.backgroundEffect === 'blur' ? 'blur' : 'none'
  }
  if (clean.shadow !== undefined) {
    next.shadow = clean.shadow !== false
  }
  if (clean.mirror !== undefined) {
    next.mirror = clean.mirror !== false
  }
  if (clean.openLibraryOnFinish !== undefined) {
    next.openLibraryOnFinish = clean.openLibraryOnFinish !== false
  }
  if (clean.cameraFilter !== undefined) {
    next.cameraFilter = await saveCameraFilter(clean.cameraFilter)
  }
  if (clean.captureQuality !== undefined) {
    next.captureQuality = normalizeCaptureQuality(clean.captureQuality)
  }
  if (clean.captureCursor !== undefined) {
    next.captureCursor = clean.captureCursor !== false
  }
  // Dual-write: sync for profile roaming + local so reboot always has a copy.
  await Promise.all([
    chrome.storage.sync.set({ [KEY]: next }),
    chrome.storage.local.set({ [KEY]: next }),
  ])
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
