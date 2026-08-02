import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import {
  keepSegmentsFromRemoves,
  type TimeRange,
} from './silenceDetect'

let ffmpegSingleton: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null

function coreBaseUrl(): string {
  // Files copied to dist/ffmpeg by vite publicDir / postinstall
  return chrome.runtime.getURL('ffmpeg')
}

export async function getFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegSingleton?.loaded) return ffmpegSingleton
  if (loading) return loading

  loading = (async () => {
    const ffmpeg = new FFmpeg()
    ffmpeg.on('log', ({ message }) => onLog?.(message))
    const base = coreBaseUrl()
    // Packaged extension URLs — do not use toBlobURL (MV3 forbids blob: in extension_pages CSP).
    // Vite rewrites the package Worker(import.meta.url) to a hashed asset under assets/.
    await ffmpeg.load({
      coreURL: `${base}/ffmpeg-core.js`,
      wasmURL: `${base}/ffmpeg-core.wasm`,
    })
    ffmpegSingleton = ffmpeg
    return ffmpeg
  })()

  try {
    return await loading
  } finally {
    loading = null
  }
}

export type EditPlan = {
  /** Keep from this time (seconds) */
  inSec: number
  /** Keep until this time (seconds) */
  outSec: number
  /** Optional range to remove inside the keep window */
  cutStartSec?: number | null
  cutEndSec?: number | null
  /** Extra ranges to remove (e.g. detected silences) */
  removeRanges?: TimeRange[]
  /** Optional noise reduction on export (ffmpeg afftdn) — stretch */
  noiseReduce?: boolean
}

function collectRemoves(plan: EditPlan): TimeRange[] {
  const ranges: TimeRange[] = [...(plan.removeRanges ?? [])]
  if (
    plan.cutStartSec != null &&
    plan.cutEndSec != null &&
    plan.cutEndSec > plan.cutStartSec
  ) {
    ranges.push({ start: plan.cutStartSec, end: plan.cutEndSec })
  }
  return ranges
}

export function planToKeepSegments(plan: EditPlan): TimeRange[] {
  return keepSegmentsFromRemoves(plan.inSec, plan.outSec, collectRemoves(plan))
}

/**
 * Trim and optional middle cuts via ffmpeg.wasm. Re-encodes to WebM (vp8/opus)
 * for predictable results across browsers.
 */
export async function exportEditedVideo(
  input: Blob,
  plan: EditPlan,
  onProgress?: (ratio: number) => void,
  onLog?: (msg: string) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onLog)
  const progressHandler = ({ progress }: { progress: number }) => onProgress?.(progress)
  ffmpeg.on('progress', progressHandler)

  const inName = 'input.webm'
  const outName = 'output.webm'

  const segments = planToKeepSegments(plan)
  if (segments.length === 0) {
    throw new Error('Nothing left to export — adjust trim or silence cuts.')
  }

  const noise = plan.noiseReduce ? ',afftdn=nf=-25' : ''

  // -y so a partial output.webm from an earlier failed export never blocks the next run.
  const run = async (args: string[]) => {
    await ffmpeg.exec(['-y', ...args])
  }

  try {
    await ffmpeg.writeFile(inName, await fetchFile(input))

    if (segments.length === 1 && !plan.noiseReduce) {
      const seg = segments[0]!
      try {
        await run([
          '-ss',
          String(seg.start),
          '-to',
          String(seg.end),
          '-i',
          inName,
          '-c:v',
          'libvpx',
          '-b:v',
          '2M',
          '-c:a',
          'libvorbis',
          outName,
        ])
      } catch {
        await run([
          '-ss',
          String(seg.start),
          '-to',
          String(seg.end),
          '-i',
          inName,
          '-c:v',
          'libvpx',
          '-b:v',
          '2M',
          '-an',
          outName,
        ])
      }
    } else {
      const tryChain = async (withAudio: boolean, noise: string) => {
        await run(buildConcatArgs(inName, outName, segments, withAudio, noise))
      }
      try {
        await tryChain(true, noise)
      } catch {
        try {
          // Retry without noise reduction if afftdn is unavailable in this ffmpeg build
          await tryChain(true, '')
        } catch {
          await tryChain(false, '')
        }
      }
    }

    const data = await ffmpeg.readFile(outName)
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    // Copy into a fresh ArrayBuffer-backed Uint8Array for Blob Part compatibility
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return new Blob([copy], { type: 'video/webm' })
  } finally {
    ffmpeg.off('progress', progressHandler)
    await ffmpeg.deleteFile(inName).catch(() => {})
    await ffmpeg.deleteFile(outName).catch(() => {})
  }
}

function buildConcatArgs(
  inName: string,
  outName: string,
  segments: TimeRange[],
  withAudio: boolean,
  audioExtra: string,
): string[] {
  const n = segments.length
  if (withAudio) {
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      const { start, end } = segments[i]!
      parts.push(
        `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`,
        `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS${audioExtra}[a${i}]`,
      )
    }
    const maps = segments.map((_, i) => `[v${i}][a${i}]`).join('')
    parts.push(`${maps}concat=n=${n}:v=1:a=1[outv][outa]`)
    return [
      '-i',
      inName,
      '-filter_complex',
      parts.join(';'),
      '-map',
      '[outv]',
      '-map',
      '[outa]',
      '-c:v',
      'libvpx',
      '-b:v',
      '2M',
      '-c:a',
      'libvorbis',
      outName,
    ]
  }

  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const { start, end } = segments[i]!
    parts.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`)
  }
  const maps = segments.map((_, i) => `[v${i}]`).join('')
  parts.push(`${maps}concat=n=${n}:v=1:a=0[outv]`)
  return [
    '-i',
    inName,
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[outv]',
    '-c:v',
    'libvpx',
    '-b:v',
    '2M',
    '-an',
    outName,
  ]
}

export function estimateOutputDuration(plan: EditPlan): number {
  return planToKeepSegments(plan).reduce((sum, s) => sum + (s.end - s.start), 0)
}
