/**
 * MV3 service workers reject dynamic import() (HTML spec /
 * ServiceWorkerGlobalScope). Walk the production SW module graph and fail if
 * any file contains import( — static import '…' is allowed.
 *
 * Also guards the recording overlay inject path: executeScript must use the
 * stable classic IIFE (src/content/pipOverlay.js), never a CRX ESM loader
 * (assets/*-loader-*.js / *ts-loader*).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist')
const loaderPath = path.join(outDir, 'service-worker-loader.js')
const STABLE_OVERLAY = 'src/content/pipOverlay.js'
const stableOverlayPath = path.join(outDir, STABLE_OVERLAY)

if (!fs.existsSync(loaderPath)) {
  console.error('[verify-sw] missing service-worker-loader.js')
  process.exit(1)
}

if (!fs.existsSync(stableOverlayPath)) {
  console.error(`[verify-sw] missing stable overlay IIFE: ${STABLE_OVERLAY}`)
  process.exit(1)
}

const overlayCode = fs.readFileSync(stableOverlayPath, 'utf8')
if (!/\(function\s*\(/.test(overlayCode) && !/\(function\(\)/.test(overlayCode)) {
  console.error(
    `[verify-sw] ${STABLE_OVERLAY} does not look like a classic IIFE bundle`,
  )
  process.exit(1)
}
if (/\bimport\s*\{/.test(overlayCode) || /\bimport\s*\(/.test(overlayCode)) {
  console.error(
    `[verify-sw] ${STABLE_OVERLAY} still contains ESM import — not injectable via executeScript`,
  )
  process.exit(1)
}

/** @type {Set<string>} */
const visited = new Set()
/** @type {string[]} */
const queue = [loaderPath]
/** @type {string[]} */
const dynamicHits = []
/** @type {string[]} */
const blurHits = []
/** @type {string[]} */
const unresolved = []
/** @type {string[]} */
const loaderHits = []
/** @type {string[]} */
const swFiles = []

const staticImportRe =
  /\bimport\s*(?:(?:type\s+)?[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']/g
const sideEffectImportRe = /\bimport\s*["']([^"']+)["']/g
const dynamicImportRe = /\bimport\s*\(/g
const forbiddenOverlayPathRe =
  /pipOverlay[^"'`\s]*loader|ts-loader|assets\/pipOverlay\.ts-loader/i

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null
  const base = path.resolve(path.dirname(fromFile), spec)
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base
  for (const ext of ['.js', '.mjs']) {
    if (fs.existsSync(base + ext)) return base + ext
  }
  return null
}

while (queue.length) {
  const file = queue.pop()
  if (!file || visited.has(file)) continue
  visited.add(file)
  swFiles.push(file)

  const code = fs.readFileSync(file, 'utf8')
  const rel = path.relative(outDir, file)

  if (dynamicImportRe.test(code)) {
    dynamicHits.push(rel)
  }
  // Reset lastIndex — /g regex retains state across test/exec.
  dynamicImportRe.lastIndex = 0

  if (/backgroundBlur/i.test(code) || /getSegmentationReady/.test(code)) {
    blurHits.push(rel)
  }

  if (forbiddenOverlayPathRe.test(code)) {
    loaderHits.push(rel)
  }

  for (const re of [staticImportRe, sideEffectImportRe]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code))) {
      const spec = m[1]
      // Bare specifiers are bundled away by Vite; only relative/absolute
      // specifiers should appear, and each must resolve to a real file.
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue
      const next = resolveImport(file, spec)
      if (!next) {
        unresolved.push(`${rel} -> ${spec}`)
        continue
      }
      if (!visited.has(next)) queue.push(next)
    }
  }
}

// The loader is a one-line re-export; if we only ever saw that file, the graph
// walk silently missed the real SW bundle and every check below is vacuous.
if (visited.size < 2) {
  console.error(
    `[verify-sw] SW graph has only ${visited.size} file(s) — the walk did not reach the SW bundle, so these checks prove nothing`,
  )
  process.exit(1)
}

if (unresolved.length) {
  console.error(
    '[verify-sw] unresolved imports in SW graph (walk incomplete):',
    unresolved.join(', '),
  )
  process.exit(1)
}

const swConcat = swFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
if (!swConcat.includes(JSON.stringify(STABLE_OVERLAY)) && !swConcat.includes(STABLE_OVERLAY)) {
  console.error(
    `[verify-sw] SW graph must embed stable overlay path ${JSON.stringify(STABLE_OVERLAY)}`,
  )
  process.exit(1)
}

// Dist must not contain CRX ESM loaders for the overlay.
const distLoaderFiles = []
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p)
    else if (/pipOverlay/i.test(ent.name) && /loader/i.test(ent.name)) {
      distLoaderFiles.push(path.relative(outDir, p))
    }
  }
}
walk(outDir)

let failed = false
if (dynamicHits.length) {
  failed = true
  console.error(
    '[verify-sw] dynamic import() found in SW graph (forbidden):',
    dynamicHits.join(', '),
  )
}
if (blurHits.length) {
  failed = true
  console.error(
    '[verify-sw] backgroundBlur / getSegmentationReady must not be in SW graph:',
    blurHits.join(', '),
  )
}
if (loaderHits.length) {
  failed = true
  console.error(
    '[verify-sw] SW graph references forbidden pipOverlay loader path:',
    loaderHits.join(', '),
  )
}
if (distLoaderFiles.length) {
  failed = true
  console.error(
    '[verify-sw] dist contains pipOverlay loader files (forbidden):',
    distLoaderFiles.join(', '),
  )
}

if (failed) process.exit(1)

// Drop orphan CRX ESM chunks for the overlay (IIFE is the only inject target).
// These can appear as assets/pipOverlay.ts-<hash>.js from emitFile(chunk).
for (const ent of fs.readdirSync(path.join(outDir, 'assets'), { withFileTypes: true })) {
  if (!ent.isFile()) continue
  if (/^pipOverlay\.ts-[A-Za-z0-9_-]+\.js$/.test(ent.name)) {
    const orphan = path.join(outDir, 'assets', ent.name)
    const referenced = swConcat.includes(ent.name)
    if (!referenced) {
      fs.unlinkSync(orphan)
      console.log(`[verify-sw] removed orphan ESM chunk assets/${ent.name}`)
    } else {
      failed = true
      console.error(
        `[verify-sw] SW still references orphan ESM overlay chunk assets/${ent.name}`,
      )
    }
  }
}
if (failed) process.exit(1)

console.log(
  `[verify-sw] OK — ${visited.size} SW modules, stable overlay ${STABLE_OVERLAY}, no loaders`,
)
for (const f of [...visited].sort()) {
  console.log(`  - ${path.relative(outDir, f)}`)
}
