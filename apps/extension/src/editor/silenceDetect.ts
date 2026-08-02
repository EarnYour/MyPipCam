export type TimeRange = { start: number; end: number }

export type SilenceDetectOptions = {
  /** RMS below this fraction of peak is treated as silence (0–1). Default 0.02 */
  threshold?: number
  /** Minimum silence length in seconds. Default 0.45 */
  minSilenceSec?: number
  /** Analysis window size in seconds. Default 0.05 */
  hopSec?: number
  /** Padding to keep around speech edges (seconds). Default 0.08 */
  paddingSec?: number
}

/**
 * Decode audio from a media blob and find silent ranges via RMS energy.
 * Works client-side with Web Audio — no network.
 */
export async function detectSilenceRanges(
  blob: Blob,
  options: SilenceDetectOptions = {},
): Promise<TimeRange[]> {
  const threshold = options.threshold ?? 0.02
  const minSilenceSec = options.minSilenceSec ?? 0.45
  const hopSec = options.hopSec ?? 0.05
  const paddingSec = options.paddingSec ?? 0.08

  const buffer = await decodeAudio(blob)
  const channel = mixToMono(buffer)
  const sampleRate = buffer.sampleRate
  const hop = Math.max(1, Math.floor(hopSec * sampleRate))

  let peak = 0
  for (let i = 0; i < channel.length; i++) {
    const a = Math.abs(channel[i]!)
    if (a > peak) peak = a
  }
  if (peak < 1e-6) {
    // Entirely silent — propose cutting everything except a tiny head/tail keep
    const dur = buffer.duration
    if (dur <= minSilenceSec * 2) return []
    return [{ start: paddingSec, end: Math.max(paddingSec, dur - paddingSec) }]
  }

  const silentFlags: boolean[] = []
  for (let i = 0; i < channel.length; i += hop) {
    const end = Math.min(channel.length, i + hop)
    let sum = 0
    for (let j = i; j < end; j++) {
      const s = channel[j]!
      sum += s * s
    }
    const rms = Math.sqrt(sum / Math.max(1, end - i))
    silentFlags.push(rms / peak < threshold)
  }

  const raw: TimeRange[] = []
  let i = 0
  while (i < silentFlags.length) {
    if (!silentFlags[i]) {
      i++
      continue
    }
    const startIdx = i
    while (i < silentFlags.length && silentFlags[i]) i++
    const start = (startIdx * hop) / sampleRate
    const end = (i * hop) / sampleRate
    if (end - start >= minSilenceSec) {
      raw.push({
        start: Math.min(buffer.duration, start + paddingSec),
        end: Math.max(0, end - paddingSec),
      })
    }
  }

  return raw.filter((r) => r.end > r.start && r.end - r.start >= minSilenceSec * 0.5)
}

async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const ctx = new AudioContext()
  try {
    const ab = await blob.arrayBuffer()
    return await ctx.decodeAudioData(ab.slice(0))
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const len = buffer.length
  const out = new Float32Array(len)
  const n = buffer.numberOfChannels
  for (let c = 0; c < n; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < len; i++) {
      out[i]! += data[i]! / n
    }
  }
  return out
}

/** Normalize an unordered pair into a TimeRange. */
export function normalizeRange(a: number, b: number): TimeRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

/** Merge overlapping/adjacent ranges (sorted). */
export function mergeRanges(ranges: TimeRange[], gap = 0.02): TimeRange[] {
  const sorted = [...ranges]
    .filter((r) => r.end > r.start + gap)
    .sort((a, b) => a.start - b.start)
  const merged: TimeRange[] = []
  for (const r of sorted) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + gap) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ ...r })
    }
  }
  return merged
}

/** Merge overlapping/adjacent remove ranges, then invert into keep segments within [inSec, outSec]. */
export function keepSegmentsFromRemoves(
  inSec: number,
  outSec: number,
  removes: TimeRange[],
): TimeRange[] {
  const merged = mergeRanges(
    removes.map((r) => ({
      start: Math.max(inSec, r.start),
      end: Math.min(outSec, r.end),
    })),
  )

  const keeps: TimeRange[] = []
  let cursor = inSec
  for (const r of merged) {
    if (r.start > cursor + 0.02) {
      keeps.push({ start: cursor, end: r.start })
    }
    cursor = Math.max(cursor, r.end)
  }
  if (outSec > cursor + 0.02) {
    keeps.push({ start: cursor, end: outSec })
  }
  return keeps
}

/** True when t falls inside any range (half-open [start, end)). */
export function rangeContaining(ranges: TimeRange[], t: number): TimeRange | null {
  for (const r of ranges) {
    if (t >= r.start && t < r.end) return r
  }
  return null
}
