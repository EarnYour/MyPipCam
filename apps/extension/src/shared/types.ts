export type TranscriptSegment = {
  start: number
  end: number
  text: string
}

/** Word-level timing from Whisper (needed for filler-word cuts). */
export type TranscriptWord = {
  word: string
  start: number
  end: number
}

export type TranscriptData = {
  text: string
  segments: TranscriptSegment[]
  /** Present when transcribed with word timestamps; required for filler removal. */
  words?: TranscriptWord[]
  language?: string
  createdAt: number
  provider: 'openai'
}

/** Virtual library organization folder (metadata only — not an on-disk directory). */
export type LibraryFolder = {
  id: string
  name: string
  createdAt: number
  /** Stable sidebar order (lower first). */
  sortOrder?: number
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
  /**
   * Virtual library folder id (`folders.json` / chrome.storage).
   * `null` / omitted = Unfiled.
   */
  folderId?: string | null
  /** Google Drive file id when uploaded to the shared library folder. */
  driveFileId?: string
  driveWebViewLink?: string
  driveShared?: boolean
  /**
   * Drive video playback readiness (binary — API has no percent).
   * Inferred from videoMediaMetadata / thumbnail after upload.
   */
  driveProcessingStatus?: 'processing' | 'ready' | 'unknown'
  /** Epoch ms when Drive readiness proxies first looked ready. */
  driveReadyAt?: number
  /** MyPipCam watch-page share id (`mypipcam.earnyour.com/w/{shareId}`). */
  shareId?: string
  /** Cached view count from the share API (refreshed on Library load). */
  shareViewCount?: number
  /** ISO timestamp of last watch-page open. */
  shareLastViewedAt?: string | null
  /** ISO timestamp when the public watch link expires (default 30 days). */
  shareExpiresAt?: string | null
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

/** Color filter on the camera PiP (see shared/cameraFilters.ts). */
export type CameraFilterId =
  | 'none'
  | 'bw'
  | 'sepia'
  | 'warm'
  | 'cool'
  | 'contrast'
  | 'soft'

export type PipSettings = {
  cameraDeviceId: string | null
  micDeviceId: string | null
  recordMode: RecordMode
  bubbleX: number
  bubbleY: number
  bubbleSize: number
  bubbleShape: BubbleShape
  borderColor: string
  /**
   * Camera bubble border thickness in CSS pixels (0 = no border).
   * Applied on the live overlay / advanced preview; advanced compositor scales with bubble radius.
   */
  borderWidth: number
  shadow: boolean
  mirror: boolean
  /** Person-sharp background blur (MediaPipe selfie segmenter). */
  backgroundEffect: BackgroundEffect
  /** Color filter on the camera bubble (persisted in chrome.storage.local). */
  cameraFilter: CameraFilterId
  openLibraryOnFinish: boolean
  /**
   * Include the mouse cursor in tab/screen capture (getDisplayMedia / tabCapture).
   * Does not affect the camera PiP bubble. Default true matches prior behavior.
   */
  captureCursor: boolean
  /**
   * Target resolution for tab/screen capture (not the camera PiP).
   * Chrome may deliver a lower size if the surface cannot meet the request.
   */
  captureQuality: CaptureQuality
}

/** Cursor constraint for display/tab capture (`always` | `never`). */
export type CursorCaptureConstraint = 'always' | 'never'

export function cursorCaptureConstraint(captureCursor: boolean): CursorCaptureConstraint {
  return captureCursor ? 'always' : 'never'
}

export type CaptureQuality = '720p' | '1080p' | '1440p' | '4k'

export const CAPTURE_QUALITY_OPTIONS: readonly {
  id: CaptureQuality
  label: string
  width: number
  height: number
}[] = [
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: '1440p', label: '1440p', width: 2560, height: 1440 },
  { id: '4k', label: '4K', width: 3840, height: 2160 },
] as const

export function isCaptureQuality(value: unknown): value is CaptureQuality {
  return value === '720p' || value === '1080p' || value === '1440p' || value === '4k'
}

export function normalizeCaptureQuality(value: unknown): CaptureQuality {
  return isCaptureQuality(value) ? value : '1080p'
}

export function captureQualitySize(quality: CaptureQuality): { width: number; height: number } {
  const preset = CAPTURE_QUALITY_OPTIONS.find((o) => o.id === quality)
  return preset
    ? { width: preset.width, height: preset.height }
    : { width: 1920, height: 1080 }
}

/**
 * Target MediaRecorder video bitrate by capture quality.
 * Screen capture needs more bits than typical webcam encodes at the same resolution.
 */
export const CAPTURE_QUALITY_VIDEO_BITRATE: Record<CaptureQuality, number> = {
  '720p': 3_500_000,
  '1080p': 10_000_000,
  '1440p': 16_000_000,
  '4k': 28_000_000,
}

export const CAPTURE_AUDIO_BITRATE = 128_000

export function captureQualityVideoBitrate(quality: CaptureQuality): number {
  return CAPTURE_QUALITY_VIDEO_BITRATE[quality] ?? CAPTURE_QUALITY_VIDEO_BITRATE['1080p']
}

/** Border thickness presets (CSS px) shown in Effects / overlay / advanced recorder. */
export const BORDER_WIDTH_OPTIONS = [
  { id: 0, label: 'None' },
  { id: 2, label: 'Thin' },
  { id: 3, label: 'Default' },
  { id: 5, label: 'Medium' },
  { id: 8, label: 'Thick' },
] as const

export const BORDER_WIDTH_MIN = 0
export const BORDER_WIDTH_MAX = 16

/** Clamp / coerce stored border thickness (CSS px). Missing → default 3. */
export function normalizeBorderWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 3
  return Math.min(BORDER_WIDTH_MAX, Math.max(BORDER_WIDTH_MIN, Math.round(value)))
}

/**
 * Canvas stroke width for advanced compositor — scales with bubble radius so
 * CSS px on a typical on-screen bubble (~180px) roughly matches the recording.
 */
export function canvasBorderLineWidth(borderWidth: number, radius: number): number {
  const w = normalizeBorderWidth(borderWidth)
  if (w <= 0) return 0
  return w * Math.max(1, radius * 0.02)
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
  borderWidth: 3,
  shadow: true,
  mirror: true,
  backgroundEffect: 'none',
  cameraFilter: 'none',
  openLibraryOnFinish: true,
  captureCursor: true,
  captureQuality: '1080p',
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
