/**
 * Hidden offscreen compositor: MediaRecorder for Chrome tab / camera capture.
 * Camera PiP lives in the content-script overlay on the captured tab for
 * screen+cam (recorded 1:1). Cam-only records from getUserMedia here.
 *
 * Flow:
 * 1. OFFSCREEN_PREPARE — consume tabCapture streamId immediately (expires in
 *    seconds; must happen in the Start user-gesture chain), hold MediaStreams.
 * 2. OFFSCREEN_COMMIT — start MediaRecorder after the on-page 3→2→1 countdown.
 * 3. OFFSCREEN_RESET — discard the current take but keep streams for restart.
 */

import {
  cameraFilterCss,
  normalizeCameraFilter,
  type CameraFilterId,
} from '../shared/cameraFilters'
import { saveRecording } from '../shared/db'
import { preferredMimeType } from '../recorder/capture'

type RecordMode = 'screen-cam' | 'screen' | 'cam'

type PrepareMessage = {
  type: 'OFFSCREEN_PREPARE' | 'OFFSCREEN_START'
  streamId?: string
  includeMic?: boolean
  micDeviceId?: string | null
  cameraDeviceId?: string | null
  recordMode?: RecordMode
  cameraFilter?: CameraFilterId | string | null
  /** When true (legacy OFFSCREEN_START), start MediaRecorder immediately. */
  commit?: boolean
}

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let mimeType = 'video/webm'
let startedAt = 0
let tabStream: MediaStream | null = null
let camStream: MediaStream | null = null
let micStream: MediaStream | null = null
let mixedStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let prepared = false
let paused = false
/** Canvas filter loop for cam-only when a color filter is active. */
let filterLoopRaf = 0
let filterVideo: HTMLVideoElement | null = null
let filterCanvas: HTMLCanvasElement | null = null

function errDetail(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  try {
    const s = JSON.stringify(err)
    if (s && s !== '{}' && s !== 'null') return s
  } catch {
    /* ignore */
  }
  return fallback
}

function pickMimeType(): string {
  return preferredMimeType()
}

async function acquireTabStream(streamId: string): Promise<MediaStream> {
  const videoConstraints = {
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: streamId,
      maxFrameRate: 30,
    },
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: videoConstraints,
    } as unknown as MediaStreamConstraints)
  } catch (withAudio) {
    // Some tabs / Chrome builds reject tab audio — fall back to video-only.
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: videoConstraints,
      } as unknown as MediaStreamConstraints)
    } catch (videoOnly) {
      throw new Error(
        errDetail(
          videoOnly,
          errDetail(withAudio, 'Tab capture getUserMedia failed'),
        ),
      )
    }
  }
}

async function acquireCamera(deviceId: string | null): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
  } catch (first) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      })
    } catch {
      throw first instanceof Error ? first : new Error(errDetail(first, 'Camera unavailable'))
    }
  }
}

function isPermissionDismissed(err: unknown): boolean {
  const msg = errDetail(err, '').toLowerCase()
  const name =
    err && typeof err === 'object' && 'name' in err
      ? String((err as { name?: string }).name)
      : ''
  return (
    name === 'NotAllowedError' ||
    name === 'PermissionDeniedError' ||
    /permission dismissed|notallowed|permission denied|denied by user|dismissed/i.test(msg)
  )
}

