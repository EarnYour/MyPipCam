/**
 * MV3 service workers reject dynamic import() (HTML spec /
 * ServiceWorkerGlobalScope). Walk the production SW module graph and fail if
 * any file contains import( — static import '…' is allowed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist')
const loaderPath = path.join(outDir, 'service-worker-loader.js')

if (!fs.existsSync(loaderPath)) {
  console.error('[verify-sw] missing service-worker-loader.js')
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

const staticImportRe =
  /\bimport\s*(?:(?:type\s+)?[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']/g
const sideEffectImportRe = /\bimport\s*["']([^"']+)["']/g
const dynamicImportRe = /\bimport\s*\(/g

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

if (failed) process.exit(1)

console.log(
  `[verify-sw] OK — ${visited.size} SW modules, no dynamic import(), no backgroundBlur`,
)
for (const f of [...visited].sort()) {
  console.log(`  - ${path.relative(outDir, f)}`)
}
