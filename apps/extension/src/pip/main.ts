/**
 * Camera runs in the extension origin (iframe), not the host page.
 * Site camera blocks (address-bar ✕) do not apply here.
 *
 * Security: this page is web-accessible. Camera starts only after the
 * background validates a short-lived channel token registered by the
 * content script. postMessage commands require the same token.
 */

import {
  createPersonBackgroundBlur,
  isBlurEffect,
  type PersonBackgroundBlur,
} from '../shared/backgroundBlur'
import {
  cameraFilterCss,
  normalizeCameraFilter,
  type CameraFilterId,
} from '../shared/cameraFilters'
import { isPipChannelToken } from '../shared/security'
import type { BackgroundEffect } from '../shared/types'

const video = document.getElementById('cam') as HTMLVideoElement
const canvas = document.getElementById('out') as HTMLCanvasElement
let stream: MediaStream | null = null
let effect: BackgroundEffect = 'none'
let cameraFilter: CameraFilterId = 'none'
let blurEngine: PersonBackgroundBlur | null = null
let raf = 0
let running = false

const channelToken = (() => {
  const raw = new URLSearchParams(location.search).get('ch')
  return isPipChannelToken(raw) ? raw : ''
})()

function postToParent(payload: Record<string, unknown>) {
  window.parent.postMessage(
    channelToken ? { ...payload, token: channelToken } : payload,
    '*',
  )
}

function readEffectFromQuery(): BackgroundEffect {
  const params = new URLSearchParams(location.search)
  return params.get('effect') === 'blur' ? 'blur' : 'none'
}

function readFilterFromQuery(): CameraFilterId {
  const params = new URLSearchParams(location.search)
  return normalizeCameraFilter(params.get('filter'))
}

function setMirror(on: boolean) {
  video.classList.toggle('mirror', on)
  canvas.classList.toggle('mirror', on)
}

function applyCameraFilter(next: CameraFilterId) {
  cameraFilter = normalizeCameraFilter(next)
  const css = cameraFilterCss(cameraFilter)
  video.style.filter = css
  canvas.style.filter = css
}

function showFallback(message: string) {
  video.remove()
  canvas.remove()
  const el = document.createElement('div')
  el.className = 'fallback'
  el.textContent = message
  document.body.appendChild(el)
}

function showSurface(mode: 'video' | 'canvas') {
  video.classList.toggle('is-hidden', mode !== 'video')
  canvas.classList.toggle('is-hidden', mode !== 'canvas')
}

function stopLoop() {
  running = false
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

function drawLoop() {
  if (!running) return
  raf = requestAnimationFrame(drawLoop)
  if (!blurEngine || !isBlurEffect(effect)) return
  if (!video.videoWidth) return
  const frame = blurEngine.process(video)
  if (!frame) return
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width
    canvas.height = frame.height
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(frame, 0, 0)
}

async function applyEffect(next: BackgroundEffect) {
  effect = next
  if (!isBlurEffect(effect)) {
    stopLoop()
    showSurface('video')
    return
  }
  try {
    if (!blurEngine) {
      blurEngine = await createPersonBackgroundBlur()
    }
    showSurface('canvas')
    if (!running) {
      running = true
      drawLoop()
    }
  } catch (err) {
    console.warn('[MyPipCam] background blur unavailable', err)
    effect = 'none'
    stopLoop()
    showSurface('video')
  }
}

let cameraBootstrapped = false

async function startCamera(deviceId: string | null) {
  const params = new URLSearchParams(location.search)
  const id = deviceId ?? params.get('deviceId')
  // Seed mirror/effect/filter from the URL once. Later MPC_PIP_* messages own
  // live state — do not reset them when switching cameras mid-recording.
  if (!cameraBootstrapped) {
    setMirror(params.get('mirror') !== '0')
    effect = readEffectFromQuery()
    applyCameraFilter(readFilterFromQuery())
    cameraBootstrapped = true
  }

  try {
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(id ? { deviceId: { exact: id } } : {}),
        width: { ideal: 640 },
        height: { ideal: 640 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
    video.srcObject = stream
    await video.play().catch(() => undefined)
    await applyEffect(effect)
    postToParent({ type: 'MPC_PIP_CAMERA', ok: true })
  } catch (err) {
    // Fallback without exact device if chosen cam fails
    if (id) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 640 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        })
        video.srcObject = stream
        await video.play().catch(() => undefined)
        await applyEffect(effect)
        postToParent({ type: 'MPC_PIP_CAMERA', ok: true })
        return
      } catch {
        /* fall through */
      }
    }
    const msg = err instanceof Error ? err.message : 'Camera unavailable'
    showFallback('Allow camera for MyPipCam')
    postToParent({ type: 'MPC_PIP_CAMERA', ok: false, reason: msg })
  }
}

function stopCamera() {
  stopLoop()
  blurEngine?.close()
  blurEngine = null
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
  video.srcObject = null
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return
  if (!channelToken) return
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.token !== channelToken) return
  if (data.type === 'MPC_PIP_MIRROR') {
    setMirror(Boolean(data.mirror))
    if (data.deviceId != null) {
      void startCamera(typeof data.deviceId === 'string' ? data.deviceId : null)
    }
  }
  if (data.type === 'MPC_PIP_EFFECT') {
    const next: BackgroundEffect = data.effect === 'blur' ? 'blur' : 'none'
    void applyEffect(next)
  }
  if (data.type === 'MPC_PIP_FILTER') {
    applyCameraFilter(normalizeCameraFilter(data.filter))
  }
  if (data.type === 'MPC_PIP_STOP') {
    stopCamera()
  }
})

async function boot() {
  if (!channelToken) {
    showFallback('Camera overlay unavailable')
    postToParent({
      type: 'MPC_PIP_CAMERA',
      ok: false,
      reason: 'Camera overlay unavailable (missing channel)',
    })
    return
  }
  let allowed = false
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'VALIDATE_PIP_CHANNEL',
        token: channelToken,
      })) as { ok?: boolean } | undefined
      if (res?.ok) {
        allowed = true
        break
      }
    } catch {
      /* retry — SW may still be waking / token settling */
    }
    await new Promise((r) => setTimeout(r, 60 * (attempt + 1)))
  }
  if (!allowed) {
    showFallback('Camera overlay unavailable')
    postToParent({
      type: 'MPC_PIP_CAMERA',
      ok: false,
      reason: 'Camera overlay unavailable (channel validation failed)',
    })
    return
  }
  void startCamera(null)
}

void boot()