async function acquireMic(deviceId: string | null | undefined): Promise<MediaStream> {
  // Match grant page first: plain { audio: true } after a visible Allow.
  const tryPlain = () => navigator.mediaDevices.getUserMedia({ audio: true })
  const tryEnhanced = (exactId: string | null) =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        ...(exactId ? { deviceId: { exact: exactId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    })

  if (deviceId) {
    try {
      return await tryEnhanced(deviceId)
    } catch (first) {
      try {
        return await tryPlain()
      } catch (second) {
        throw new Error(
          errDetail(
            second,
            errDetail(first, 'Microphone unavailable — allow mic in the MyPipCam grant window'),
          ),
        )
      }
    }
  }

  try {
    return await tryPlain()
  } catch (first) {
    try {
      return await tryEnhanced(null)
    } catch (second) {
      throw new Error(
        errDetail(
          second,
          errDetail(first, 'Microphone unavailable — allow mic in the MyPipCam grant window'),
        ),
      )
    }
  }
}

/**
 * Offscreen docs often can't show Chrome's mic Allow dialog ("Permission dismissed").
 * Prefer continuing with tab/cam video (+ tab audio) over aborting the whole start.
 */
async function tryAcquireMic(
  deviceId: string | null | undefined,
): Promise<MediaStream | null> {
  try {
    return await acquireMic(deviceId)
  } catch (err) {
    if (isPermissionDismissed(err)) {
      console.warn(
        '[MyPipCam][start] offscreen mic Permission dismissed — continuing without mic. Grant mic from the permission window first (popup → Allow microphone).',
        err,
      )
      return null
    }
    console.warn('[MyPipCam][start] offscreen mic failed — continuing without mic:', errDetail(err, ''))
    return null
  }
}

async function ensureAudioContextRunning(ctx: AudioContext | null): Promise<void> {
  if (!ctx) return
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch (err) {
      console.warn('[MyPipCam offscreen] AudioContext resume failed', err)
    }
  }
}

async function mixAudio(
  videoSource: MediaStream | null | undefined,
  mic: MediaStream | null | undefined,
): Promise<{ stream: MediaStream; ctx: AudioContext | null }> {
  if (!videoSource || typeof videoSource.getVideoTracks !== 'function') {
    throw new Error('Capture stream missing — tab/camera did not return a MediaStream')
  }

  const videoTracks = videoSource.getVideoTracks()
  const existingAudio =
    typeof videoSource.getAudioTracks === 'function' ? videoSource.getAudioTracks() : []
  const micTracks =
    mic && typeof mic.getAudioTracks === 'function' ? mic.getAudioTracks() : []

  if (micTracks.length === 0) {
    // Tab audio only (or silent video). Still resume a context if we monitor tab audio.
    if (existingAudio.length) {
      const ctx = new AudioContext()
      const tabSource = ctx.createMediaStreamSource(new MediaStream(existingAudio))
      tabSource.connect(ctx.destination)
      await ensureAudioContextRunning(ctx)
      return { stream: videoSource, ctx }
    }
    return { stream: videoSource, ctx: null }
  }

  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  if (!dest.stream) {
    throw new Error('Audio mix destination missing')
  }
  if (existingAudio.length) {
    const tabSource = ctx.createMediaStreamSource(new MediaStream(existingAudio))
    tabSource.connect(dest)
    // Tab capture mutes page audio — play it so the user still hears the tab.
    tabSource.connect(ctx.destination)
  }
  const micSource = ctx.createMediaStreamSource(new MediaStream(micTracks))
  const micGain = ctx.createGain()
  micGain.gain.value = 1
  micSource.connect(micGain)
  micGain.connect(dest)

  await ensureAudioContextRunning(ctx)

  const mixedAudio = dest.stream.getAudioTracks()
  if (mixedAudio.length === 0) {
    throw new Error('Audio mix produced no microphone tracks')
  }

  const out = new MediaStream([...videoTracks, ...mixedAudio])
  return { stream: out, ctx }
}

