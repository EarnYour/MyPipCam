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
  if (ffmpegSingleton?.loaded) {
    if (onLog) {
      // Replace prior log listener by attaching a fresh one (ffmpeg allows multiple).
      ffmpegSingleton.on('log', ({ message }) => onLog(message))
    }
    return ffmpegSingleton
  }
  if (loading) return loading

  loading = (async () => {
    const ffmpeg = new FFmpeg()
    if (onLog) ffmpeg.on('log', ({ message }) => onLog(message))
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
  /** Manual cut-out ranges (remove middle pieces; concatenated keeps on export) */
  cutRanges?: TimeRange[]
  /** @deprecated Prefer cutRanges — single middle cut for older callers */
  cutStartSec?: number | null
  cutEndSec?: number | null
  /** Extra ranges to remove (e.g. detected silences / fillers) */
  removeRanges?: TimeRange[]
  /** Optional noise reduction on export (ffmpeg afftdn) — stretch */
  noiseReduce?: boolean
}

function collectRemoves(plan: EditPlan): TimeRange[] {
  const ranges: TimeRange[] = [
    ...(plan.cutRanges ?? []),
    ...(plan.removeRanges ?? []),
  ]
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

async function safeDelete(ffmpeg: FFmpeg, name: string) {
  try {
    await ffmpeg.deleteFile(name)
  } catch {
    // ignore missing
  }
}

/**
 * Trim and optional middle cuts via ffmpeg.wasm. Re-encodes to WebM (vp8/vorbis)
 * for predictable results across browsers.
 */
export async function exportEditedVideo(
  input: Blob,
  plan: EditPlan,
  onProgress?: (ratio: number) => void,
  onLog?: (msg: string) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg(onLog)
  // Named so it can be removed in `finally` — the ffmpeg instance is a
  // singleton, so an anonymous listener per export accumulates forever and
  // every later export fires every earlier export's progress callback.
  const progressHandler = ({ progress }: { progress: number }) =>
    onProgress?.(Math.min(1, Math.max(0, progress)))
  ffmpeg.on('progress', progressHandler)

  const inName = 'input.webm'
  const outName = 'output.webm'

  try {
    // Stale files from an earlier failed export would otherwise poison this one.
    await safeDelete(ffmpeg, inName)
    await safeDelete(ffmpeg, outName)
    await ffmpeg.writeFile(inName, await fetchFile(input))

    const segments = planToKeepSegments(plan)
    if (segments.length === 0) {
      throw new Error('Nothing left to export — adjust trim, silence, or filler cuts.')
    }

    // Guard absurd plans (all cuts / float noise).
    const totalKeep = segments.reduce((sum, s) => sum + (s.end - s.start), 0)
    if (totalKeep < 0.05) {
      throw new Error('Output would be under 0.05s — loosen your cuts.')
    }

    const noise = plan.noiseReduce ? ',afftdn=nf=-25' : ''

    const run = async (args: string[]) => {
      await safeDelete(ffmpeg, outName)
      await ffmpeg.exec(args)
    }

    onLog?.(`Exporting ${segments.length} segment(s)…`)

    if (segments.length === 1 && !plan.noiseReduce) {
      const seg = segments[0]!
      // Input-seek for speed, then accurate -to as absolute timestamp.
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
        // Retry with decode-then-seek (more accurate) + video-only fallback.
        try {
          await run([
            '-i',
            inName,
            '-ss',
            String(seg.start),
            '-to',
            String(seg.end),
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
            '-i',
            inName,
            '-ss',
            String(seg.start),
            '-to',
            String(seg.end),
            '-c:v',
            'libvpx',
            '-b:v',
            '2M',
            '-an',
            outName,
          ])
        }
      }
    } else {
      const tryChain = async (withAudio: boolean, noiseExtra: string) => {
        await run(buildConcatArgs(inName, outName, segments, withAudio, noiseExtra))
      }
      try {
        await tryChain(true, noise)
      } catch {
        try {
          // Retry without noise reduction if afftdn is unavailable in this ffmpeg build
          onLog?.('Retrying export without noise reduction…')
          await tryChain(true, '')
        } catch {
          onLog?.('Retrying export without audio…')
          await tryChain(false, '')
        }
      }
    }

    const data = await ffmpeg.readFile(outName)
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    if (bytes.byteLength < 32) {
      throw new Error(
        'Export produced an empty file. Try a simpler trim or disable noise reduction.',
      )
    }
    // Copy into a fresh ArrayBuffer-backed Uint8Array for Blob Part compatibility
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return new Blob([copy], { type: 'video/webm' })
  } finally {
    // Runs on the throw paths too, so a failed export leaves no MEMFS residue.
    ffmpeg.off('progress', progressHandler)
    await safeDelete(ffmpeg, inName)
    await safeDelete(ffmpeg, outName)
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
      // Clamp tiny float noise; ffmpeg trim is exclusive on end.
      const s = Math.max(0, start)
      const e = Math.max(s + 0.02, end)
      parts.push(
        `[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`,
        `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS${audioExtra}[a${i}]`,
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
    const s = Math.max(0, start)
    const e = Math.max(s + 0.02, end)
    parts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`)
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
