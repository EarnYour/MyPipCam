import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
import { detectSilenceRanges, type TimeRange } from './silenceDetect'
import {
  chaptersFromTranscript,
  transcriptToPlainText,
  transcriptToSrt,
  transcribeWithOpenAI,
} from './transcribe'

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const

type SidebarTab = 'edit' | 'transcript' | 'export'
type DragKind = 'in' | 'out' | 'seek' | 'cutStart' | 'cutEnd'

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

function clientXToTime(clientX: number, el: HTMLElement, duration: number) {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || duration <= 0) return 0
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return pct * duration
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
  const [cutEnabled, setCutEnabled] = useState(false)
  const [cutStart, setCutStart] = useState(0)
  const [cutEnd, setCutEnd] = useState(0)
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
  const [trimAdvancedOpen, setTrimAdvancedOpen] = useState(false)
  const [playing, setPlaying] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const dragKindRef = useRef<DragKind | null>(null)
  const autoRanRef = useRef(false)

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
      setFocusHint('Silences will appear as markers on the timeline. Review, then Export.')
    } else if (focus === 'trim') {
      setFocusHint('Drag the orange handles on the timeline to trim — then open Export.')
    } else if (focus === 'filler') {
      setFillerOpen(true)
      setFocusHint('Detect fillers to mark them on the timeline, then Export.')
    }
    void (async () => {
      const rec = await getRecording(safe)
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
      setCutStart(dur * 0.35)
      setCutEnd(dur * 0.55)
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
      cutStartSec: cutEnabled ? cutStart : null,
      cutEndSec: cutEnabled ? cutEnd : null,
      removeRanges: removes,
      noiseReduce,
    }
  }, [
    inSec,
    outSec,
    cutEnabled,
    cutStart,
    cutEnd,
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
  const cutCount =
    (applySilences ? silenceRanges.length : 0) +
    (applyFillers ? fillerRanges.length : 0) +
    (cutEnabled ? 1 : 0)

  function clampCut() {
    const start = Math.max(inSec, Math.min(cutStart, outSec))
    const end = Math.max(start, Math.min(cutEnd, outSec))
    setCutStart(start)
    setCutEnd(end)
  }

  function seekTo(t: number) {
    const v = videoRef.current
    const next = Math.max(0, Math.min(t, duration || t))
    if (v) v.currentTime = next
    setCurrent(next)
  }

  function applyDrag(kind: DragKind, t: number) {
    if (kind === 'in') {
      const next = Math.min(t, outSec - 0.1)
      setInSec(Math.max(0, next))
      seekTo(Math.max(0, next))
      return
    }
    if (kind === 'out') {
      const next = Math.max(t, inSec + 0.1)
      setOutSec(Math.min(duration || next, next))
      seekTo(Math.min(duration || next, next))
      return
    }
    if (kind === 'cutStart') {
      setCutStart(Math.max(inSec, Math.min(t, cutEnd - 0.05)))
      seekTo(Math.max(inSec, Math.min(t, cutEnd - 0.05)))
      return
    }
    if (kind === 'cutEnd') {
      setCutEnd(Math.min(outSec, Math.max(t, cutStart + 0.05)))
      seekTo(Math.min(outSec, Math.max(t, cutStart + 0.05)))
      return
    }
    seekTo(t)
  }

  function onTimelinePointerDown(kind: DragKind, e: ReactPointerEvent<HTMLElement>) {
    e.preventDefault()
    e.stopPropagation()
    const track = timelineRef.current
    if (!track || !duration) return
    dragKindRef.current = kind
    track.setPointerCapture(e.pointerId)
    applyDrag(kind, clientXToTime(e.clientX, track, duration))
  }

  function onTimelinePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const kind = dragKindRef.current
    const track = timelineRef.current
    if (!kind || !track || !duration) return
    applyDrag(kind, clientXToTime(e.clientX, track, duration))
  }

  function onTimelinePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragKindRef.current) {
      dragKindRef.current = null
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }
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
      setApplySilences(ranges.length > 0)
      if (ranges.length === 0) {
        setError(
          'No silences found with current threshold. Try a higher threshold or shorter min duration.',
        )
      } else {
        setSuccess(
          `Found ${ranges.length} silence range${ranges.length === 1 ? '' : 's'}. Applied on export.`,
        )
        setFocusHint('Silences marked on the timeline. Open Export when ready.')
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
      setApplyFillers(ranges.length > 0)
      if (ranges.length === 0) {
        setError(
          includeExtendedFillers
            ? 'No filler words found in the transcript.'
            : 'No core fillers (um/uh/…) found. Try enabling “like / you know / etc.”',
        )
      } else {
        setSuccess(
          `Found ${ranges.length} filler cut${ranges.length === 1 ? '' : 's'}. Applied on export.`,
        )
        setFocusHint('Fillers marked on the timeline. Open Export when ready.')
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
          setApplySilences(ranges.length > 0)
          if (ranges.length === 0) {
            setError(
              'No silences found with current threshold. Try a higher threshold or shorter min duration.',
            )
          } else {
            setSuccess(
              `Found ${ranges.length} silence range${ranges.length === 1 ? '' : 's'}. Applied on export.`,
            )
            setFocusHint('Silences marked on the timeline. Open Export when ready.')
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
        setApplyFillers(ranges.length > 0)
        if (ranges.length === 0) {
          setError('No filler words found in the transcript.')
        } else {
          setSuccess(
            `Found ${ranges.length} filler cut${ranges.length === 1 ? '' : 's'}. Applied on export.`,
          )
          setFocusHint('Fillers marked on the timeline. Open Export when ready.')
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
              onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
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
                <span className="muted speed-hint">preview</span>
              </label>
            </div>
          </div>

          <div className="timeline-block">
            <div className="timeline-meta">
              <span className="mono">In {secLabel(inSec)}</span>
              <span className="muted timeline-hint">Drag handles to trim · click track to scrub</span>
              <span className="mono">Out {secLabel(outSec)}</span>
            </div>

            <div
              ref={timelineRef}
              className="timeline"
              role="slider"
              aria-label="Trim timeline"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={current}
              onPointerDown={(e) => onTimelinePointerDown('seek', e)}
              onPointerMove={onTimelinePointerMove}
              onPointerUp={onTimelinePointerUp}
              onPointerCancel={onTimelinePointerUp}
            >
              <div className="timeline-dim left" style={{ width: `${inPct}%` }} />
              <div className="timeline-dim right" style={{ width: `${100 - outPct}%` }} />

              <div
                className="keep"
                style={{ left: `${inPct}%`, width: `${keepWidth}%` }}
              />

              {cutEnabled && (
                <div
                  className="cut"
                  style={{
                    left: `${duration ? (cutStart / duration) * 100 : 0}%`,
                    width: `${duration ? ((cutEnd - cutStart) / duration) * 100 : 0}%`,
                  }}
                />
              )}

              {applySilences &&
                silenceRanges.map((r, i) => (
                  <div
                    key={`sil-${i}`}
                    className="silence"
                    style={{
                      left: `${duration ? (r.start / duration) * 100 : 0}%`,
                      width: `${duration ? ((r.end - r.start) / duration) * 100 : 0}%`,
                    }}
                  />
                ))}

              {applyFillers &&
                fillerRanges.map((r, i) => (
                  <div
                    key={`fil-${i}`}
                    className="filler"
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

              {cutEnabled && (
                <>
                  <button
                    type="button"
                    className="cut-handle cut-handle--start"
                    style={{ left: `${duration ? (cutStart / duration) * 100 : 0}%` }}
                    aria-label="Cut start"
                    onPointerDown={(e) => onTimelinePointerDown('cutStart', e)}
                  />
                  <button
                    type="button"
                    className="cut-handle cut-handle--end"
                    style={{ left: `${duration ? (cutEnd / duration) * 100 : 0}%` }}
                    aria-label="Cut end"
                    onPointerDown={(e) => onTimelinePointerDown('cutEnd', e)}
                  />
                </>
              )}
            </div>

            <div className="timeline-legend muted">
              <span className="leg keep-leg">Keep</span>
              <span className="leg cut-leg">Cut</span>
              <span className="leg sil-leg">Silence</span>
              <span className="leg fil-leg">Filler</span>
            </div>
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
                    Drag the orange in/out handles on the timeline under the video.
                  </p>
                  <div className="action-row">
                    <button
                      type="button"
                      onClick={() => setInSec(Math.min(current, outSec - 0.1))}
                    >
                      Set in here
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutSec(Math.max(current, inSec + 0.1))}
                    >
                      Set out here
                    </button>
                  </div>
                  <button
                    type="button"
                    className="ghost action-more"
                    onClick={() => setTrimAdvancedOpen((v) => !v)}
                  >
                    {trimAdvancedOpen ? 'Hide advanced' : 'Cut middle / jump…'}
                  </button>
                  {trimAdvancedOpen && (
                    <div className="action-advanced">
                      <div className="action-row">
                        <button
                          type="button"
                          onClick={() => setOutSec(Math.max(current, inSec + 0.1))}
                          title="Trim everything after the playhead"
                        >
                          Cut ahead
                        </button>
                        <button
                          type="button"
                          onClick={() => setInSec(Math.min(current, outSec - 0.1))}
                          title="Trim everything before the playhead"
                        >
                          Cut behind
                        </button>
                      </div>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={cutEnabled}
                          onChange={(e) => {
                            setCutEnabled(e.target.checked)
                            if (e.target.checked) clampCut()
                          }}
                        />
                        Cut a middle range
                      </label>
                      {cutEnabled && (
                        <div className="action-row">
                          <button
                            type="button"
                            onClick={() => setCutStart(Math.min(current, cutEnd - 0.05))}
                          >
                            Mark cut start
                          </button>
                          <button
                            type="button"
                            onClick={() => setCutEnd(Math.max(current, cutStart + 0.05))}
                          >
                            Mark cut end
                          </button>
                        </div>
                      )}
                      <div className="action-row">
                        <button type="button" onClick={() => seekTo(inSec)}>
                          Jump to in
                        </button>
                        <button type="button" onClick={() => seekTo(outSec)}>
                          Jump to out
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                <section className="action-card">
                  <div className="action-card-head">
                    <h2>Remove silences</h2>
                    {silenceRanges.length > 0 && (
                      <span className="action-badge">{silenceRanges.length}</span>
                    )}
                  </div>
                  <p className="action-help">Local audio analysis · marks yellow on timeline</p>
                  <div className="action-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={silenceBusy || busy}
                      onClick={() => void onDetectSilences()}
                    >
                      {silenceBusy ? 'Detecting…' : 'Detect'}
                    </button>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={applySilences}
                        disabled={silenceRanges.length === 0}
                        onChange={(e) => setApplySilences(e.target.checked)}
                      />
                      Apply
                    </label>
                  </div>
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
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={applyFillers}
                        disabled={fillerRanges.length === 0}
                        onChange={(e) => setApplyFillers(e.target.checked)}
                      />
                      Apply
                    </label>
                  </div>
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
                  Export runs locally via ffmpeg.wasm. Overwrite clears the old transcript after
                  cuts.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
