/**
 * MV3 service workers have no DOM. Vite wraps dynamic import() with a preload
 * helper that touches document/window — that throws during SW evaluation and
 * fails registration (status 15 / "document is not defined").
 *
 * Rewrite dist SW boot to a plain import('./main-*.js').
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist')
const loaderPath = path.join(outDir, 'service-worker-loader.js')

if (!fs.existsSync(loaderPath)) {
  console.error('[strip-sw-vite-preload] missing service-worker-loader.js')
  process.exit(1)
}

const loader = fs.readFileSync(loaderPath, 'utf8')
const bootMatch = loader.match(/import\s+['"](\.\/assets\/[^'"]+)['"]/)
if (!bootMatch) {
  console.error('[strip-sw-vite-preload] could not resolve SW boot chunk')
  process.exit(1)
}

const bootRel = bootMatch[1]
const bootPath = path.join(outDir, bootRel)
let code = fs.readFileSync(bootPath, 'utf8')

if (!/document\.(createElement|querySelector|getElementsByTagName|head)/.test(code)) {
  console.log(`[strip-sw-vite-preload] ${bootRel} already DOM-free`)
  process.exit(0)
}

const wrapped = code.match(
  /[A-Za-z_$][\w$]*\(\s*\(\)\s*=>\s*(import\s*\(\s*["'][^"']+["']\s*\))\s*,\s*(?:__vite__mapDeps\(\[[^\]]*\]\)|\[[^\]]*\])\s*(?:,\s*import\.meta\.url)?\s*\)/,
)
if (!wrapped) {
  console.error(
    '[strip-sw-vite-preload] expected Vite preload wrapper around import("./main")',
  )
  process.exit(1)
}
code = code.replace(wrapped[0], wrapped[1])

// Vite inlines: const scriptRel=...,assetsURL=...,seen={},preload=...,keepalive=...
// Keep `const` so the keepalive binding stays valid.
code = code.replace(
  /const\s+[A-Za-z_$][\w$]*\s*=\s*\(function\s*\(\)\s*\{const\s+\w+=typeof document<"u"[\s\S]*?,\s*(?=[A-Za-z_$][\w$]*="mypipcam-sw-keepalive")/,
  'const ',
)

code = code.replace(
  /const __vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=\[[\s\S]*?\]\)\)\)=>i\.map\(i=>d\[i\]\);\s*/g,
  '',
)

code = code.replace(
  /import\s*\{[^}]*\}\s*from\s*["'][^"']*preload-helper[^"']*["'];?/g,
  '',
)

if (/document\.(createElement|querySelector|getElementsByTagName|head)/.test(code)) {
  console.error('[strip-sw-vite-preload] SW boot still references document after strip')
  process.exit(1)
}

if (!/import\s*\(\s*["']\.\/main-[^"']+\.js["']\s*\)/.test(code)) {
  console.error('[strip-sw-vite-preload] plain import("./main-*.js") missing after strip')
  process.exit(1)
}

fs.writeFileSync(bootPath, code)
console.log(`[strip-sw-vite-preload] stripped Vite document preload from ${bootRel}`)
