import { useEffect, useMemo, useRef, useState } from 'react'
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

function secLabel(s: number) {
  return formatDuration(s * 1000)
}

function parseEditorFocus(raw: string | null): EditorFocus | null {
  if (raw === 'trim' || raw === 'silence' || raw === 'filler') return raw
  return null
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
  const videoRef = useRef<HTMLVideoElement>(null)
  const trimSectionRef = useRef<HTMLElement>(null)
  const silenceSectionRef = useRef<HTMLElement>(null)
  const fillerSectionRef = useRef<HTMLElement>(null)
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
    if (focus === 'silence') {
      setFocusHint('Detecting silences… then review the yellow ranges and export.')
    } else if (focus === 'trim') {
      setFocusHint('Drag Out to trim the end, or set In/Out at the playhead — then export.')
    } else if (focus === 'filler') {
      setFocusHint(
        'Filler removal needs a transcript with word timings. Detect fillers below, then export.',
      )
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
      requestAnimationFrame(() => {
        const el =
          focus === 'silence'
            ? silenceSectionRef.current
            : focus === 'filler'
              ? fillerSectionRef.current
              : trimSectionRef.current
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
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

  function clampCut() {
    const start = Math.max(inSec, Math.min(cutStart, outSec))
    const end = Math.max(start, Math.min(cutEnd, outSec))
    setCutStart(start)
    setCutEnd(end)
  }

  function seekTo(t: number) {
    const v = videoRef.current
    if (v) v.currentTime = Math.max(0, Math.min(t, duration || t))
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
        setSuccess(`Found ${ranges.length} silence range${ranges.length === 1 ? '' : 's'}. Applied on export.`)
        setFocusHint('Silences highlighted in yellow. Export when ready (Download / Save as new / Overwrite).')
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
        setFocusHint('Fillers highlighted in purple. Export when ready.')
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
            setFocusHint(
              'Silences highlighted in yellow. Export when ready (Download / Save as new / Overwrite).',
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
            setFocusHint(
              'Add an OpenAI API key in Settings, then detect fillers to cut um/uh/like.',
            )
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
          setFocusHint('Fillers highlighted in purple. Export when ready.')
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
        // Timings no longer match the original transcript after cuts.
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

  if (error && !record) {
    return (
      <div className="page">
        <p className="error" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
        <button type="button" onClick={() => void openLibraryTab()}>
          Back to library
        </button>
      </div>
    )
  }

  if (!record || !videoUrl) {
    return (
      <div className="page">
        <p className="muted">Loading editor…</p>
      </div>
    )
  }

  return (
    <div className="page editor-page">
      <header className="page-header">
        <div className="editor-title-block">
          <InlineRename
            title={record.title}
            as="h1"
            className="editor-title"
            onSave={async (next) => {
              await renameRecording(record.id, next)
              setRecord({ ...record, title: next.trim() || record.title })
            }}
          />
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Trim, cut silences, remove fillers, transcribe — export runs locally via ffmpeg.wasm.
          </p>
        </div>
        <div className="row">
          <button
            type="button"
            className="ghost"
            onClick={() => void openLibraryTab(record.id, true)}
          >
            Settings
          </button>
          <button type="button" className="ghost" onClick={() => void openLibraryTab(record.id)}>
            Library
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

      <div className="editor-layout">
        <div className="preview-column">
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
            />
          </div>

          <div className="transport-bar">
            <span className="muted mono">
              {secLabel(current)} / {secLabel(duration)}
            </span>
            <label className="speed-label">
              Speed
              <select
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <span className="muted" style={{ fontSize: '0.75rem' }}>
                preview only
              </span>
            </label>
          </div>

          <div className="timeline-block">
            <div className="timeline" aria-hidden>
              <div
                className="keep"
                style={{
                  left: `${duration ? (inSec / duration) * 100 : 0}%`,
                  width: `${duration ? ((outSec - inSec) / duration) * 100 : 0}%`,
                }}
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
              <div
                className="playhead"
                style={{ left: `${duration ? (current / duration) * 100 : 0}%` }}
              />
            </div>
            <div className="timeline-legend muted">
              <span className="leg keep-leg">Keep</span>
              <span className="leg cut-leg">Cut selection</span>
              <span className="leg sil-leg">Silence</span>
              <span className="leg fil-leg">Filler</span>
            </div>
          </div>
        </div>

        <aside className="controls-panel">
          <section className="tool-section" ref={trimSectionRef}>
            <h2>Trim &amp; cut</h2>
            <div className="btn-row">
              <button type="button" onClick={() => setInSec(Math.min(current, outSec - 0.1))}>
                Set in at playhead
              </button>
              <button type="button" onClick={() => setOutSec(Math.max(current, inSec + 0.1))}>
                Set out at playhead
              </button>
            </div>
            <div className="btn-row">
              <button
                type="button"
                onClick={() => {
                  setOutSec(Math.max(current, inSec + 0.1))
                }}
                title="Trim everything after the playhead"
              >
                Cut ahead
              </button>
              <button
                type="button"
                onClick={() => {
                  setInSec(Math.min(current, outSec - 0.1))
                }}
                title="Trim everything before the playhead"
              >
                Cut behind
              </button>
              <button
                type="button"
                onClick={() => {
                  const mid = current
                  setCutEnabled(true)
                  setCutStart(Math.max(inSec, Math.min(mid, outSec - 0.2)))
                  setCutEnd(Math.min(outSec, Math.max(mid + 0.2, inSec + 0.2)))
                }}
              >
                Split at playhead
              </button>
            </div>

            <div className="field">
              <label>In · {secLabel(inSec)}</label>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.05}
                value={inSec}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setInSec(Math.min(v, outSec - 0.1))
                }}
              />
            </div>

            <div className="field">
              <label>Out · {secLabel(outSec)}</label>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.05}
                value={outSec}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setOutSec(Math.max(v, inSec + 0.1))
                }}
              />
            </div>

            <label className="row check-row">
              <input
                type="checkbox"
                checked={cutEnabled}
                onChange={(e) => {
                  setCutEnabled(e.target.checked)
                  if (e.target.checked) clampCut()
                }}
              />
              Cut selection (remove middle range)
            </label>

            {cutEnabled && (
              <>
                <div className="btn-row">
                  <button type="button" onClick={() => setCutStart(Math.min(current, cutEnd - 0.05))}>
                    Mark cut start
                  </button>
                  <button type="button" onClick={() => setCutEnd(Math.max(current, cutStart + 0.05))}>
                    Mark cut end
                  </button>
                </div>
                <div className="field">
                  <label>Cut start · {secLabel(cutStart)}</label>
                  <input
                    type="range"
                    min={inSec}
                    max={outSec}
                    step={0.05}
                    value={cutStart}
                    onChange={(e) => setCutStart(Math.min(Number(e.target.value), cutEnd - 0.05))}
                  />
                </div>
                <div className="field">
                  <label>Cut end · {secLabel(cutEnd)}</label>
                  <input
                    type="range"
                    min={inSec}
                    max={outSec}
                    step={0.05}
                    value={cutEnd}
                    onChange={(e) => setCutEnd(Math.max(Number(e.target.value), cutStart + 0.05))}
                  />
                </div>
              </>
            )}

            <div className="btn-row">
              <button type="button" onClick={() => seekTo(inSec)}>
                Jump to in
              </button>
              <button type="button" onClick={() => seekTo(outSec)}>
                Jump to out
              </button>
            </div>
          </section>

          <section className="tool-section" ref={silenceSectionRef}>
            <h2>Cut silences</h2>
            <p className="muted tool-help">
              Analyzes audio locally, highlights silent ranges, then removes them on export.
            </p>
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
            <div className="btn-row">
              <button
                type="button"
                disabled={silenceBusy || busy}
                onClick={() => void onDetectSilences()}
              >
                {silenceBusy ? 'Detecting…' : 'Detect silences'}
              </button>
              <label className="row check-row" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={applySilences}
                  disabled={silenceRanges.length === 0}
                  onChange={(e) => setApplySilences(e.target.checked)}
                />
                Apply on export ({silenceRanges.length})
              </label>
            </div>
          </section>

          <section className="tool-section" ref={fillerSectionRef}>
            <h2>Remove filler words</h2>
            <p className="muted tool-help">
              Uses Whisper word timings (um, uh, like, you know…). Needs an OpenAI key.
              {!hasWordTimings && transcript
                ? ' Current transcript has no word timings — detect will re-transcribe.'
                : !transcript
                  ? ' No transcript yet — detect will transcribe first.'
                  : ''}
            </p>
            <label className="row check-row">
              <input
                type="checkbox"
                checked={includeExtendedFillers}
                onChange={(e) => setIncludeExtendedFillers(e.target.checked)}
              />
              Include like / you know / basically / etc.
            </label>
            {!hasKey && (
              <p className="key-hint" style={{ margin: 0 }}>
                Add API key in Settings to enable filler removal.
              </p>
            )}
            <div className="btn-row">
              <button
                type="button"
                disabled={fillerBusy || transcribeBusy || busy || !hasKey}
                title={!hasKey ? 'Add API key in Settings' : undefined}
                onClick={() => void onDetectFillers()}
              >
                {fillerBusy || (transcribeBusy && editorFocus === 'filler')
                  ? hasWordTimings
                    ? 'Detecting…'
                    : 'Transcribing…'
                  : 'Detect fillers'}
              </button>
              {!hasKey && (
                <button type="button" onClick={() => void openLibraryTab(record.id, true)}>
                  Add API key
                </button>
              )}
              <label className="row check-row" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={applyFillers}
                  disabled={fillerRanges.length === 0}
                  onChange={(e) => setApplyFillers(e.target.checked)}
                />
                Apply on export ({fillerRanges.length})
              </label>
            </div>
          </section>

          <section className="tool-section">
            <h2>Export</h2>
            <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
              Output ≈ {secLabel(outDuration)}
              {applySilences || applyFillers || cutEnabled
                ? ` · removing ${
                    (applySilences ? silenceRanges.length : 0) +
                    (applyFillers ? fillerRanges.length : 0) +
                    (cutEnabled ? 1 : 0)
                  } cut(s)`
                : ''}
            </p>
            <label className="row check-row">
              <input
                type="checkbox"
                checked={noiseReduce}
                onChange={(e) => setNoiseReduce(e.target.checked)}
              />
              Noise reduction on export
              <span className="muted" style={{ fontSize: '0.75rem' }}>
                (ffmpeg afftdn — may fail on some clips)
              </span>
            </label>
            <div className="btn-row">
              <button
                className="primary"
                disabled={busy}
                onClick={() => void runExport('download')}
              >
                {busy ? 'Exporting…' : 'Download'}
              </button>
              <button disabled={busy} onClick={() => void runExport('save-as')}>
                Save as new
              </button>
              <button disabled={busy} onClick={() => void runExport('overwrite')}>
                Overwrite
              </button>
            </div>
            {busy && (
              <p className="progress">
                {(progress * 100).toFixed(0)}%{'\n'}
                {log.slice(-120)}
              </p>
            )}
            <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
              Overwrite clears the old transcript (timings no longer match). Re-transcribe after
              major cuts.
            </p>
          </section>

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
        </aside>

        <aside className="transcript-panel">
          <div className="transcript-header">
            <h2>Transcript</h2>
            {!hasKey && (
              <p className="key-hint">
                Add API key in Settings to enable Transcribe.
              </p>
            )}
          </div>

          <div className="btn-row">
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
                Add API key in Settings
              </button>
            )}
          </div>

          {transcript ? (
            <>
              <div className="btn-row">
                <button type="button" onClick={() => void copyTranscript()}>
                  Copy
                </button>
                <button type="button" onClick={() => downloadTranscript('txt')}>
                  Download .txt
                </button>
                <button type="button" onClick={() => downloadTranscript('srt')}>
                  Download .srt
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowChapters((v) => !v)}
                >
                  {showChapters ? 'Hide chapters' : 'Auto chapters'}
                </button>
              </div>
              {hasWordTimings ? (
                <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
                  Word timings available ({transcript.words!.length}) — filler cuts ready.
                </p>
              ) : (
                <p className="muted" style={{ margin: 0, fontSize: '0.75rem' }}>
                  No word timings on this transcript. Re-transcribe to enable filler removal.
                </p>
              )}

              {showChapters && (
                <div className="chapters-list">
                  {chapters.length === 0 ? (
                    <p className="muted" style={{ fontSize: '0.85rem' }}>
                      Not enough segment gaps for chapters.
                    </p>
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
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Run Transcribe to generate captions and word timings for filler removal. Uses your
              OpenAI key (Whisper). The recording stays local; only audio is sent to OpenAI.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
