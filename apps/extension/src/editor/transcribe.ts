import type { TranscriptData, TranscriptSegment, TranscriptWord } from '../shared/types'

type WhisperVerboseResponse = {
  text?: string
  language?: string
  segments?: Array<{
    start?: number
    end?: number
    text?: string
  }>
  words?: Array<{
    word?: string
    start?: number
    end?: number
  }>
}

/**
 * Transcribe a recording with OpenAI Whisper using the user's API key.
 * Requests segment + word timestamps (word timings power filler-word cuts).
 * Does not log the key. Throws friendly Error messages for UI.
 */
export async function transcribeWithOpenAI(
  blob: Blob,
  apiKey: string,
  filename = 'recording.webm',
): Promise<TranscriptData> {
  const key = apiKey.trim()
  if (!key) {
    throw new Error('Add your OpenAI API key in Settings to transcribe.')
  }

  const form = new FormData()
  form.append('file', blob, filename)
  form.append('model', 'whisper-1')
  form.append('response_format', 'verbose_json')
  // Both granularities: segments for captions UI, words for filler removal.
  form.append('timestamp_granularities[]', 'segment')
  form.append('timestamp_granularities[]', 'word')

  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
      },
      body: form,
    })
  } catch {
    throw new Error('Could not reach OpenAI. Check your network connection and try again.')
  }

  if (!res.ok) {
    throw new Error(await friendlyOpenAiError(res))
  }

  const data = (await res.json()) as WhisperVerboseResponse
  const segments: TranscriptSegment[] = (data.segments ?? [])
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: (s.text ?? '').trim(),
    }))
    .filter((s) => s.text.length > 0)

  const words: TranscriptWord[] = (data.words ?? [])
    .map((w) => ({
      word: (w.word ?? '').trim(),
      start: Number(w.start) || 0,
      end: Number(w.end) || 0,
    }))
    .filter((w) => w.word.length > 0 && w.end >= w.start)

  const text = (data.text ?? segments.map((s) => s.text).join(' ')).trim()
  if (!text) {
    throw new Error('Transcription returned empty text. Try again or check audio levels.')
  }

  return {
    text,
    segments,
    words: words.length > 0 ? words : undefined,
    language: data.language,
    createdAt: Date.now(),
    provider: 'openai',
  }
}

async function friendlyOpenAiError(res: Response): Promise<string> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string; type?: string } }
    detail = body.error?.message ?? ''
    const code = body.error?.code ?? body.error?.type ?? ''
    if (res.status === 401 || code.includes('invalid_api_key')) {
      return 'OpenAI API key is invalid. Update it in Settings.'
    }
    if (res.status === 429 || code.includes('rate_limit') || /quota/i.test(detail)) {
      return 'OpenAI quota or rate limit exceeded. Check your OpenAI billing and try later.'
    }
    if (res.status === 413 || /too large/i.test(detail)) {
      return 'Recording is too large for Whisper. Trim it first, then transcribe.'
    }
  } catch {
    // ignore parse errors
  }
  if (res.status === 401) return 'OpenAI API key is invalid. Update it in Settings.'
  if (res.status === 429) {
    return 'OpenAI quota or rate limit exceeded. Check your OpenAI billing and try later.'
  }
  return detail
    ? `Transcription failed: ${detail}`
    : `Transcription failed (HTTP ${res.status}).`
}

export function transcriptToPlainText(transcript: TranscriptData): string {
  return transcript.text
}

/** Build WebVTT-compatible SRT from segment timestamps. */
export function transcriptToSrt(transcript: TranscriptData): string {
  const segs =
    transcript.segments.length > 0
      ? transcript.segments
      : [{ start: 0, end: 0, text: transcript.text }]

  return segs
    .map((s, i) => {
      const start = formatSrtTime(s.start)
      const end = formatSrtTime(Math.max(s.end, s.start + 0.5))
      return `${i + 1}\n${start} --> ${end}\n${s.text}\n`
    })
    .join('\n')
}

function formatSrtTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const ms = totalMs % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** Simple chapter stubs from transcript gaps — stretch feature. */
export function chaptersFromTranscript(
  transcript: TranscriptData,
  minGapSec = 4,
): Array<{ start: number; title: string }> {
  if (transcript.segments.length === 0) return []
  const chapters: Array<{ start: number; title: string }> = []
  let lastEnd = -Infinity
  for (const seg of transcript.segments) {
    if (chapters.length === 0 || seg.start - lastEnd >= minGapSec) {
      const title = seg.text.slice(0, 48).trim() || `Chapter ${chapters.length + 1}`
      chapters.push({ start: seg.start, title })
    }
    lastEnd = seg.end
  }
  return chapters
}