function stopTracks(stream: MediaStream | null) {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

function stopCameraFilterPipeline() {
  if (filterLoopRaf) {
    cancelAnimationFrame(filterLoopRaf)
    filterLoopRaf = 0
  }
  if (filterVideo) {
    filterVideo.srcObject = null
    filterVideo = null
  }
  filterCanvas = null
}

/**
 * Pipe a camera stream through a canvas with a CSS filter so cam-only
 * recordings match the PiP preview look.
 */
async function applyCameraFilterStream(
  source: MediaStream,
  filterId: CameraFilterId,
): Promise<MediaStream> {
  const css = cameraFilterCss(filterId)
  if (!css || css === 'none') return source

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = source
  await video.play().catch(() => undefined)

  // Wait briefly for dimensions.
  for (let i = 0; i < 30 && !video.videoWidth; i++) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const w = video.videoWidth || 1280
  const h = video.videoHeight || 720
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return source

  filterVideo = video
  filterCanvas = canvas

  const draw = () => {
    if (!filterVideo || !filterCanvas) return
    filterLoopRaf = requestAnimationFrame(draw)
    const vw = filterVideo.videoWidth
    const vh = filterVideo.videoHeight
    if (!vw || !vh) return
    if (filterCanvas.width !== vw || filterCanvas.height !== vh) {
      filterCanvas.width = vw
      filterCanvas.height = vh
    }
    ctx.filter = css
    ctx.drawImage(filterVideo, 0, 0, filterCanvas.width, filterCanvas.height)
    ctx.filter = 'none'
  }
  draw()

  return canvas.captureStream(30)
}

function cleanupMedia() {
  if (recorder && recorder.state !== 'inactive') {
    try {
      recorder.stop()
    } catch {
      /* ignore */
    }
  }
  recorder = null
  chunks = []
  paused = false
  prepared = false
  stopCameraFilterPipeline()
  stopTracks(mixedStream)
  stopTracks(tabStream)
  stopTracks(camStream)
  stopTracks(micStream)
  mixedStream = null
  tabStream = null
  camStream = null
  micStream = null
  void audioCtx?.close().catch(() => undefined)
  audioCtx = null
}

/** Acquire streams now (consume streamId). Does not start MediaRecorder unless commit. */
async function prepareRecording(msg: PrepareMessage) {
  if (recorder || prepared) cleanupMedia()

  const mode: RecordMode = msg.recordMode || 'screen-cam'
  const wantMic = msg.includeMic !== false

  if (mode === 'cam') {
    // Cam-only: camera must succeed. Pre-grant from the popup (Allow camera) so
    // offscreen isn't the first getUserMedia (invisible → Permission dismissed).
    try {
      camStream = await acquireCamera(msg.cameraDeviceId ?? null)
    } catch (err) {
      if (isPermissionDismissed(err)) {
        throw new Error(
          'Permission dismissed — allow Camera for MyPipCam in the popup (Allow camera) or chrome://settings/content/camera, then try again.',
        )
      }
      throw new Error(errDetail(err, 'Camera unavailable for cam-only recording'))
    }
    const filterId = normalizeCameraFilter(msg.cameraFilter)
    const videoForRecord = await applyCameraFilterStream(camStream, filterId)
    if (wantMic) {
      micStream = await tryAcquireMic(msg.micDeviceId)
    }
    const mixed = await mixAudio(videoForRecord, micStream)
    mixedStream = mixed.stream
    audioCtx = mixed.ctx
  } else {
    // Tab first — streamId expires in seconds; never delay it behind mic/cam.
    if (!msg.streamId) throw new Error('Missing tab stream id (tabCapture token expired or not granted)')
    try {
      tabStream = await acquireTabStream(msg.streamId)
    } catch (err) {
      throw new Error(
        errDetail(
          err,
          'Tab capture getUserMedia failed. Reload the extension and try again on an https tab.',
        ),
      )
    }
    if (wantMic) {
      micStream = await tryAcquireMic(msg.micDeviceId)
    }
    const mixed = await mixAudio(tabStream, micStream)
    mixedStream = mixed.stream
    audioCtx = mixed.ctx

    tabStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      void chrome.runtime.sendMessage({ type: 'LOOM_TAB_ENDED' })
    })
  }

  await ensureAudioContextRunning(audioCtx)

  if (!mixedStream || mixedStream.getVideoTracks().length === 0) {
    throw new Error('Capture produced no video track')
  }

  if (wantMic && !micStream) {
    console.warn(
      '[MyPipCam][start] prepare continuing without microphone (tab/system audio may still be present)',
    )
  }

  prepared = true

  if (msg.commit || msg.type === 'OFFSCREEN_START') {
    await startRecorder()
  }
}

