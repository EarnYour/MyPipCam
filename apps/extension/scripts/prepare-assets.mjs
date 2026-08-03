import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// postinstall runs with --tolerant so `npm install` still succeeds offline;
// dev/build run without it and must fail loudly on a missing or corrupt asset
// rather than shipping a build whose blur/export silently breaks at runtime.
const tolerant = process.argv.includes('--tolerant')
const problems = []

function assetProblem(message) {
  problems.push(message)
  console.warn(tolerant ? `${message} (tolerated)` : message)
}
const iconsDir = join(root, 'public', 'icons')
const ffmpegDir = join(root, 'public', 'ffmpeg')
const mediapipeWasmDir = join(root, 'public', 'mediapipe', 'wasm')
const mediapipeModelsDir = join(root, 'public', 'mediapipe', 'models')

mkdirSync(iconsDir, { recursive: true })
mkdirSync(ffmpegDir, { recursive: true })
mkdirSync(mediapipeWasmDir, { recursive: true })
mkdirSync(mediapipeModelsDir, { recursive: true })

/** Brand colors */
const BRAND = [255, 94, 41] // #ff5e29
const SCREEN = [17, 19, 18] // #111312
const DISPLAY = [250, 250, 247] // #fafaf7

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    }
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function dist(x, y, cx, cy) {
  const dx = x - cx
  const dy = y - cy
  return Math.sqrt(dx * dx + dy * dy)
}

/** Signed distance to rounded rect (negative = inside). */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r
  const dy = Math.abs(y - cy) - hh + r
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r
}

/**
 * Screen square with a PiP camera dot in the bottom-left.
 * Returns [r,g,b,a] with a in 0..1. Outside the screen is transparent.
 */
function sampleIcon(nx, ny) {
  const soft = (d) => Math.max(0, Math.min(1, 0.5 - d * 64))

  // Outer screen body (rounded square)
  const body = sdRoundRect(nx, ny, 0.5, 0.5, 0.4, 0.37, 0.12)
  const bodyA = soft(body)
  if (bodyA <= 0) return [0, 0, 0, 0]

  // Inner display
  const display = sdRoundRect(nx, ny, 0.5, 0.46, 0.32, 0.26, 0.08)
  const displayA = soft(display)

  // PiP cam dot — bottom-left of the display
  const pip = dist(nx, ny, 0.34, 0.6) - 0.115
  const pipA = soft(pip)

  let r = SCREEN[0]
  let g = SCREEN[1]
  let b = SCREEN[2]

  if (displayA > 0) {
    const t = displayA
    r = Math.round(r * (1 - t) + DISPLAY[0] * t)
    g = Math.round(g * (1 - t) + DISPLAY[1] * t)
    b = Math.round(b * (1 - t) + DISPLAY[2] * t)
  }

  if (pipA > 0) {
    const t = pipA
    r = Math.round(r * (1 - t) + BRAND[0] * t)
    g = Math.round(g * (1 - t) + BRAND[1] * t)
    b = Math.round(b * (1 - t) + BRAND[2] * t)
  }

  return [r, g, b, bodyA]
}

