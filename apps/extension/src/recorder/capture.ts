import {
  captureQualitySize,
  cursorCaptureConstraint,
  normalizeCaptureQuality,
  type BubbleShape,
  type PipSettings,
} from '../shared/types'
import { SQUARE_CORNER_FRACTION } from '../shared/types'
import {
  createPersonBackgroundBlur,
  isBlurEffect,
  type PersonBackgroundBlur,
} from '../shared/backgroundBlur'
import { cameraFilterCss } from '../shared/cameraFilters'

export type CaptureBundle = {
  displayStream: MediaStream
  cameraStream: MediaStream | null
  canvas: HTMLCanvasElement
  canvasStream: MediaStream
  width: number
  height: number
}

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}

export function preferredMimeType(): string {
  return pickMimeType()
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
) {
  const vw = video.videoWidth || w
  const vh = video.videoHeight || h
  const scale = Math.max(w / vw, h / vh)
  const dw = vw * scale
  const dh = vh * scale
  const dx = (w - dw) / 2
  const dy = (h - dh) / 2
  ctx.drawImage(video, dx, dy, dw, dh)
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawBubbleCover(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  cx: number,
  cy: number,
  radius: number,
  mirror: boolean,
  borderColor: string,
  shadow: boolean,
  shape: BubbleShape = 'circle',
  filterCss = 'none',
) {
  if (!sourceW) return

  const size = radius * 2
  const left = cx - radius
  const top = cy - radius
  const cornerR = shape === 'square' ? size * SQUARE_CORNER_FRACTION : radius

  ctx.save()
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = Math.max(8, radius * 0.18)
    ctx.shadowOffsetY = Math.max(4, radius * 0.08)
  }

  if (shape === 'square') {
    roundedRectPath(ctx, left, top, size, size, cornerR)
  } else {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.closePath()
  }
  ctx.clip()

  const scale = Math.max(size / sourceW, size / sourceH)
  const dw = sourceW * scale
  const dh = sourceH * scale
  const dx = cx - dw / 2
  const dy = cy - dh / 2

  if (mirror) {
    ctx.translate(cx, cy)
    ctx.scale(-1, 1)
    ctx.translate(-cx, -cy)
  }
  if (filterCss && filterCss !== 'none') {
    ctx.filter = filterCss
  }
  ctx.drawImage(source, dx, dy, dw, dh)
  ctx.filter = 'none'
  ctx.restore()

  if (borderColor !== 'transparent') {
    ctx.save()
    if (shape === 'square') {
      roundedRectPath(ctx, left, top, size, size, cornerR)
    } else {
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    }
    ctx.strokeStyle = borderColor
    ctx.lineWidth = Math.max(3, radius * 0.06)
    ctx.stroke()
    ctx.restore()
  }
}

export async function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return
  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Video failed to load'))
    }
    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('error', onError)
  })
}

export function createHiddenVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement('video')
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  void video.play().catch(() => undefined)
  return video
}