async function startRecorder() {
  if (!mixedStream) throw new Error('Recorder not prepared — streams missing')
  if (recorder && recorder.state !== 'inactive') return

  await ensureAudioContextRunning(audioCtx)

  mimeType = pickMimeType()
  chunks = []
  paused = false
  try {
    recorder = new MediaRecorder(
      mixedStream,
      mimeType
        ? { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 }
        : { videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 },
    )
  } catch (err) {
    throw new Error(errDetail(err, 'MediaRecorder could not start with this stream'))
  }
  mimeType = mimeType || recorder.mimeType || 'video/webm'
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  startedAt = Date.now()
  recorder.start(1000)
}

async function commitRecording(): Promise<{ ok: boolean; reason?: string }> {
  if (!prepared || !mixedStream) {
    return { ok: false, reason: 'Capture was not prepared before countdown finished.' }
  }
  try {
    await startRecorder()
    return { ok: true }
  } catch (err) {
    cleanupMedia()
    return { ok: false, reason: errDetail(err, 'Could not start MediaRecorder') }
  }
}

function pauseRecording(): { ok: boolean; reason?: string } {
  if (!recorder || recorder.state !== 'recording') {
    return { ok: false, reason: 'not-recording' }
  }
  try {
    recorder.pause()
    paused = true
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: errDetail(err, 'pause-failed') }
  }
}

function resumeRecording(): { ok: boolean; reason?: string } {
  if (!recorder || recorder.state !== 'paused') {
    return { ok: false, reason: 'not-paused' }
  }
  try {
    recorder.resume()
    paused = false
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: errDetail(err, 'resume-failed') }
  }
}

function discardRecording(): { ok: boolean } {
  cleanupMedia()
  return { ok: true }
}

/**
 * Drop the in-progress take without saving, but keep MediaStreams armed so
 * restart can re-run countdown → OFFSCREEN_COMMIT without a new tabCapture token.
 */
async function resetRecordingKeepStreams(): Promise<{ ok: boolean; reason?: string }> {
  const active = recorder
  if (active && active.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      active.ondataavailable = null
      active.onstop = done
      active.onerror = done
      try {
        active.stop()
      } catch {
        done()
      }
    })
  }
  recorder = null
  chunks = []
  paused = false
  startedAt = 0

  const videoAlive = Boolean(
    mixedStream?.getVideoTracks().some((t) => t.readyState === 'live'),
  )
  if (!prepared || !mixedStream || !videoAlive) {
    cleanupMedia()
    return { ok: false, reason: 'capture-ended' }
  }

  prepared = true
  return { ok: true }
}

async function stopAndSave(): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const active = recorder
  if (!active) {
    // Still drop any live tab/cam tracks so Chrome's sharing banner clears.
    cleanupMedia()
    return { ok: false, reason: 'not-recording' }
  }

  const durationMs = Date.now() - startedAt
  const blob = await new Promise<Blob>((resolve, reject) => {
    const finish = () => resolve(new Blob(chunks, { type: mimeType }))
    active.onstop = finish
    active.onerror = () => reject(new Error('Recorder failed'))
    try {
      if (active.state !== 'inactive') active.stop()
      else finish()
    } catch (e) {
      reject(e)
    }
  }).catch((err) => {
    cleanupMedia()
    throw err
  })

  cleanupMedia()

  if (blob.size < 64) {
    return { ok: false, reason: 'empty-recording' }
  }

  let thumbnail: Blob | undefined
  try {
    thumbnail = await blobToThumbnail(blob)
  } catch {
    thumbnail = undefined
  }

  const record = await saveRecording({
    blob,
    durationMs,
    thumbnail,
    mimeType,
  })

  return { ok: true, id: record.id }
}

