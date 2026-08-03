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

/** Background gaussian radius — applied at downscaled blur buffer, then upscaled. */
const BLUR_PX = 6
/**
 * Feather the person mask edge (px at mask resolution). Softens the cutout so hair /
 * shoulders blend into the blurred background instead of a hard stencil.
 */
const MASK_FEATHER_PX = 5
/** Slight confidence boost before feathering — expands the subject a touch so blur doesn't eat into the face. */
const MASK_DILATE = 0.08
/** Process at most this many segmentations per second (draw can reuse last frame). */
const MAX_SEGMENT_FPS = 12
/**
 * Max long-edge for segmentation input. Selfie segmenter is trained small;
 * downscaling is the largest CPU/GPU win vs feeding full 640² every frame.
 */
const SEG_MAX_EDGE = 256
/** Blur the background at this fraction of output size, then upscale (cheaper than full-res CSS blur). */
const BLUR_SCALE = 0.5

function assetUrl(path: string): string {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path)
  }
  return `/${path.replace(/^\//, '')}`
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { willReadFrequently: false })
}

export class PersonBackgroundBlur {
  private segmenter: ImageSegmenter | null = null
  private readonly output = document.createElement('canvas')
  private readonly blurCanvas = document.createElement('canvas')
  private readonly personCanvas = document.createElement('canvas')
  private readonly maskCanvas = document.createElement('canvas')
  /** Softened alpha mask (gaussian feather) used for destination-in. */
  private readonly softMaskCanvas = document.createElement('canvas')
  /** Downscaled frame fed to the segmenter (reused every frame). */
  private readonly segInput = document.createElement('canvas')

  private outCtx: CanvasRenderingContext2D | null = null
  private blurCtx: CanvasRenderingContext2D | null = null
  private personCtx: CanvasRenderingContext2D | null = null
  private maskCtx: CanvasRenderingContext2D | null = null
  private softMaskCtx: CanvasRenderingContext2D | null = null
  private segCtx: CanvasRenderingContext2D | null = null

  /** Reused mask ImageData buffer (avoids allocate-per-frame). */
  private maskImageData: ImageData | null = null

  private lastTs = -1
  private lastSegmentAt = 0
  private busy = false
  private closed = false
  /** When true, segment even less often (active recording / thermal pressure). */
  private lowPower = false

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

  /** Drop segmentation rate further while MediaRecorder is active. */
  setLowPower(on: boolean) {
    this.lowPower = on
  }

  private ensureOutputSize(vw: number, vh: number) {
    if (this.output.width === vw && this.output.height === vh) return
    this.output.width = vw
    this.output.height = vh
    this.personCanvas.width = vw
    this.personCanvas.height = vh
    const bw = Math.max(2, Math.round(vw * BLUR_SCALE))
    const bh = Math.max(2, Math.round(vh * BLUR_SCALE))
    this.blurCanvas.width = bw
    this.blurCanvas.height = bh
    this.outCtx = get2d(this.output)
    this.blurCtx = get2d(this.blurCanvas)
    this.personCtx = get2d(this.personCanvas)
  }