export async function startCapture(settings: PipSettings): Promise<{
  bundle: CaptureBundle
  displayVideo: HTMLVideoElement
  cameraVideo: HTMLVideoElement | null
  stopDraw: () => void
  getBubbleRect: () => { x: number; y: number; size: number }
  setBubbleNorm: (x: number, y: number) => void
  setBubbleSize: (size: number) => void
  updateSettings: (next: PipSettings) => void
  setDrawCamera: (on: boolean) => void
  displaySurface: string | undefined
}> {
  const cursor = cursorCaptureConstraint(settings.captureCursor !== false)
  const quality = normalizeCaptureQuality(settings.captureQuality)
  const { width: idealW, height: idealH } = captureQualitySize(quality)
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30 },
      width: { ideal: idealW },
      height: { ideal: idealH },
      // Screen Capture: cursor + resolution apply to tab/screen, not camera PiP.
      cursor,
    } as MediaTrackConstraints,
    audio: true,
  })
  // Best-effort if the picker ignored constraints (some surfaces/browsers).
  const displayVideoTrack = displayStream.getVideoTracks()[0]
  if (displayVideoTrack) {
    try {
      await displayVideoTrack.applyConstraints({
        width: { ideal: idealW },
        height: { ideal: idealH },
        frameRate: { ideal: 30 },
        cursor,
      } as MediaTrackConstraints)
    } catch {
      try {
        await displayVideoTrack.applyConstraints({
          width: { ideal: idealW },
          height: { ideal: idealH },
          frameRate: { ideal: 30 },
        })
      } catch {
        /* unsupported on this surface */
      }
      try {
        await displayVideoTrack.applyConstraints({ cursor } as MediaTrackConstraints)
      } catch {
        /* unsupported on this surface */
      }
    }
  }

  let cameraStream: MediaStream | null = null
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: settings.cameraDeviceId
          ? { exact: settings.cameraDeviceId }
          : undefined,
        width: { ideal: 640 },
        height: { ideal: 640 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
  } catch {
    cameraStream = null
  }

  const displayVideo = createHiddenVideo(displayStream)
  await waitForVideo(displayVideo)

  let cameraVideo: HTMLVideoElement | null = null
  if (cameraStream) {
    cameraVideo = createHiddenVideo(cameraStream)
    await waitForVideo(cameraVideo).catch(() => {
      cameraVideo = null
    })
  }

  const width = displayVideo.videoWidth || 1280
  const height = displayVideo.videoHeight || 720
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')

  let liveSettings = { ...settings }
  let bubbleX = settings.bubbleX
  let bubbleY = settings.bubbleY
  let raf = 0
  let running = true
  let drawCamera = true
  let blurEngine: PersonBackgroundBlur | null = null
  let blurInit: Promise<void> | null = null

  const clampSize = (size: number) => Math.min(0.35, Math.max(0.1, size))

  const ensureBlur = () => {
    if (!isBlurEffect(liveSettings.backgroundEffect) || blurEngine || blurInit) return
    blurInit = createPersonBackgroundBlur()
      .then((engine) => {
        blurEngine = engine
      })
      .catch((err) => {
        console.warn('[MyPipCam] background blur unavailable', err)
        liveSettings = { ...liveSettings, backgroundEffect: 'none' }
      })
      .finally(() => {
        blurInit = null
      })
  }

  ensureBlur()

  const draw = () => {
    if (!running) return
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    drawCover(ctx, displayVideo, width, height)

    if (cameraVideo && drawCamera) {
      const radius = (Math.min(width, height) * liveSettings.bubbleSize) / 2
      const cx = bubbleX * width
      const cy = bubbleY * height
      let source: CanvasImageSource = cameraVideo
      let sourceW = cameraVideo.videoWidth
      let sourceH = cameraVideo.videoHeight

      if (isBlurEffect(liveSettings.backgroundEffect)) {
        ensureBlur()
        const blurred = blurEngine?.process(cameraVideo)
        if (blurred && blurred.width > 0) {
          source = blurred
          sourceW = blurred.width
          sourceH = blurred.height
        }
      }

      drawBubbleCover(
        ctx,
        source,
        sourceW,
        sourceH,
        cx,
        cy,
        radius,
        liveSettings.mirror,
        liveSettings.borderColor,
        liveSettings.shadow,
        liveSettings.bubbleShape === 'square' ? 'square' : 'circle',
        cameraFilterCss(liveSettings.cameraFilter),
      )
    }
    raf = requestAnimationFrame(draw)
  }
  draw()

  const canvasStream = canvas.captureStream(30)
  const displayAudio = displayStream?.getAudioTracks?.() ?? []
  for (const track of displayAudio) {
    canvasStream.addTrack(track)
  }

  const displayTrack = displayStream?.getVideoTracks?.()?.[0]
  const displaySurface = displayTrack?.getSettings?.().displaySurface as string | undefined

  // Class used by recorder CSS for contain-fit in the live stage
  canvas.className = 'recorder-canvas'

  return {
    bundle: { displayStream, cameraStream, canvas, canvasStream, width, height },
    displayVideo,
    cameraVideo,
    stopDraw: () => {
      running = false
      cancelAnimationFrame(raf)
      blurEngine?.close()
      blurEngine = null
    },
    getBubbleRect: () => ({
      x: bubbleX,
      y: bubbleY,
      size: liveSettings.bubbleSize,
    }),
    setBubbleNorm: (x, y) => {
      bubbleX = Math.min(0.95, Math.max(0.05, x))
      bubbleY = Math.min(0.95, Math.max(0.05, y))
    },
    setBubbleSize: (size) => {
      liveSettings = { ...liveSettings, bubbleSize: clampSize(size) }
    },
    updateSettings: (next) => {
      liveSettings = {
        ...next,
        bubbleSize: clampSize(next.bubbleSize),
      }
      if (isBlurEffect(liveSettings.backgroundEffect)) ensureBlur()
    },
    setDrawCamera: (on: boolean) => {
      drawCamera = on
    },
    displaySurface,
  }
}

export function stopStreams(bundle: CaptureBundle | null) {
  if (!bundle) return
  for (const track of bundle.displayStream.getTracks()) track.stop()
  if (bundle.cameraStream) {
    for (const track of bundle.cameraStream.getTracks()) track.stop()
  }
  for (const track of bundle.canvasStream.getTracks()) track.stop()
}

export function createRecorder(stream: MediaStream): {
  recorder: MediaRecorder
  mimeType: string
  chunks: Blob[]
} {
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  return { recorder, mimeType: mimeType || recorder.mimeType || 'video/webm', chunks }
}

export async function captureThumbnail(
  canvas: HTMLCanvasElement,
): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.72)
  })
}
