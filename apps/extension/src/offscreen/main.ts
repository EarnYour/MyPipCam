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
import {
  concatRecordingParts,
  measureBlobDurationMs,
  partsDurationMs,
  sliceTimesliceChunks,
  trimBlobToSeconds,
  type RecordingPart,
} from '../shared/liveTrimMedia'
import { preferredMimeType } from '../recorder/capture'
import {
  CAPTURE_AUDIO_BITRATE,
  captureQualitySize,
  captureQualityVideoBitrate,
  cursorCaptureConstraint,
  normalizeCaptureQuality,
  type CaptureQuality,
} from '../shared/types'

type RecordMode = 'screen-cam' | 'screen' | 'cam'

type PrepareMessage = {
  type: 'OFFSCREEN_PREPARE' | 'OFFSCREEN_START'
  streamId?: string
  includeMic?: boolean
  micDeviceId?: string | null
  cameraDeviceId?: string | null
  recordMode?: RecordMode
  cameraFilter?: CameraFilterId | string | null
  /** Include mouse cursor in tab capture (default true). Not camera PiP. */
  captureCursor?: boolean
  /** Tab/screen capture resolution preset (default 1080p). Not camera PiP. */
  captureQuality?: CaptureQuality | string | null
  /** When true (legacy OFFSCREEN_START), start MediaRecorder immediately. */
  commit?: boolean
}

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
/** Sealed prefixes from mid-take rewind & trim (concatenated on final save). */
let sealedParts: RecordingPart[] = []
let mimeType = 'video/webm'
let startedAt = 0
let tabStream: MediaStream | null = null
let camStream: MediaStream | null = null
let micStream: MediaStream | null = null
let mixedStream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let prepared = false
/** Quality chosen at prepare — drives MediaRecorder bitrate on commit. */
let activeCaptureQuality: CaptureQuality = '1080p'
let paused = false
let pausedAccumMs = 0
let pauseStartedAt = 0
/** True while dock/HUD rewind scrub UI is open (recorder stays paused). */
let rewindUiOpen = false
/** Canvas filter loop for cam-only when a color filter is active. */
let filterLoopRaf = 0
let filterVideo: HTMLVideoElement | null = null
let filterCanvas: HTMLCanvasElement | null = null

function activeElapsedMs(): number {
  if (!startedAt) return 0
  let ms = Date.now() - startedAt - pausedAccumMs
  if (paused && pauseStartedAt) ms -= Date.now() - pauseStartedAt
  return Math.max(0, ms)
}

function totalDurationMs(): number {
  return partsDurationMs(sealedParts) + activeElapsedMs()
}

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

async function applyTabTrackPrefs(
  stream: MediaStream,
  opts: { captureCursor: boolean; width: number; height: number },
): Promise<MediaStream> {
  const track = stream.getVideoTracks()[0]
  if (!track) return stream
  const cursor = cursorCaptureConstraint(opts.captureCursor)
  // Best-effort: Chrome may ignore cursor/resolution on tabCapture surfaces.
  try {
    await track.applyConstraints({
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      frameRate: { ideal: 30 },
      cursor,
    } as MediaTrackConstraints)
  } catch {
    try {
      await track.applyConstraints({
        width: { ideal: opts.width },
        height: { ideal: opts.height },
        frameRate: { ideal: 30 },
      })
    } catch {
      /* ignore */
    }
    try {
      await track.applyConstraints({ cursor } as MediaTrackConstraints)
    } catch {
      /* ignore */
    }
  }
  return stream
}