function writePng(size, path) {
  const ss = size <= 32 ? 4 : 3 // supersample factor
  const big = size * ss
  const samples = new Float32Array(size * size * 4)

  for (let sy = 0; sy < big; sy++) {
    for (let sx = 0; sx < big; sx++) {
      const nx = (sx + 0.5) / big
      const ny = (sy + 0.5) / big
      const [r, g, b, a] = sampleIcon(nx, ny)
      const x = Math.floor(sx / ss)
      const y = Math.floor(sy / ss)
      const i = (y * size + x) * 4
      samples[i] += r * a
      samples[i + 1] += g * a
      samples[i + 2] += b * a
      samples[i + 3] += a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  const row = size * 4 + 1
  const raw = Buffer.alloc(row * size)
  const inv = 1 / (ss * ss)

  for (let y = 0; y < size; y++) {
    raw[y * row] = 0
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4
      const aSum = samples[si + 3] * inv
      const i = y * row + 1 + x * 4
      if (aSum < 0.002) {
        raw[i] = 0
        raw[i + 1] = 0
        raw[i + 2] = 0
        raw[i + 3] = 0
        continue
      }
      // Un-premultiply for PNG store
      const a = Math.min(1, aSum)
      raw[i] = Math.round(Math.min(255, (samples[si] * inv) / a))
      raw[i + 1] = Math.round(Math.min(255, (samples[si + 1] * inv) / a))
      raw[i + 2] = Math.round(Math.min(255, (samples[si + 2] * inv) / a))
      raw[i + 3] = Math.round(a * 255)
    }
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  writeFileSync(path, png)
}

for (const size of [16, 32, 48, 128]) {
  writePng(size, join(iconsDir, `icon${size}.png`))
}

const coreCandidates = [
  join(root, 'node_modules/@ffmpeg/core/dist/umd'),
  join(root, 'node_modules/@ffmpeg/core/dist/esm'),
]

let copied = false
for (const dir of coreCandidates) {
  const js = join(dir, 'ffmpeg-core.js')
  const wasm = join(dir, 'ffmpeg-core.wasm')
  if (existsSync(js) && existsSync(wasm)) {
    copyFileSync(js, join(ffmpegDir, 'ffmpeg-core.js'))
    copyFileSync(wasm, join(ffmpegDir, 'ffmpeg-core.wasm'))
    copied = true
    console.log(`Copied ffmpeg core from ${dir}`)
    break
  }
}

if (!copied) {
  assetProblem(
    'ffmpeg core not found — run npm install (@ffmpeg/core), then npm run prepare-assets',
  )
}

/** MediaPipe Image Segmenter WASM (SIMD + nosimd). ~21MB total — loaded only when blur is on. */
const mediapipeWasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const mediapipeWasmFiles = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
]
let mediapipeCopied = 0
if (existsSync(mediapipeWasmSrc)) {
  for (const name of mediapipeWasmFiles) {
    const src = join(mediapipeWasmSrc, name)
    if (existsSync(src)) {
      copyFileSync(src, join(mediapipeWasmDir, name))
      mediapipeCopied += 1
    }
  }
}
if (mediapipeCopied === mediapipeWasmFiles.length) {
  console.log(`Copied MediaPipe vision WASM (${mediapipeCopied} files)`)
} else {
  assetProblem(
    'MediaPipe WASM incomplete — run npm install (@mediapipe/tasks-vision), then npm run prepare-assets',
  )
}

const selfieModel = join(mediapipeModelsDir, 'selfie_segmenter.tflite')

// Pinned to model revision 1, not "latest": the build fetches this over the
// network into the shipped extension, so an upstream change must not silently
// alter what we publish. Update URL and hash together after verifying a new
// revision. sha256 of float16/1/selfie_segmenter.tflite (249537 bytes).
const SELFIE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'
const SELFIE_MODEL_SHA256 =
  '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b'

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function ensureSelfieModel() {
  if (existsSync(selfieModel)) {
    const actual = sha256(readFileSync(selfieModel))
    if (actual === SELFIE_MODEL_SHA256) {
      console.log('MediaPipe selfie_segmenter.tflite present (checksum ok)')
      return
    }
    console.warn(
      `selfie_segmenter.tflite checksum mismatch (${actual}) — re-downloading pinned revision`,
    )
    rmSync(selfieModel, { force: true })
  }
  try {
    const res = await fetch(SELFIE_MODEL_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const actual = sha256(buf)
    if (actual !== SELFIE_MODEL_SHA256) {
      throw new Error(
        `checksum mismatch: expected ${SELFIE_MODEL_SHA256}, got ${actual}`,
      )
    }
    writeFileSync(selfieModel, buf)
    console.log('Downloaded selfie_segmenter.tflite (checksum verified)')
  } catch (err) {
    assetProblem(
      `Could not fetch a verified selfie_segmenter.tflite — background blur will not work: ${
        err instanceof Error ? err.message : err
      }`,
    )
  }
}

await ensureSelfieModel()

console.log('Icons written to public/icons (RGBA transparent)')

if (problems.length && !tolerant) {
  console.error(
    `\nprepare-assets failed — ${problems.length} asset problem(s):\n` +
      problems.map((p) => `  - ${p}`).join('\n'),
  )
  process.exit(1)
}
