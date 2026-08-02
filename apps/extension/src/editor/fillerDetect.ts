import type { TranscriptWord } from '../shared/types'
import type { TimeRange } from './silenceDetect'

/** Core vocal fillers — always matched as whole tokens. */
const CORE_FILLERS = new Set([
  'um',
  'uh',
  'uhm',
  'erm',
  'er',
  'ah',
  'ahh',
  'hmm',
  'hm',
  'mm',
  'mmm',
  'mhm',
  'uhhuh',
  'uh-huh',
])

/** Extended conversational fillers (optional). */
const EXTENDED_FILLERS = new Set([
  'like',
  'basically',
  'actually',
  'literally',
  'right',
  'okay',
  'ok',
  'so',
])

/** Multi-token filler phrases (normalized tokens). */
const FILLER_PHRASES: string[][] = [
  ['you', 'know'],
  ['i', 'mean'],
  ['kind', 'of'],
  ['sort', 'of'],
]

export type FillerDetectOptions = {
  /** Include like / you know / basically / etc. Default true. */
  includeExtended?: boolean
  /** Extra time removed around each filler (seconds). Default 0.04 */
  paddingSec?: number
  /** Merge fillers closer than this gap (seconds). Default 0.12 */
  mergeGapSec?: number
}

export function normalizeTranscriptToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '')
    .replace(/'/g, '')
}

function isFillerToken(token: string, includeExtended: boolean): boolean {
  if (!token) return false
  if (CORE_FILLERS.has(token)) return true
  if (includeExtended && EXTENDED_FILLERS.has(token)) return true
  return false
}

/**
 * Find filler-word ranges from Whisper word timings.
 * Returns empty if there are no words (caller should re-transcribe).
 */
export function detectFillerRanges(
  words: TranscriptWord[] | undefined,
  options: FillerDetectOptions = {},
): TimeRange[] {
  if (!words?.length) return []

  const includeExtended = options.includeExtended ?? true
  const paddingSec = options.paddingSec ?? 0.04
  const mergeGapSec = options.mergeGapSec ?? 0.12

  const tokens = words.map((w) => ({
    start: w.start,
    end: w.end,
    token: normalizeTranscriptToken(w.word),
  }))

  const hit = new Array(tokens.length).fill(false)

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (isFillerToken(t.token, includeExtended)) hit[i] = true
  }

  if (includeExtended) {
    for (const phrase of FILLER_PHRASES) {
      for (let i = 0; i <= tokens.length - phrase.length; i++) {
        let match = true
        for (let j = 0; j < phrase.length; j++) {
          if (tokens[i + j]!.token !== phrase[j]) {
            match = false
            break
          }
        }
        if (match) {
          for (let j = 0; j < phrase.length; j++) hit[i + j] = true
        }
      }
    }
  }

  const raw: TimeRange[] = []
  let i = 0
  while (i < hit.length) {
    if (!hit[i]) {
      i++
      continue
    }
    const startIdx = i
    while (i < hit.length && hit[i]) i++
    const start = Math.max(0, tokens[startIdx]!.start - paddingSec)
    const end = tokens[i - 1]!.end + paddingSec
    if (end > start + 0.02) raw.push({ start, end })
  }

  return mergeRanges(raw, mergeGapSec)
}

function mergeRanges(ranges: TimeRange[], gapSec: number): TimeRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: TimeRange[] = [{ ...sorted[0]! }]
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i]!
    const last = out[out.length - 1]!
    if (r.start <= last.end + gapSec) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

export function countFillerHits(
  words: TranscriptWord[] | undefined,
  options: FillerDetectOptions = {},
): number {
  return detectFillerRanges(words, options).length
}

export function transcriptHasWordTimings(
  words: TranscriptWord[] | undefined,
): boolean {
  return Boolean(words && words.length > 0)
}
