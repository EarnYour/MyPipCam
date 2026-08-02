import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { hasOpenAiKey, loadApiSettings } from '../shared/apiSettings'
import {
  downloadBlob,
  getRecording,
  recordingFilename,
  renameRecording,
  updateRecordingBlob,
  updateRecordingTranscript,
} from '../shared/db'
import { InlineRename } from '../shared/InlineRename'
import { openLibraryTab, type EditorFocus } from '../shared/navigation'
import {
  formatDuration,
  type RecordingRecord,
  type TranscriptData,
} from '../shared/types'
import { estimateOutputDuration, exportEditedVideo, type EditPlan } from './ffmpegExport'
import {
  detectFillerRanges,
  transcriptHasWordTimings,
} from './fillerDetect'
import {
  detectSilenceRanges,
  mergeRanges,
  normalizeRange,
  rangeContaining,
  type TimeRange,
} from './silenceDetect'
import {
  chaptersFromTranscript,
  transcriptToPlainText,
  transcriptToSrt,
  transcribeWithOpenAI,
} from './transcribe'

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const
const MIN_RANGE = 0.05
const NUDGE_FINE = 1 / 30
const NUDGE_COARSE = 1
const MAX_UNDO = 40

type SidebarTab = 'edit' | 'transcript' | 'export'
type DragKind =
  | 'in'
  | 'out'
  | 'seek'
  | 'select'
  | 'selStart'
  | 'selEnd'
  | { type: 'cutStart'; index: number }
  | { type: 'cutEnd'; index: number }

function secLabel(s: number) {
  return formatDuration(s * 1000)
}

function parseEditorFocus(raw: string | null): EditorFocus | null {
  if (raw === 'trim' || raw === 'silence' || raw === 'filler') return raw
  return null
}

function focusToTab(focus: EditorFocus | null): SidebarTab {
  if (focus === 'trim' || focus === 'silence' || focus === 'filler') return 'edit'
  return 'edit'
}

