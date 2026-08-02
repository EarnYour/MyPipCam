export type RecordingMeta = {
  id: string
  title: string
  createdAt: number
  durationMs: number
  mimeType: string
  sizeBytes: number
  thumbnail?: Blob
}

export type RecordingRecord = RecordingMeta & {
  blob: Blob
}

export type PipSettings = {
  cameraDeviceId: string | null
  bubbleX: number
  bubbleY: number
  bubbleSize: number
  borderColor: string
  shadow: boolean
  mirror: boolean
  openLibraryOnFinish: boolean
}

export const DEFAULT_PIP_SETTINGS: PipSettings = {
  cameraDeviceId: null,
  bubbleX: 0.82,
  bubbleY: 0.78,
  bubbleSize: 0.18,
  borderColor: '#ffffff',
  shadow: true,
  mirror: true,
  openLibraryOnFinish: true,
}

export const BORDER_PRESETS = [
  '#ffffff',
  '#000000',
  '#ff3b30',
  '#34c759',
  '#007aff',
  '#af52de',
  'transparent',
] as const

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function defaultTitle(createdAt = Date.now()): string {
  const d = new Date(createdAt)
  return `Recording ${d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} ${d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })}`
}