  private ensureSegSize(vw: number, vh: number): { sw: number; sh: number } {
    const scale = Math.min(1, SEG_MAX_EDGE / Math.max(vw, vh))
    const sw = Math.max(2, Math.round(vw * scale))
    const sh = Math.max(2, Math.round(vh * scale))
    if (this.segInput.width !== sw || this.segInput.height !== sh) {
      this.segInput.width = sw
      this.segInput.height = sh
      this.segCtx = get2d(this.segInput)
    }
    return { sw, sh }
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

    this.ensureOutputSize(vw, vh)

    const now = performance.now()
    const maxFps = this.lowPower ? MAX_SEGMENT_FPS * 0.6 : MAX_SEGMENT_FPS
    const minGap = 1000 / Math.max(4, maxFps)
    if (this.busy || now - this.lastSegmentAt < minGap) {
      return this.output.width ? this.output : null
    }

    this.busy = true
    this.lastSegmentAt = now
    let ts = now
    if (ts <= this.lastTs) ts = this.lastTs + 1
    this.lastTs = ts

    try {
      const { sw, sh } = this.ensureSegSize(vw, vh)
      const segCtx = this.segCtx
      if (!segCtx) throw new Error('no seg ctx')
      segCtx.drawImage(video, 0, 0, sw, sh)

      const result = this.segmenter.segmentForVideo(this.segInput, ts)
      this.composite(video, result)
      result.close()
    } catch {
      // Fall back to raw frame so the bubble never goes blank.
      const ctx = this.outCtx ?? get2d(this.output)
      this.outCtx = ctx
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
      const ctx = this.outCtx
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
      this.softMaskCanvas.width = mw
      this.softMaskCanvas.height = mh
      this.maskCtx = get2d(this.maskCanvas)
      this.softMaskCtx = get2d(this.softMaskCanvas)
      this.maskImageData = null
    }

    const maskCtx = this.maskCtx
    const softMaskCtx = this.softMaskCtx
    const blurCtx = this.blurCtx
    const personCtx = this.personCtx
    const outCtx = this.outCtx
    if (!maskCtx || !softMaskCtx || !blurCtx || !personCtx || !outCtx) {
      mask.close()
      return
    }

    const floats = mask.getAsFloat32Array()
    let imageData = this.maskImageData
    if (!imageData || imageData.width !== mw || imageData.height !== mh) {
      imageData = maskCtx.createImageData(mw, mh)
      this.maskImageData = imageData
    }
    const data = imageData.data
    for (let i = 0; i < floats.length; i++) {
      // Dilate slightly so subsequent feather doesn't shrink the subject inward.
      const v = Math.min(1, floats[i]! + MASK_DILATE)
      const a = Math.max(0, Math.min(255, Math.round(v * 255)))
      const o = i * 4
      data[o] = 255
      data[o + 1] = 255
      data[o + 2] = 255
      data[o + 3] = a
    }
    maskCtx.putImageData(imageData, 0, 0)
    mask.close()

    // Feather mask edges at mask resolution (cheap vs full-frame blur).
    softMaskCtx.clearRect(0, 0, mw, mh)
    softMaskCtx.filter = `blur(${MASK_FEATHER_PX}px)`
    softMaskCtx.drawImage(this.maskCanvas, 0, 0)
    softMaskCtx.filter = 'none'

    // Soft blurred background at reduced resolution, then upscale.
    blurCtx.save()
    blurCtx.filter = `blur(${BLUR_PX}px)`
    blurCtx.drawImage(video, 0, 0, this.blurCanvas.width, this.blurCanvas.height)
    blurCtx.restore()

    // Person cutout with feathered alpha (full output resolution).
    personCtx.clearRect(0, 0, vw, vh)
    personCtx.filter = 'none'
    personCtx.drawImage(video, 0, 0, vw, vh)
    personCtx.globalCompositeOperation = 'destination-in'
    personCtx.drawImage(this.softMaskCanvas, 0, 0, vw, vh)
    personCtx.globalCompositeOperation = 'source-over'

    outCtx.clearRect(0, 0, vw, vh)
    outCtx.imageSmoothingEnabled = true
    outCtx.drawImage(this.blurCanvas, 0, 0, vw, vh)
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
    this.outCtx = null
    this.blurCtx = null
    this.personCtx = null
    this.maskCtx = null
    this.softMaskCtx = null
    this.segCtx = null
    this.maskImageData = null
  }
}

/** Create a fresh segmenter (WASM loads once per call — only when blur is enabled). */
export async function createPersonBackgroundBlur(): Promise<PersonBackgroundBlur> {
  return PersonBackgroundBlur.create()
}

export function isBlurEffect(effect: BackgroundEffect | undefined): boolean {
  return effect === 'blur'
}
