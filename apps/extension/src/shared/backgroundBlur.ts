/**
 * Loom-style person-sharp / background-blur using MediaPipe Image Segmenter
 * (selfie_segmenter). WASM + model are vendored under public/mediapipe/ (~21MB).
 *
 * Dependency: `@mediapipe/tasks-vision` (see package.json). Assets are copied by
 * `scripts/prepare-assets.mjs` so MV3 CSP never loads CDN scripts.
 */

import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision'
import type { BackgroundEffect } from './types'

const BLUR_PX = 14
/** Process at most this many segmentations per second (draw can reuse last frame). */
const MAX_SEGMENT_FPS = 20

function assetUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path)
  }
  return `/${path.replace(/^\//, '')}`
}

export class PersonBackgroundBlur {
  private segmenter: ImageSegmenter | null = null
  private readonly output = document.createElement('canvas')
  private readonly blurCanvas = document.createElement('canvas')
  private readonly personCanvas = document.createElement('canvas')
  private readonly maskCanvas = document.createElement('canvas')
  private lastTs = -1
  private lastSegmentAt = 0
  private busy = false
  private closed = false

  static async create(): Promise<PersonBackgroundBlur> {
    const engine = new PersonBackgroundBlur()
    await engine.init()
    return engine
  }

  private async init() {
    const wasm = await FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'))
    const modelAssetPath = assetUrl('mediapipe/models/selfie_segmenter.tflite')
    try {
      this.segmenter = await ImageSegmenter.createFromOptions(wasm, {
        baseOptions: { modelAssetPath, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      })
    } catch {
      this.segmenter = await ImageSegmenter.createFromOptions(wasm, {
        baseOptions: { modelAssetPath, delegate: 'CPU' },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      })
    }
  }

  /** Latest processed frame (may be empty until the first successful segment). */
  get canvas(): HTMLCanvasElement {
    return this.output
  }

  get ready(): boolean {
    return Boolean(this.segmenter) && !this.closed
  }

  /**
   * Segment + composite. Returns the output canvas, or null if not ready /
   * video has no frames yet. Reuses the previous output when throttled.
   */
  process(video: HTMLVideoElement): HTMLCanvasElement | null {
    if (!this.segmenter || this.closed) return null
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null

    if (this.output.width !== vw || this.output.height !== vh) {
      this.output.width = vw
      this.output.height = vh
      this.blurCanvas.width = vw
      this.blurCanvas.height = vh
      this.personCanvas.width = vw
      this.personCanvas.height = vh
    }

    const now = performance.now()
    const minGap = 1000 / MAX_SEGMENT_FPS
    if (this.busy || now - this.lastSegmentAt < minGap) {
      return this.output.width ? this.output : null
    }

    this.busy = true
    this.lastSegmentAt = now
    let ts = now
    if (ts <= this.lastTs) ts = this.lastTs + 1
    this.lastTs = ts

    try {
      const result = this.segmenter.segmentForVideo(video, ts)
      this.composite(video, result)
      result.close()
    } catch {
      // Fall back to raw frame so the bubble never goes blank.
      const ctx = this.output.getContext('2d')
      if (ctx) {
        ctx.filter = 'none'
        ctx.drawImage(video, 0, 0, vw, vh)
      }
    } finally {
      this.busy = false
    }

    return this.output
  }

  private composite(video: HTMLVideoElement, result: ImageSegmenterResult) {
    const vw = this.output.width
    const vh = this.output.height
    const mask = result.confidenceMasks?.[0]
    if (!mask) {
      const ctx = this.output.getContext('2d')
      if (ctx) {
        ctx.filter = 'none'
        ctx.drawImage(video, 0, 0, vw, vh)
      }
      return
    }

    const mw = mask.width
    const mh = mask.height
    if (this.maskCanvas.width !== mw || this.maskCanvas.height !== mh) {
      this.maskCanvas.width = mw
      this.maskCanvas.height = mh
    }

    const maskCtx = this.maskCanvas.getContext('2d')
    const blurCtx = this.blurCanvas.getContext('2d')
    const personCtx = this.personCanvas.getContext('2d')
    const outCtx = this.output.getContext('2d')
    if (!maskCtx || !blurCtx || !personCtx || !outCtx) {
      mask.close()
      return
    }

    const floats = mask.getAsFloat32Array()
    const imageData = maskCtx.createImageData(mw, mh)
    const data = imageData.data
    for (let i = 0; i < floats.length; i++) {
      const a = Math.max(0, Math.min(255, Math.round(floats[i] * 255)))
      const o = i * 4
      data[o] = 255
      data[o + 1] = 255
      data[o + 2] = 255
      data[o + 3] = a
    }
    maskCtx.putImageData(imageData, 0, 0)
    mask.close()

    // Soft blurred background
    blurCtx.save()
    blurCtx.filter = `blur(${BLUR_PX}px)`
    blurCtx.drawImage(video, 0, 0, vw, vh)
    blurCtx.restore()

    // Sharp person cutout
    personCtx.clearRect(0, 0, vw, vh)
    personCtx.drawImage(video, 0, 0, vw, vh)
    personCtx.globalCompositeOperation = 'destination-in'
    personCtx.drawImage(this.maskCanvas, 0, 0, vw, vh)
    personCtx.globalCompositeOperation = 'source-over'

    outCtx.clearRect(0, 0, vw, vh)
    outCtx.drawImage(this.blurCanvas, 0, 0)
    outCtx.drawImage(this.personCanvas, 0, 0)
  }

  close() {
    this.closed = true
    try {
      this.segmenter?.close()
    } catch {
      /* ignore */
    }
    this.segmenter = null
  }
}

/** Create a fresh segmenter (WASM loads once per call — only when blur is enabled). */
export async function createPersonBackgroundBlur(): Promise<PersonBackgroundBlur> {
  return PersonBackgroundBlur.create()
}

export function isBlurEffect(effect: BackgroundEffect | undefined): boolean {
  return effect === 'blur'
}