function isTypingTarget(el: EventTarget | null) {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function EditorApp() {
  const [record, setRecord] = useState<RecordingRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [inSec, setInSec] = useState(0)
  const [outSec, setOutSec] = useState(0)
  const [cutRanges, setCutRanges] = useState<TimeRange[]>([])
  const [selection, setSelection] = useState<TimeRange | null>(null)
  const [undoStack, setUndoStack] = useState<TimeRange[][]>([])
  const [silenceRanges, setSilenceRanges] = useState<TimeRange[]>([])
  const [applySilences, setApplySilences] = useState(false)
  const [silenceBusy, setSilenceBusy] = useState(false)
  const [silenceThreshold, setSilenceThreshold] = useState(0.02)
  const [minSilenceSec, setMinSilenceSec] = useState(0.45)
  const [fillerRanges, setFillerRanges] = useState<TimeRange[]>([])
  const [applyFillers, setApplyFillers] = useState(false)
  const [fillerBusy, setFillerBusy] = useState(false)
  const [includeExtendedFillers, setIncludeExtendedFillers] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [log, setLog] = useState('')
  const [transcript, setTranscript] = useState<TranscriptData | null>(null)
  const [transcribeBusy, setTranscribeBusy] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [noiseReduce, setNoiseReduce] = useState(false)
  const [showChapters, setShowChapters] = useState(false)
  const [focusHint, setFocusHint] = useState<string | null>(null)
  const [editorFocus, setEditorFocus] = useState<EditorFocus | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('edit')
  const [silenceOpen, setSilenceOpen] = useState(false)
  const [fillerOpen, setFillerOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [previewEdits, setPreviewEdits] = useState(true)
  const [zoom, setZoom] = useState(1)

  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragKindRef = useRef<DragKind | null>(null)
  const selectAnchorRef = useRef<number | null>(null)
  const autoRanRef = useRef(false)
  const skipGuardRef = useRef(false)

  useEffect(() => {
    void loadApiSettings().then((s) => setHasKey(hasOpenAiKey(s)))
    const onFocus = () => {
      void loadApiSettings().then((s) => setHasKey(hasOpenAiKey(s)))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id')
    const focus = parseEditorFocus(params.get('focus'))
    const safe =
      id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        ? id
        : null
    if (!safe) {
      setError('Missing or invalid recording id')
      return
    }
    setEditorFocus(focus)
    setSidebarTab(focusToTab(focus))
    if (focus === 'silence') {
      setSilenceOpen(true)
      setFocusHint('Silences appear as yellow markers. Convert them to cuts, or Apply on export.')
    } else if (focus === 'trim') {
      setFocusHint(
        'Drag orange handles to trim. Shift-drag on the timeline to select a middle section, then Cut out (or Delete).',
      )
    } else if (focus === 'filler') {
      setFillerOpen(true)
      setFocusHint('Detect fillers to mark them, then convert to cuts or Apply on export.')
    }
    void (async () => {
      let rec
      try {
        rec = await getRecording(safe)
      } catch (err) {
        // Without this a storage/folder read failure leaves the editor stuck
        // on "Loading editor…" with an unhandled rejection.
        setError(err instanceof Error ? err.message : 'Could not load the recording')
        return
      }
      if (!rec) {
        setError('Recording not found')
        return
      }
      setRecord(rec)
      if (rec.transcript) setTranscript(rec.transcript)
      const url = URL.createObjectURL(rec.blob)
      setVideoUrl(url)
      const dur = rec.durationMs / 1000
      setDuration(dur)
      setOutSec(dur)
    })()
  }, [])

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = speed
  }, [speed])

  const plan: EditPlan = useMemo(() => {
    const removes: TimeRange[] = []
    if (applySilences) removes.push(...silenceRanges)
    if (applyFillers) removes.push(...fillerRanges)
    return {
      inSec,
      outSec,
      cutRanges,
      removeRanges: removes,
      noiseReduce,
    }
  }, [
    inSec,
    outSec,
    cutRanges,
    applySilences,
    silenceRanges,
    applyFillers,
    fillerRanges,
    noiseReduce,
  ])

  const outDuration = estimateOutputDuration(plan)
  const chapters = useMemo(
    () => (transcript && showChapters ? chaptersFromTranscript(transcript) : []),
    [transcript, showChapters],
  )
  const hasWordTimings = transcriptHasWordTimings(transcript?.words)
  const autoCutCount =
    (applySilences ? silenceRanges.length : 0) + (applyFillers ? fillerRanges.length : 0)
  const cutCount = cutRanges.length + autoCutCount

  const skipRanges = useMemo(() => {
    const ranges: TimeRange[] = [...cutRanges]
    if (applySilences) ranges.push(...silenceRanges)
    if (applyFillers) ranges.push(...fillerRanges)
    return mergeRanges(ranges)
  }, [cutRanges, applySilences, silenceRanges, applyFillers, fillerRanges])

  function pushUndo(prev: TimeRange[]) {
    setUndoStack((stack) => [...stack.slice(-(MAX_UNDO - 1)), prev.map((r) => ({ ...r }))])
  }

  function undoCut() {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack
      const prev = stack[stack.length - 1]!
      setCutRanges(prev)
      setSuccess('Undid last cut.')
      return stack.slice(0, -1)
    })
  }

  function commitCuts(next: TimeRange[], message?: string) {
    pushUndo(cutRanges)
    setCutRanges(mergeRanges(next))
    if (message) setSuccess(message)
  }

  function seekTo(t: number) {
    const v = videoRef.current
    const next = clamp(t, 0, duration || t)
    skipGuardRef.current = true
    if (v) v.currentTime = next
    setCurrent(next)
    window.setTimeout(() => {
      skipGuardRef.current = false
    }, 40)
  }

  function clientXToTime(clientX: number) {
    const track = trackRef.current
    if (!track || duration <= 0) return 0
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1)
    return pct * duration
  }

  function applyDrag(kind: DragKind, t: number) {
    if (kind === 'in') {
      const next = Math.min(t, outSec - MIN_RANGE)
      setInSec(Math.max(0, next))
      seekTo(Math.max(0, next))
      return
    }
    if (kind === 'out') {
      const next = Math.max(t, inSec + MIN_RANGE)
      setOutSec(Math.min(duration || next, next))
      seekTo(Math.min(duration || next, next))
      return
    }
    if (kind === 'selStart' && selection) {
      const start = clamp(t, inSec, selection.end - MIN_RANGE)
      setSelection({ start, end: selection.end })
      seekTo(start)
      return
    }
    if (kind === 'selEnd' && selection) {
      const end = clamp(t, selection.start + MIN_RANGE, outSec)
      setSelection({ start: selection.start, end })
      seekTo(end)
      return
    }
    if (kind === 'select') {
      const anchor = selectAnchorRef.current ?? t
      const range = normalizeRange(anchor, t)
      const start = clamp(range.start, inSec, outSec)
      const end = clamp(range.end, inSec, outSec)
      if (end - start >= MIN_RANGE) setSelection({ start, end })
      else setSelection(null)
      seekTo(t)
      return
    }
    if (typeof kind === 'object' && kind.type === 'cutStart') {
      const nextStart = clamp(t, inSec, (cutRanges[kind.index]?.end ?? t) - MIN_RANGE)
      setCutRanges((ranges) => {
        const copy = ranges.map((r) => ({ ...r }))
        const cur = copy[kind.index]
        if (!cur) return ranges
        cur.start = nextStart
        return copy
      })
      seekTo(nextStart)
      return
    }
    if (typeof kind === 'object' && kind.type === 'cutEnd') {
      const nextEnd = clamp(t, (cutRanges[kind.index]?.start ?? t) + MIN_RANGE, outSec)
      setCutRanges((ranges) => {
        const copy = ranges.map((r) => ({ ...r }))
        const cur = copy[kind.index]
        if (!cur) return ranges
        cur.end = nextEnd
        return copy
      })
      seekTo(nextEnd)
      return
    }
    seekTo(t)
  }

  function onTimelinePointerDown(kind: DragKind, e: ReactPointerEvent<HTMLElement>) {
    e.preventDefault()
    e.stopPropagation()
    const scroller = timelineRef.current
    if (!scroller || !duration) return

    if (kind === 'select' || (kind === 'seek' && e.shiftKey)) {
      const t = clientXToTime(e.clientX)
      selectAnchorRef.current = t
      dragKindRef.current = 'select'
      scroller.setPointerCapture(e.pointerId)
      setSelection(null)
      seekTo(t)
      return
    }

    dragKindRef.current = kind
    scroller.setPointerCapture(e.pointerId)
    applyDrag(kind, clientXToTime(e.clientX))
  }

  function onTimelinePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const kind = dragKindRef.current
    if (!kind || !duration) return
    applyDrag(kind, clientXToTime(e.clientX))
  }

  function onTimelinePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const kind = dragKindRef.current
    if (kind) {
      dragKindRef.current = null
      selectAnchorRef.current = null
      if (typeof kind === 'object') {
        setCutRanges((ranges) => mergeRanges(ranges))
      }
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }
  }

  function onTimelineWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.25 : 0.25
    setZoom((z) => clamp(Math.round((z + delta) * 4) / 4, 1, 6))
  }

  function cutSelection() {
    if (!selection || selection.end - selection.start < MIN_RANGE) {
      setError('Select a range first — Shift-drag on the timeline, or mark [ and ].')
      return
    }
    const clipped = {
      start: Math.max(inSec, selection.start),
      end: Math.min(outSec, selection.end),
    }
    if (clipped.end - clipped.start < MIN_RANGE) {
      setError('Selection is outside the keep range.')
      return
    }
    commitCuts([...cutRanges, clipped], `Cut ${secLabel(clipped.end - clipped.start)} from timeline.`)
    setSelection(null)
    setError(null)
  }

  function removeCutAt(index: number) {
    commitCuts(
      cutRanges.filter((_, i) => i !== index),
      'Removed cut.',
    )
  }

  function clearAllCuts() {
    if (cutRanges.length === 0) return
    commitCuts([], 'Cleared all cuts.')
    setSelection(null)
  }

  function convertOverlaysToCuts(kind: 'silence' | 'filler' | 'both') {
    const add: TimeRange[] = []
    if (kind === 'silence' || kind === 'both') add.push(...silenceRanges)
    if (kind === 'filler' || kind === 'both') add.push(...fillerRanges)
    if (add.length === 0) {
      setError(`No ${kind === 'both' ? 'overlays' : kind} ranges to convert.`)
      return
    }
    commitCuts([...cutRanges, ...add], `Added ${add.length} cut${add.length === 1 ? '' : 's'} from overlays.`)
    if (kind === 'silence' || kind === 'both') {
      setApplySilences(false)
    }
    if (kind === 'filler' || kind === 'both') {
      setApplyFillers(false)
    }
    setError(null)
  }

  async function onDetectSilences() {
    if (!record) return
    setSilenceBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const ranges = await detectSilenceRanges(record.blob, {
        threshold: silenceThreshold,
        minSilenceSec,
      })
      setSilenceRanges(ranges)
      setApplySilences(false)
      if (ranges.length === 0) {
        setError(
          'No silences found with current threshold. Try a higher threshold or shorter min duration.',
        )
      } else {
        setSuccess(
          `Found ${ranges.length} silence range${ranges.length === 1 ? '' : 's'}. Convert to cuts or Apply on export.`,
        )
        setFocusHint('Yellow silence markers on the timeline — Convert to cuts to edit them.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Silence detection failed')
    } finally {
      setSilenceBusy(false)
    }
  }

  async function ensureTranscriptWithWords(): Promise<TranscriptData> {
    if (!record) throw new Error('Recording not loaded')
    if (transcriptHasWordTimings(transcript?.words) && transcript) return transcript

    const settings = await loadApiSettings()
    if (!hasOpenAiKey(settings)) {
      setHasKey(false)
      throw new Error(
        'Filler removal needs a transcript. Add your OpenAI API key in Settings, then try again.',
      )
    }
    setHasKey(true)
    setTranscribeBusy(true)
    try {
      const result = await transcribeWithOpenAI(
        record.blob,
        settings.openaiApiKey,
        recordingFilename(record),
      )
      if (!transcriptHasWordTimings(result.words)) {
        throw new Error(
          'Transcription succeeded but returned no word timings. Try again, or check your OpenAI account access to whisper-1.',
        )
      }
      setTranscript(result)
      await updateRecordingTranscript(record.id, result)
      setRecord({ ...record, transcript: result })
      return result
    } finally {
      setTranscribeBusy(false)
    }
  }

  async function onDetectFillers() {
    if (!record) return
    setFillerBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const data = await ensureTranscriptWithWords()
      const ranges = detectFillerRanges(data.words, {
        includeExtended: includeExtendedFillers,
      })
      setFillerRanges(ranges)
      setApplyFillers(false)
      if (ranges.length === 0) {
        setError(
          includeExtendedFillers
            ? 'No filler words found in the transcript.'
            : 'No core fillers (um/uh/…) found. Try enabling “like / you know / etc.”',
        )
      } else {
        setSuccess(
          `Found ${ranges.length} filler cut${ranges.length === 1 ? '' : 's'}. Convert to cuts or Apply on export.`,
        )
        setFocusHint('Filler markers on the timeline — Convert to cuts to edit them.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Filler detection failed')
    } finally {
      setFillerBusy(false)
    }
  }

  // Auto-run silence / filler detection when opened from Library focus links.
  useEffect(() => {
    if (!record || autoRanRef.current) return
    if (editorFocus !== 'silence' && editorFocus !== 'filler') return
    autoRanRef.current = true
    if (editorFocus === 'silence') {
      void (async () => {
        setSilenceBusy(true)
        setError(null)
        try {
          const ranges = await detectSilenceRanges(record.blob, {
            threshold: silenceThreshold,
            minSilenceSec,
          })
          setSilenceRanges(ranges)
          setApplySilences(false)
          if (ranges.length === 0) {
            setError(
              'No silences found with current threshold. Try a higher threshold or shorter min duration.',
            )
          } else {
            setSuccess(
              `Found ${ranges.length} silence range${ranges.length === 1 ? '' : 's'}. Convert to cuts or Apply on export.`,
            )
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Silence detection failed')
        } finally {
          setSilenceBusy(false)
        }
      })()
      return
    }

    void (async () => {
      setFillerBusy(true)
      setError(null)
      try {
        let data = transcript
        if (!transcriptHasWordTimings(data?.words)) {
          const settings = await loadApiSettings()
          if (!hasOpenAiKey(settings)) {
            setHasKey(false)
            setError(
              'Filler removal needs a transcript. Add your OpenAI API key in Settings, then click Detect fillers.',
            )
            setFocusHint('Add an OpenAI API key in Settings, then detect fillers.')
            return
          }
          setHasKey(true)
          setTranscribeBusy(true)
          data = await transcribeWithOpenAI(
            record.blob,
            settings.openaiApiKey,
            recordingFilename(record),
          )
          if (!transcriptHasWordTimings(data.words)) {
            throw new Error(
              'Transcription succeeded but returned no word timings. Try Detect fillers again.',
            )
          }
          setTranscript(data)
          await updateRecordingTranscript(record.id, data)
          setRecord({ ...record, transcript: data })
        }
        const ranges = detectFillerRanges(data!.words, {
          includeExtended: includeExtendedFillers,
        })
        setFillerRanges(ranges)
        setApplyFillers(false)
        if (ranges.length === 0) {
          setError('No filler words found in the transcript.')
        } else {
          setSuccess(
            `Found ${ranges.length} filler cut${ranges.length === 1 ? '' : 's'}. Convert to cuts or Apply on export.`,
          )
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Filler detection failed')
      } finally {
        setFillerBusy(false)
        setTranscribeBusy(false)
      }
    })()
    // Intentionally once after recording load for deep-link focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, editorFocus])

  // Preview: skip cut / applied overlay regions while playing.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    const onTime = () => {
      if (skipGuardRef.current) return
      const t = v.currentTime
      setCurrent(t)

      if (!previewEdits) return

      if (t < inSec - 0.02) {
        skipGuardRef.current = true
        v.currentTime = inSec
        skipGuardRef.current = false
        return
      }
      if (t >= outSec - 0.02) {
        if (!v.paused) {
          v.pause()
          skipGuardRef.current = true
          v.currentTime = outSec
          skipGuardRef.current = false
        }
        return
      }

      const hit = rangeContaining(skipRanges, t)
      if (hit) {
        skipGuardRef.current = true
        if (hit.end >= outSec - 0.02) {
          v.pause()
          v.currentTime = outSec
        } else {
          v.currentTime = hit.end + 0.001
        }
        skipGuardRef.current = false
      }
    }

    v.addEventListener('timeupdate', onTime)
    return () => v.removeEventListener('timeupdate', onTime)
  }, [previewEdits, inSec, outSec, skipRanges])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      if (busy) return

      const meta = e.metaKey || e.ctrlKey
      const key = e.key

      if (meta && key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoCut()
        return
      }

      if (key === ' ' || key === 'k' || key === 'K') {
        e.preventDefault()
        void togglePlay()
        return
      }

      if (key === 'j' || key === 'J') {
        e.preventDefault()
        seekTo(current - (e.shiftKey ? NUDGE_COARSE : NUDGE_FINE * 10))
        return
      }

      if (key === 'l' || key === 'L') {
        e.preventDefault()
        seekTo(current + (e.shiftKey ? NUDGE_COARSE : NUDGE_FINE * 10))
        return
      }

      if (key === 'ArrowLeft') {
        e.preventDefault()
        seekTo(current - (e.shiftKey ? NUDGE_COARSE : NUDGE_FINE))
        return
      }

      if (key === 'ArrowRight') {
        e.preventDefault()
        seekTo(current + (e.shiftKey ? NUDGE_COARSE : NUDGE_FINE))
        return
      }

      if (key === 'i' || key === 'I') {
        e.preventDefault()
        setInSec(Math.min(current, outSec - MIN_RANGE))
        setSuccess(`In set to ${secLabel(Math.min(current, outSec - MIN_RANGE))}`)
        return
      }

      if (key === 'o' || key === 'O') {
        e.preventDefault()
        setOutSec(Math.max(current, inSec + MIN_RANGE))
        setSuccess(`Out set to ${secLabel(Math.max(current, inSec + MIN_RANGE))}`)
        return
      }

      if (key === '[') {
        e.preventDefault()
        const start = clamp(current, inSec, outSec)
        setSelection((sel) => {
          const end = sel ? Math.max(sel.end, start + MIN_RANGE) : Math.min(outSec, start + 1)
          return { start, end: Math.max(end, start + MIN_RANGE) }
        })
        return
      }

      if (key === ']') {
        e.preventDefault()
        const end = clamp(current, inSec, outSec)
        setSelection((sel) => {
          const start = sel ? Math.min(sel.start, end - MIN_RANGE) : Math.max(inSec, end - 1)
          return { start: Math.min(start, end - MIN_RANGE), end }
        })
        return
      }

      if (key === 'Delete' || key === 'Backspace') {
        e.preventDefault()
        if (selection && selection.end - selection.start >= MIN_RANGE) {
          cutSelection()
          return
        }
        const hitIdx = cutRanges.findIndex((r) => current >= r.start && current < r.end)
        if (hitIdx >= 0) {
          removeCutAt(hitIdx)
          return
        }
        setError('Nothing to cut — Shift-drag a range first, or place the playhead on a cut.')
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, current, inSec, outSec, selection, cutRanges, undoStack])

  async function runExport(mode: 'download' | 'overwrite' | 'save-as') {
    if (!record) return
    setBusy(true)
    setProgress(0)
    setLog('Loading ffmpeg…')
    setError(null)
    setSuccess(null)
    try {
      const blob = await exportEditedVideo(
        record.blob,
        plan,
        (p) => setProgress(p),
        (msg) => setLog(msg),
      )
      const durationMs = Math.max(50, outDuration * 1000)
      if (mode === 'download') {
        downloadBlob(blob, recordingFilename({ ...record, mimeType: 'video/webm' }))
        setSuccess('Downloaded edited video.')
        setLog('Done')
      } else if (mode === 'overwrite') {
        await updateRecordingBlob(record.id, blob, durationMs, undefined, true)
        await updateRecordingTranscript(record.id, undefined)
        setSuccess('Saved over original. Opening library…')
        await openLibraryTab(record.id)
      } else {
        const saved = await updateRecordingBlob(record.id, blob, durationMs, undefined, false)
        setSuccess('Saved as new recording. Opening library…')
        await openLibraryTab(saved.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  async function onTranscribe() {
    if (!record) return
    setTranscribeBusy(true)
    setError(null)
    setSuccess(null)
    try {
      const settings = await loadApiSettings()
      if (!hasOpenAiKey(settings)) {
        setHasKey(false)
        throw new Error('Add your OpenAI API key in Settings to transcribe.')
      }
      setHasKey(true)
      const result = await transcribeWithOpenAI(
        record.blob,
        settings.openaiApiKey,
        recordingFilename(record),
      )
      setTranscript(result)
      await updateRecordingTranscript(record.id, result)
      setRecord({ ...record, transcript: result })
      setSuccess(
        result.words?.length
          ? `Transcript ready (${result.words.length} words). Filler removal is available.`
          : 'Transcript ready.',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed')
    } finally {
      setTranscribeBusy(false)
    }
  }

  function downloadTranscript(format: 'txt' | 'srt') {
    if (!transcript || !record) return
    const body = format === 'srt' ? transcriptToSrt(transcript) : transcriptToPlainText(transcript)
    const safe = record.title.replace(/[^\w\- ]+/g, '').trim() || 'transcript'
    downloadBlob(
      new Blob([body], { type: 'text/plain;charset=utf-8' }),
      `${safe}.${format}`,
    )
  }

  async function copyTranscript() {
    if (!transcript) return
    try {
      await navigator.clipboard.writeText(transcript.text)
      setSuccess('Transcript copied.')
    } catch {
      setError('Could not copy to clipboard.')
    }
  }

  async function togglePlay() {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      if (previewEdits && (v.currentTime < inSec || v.currentTime >= outSec)) {
        v.currentTime = inSec
      }
      await v.play()
    } else {
      v.pause()
    }
  }

  if (error && !record) {
    return (
      <div className="editor-shell editor-shell--empty">
        <p className="editor-status error" role="alert">
          {error}
        </p>
        <button type="button" className="primary" onClick={() => void openLibraryTab()}>
          Back to library
        </button>
      </div>
    )
  }

  if (!record || !videoUrl) {
    return (
      <div className="editor-shell editor-shell--empty">
        <p className="muted">Loading editor…</p>
      </div>
    )
  }

  const inPct = duration ? (inSec / duration) * 100 : 0
  const outPct = duration ? (outSec / duration) * 100 : 0
  const keepWidth = Math.max(0, outPct - inPct)
  const playPct = duration ? (current / duration) * 100 : 0
  const selPct = selection
    ? {
        left: duration ? (selection.start / duration) * 100 : 0,
        width: duration ? ((selection.end - selection.start) / duration) * 100 : 0,
      }
    : null

  return (
    <div className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-topbar-left">
          <button
            type="button"
            className="ghost editor-back"
            onClick={() => void openLibraryTab(record.id)}
            aria-label="Back to library"
          >
            ← Library
          </button>
          <div className="editor-brand-block">
            <span className="editor-brand">MyPipCam</span>
            <InlineRename
              title={record.title}
              as="h1"
              className="editor-title"
              onSave={async (next) => {
                await renameRecording(record.id, next)
                setRecord({ ...record, title: next.trim() || record.title })
              }}
            />
          </div>
        </div>
        <div className="editor-topbar-right">
          <button
            type="button"
            className="ghost"
            onClick={() => void openLibraryTab(record.id, true)}
          >
            Settings
          </button>
          <button
            type="button"
            className="primary editor-export-cta"
            onClick={() => setSidebarTab('export')}
          >
            Export
          </button>
        </div>
      </header>

      {focusHint && (
        <div className="editor-focus-hint" role="status">
          <p>{focusHint}</p>
          <button type="button" className="ghost" onClick={() => setFocusHint(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="editor-body">
        <main className="editor-stage">
          <div className="preview-panel">
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration
                if (Number.isFinite(d) && d > 0) {
                  setDuration(d)
                  setOutSec((o) => (o <= 0 ? d : Math.min(o, d)))
                }
                e.currentTarget.playbackRate = speed
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          </div>

          <div className="transport-bar">
            <div className="transport-left">
              <button
                type="button"
                className="transport-play"
                onClick={() => void togglePlay()}
                aria-label={playing ? 'Pause' : 'Play'}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <span className="mono transport-time">
                {secLabel(current)}
                <span className="transport-sep">/</span>
                {secLabel(duration)}
              </span>
            </div>
            <div className="transport-right">
              <span className="muted transport-out">
                Out {secLabel(outDuration)}
                {cutCount > 0 ? ` · ${cutCount} cut${cutCount === 1 ? '' : 's'}` : ''}
              </span>
              <label className="speed-label">
                <span className="speed-caption">Speed</span>
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
              <label className="check-row transport-preview">
                <input
                  type="checkbox"
                  checked={previewEdits}
                  onChange={(e) => setPreviewEdits(e.target.checked)}
                />
                Skip cuts
              </label>
            </div>
          </div>

          <div className="timeline-block">
            <div className="timeline-meta">
              <span className="mono">In {secLabel(inSec)}</span>
              <span className="muted timeline-hint">
                Scrub · Shift-drag select · Delete cut · ⌘Z undo · ⌘/Ctrl-scroll zoom
              </span>
              <span className="mono">Out {secLabel(outSec)}</span>
            </div>

            <div className="timeline-toolbar">
              <div className="timeline-toolbar-left">
                <button
                  type="button"
                  className="primary"
                  disabled={!selection}
                  onClick={() => cutSelection()}
                  title="Cut out the selected range (Delete)"
                >
                  Cut out
                </button>
                <button
                  type="button"
                  disabled={undoStack.length === 0}
                  onClick={() => undoCut()}
                  title="Undo last cut (⌘Z)"
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={cutRanges.length === 0}
                  onClick={() => clearAllCuts()}
                >
                  Clear cuts
                </button>
              </div>
              <div className="timeline-zoom">
                <button
                  type="button"
                  className="ghost"
                  disabled={zoom <= 1}
                  onClick={() => setZoom((z) => clamp(z - 0.5, 1, 6))}
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="mono zoom-label">{zoom.toFixed(1)}×</span>
                <button
                  type="button"
                  className="ghost"
                  disabled={zoom >= 6}
                  onClick={() => setZoom((z) => clamp(z + 0.5, 1, 6))}
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            </div>

            <div
              ref={timelineRef}
              className="timeline-scroll"
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              onPointerCancel={onTimelinePointerUp}
              onWheel={onTimelineWheel}
            >
              <div
                ref={trackRef}
                className="timeline"
                style={{ width: `${zoom * 100}%` }}
                role="slider"
                aria-label="Edit timeline"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={current}
                onPointerDown={(e) => onTimelinePointerDown(e.shiftKey ? 'select' : 'seek', e)}
              >
                <div className="timeline-dim left" style={{ width: `${inPct}%` }} />
                <div className="timeline-dim right" style={{ width: `${100 - outPct}%` }} />

                <div className="keep" style={{ left: `${inPct}%`, width: `${keepWidth}%` }} />

                {cutRanges.map((r, i) => (
                  <div key={`cut-${i}`}>
                    <div
                      className="cut"
                      style={{
                        left: `${duration ? (r.start / duration) * 100 : 0}%`,
                        width: `${duration ? ((r.end - r.start) / duration) * 100 : 0}%`,
                      }}
                      title={`Cut ${secLabel(r.start)}–${secLabel(r.end)}`}
                    />
                    <button
                      type="button"
                      className="cut-handle cut-handle--start"
                      style={{ left: `${duration ? (r.start / duration) * 100 : 0}%` }}
                      aria-label={`Cut ${i + 1} start`}
                      onPointerDown={(e) =>
                        onTimelinePointerDown({ type: 'cutStart', index: i }, e)
                      }
                    />
                    <button
                      type="button"
                      className="cut-handle cut-handle--end"
                      style={{ left: `${duration ? (r.end / duration) * 100 : 0}%` }}
                      aria-label={`Cut ${i + 1} end`}
                      onPointerDown={(e) =>
                        onTimelinePointerDown({ type: 'cutEnd', index: i }, e)
                      }
                    />
                  </div>
                ))}

                {selPct && (
                  <>
                    <div
                      className="selection"
                      style={{ left: `${selPct.left}%`, width: `${selPct.width}%` }}
                    />
                    <button
                      type="button"
                      className="sel-handle sel-handle--start"
                      style={{ left: `${selPct.left}%` }}
                      aria-label="Selection start"
                      onPointerDown={(e) => onTimelinePointerDown('selStart', e)}
                    />
                    <button
                      type="button"
                      className="sel-handle sel-handle--end"
                      style={{ left: `${selPct.left + selPct.width}%` }}
                      aria-label="Selection end"
                      onPointerDown={(e) => onTimelinePointerDown('selEnd', e)}
                    />
                  </>
                )}

                {silenceRanges.map((r, i) => (
                  <div
                    key={`sil-${i}`}
                    className={`silence ${applySilences ? 'is-applied' : ''}`}
                    style={{
                      left: `${duration ? (r.start / duration) * 100 : 0}%`,
                      width: `${duration ? ((r.end - r.start) / duration) * 100 : 0}%`,
                    }}
                  />
                ))}

                {fillerRanges.map((r, i) => (
                  <div
                    key={`fil-${i}`}
                    className={`filler ${applyFillers ? 'is-applied' : ''}`}
                    style={{
                      left: `${duration ? (r.start / duration) * 100 : 0}%`,
                      width: `${duration ? ((r.end - r.start) / duration) * 100 : 0}%`,
                    }}
                  />
                ))}

                <div className="playhead" style={{ left: `${playPct}%` }} />

                <button
                  type="button"
                  className="trim-handle trim-handle--in"
                  style={{ left: `${inPct}%` }}
                  aria-label="Trim in"
                  onPointerDown={(e) => onTimelinePointerDown('in', e)}
                />
                <button
                  type="button"
                  className="trim-handle trim-handle--out"
                  style={{ left: `${outPct}%` }}
                  aria-label="Trim out"
                  onPointerDown={(e) => onTimelinePointerDown('out', e)}
                />
              </div>
            </div>

            <div className="timeline-legend muted">
              <span className="leg keep-leg">Keep</span>
              <span className="leg cut-leg">Cut out</span>
              <span className="leg sel-leg">Selection</span>
              <span className="leg sil-leg">Silence</span>
              <span className="leg fil-leg">Filler</span>
            </div>

            {selection && (
              <div className="selection-bar">
                <span className="mono">
                  Selected {secLabel(selection.start)} – {secLabel(selection.end)} (
                  {secLabel(selection.end - selection.start)})
                </span>
                <button type="button" className="primary" onClick={() => cutSelection()}>
                  Cut out selection
                </button>
                <button type="button" className="ghost" onClick={() => setSelection(null)}>
                  Clear
                </button>
              </div>
            )}

            {cutRanges.length > 0 && (
              <ul className="cut-list">
                {cutRanges.map((r, i) => (
                  <li key={i}>
                    <button type="button" className="cut-jump" onClick={() => seekTo(r.start)}>
                      <span className="mono">
                        {secLabel(r.start)}–{secLabel(r.end)}
                      </span>
                      <span className="muted">−{secLabel(r.end - r.start)}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost cut-remove"
                      aria-label={`Remove cut ${i + 1}`}
                      onClick={() => removeCutAt(i)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {(error || success) && (
            <div className="editor-toast-row">
              {error && (
                <p className="editor-status error" role="alert">
                  {error}
                </p>
              )}
              {success && !error && (
                <p className="editor-status success" role="status">
                  {success}
                </p>
              )}
            </div>
          )}
        </main>

        <aside className="editor-sidebar">
          <div className="sidebar-tabs" role="tablist" aria-label="Editor panels">
            {(
              [
                ['edit', 'Edit'],
                ['transcript', 'Transcript'],
                ['export', 'Export'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={sidebarTab === id}
                className={`sidebar-tab ${sidebarTab === id ? 'active' : ''}`}
                onClick={() => setSidebarTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="sidebar-panel" role="tabpanel">
            {sidebarTab === 'edit' && (
              <div className="edit-actions">
                <section className="action-card">
                  <div className="action-card-head">
                    <h2>Trim</h2>
                    <span className="action-meta mono">
                      {secLabel(inSec)} – {secLabel(outSec)}
                    </span>
                  </div>
                  <p className="action-help">
                    Orange handles set the keep ends. Shortcut: I / O at playhead.
                  </p>
                  <div className="action-row">
                    <button
                      type="button"
                      onClick={() => setInSec(Math.min(current, outSec - MIN_RANGE))}
                    >
                      Set in here
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutSec(Math.max(current, inSec + MIN_RANGE))}
                    >
                      Set out here
                    </button>
                  </div>
                  <div className="action-row">
                    <button type="button" onClick={() => seekTo(inSec)}>
                      Jump to in
                    </button>
                    <button type="button" onClick={() => seekTo(outSec)}>
                      Jump to out
                    </button>
                  </div>
                </section>

                <section className="action-card">
                  <div className="action-card-head">
                    <h2>Cut out</h2>
                    {cutRanges.length > 0 && (
                      <span className="action-badge">{cutRanges.length}</span>
                    )}
                  </div>
                  <p className="action-help">
                    Shift-drag a range on the timeline, then Cut out (or Delete). Export joins the
                    green keep pieces.
                  </p>
                  <div className="action-row">
                    <button
                      type="button"
                      onClick={() => {
                        const start = clamp(current, inSec, outSec)
                        setSelection((sel) => ({
                          start,
                          end: sel
                            ? Math.max(sel.end, start + MIN_RANGE)
                            : Math.min(outSec, start + Math.max(1, (outSec - inSec) * 0.1)),
                        }))
                      }}
                    >
                      Mark [ here
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const end = clamp(current, inSec, outSec)
                        setSelection((sel) => ({
                          start: sel
                            ? Math.min(sel.start, end - MIN_RANGE)
                            : Math.max(inSec, end - Math.max(1, (outSec - inSec) * 0.1)),
                          end,
                        }))
                      }}
                    >
                      Mark ] here
                    </button>
                  </div>
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={!selection}
                      onClick={() => cutSelection()}
                    >
                      Cut out selection
                    </button>
                    <button
                      type="button"
                      disabled={undoStack.length === 0}
                      onClick={() => undoCut()}
                    >
                      Undo
                    </button>
                  </div>
                  <p className="muted micro">
                    Space play · J / L nudge · ← → frame · ⌘Z undo
                  </p>
                </section>

                <section className="action-card">
                  <div className="action-card-head">
                    <h2>Remove silences</h2>
                    {silenceRanges.length > 0 && (
                      <span className="action-badge">{silenceRanges.length}</span>
                    )}
                  </div>
                  <p className="action-help">Local audio analysis · yellow on timeline</p>
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={silenceBusy || busy}
                      onClick={() => void onDetectSilences()}
                    >
                      {silenceBusy ? 'Detecting…' : 'Detect'}
                    </button>
                    <button
                      type="button"
                      disabled={silenceRanges.length === 0}
                      onClick={() => convertOverlaysToCuts('silence')}
                    >
                      Convert to cuts
                    </button>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={applySilences}
                      disabled={silenceRanges.length === 0}
                      onChange={(e) => setApplySilences(e.target.checked)}
                    />
                    Apply on export (without converting)
                  </label>
                  <button
                    type="button"
                    className="ghost action-more"
                    onClick={() => setSilenceOpen((v) => !v)}
                  >
                    {silenceOpen ? 'Hide sensitivity' : 'Sensitivity…'}
                  </button>
                  {silenceOpen && (
                    <div className="action-advanced">
                      <div className="field">
                        <label>Threshold · {(silenceThreshold * 100).toFixed(0)}% of peak</label>
                        <input
                          type="range"
                          min={0.005}
                          max={0.08}
                          step={0.005}
                          value={silenceThreshold}
                          onChange={(e) => setSilenceThreshold(Number(e.target.value))}
                        />
                      </div>
                      <div className="field">
                        <label>Min silence · {minSilenceSec.toFixed(2)}s</label>
                        <input
                          type="range"
                          min={0.2}
                          max={2}
                          step={0.05}
                          value={minSilenceSec}
                          onChange={(e) => setMinSilenceSec(Number(e.target.value))}
                        />
                      </div>
                    </div>
                  )}
                </section>

                <section className="action-card">
                  <div className="action-card-head">
                    <h2>Remove fillers</h2>
                    {fillerRanges.length > 0 && (
                      <span className="action-badge">{fillerRanges.length}</span>
                    )}
                  </div>
                  <p className="action-help">
                    Whisper word timings · um, uh, like…
                    {!hasKey ? ' Needs an OpenAI key.' : ''}
                  </p>
                  {!hasKey && (
                    <p className="key-hint">Add API key in Settings to enable.</p>
                  )}
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={fillerBusy || transcribeBusy || busy || !hasKey}
                      title={!hasKey ? 'Add API key in Settings' : undefined}
                      onClick={() => void onDetectFillers()}
                    >
                      {fillerBusy || (transcribeBusy && editorFocus === 'filler')
                        ? hasWordTimings
                          ? 'Detecting…'
                          : 'Transcribing…'
                        : 'Detect'}
                    </button>
                    {!hasKey && (
                      <button type="button" onClick={() => void openLibraryTab(record.id, true)}>
                        Add key
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={fillerRanges.length === 0}
                      onClick={() => convertOverlaysToCuts('filler')}
                    >
                      Convert to cuts
                    </button>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={applyFillers}
                      disabled={fillerRanges.length === 0}
                      onChange={(e) => setApplyFillers(e.target.checked)}
                    />
                    Apply on export (without converting)
                  </label>
                  <button
                    type="button"
                    className="ghost action-more"
                    onClick={() => setFillerOpen((v) => !v)}
                  >
                    {fillerOpen ? 'Hide options' : 'Options…'}
                  </button>
                  {fillerOpen && (
                    <div className="action-advanced">
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={includeExtendedFillers}
                          onChange={(e) => setIncludeExtendedFillers(e.target.checked)}
                        />
                        Include like / you know / basically / etc.
                      </label>
                    </div>
                  )}
                </section>
              </div>
            )}

            {sidebarTab === 'transcript' && (
              <div className="transcript-pane">
                {!hasKey && (
                  <p className="key-hint">Add API key in Settings to enable Transcribe.</p>
                )}
                <div className="action-row">
                  <button
                    type="button"
                    className="primary"
                    disabled={transcribeBusy || !hasKey}
                    title={!hasKey ? 'Add API key in Settings' : undefined}
                    onClick={() => void onTranscribe()}
                  >
                    {transcribeBusy ? 'Transcribing…' : transcript ? 'Re-transcribe' : 'Transcribe'}
                  </button>
                  {!hasKey && (
                    <button type="button" onClick={() => void openLibraryTab(record.id, true)}>
                      Add API key
                    </button>
                  )}
                </div>

                {transcript ? (
                  <>
                    <div className="action-row">
                      <button type="button" onClick={() => void copyTranscript()}>
                        Copy
                      </button>
                      <button type="button" onClick={() => downloadTranscript('txt')}>
                        .txt
                      </button>
                      <button type="button" onClick={() => downloadTranscript('srt')}>
                        .srt
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setShowChapters((v) => !v)}
                      >
                        {showChapters ? 'Hide chapters' : 'Chapters'}
                      </button>
                    </div>
                    {hasWordTimings ? (
                      <p className="muted micro">
                        Word timings ({transcript.words!.length}) — filler cuts ready.
                      </p>
                    ) : (
                      <p className="muted micro">
                        No word timings. Re-transcribe to enable filler removal.
                      </p>
                    )}

                    {showChapters && (
                      <div className="chapters-list">
                        {chapters.length === 0 ? (
                          <p className="muted micro">Not enough segment gaps for chapters.</p>
                        ) : (
                          chapters.map((ch, i) => (
                            <button
                              key={i}
                              type="button"
                              className="chapter-btn"
                              onClick={() => seekTo(ch.start)}
                            >
                              <span className="mono">{secLabel(ch.start)}</span>
                              {ch.title}
                            </button>
                          ))
                        )}
                      </div>
                    )}

                    <div className="transcript-body">
                      {transcript.segments.length > 0 ? (
                        transcript.segments.map((seg, i) => (
                          <button
                            key={i}
                            type="button"
                            className={`transcript-seg ${current >= seg.start && current < seg.end ? 'active' : ''}`}
                            onClick={() => seekTo(seg.start)}
                          >
                            <span className="mono seg-time">{secLabel(seg.start)}</span>
                            <span>{seg.text}</span>
                          </button>
                        ))
                      ) : (
                        <p className="transcript-plain">{transcript.text}</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted action-help">
                    Transcribe for captions and word timings. Audio is sent to OpenAI Whisper; the
                    recording file stays local.
                  </p>
                )}
              </div>
            )}

            {sidebarTab === 'export' && (
              <div className="export-pane">
                <div className="export-summary">
                  <p className="export-duration mono">{secLabel(outDuration)}</p>
                  <p className="muted action-help">
                    Estimated output
                    {cutCount > 0
                      ? ` · removing ${cutCount} cut${cutCount === 1 ? '' : 's'}`
                      : ' · full keep range'}
                  </p>
                </div>

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={noiseReduce}
                    onChange={(e) => setNoiseReduce(e.target.checked)}
                  />
                  Noise reduction
                  <span className="muted micro">(ffmpeg · may fail on some clips)</span>
                </label>

                <button
                  type="button"
                  className="primary export-primary"
                  disabled={busy}
                  onClick={() => void runExport('download')}
                >
                  {busy ? 'Exporting…' : 'Download'}
                </button>

                <div className="export-secondary">
                  <button disabled={busy} onClick={() => void runExport('save-as')}>
                    Save as new
                  </button>
                  <button disabled={busy} onClick={() => void runExport('overwrite')}>
                    Overwrite
                  </button>
                </div>

                {busy && (
                  <div className="export-progress">
                    <div className="export-progress-bar">
                      <div style={{ width: `${Math.max(2, progress * 100)}%` }} />
                    </div>
                    <p className="progress">
                      {(progress * 100).toFixed(0)}% · {log.slice(-100)}
                    </p>
                  </div>
                )}

                <p className="muted micro">
                  Export concatenates keep segments locally via ffmpeg.wasm. Overwrite clears the
                  old transcript after cuts.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
