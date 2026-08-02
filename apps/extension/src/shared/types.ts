export type TranscriptSegment = {
  start: number
  end: number
  text: string
}

export type TranscriptData = {
  text: string
  segments: TranscriptSegment[]
  language?: string
  createdAt: number
  provider: 'openai'
}

export type RecordingMeta = {
  id: string
  title: string
  createdAt: number
  durationMs: number
  mimeType: string
  sizeBytes: number
  thumbnail?: Blob
  transcript?: TranscriptData
  /** Google Drive file id when uploaded to the shared library folder. */
  driveFileId?: string
  driveWebViewLink?: string
  driveShared?: boolean
  /** Present only when the item exists on Drive but not locally (other device). */
  driveOnly?: boolean
}

export type RecordingRecord = RecordingMeta & {
  blob: Blob
}

/** API keys stored only in chrome.storage.local (on-device). Never sync. */
export type ApiSettings = {
  openaiApiKey: string
}

export const DEFAULT_API_SETTINGS: ApiSettings = {
  openaiApiKey: '',
}

/** Primary popup capture modes (MV3 tab / camera). */
export type RecordMode = 'screen-cam' | 'screen' | 'cam'

export type BubbleShape = 'circle' | 'square'

/** Loom-style camera background effect (person segmentation). */
export type BackgroundEffect = 'none' | 'blur'

export type PipSettings = {
  cameraDeviceId: string | null
  micDeviceId: string | null
  recordMode: RecordMode
  bubbleX: number
  bubbleY: number
  bubbleSize: number
  bubbleShape: BubbleShape
  borderColor: string
  shadow: boolean
  mirror: boolean
  /** Person-sharp background blur (MediaPipe selfie segmenter). */
  backgroundEffect: BackgroundEffect
  openLibraryOnFinish: boolean
}

export const DEFAULT_PIP_SETTINGS: PipSettings = {
  cameraDeviceId: null,
  micDeviceId: null,
  recordMode: 'screen-cam',
  bubbleX: 0.82,
  bubbleY: 0.78,
  bubbleSize: 0.18,
  bubbleShape: 'circle',
  borderColor: '#ffffff',
  shadow: true,
  mirror: true,
  backgroundEffect: 'none',
  openLibraryOnFinish: true,
}

/** Corner radius as a fraction of bubble side length (square shape). */
export const SQUARE_CORNER_FRACTION = 0.16

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