async function acquireTabStream(
  streamId: string,
  opts: { captureCursor?: boolean; captureQuality?: CaptureQuality | string | null } = {},
): Promise<MediaStream> {
  const captureCursor = opts.captureCursor !== false
  const quality = normalizeCaptureQuality(opts.captureQuality)
  const { width, height } = captureQualitySize(quality)
  const cursor = cursorCaptureConstraint(captureCursor)

  const buildVideoConstraints = (includePrefs: boolean) => ({
    mandatory: {
      chromeMediaSource: 'tab',
      chromeMediaSourceId: streamId,
      maxFrameRate: 30,
      ...(includePrefs
        ? {
            cursor,
            maxWidth: width,
            maxHeight: height,
          }
        : {}),
    },
  })

  const tryAcquire = async (includePrefs: boolean, withAudio: boolean) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: withAudio
        ? {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId,
            },
          }
        : false,
      video: buildVideoConstraints(includePrefs),
    } as unknown as MediaStreamConstraints)
    return applyTabTrackPrefs(stream, { captureCursor, width, height })
  }

  try {
    return await tryAcquire(true, true)
  } catch (withAudio) {
    // Some tabs / Chrome builds reject tab audio — fall back to video-only.
    try {
      return await tryAcquire(true, false)
    } catch (videoOnly) {
      // Retry without cursor/quality prefs if those constraints were rejected.
      try {
        return await tryAcquire(false, false)
      } catch {
        throw new Error(
          errDetail(
            videoOnly,
            errDetail(withAudio, 'Tab capture getUserMedia failed'),
          ),
        )
      }
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
  sealedParts = []
  paused = false
  pausedAccumMs = 0
  pauseStartedAt = 0
  startedAt = 0
  rewindUiOpen = false
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
  activeCaptureQuality = normalizeCaptureQuality(msg.captureQuality)

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
    const captureCursor = msg.captureCursor !== false
    try {
      tabStream = await acquireTabStream(msg.streamId, {
        captureCursor,
        captureQuality: activeCaptureQuality,
      })
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

async function startRecorder(opts?: { continueSession?: boolean }) {
  if (!mixedStream) throw new Error('Recorder not prepared — streams missing')
  if (recorder && recorder.state !== 'inactive') return

  await ensureAudioContextRunning(audioCtx)

  mimeType = pickMimeType()
  chunks = []
  if (!opts?.continueSession) {
    sealedParts = []
  }
  paused = false
  pausedAccumMs = 0
  pauseStartedAt = 0
  rewindUiOpen = false
  const videoBitsPerSecond = captureQualityVideoBitrate(activeCaptureQuality)
  try {
    recorder = new MediaRecorder(
      mixedStream,
      mimeType
        ? {
            mimeType,
            videoBitsPerSecond,
            audioBitsPerSecond: CAPTURE_AUDIO_BITRATE,
          }
        : {
            videoBitsPerSecond,
            audioBitsPerSecond: CAPTURE_AUDIO_BITRATE,
          },
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
  if (!recorder) {
    return { ok: false, reason: 'not-recording' }
  }
  if (recorder.state === 'paused') {
    paused = true
    if (!pauseStartedAt) pauseStartedAt = Date.now()
    return { ok: true }
  }
  if (recorder.state !== 'recording') {
    return { ok: false, reason: `not-recording (${recorder.state})` }
  }
  try {
    // Flush the current timeslice before pausing so wall-clock and blob stay aligned.
    try {
      recorder.requestData()
    } catch {
      /* requestData optional */
    }
    recorder.pause()
    // MediaRecorder.state typings don't model pause()/resume() transitions.
    const state = recorder.state as MediaRecorder['state'] | string
    if (state !== 'paused') {
      paused = false
      pauseStartedAt = 0
      return { ok: false, reason: `pause-rejected (${state})` }
    }
    paused = true
    pauseStartedAt = Date.now()
    return { ok: true }
  } catch (err) {
    paused = false
    pauseStartedAt = 0
    return { ok: false, reason: errDetail(err, 'pause-failed') }
  }
}

function resumeRecording(): { ok: boolean; reason?: string } {
  if (rewindUiOpen) {
    return { ok: false, reason: 'Finish or cancel rewind first.' }
  }
  if (!recorder) {
    return { ok: false, reason: 'not-paused' }
  }
  if (recorder.state === 'recording') {
    if (pauseStartedAt) {
      pausedAccumMs += Date.now() - pauseStartedAt
      pauseStartedAt = 0
    }
    paused = false
    return { ok: true }
  }
  if (recorder.state !== 'paused') {
    return { ok: false, reason: `not-paused (${recorder.state})` }
  }
  try {
    recorder.resume()
    const state = recorder.state as MediaRecorder['state'] | string
    if (pauseStartedAt) {
      pausedAccumMs += Date.now() - pauseStartedAt
      pauseStartedAt = 0
    }
    paused = false
    if (state !== 'recording') {
      return { ok: false, reason: `resume-rejected (${state})` }
    }
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
  sealedParts = []
  paused = false
  pausedAccumMs = 0
  pauseStartedAt = 0
  startedAt = 0
  rewindUiOpen = false

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

/**
 * Stop the active MediaRecorder and return its blob + prior timeslice chunks.
 * Keeps MediaStreams / sealedParts intact for punch-in continue.
 */
async function finalizeActiveRecorder(): Promise<{
  blob: Blob
  durationMs: number
  chunks: Blob[]
} | null> {
  const durationMs = activeElapsedMs()
  const savedChunks = [...chunks]
  const active = recorder
  if (!active) {
    if (savedChunks.length === 0) return null
    chunks = []
    startedAt = 0
    paused = false
    pauseStartedAt = 0
    pausedAccumMs = 0
    return {
      blob: new Blob(savedChunks, { type: mimeType }),
      durationMs,
      chunks: savedChunks,
    }
  }

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
  })

  recorder = null
  chunks = []
  paused = false
  pauseStartedAt = 0
  pausedAccumMs = 0
  startedAt = 0
  return { blob, durationMs, chunks: savedChunks }
}

async function beginRewindTrim(): Promise<{
  ok: boolean
  durationMs?: number
  previewBlob?: Blob
  reason?: string
}> {
  if (!recorder && chunks.length === 0 && sealedParts.length === 0) {
    return { ok: false, reason: 'not-recording' }
  }
  if (!paused) {
    const pauseRes = pauseRecording()
    if (!pauseRes.ok) return { ok: false, reason: pauseRes.reason || 'pause-failed' }
  }
  try {
    recorder?.requestData()
  } catch {
    /* optional */
  }
  await new Promise((r) => setTimeout(r, 60))

  const durationMs = totalDurationMs()
  if (durationMs < 500) {
    return { ok: false, reason: 'Record a bit more before rewinding.' }
  }

  rewindUiOpen = true

  // Preview only from the active MediaRecorder buffer (same header). Sealed
  // parts need ffmpeg concat — skip preview video when parts already exist.
  let previewBlob: Blob | undefined
  if (sealedParts.length === 0 && chunks.length > 0) {
    const blob = new Blob(chunks, { type: mimeType })
    if (blob.size > 64 && blob.size < 48 * 1024 * 1024) {
      previewBlob = blob
    }
  }

  return { ok: true, durationMs, previewBlob }
}

async function applyRewindTrim(keepMsRaw: number): Promise<{
  ok: boolean
  durationMs?: number
  reason?: string
}> {
  if (!recorder && chunks.length === 0 && sealedParts.length === 0) {
    return { ok: false, reason: 'not-recording' }
  }

  const sealedMs = partsDurationMs(sealedParts)
  const total = sealedMs + activeElapsedMs()
  const keepMs = Math.max(250, Math.min(Math.round(keepMsRaw), total))

  let finalized: Awaited<ReturnType<typeof finalizeActiveRecorder>> = null
  try {
    finalized = await finalizeActiveRecorder()
  } catch (err) {
    return { ok: false, reason: errDetail(err, 'Could not pause take for trim.') }
  }

  const activeChunks = finalized?.chunks ?? []

  try {
    if (keepMs <= sealedMs) {
      // Rewind into a previously sealed prefix — trim with ffmpeg.
      const kept: RecordingPart[] = []
      let remaining = keepMs
      for (const part of sealedParts) {
        if (remaining <= 0) break
        if (remaining >= part.durationMs - 20) {
          kept.push(part)
          remaining -= part.durationMs
        } else {
          const trimmed = await trimBlobToSeconds(part.blob, remaining / 1000)
          const measured = (await measureBlobDurationMs(trimmed)) ?? remaining
          kept.push({ blob: trimmed, durationMs: measured })
          remaining = 0
        }
      }
      sealedParts = kept
    } else {
      // Keep all sealed parts; slice the active timeslice buffer.
      const keepActive = keepMs - sealedMs
      const sliced = sliceTimesliceChunks(activeChunks, keepActive, mimeType)
      if (sliced) {
        const measured = (await measureBlobDurationMs(sliced.blob)) ?? sliced.durationMs
        sealedParts = [...sealedParts, { blob: sliced.blob, durationMs: measured }]
      } else if (finalized && finalized.blob.size >= 64 && keepActive > 0) {
        // Fallback: ffmpeg-trim the finalized active blob.
        const trimmed = await trimBlobToSeconds(finalized.blob, keepActive / 1000)
        const measured = (await measureBlobDurationMs(trimmed)) ?? keepActive
        sealedParts = [...sealedParts, { blob: trimmed, durationMs: measured }]
      }
    }

    const keptDuration = partsDurationMs(sealedParts)
    await startRecorder({ continueSession: true })
    rewindUiOpen = false
    return { ok: true, durationMs: keptDuration }
  } catch (err) {
    // Best effort: try to resume capture so the user isn't stuck.
    try {
      if (!recorder && mixedStream) {
        await startRecorder({ continueSession: true })
      }
    } catch {
      /* ignore */
    }
    rewindUiOpen = false
    return { ok: false, reason: errDetail(err, 'Could not trim take.') }
  }
}

function cancelRewindTrim(): { ok: boolean; reason?: string } {
  rewindUiOpen = false
  if (!recorder) {
    return { ok: false, reason: 'not-recording' }
  }
  return resumeRecording()
}

async function stopAndSave(): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  rewindUiOpen = false
  const active = recorder
  if (!active && sealedParts.length === 0) {
    cleanupMedia()
    return { ok: false, reason: 'not-recording' }
  }

  let activeDurationMs = activeElapsedMs()
  let activeBlob: Blob | null = null

  if (active) {
    activeBlob = await new Promise<Blob>((resolve, reject) => {
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
  }

  recorder = null
  chunks = []

  const parts: RecordingPart[] = [...sealedParts]
  if (activeBlob && activeBlob.size >= 64) {
    const measured =
      (await measureBlobDurationMs(activeBlob)) ?? Math.max(0, activeDurationMs)
    parts.push({ blob: activeBlob, durationMs: measured })
  }

  const durationMs = partsDurationMs(parts)
  sealedParts = []

  if (parts.length === 0) {
    cleanupMedia()
    return { ok: false, reason: 'empty-recording' }
  }

  let blob: Blob
  try {
    blob = await concatRecordingParts(parts)
  } catch (err) {
    // Prefer last part (most recent take) if concat fails after a mid-take trim.
    const fallback = parts[parts.length - 1]?.blob
    if (fallback && fallback.size >= 64) {
      console.warn('[MyPipCam offscreen] concat failed, saving last part only:', err)
      blob = fallback
    } else {
      cleanupMedia()
      return {
        ok: false,
        reason: errDetail(err, 'Could not assemble trimmed recording.'),
      }
    }
  }

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
    durationMs: Math.max(durationMs, 0),
    thumbnail,
    mimeType: blob.type || mimeType,
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

  if (message?.type === 'OFFSCREEN_REWIND_BEGIN') {
    void (async () => {
      try {
        sendResponse(await beginRewindTrim())
      } catch (err) {
        sendResponse({
          ok: false,
          reason: errDetail(err, 'Could not open rewind.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_REWIND_APPLY') {
    void (async () => {
      try {
        const keepMs = Number(message.keepMs)
        if (!Number.isFinite(keepMs) || keepMs < 0) {
          sendResponse({ ok: false, reason: 'invalid-keepMs' })
          return
        }
        sendResponse(await applyRewindTrim(keepMs))
      } catch (err) {
        sendResponse({
          ok: false,
          reason: errDetail(err, 'Could not apply rewind trim.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'OFFSCREEN_REWIND_CANCEL') {
    sendResponse(cancelRewindTrim())
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