async function blobToThumbnail(blob: Blob): Promise<Blob | undefined> {
  const url = URL.createObjectURL(blob)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.src = url
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve()
      video.onerror = () => reject(new Error('thumb load failed'))
    })
    video.currentTime = Math.min(0.5, (video.duration || 1) * 0.1)
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve()
      window.setTimeout(() => resolve(), 400)
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.min(640, video.videoWidth || 640)
    canvas.height = Math.round(
      canvas.width * ((video.videoHeight || 360) / (video.videoWidth || 640)),
    )
    const ctx = canvas.getContext('2d')
    if (!ctx || !video.videoWidth) return undefined
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await new Promise((resolve) => {
      canvas.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.72)
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages meant only for the service worker / other pages.
  if (message?.target && message.target !== 'offscreen') return false
  // Reject cross-extension senders (defense in depth).
  if (sender?.id != null && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, reason: 'untrusted-sender' })
    return false
  }

  if (message?.type === 'OFFSCREEN_PREPARE' || message?.type === 'OFFSCREEN_START') {
    void (async () => {
      try {
        await prepareRecording(message as PrepareMessage)
        sendResponse({ ok: true })
      } catch (err) {
        cleanupMedia()
        const detail = errDetail(err, 'start-failed')
        console.error('[MyPipCam offscreen] prepare failed:', detail, err)
        sendResponse({ ok: false, reason: detail })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_COMMIT') {
    void (async () => {
      const result = await commitRecording()
      if (!result.ok) console.error('[MyPipCam offscreen] commit failed:', result.reason)
      sendResponse(result)
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_ENSURE_MIC') {
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        })
        for (const t of stream.getTracks()) t.stop()
        sendResponse({ ok: true })
      } catch (err) {
        sendResponse({
          ok: false,
          reason: errDetail(err, 'Microphone permission denied for MyPipCam'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_LIST_MICS') {
    void (async () => {
      try {
        // Unlock labels in the offscreen doc (popup getUserMedia closes the popup).
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          })
          for (const t of stream.getTracks()) t.stop()
        } catch {
          /* may still list devices without labels */
        }
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices
          .filter(
            (d) =>
              d.kind === 'audioinput' &&
              Boolean(d.deviceId) &&
              d.deviceId !== 'communications',
          )
          .map((d, i) => ({
            deviceId: d.deviceId,
            label:
              d.label?.trim() ||
              (d.deviceId === 'default' ? 'System default' : `Microphone ${i + 1}`),
          }))
        // Prefer listing physical devices; keep default if it's the only one.
        const physical = mics.filter((d) => d.deviceId !== 'default')
        sendResponse({
          ok: true,
          devices: physical.length > 0 ? physical : mics,
        })
      } catch (err) {
        sendResponse({
          ok: false,
          devices: [],
          reason: errDetail(err, 'Could not list microphones'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_STOP') {
    void (async () => {
      try {
        const result = await stopAndSave()
        sendResponse(result)
      } catch (err) {
        cleanupMedia()
        sendResponse({
          ok: false,
          reason: errDetail(err, 'stop-failed'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_PAUSE') {
    sendResponse(pauseRecording())
    return false
  }

  if (message?.type === 'OFFSCREEN_RESUME') {
    sendResponse(resumeRecording())
    return false
  }

  if (message?.type === 'OFFSCREEN_DISCARD') {
    sendResponse(discardRecording())
    return false
  }

  if (message?.type === 'OFFSCREEN_RESET') {
    void (async () => {
      try {
        sendResponse(await resetRecordingKeepStreams())
      } catch (err) {
        cleanupMedia()
        sendResponse({
          ok: false,
          reason: errDetail(err, 'reset-failed'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true, recording: Boolean(recorder), prepared, paused })
    return false
  }

  return false
})
