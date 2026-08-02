/**
 * Mid-take / save-time helpers for Loom-style rewind & trim.
 * Uses ffmpeg.wasm (same core as the editor) when sealed WebM parts must be
 * trimmed or concatenated. Active MediaRecorder chunks can be sliced without ffmpeg.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { getFFmpeg } from '../editor/ffmpegExport'

export type RecordingPart = {
  blob: Blob
  durationMs: number
}

async function safeDelete(ffmpeg: FFmpeg, name: string) {
  try {
    await ffmpeg.deleteFile(name)
  } catch {
    /* missing */
  }
}

/** Best-effort duration from a blob (Chrome MediaRecorder WebM is usually readable). */
export async function measureBlobDurationMs(blob: Blob): Promise<number | null> {
  if (blob.size < 64) return null
  const url = URL.createObjectURL(blob)
  try {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    video.src = url
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      video.onloadedmetadata = done
      video.onerror = done
      window.setTimeout(done, 1800)
    })
    const d = video.duration
    if (!Number.isFinite(d) || d <= 0) return null
    return Math.round(d * 1000)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Slice ~1s MediaRecorder timeslice chunks to approximately keepMs.
 * First chunk includes the WebM header — always keep at least one when keepMs > 0.
 */
export function sliceTimesliceChunks(
  chunks: Blob[],
  keepMs: number,
  mimeType: string,
): RecordingPart | null {
  if (chunks.length === 0 || keepMs <= 0) return null
  const n = Math.max(1, Math.min(chunks.length, Math.round(keepMs / 1000)))
  const kept = chunks.slice(0, n)
  const blob = new Blob(kept, { type: mimeType || 'video/webm' })
  if (blob.size < 64) return null
  return { blob, durationMs: Math.min(keepMs, n * 1000) }
}

/** Trim a sealed recording blob to [0, outSec] via ffmpeg (re-encode for reliability). */
export async function trimBlobToSeconds(
  input: Blob,
  outSec: number,
  onLog?: (msg: string) => void,
): Promise<Blob> {
  const end = Math.max(0.05, outSec)
  const ffmpeg = await getFFmpeg(onLog)
  const inName = 'live_trim_in.webm'
  const outName = 'live_trim_out.webm'
  await safeDelete(ffmpeg, inName)
  await safeDelete(ffmpeg, outName)
  await ffmpeg.writeFile(inName, await fetchFile(input))

  const run = async (args: string[]) => {
    await safeDelete(ffmpeg, outName)
    await ffmpeg.exec(args)
  }

  try {
    await run([
      '-i',
      inName,
      '-t',
      String(end),
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
      '-t',
      String(end),
      '-c:v',
      'libvpx',
      '-b:v',
      '2M',
      '-an',
      outName,
    ])
  }

  const data = await ffmpeg.readFile(outName)
  await safeDelete(ffmpeg, inName)
  await safeDelete(ffmpeg, outName)
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type: 'video/webm' })
}

/** Concatenate sealed WebM parts into one file (re-encode). */
export async function concatRecordingParts(
  parts: RecordingPart[],
  onLog?: (msg: string) => void,
): Promise<Blob> {
  if (parts.length === 0) throw new Error('No recording parts to concat')
  if (parts.length === 1) return parts[0]!.blob

  const ffmpeg = await getFFmpeg(onLog)
  const inNames: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const name = `live_part_${i}.webm`
    inNames.push(name)
    await safeDelete(ffmpeg, name)
    await ffmpeg.writeFile(name, await fetchFile(parts[i]!.blob))
  }
  const outName = 'live_concat_out.webm'
  await safeDelete(ffmpeg, outName)

  const n = parts.length
  const filterParts: string[] = []
  for (let i = 0; i < n; i++) {
    filterParts.push(
      `[${i}:v]setpts=PTS-STARTPTS[v${i}]`,
      `[${i}:a]asetpts=PTS-STARTPTS[a${i}]`,
    )
  }
  const maps = parts.map((_, i) => `[v${i}][a${i}]`).join('')
  filterParts.push(`${maps}concat=n=${n}:v=1:a=1[outv][outa]`)

  const args = [
    ...inNames.flatMap((name) => ['-i', name]),
    '-filter_complex',
    filterParts.join(';'),
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

  try {
    await ffmpeg.exec(args)
  } catch {
    // Audio-less fallback
    const vParts: string[] = []
    for (let i = 0; i < n; i++) {
      vParts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`)
    }
    const vMaps = parts.map((_, i) => `[v${i}]`).join('')
    vParts.push(`${vMaps}concat=n=${n}:v=1:a=0[outv]`)
    await safeDelete(ffmpeg, outName)
    await ffmpeg.exec([
      ...inNames.flatMap((name) => ['-i', name]),
      '-filter_complex',
      vParts.join(';'),
      '-map',
      '[outv]',
      '-c:v',
      'libvpx',
      '-b:v',
      '2M',
      '-an',
      outName,
    ])
  }

  const data = await ffmpeg.readFile(outName)
  for (const name of inNames) await safeDelete(ffmpeg, name)
  await safeDelete(ffmpeg, outName)
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type: 'video/webm' })
}

export function partsDurationMs(parts: RecordingPart[]): number {
  return parts.reduce((sum, p) => sum + Math.max(0, p.durationMs), 0)
}
