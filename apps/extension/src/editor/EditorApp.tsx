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
import { openLibraryTab } from '../shared/navigation'
import {
  formatDuration,
  type RecordingRecord,
  type TranscriptData,
} from '../shared/types'
import { estimateOutputDuration, exportEditedVideo, type EditPlan } from './ffmpegExport'
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

export function EditorApp() {
  const [record, setRecord] = useState<RecordingRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
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
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [log, setLog] = useState('')
  const [transcript, setTranscript] = useState<TranscriptData | null>(null)
  const [transcribeBusy, setTranscribeBusy] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [noiseReduce, setNoiseReduce] = useState(false)
  const [showChapters, setShowChapters] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    void loadApiSettings().then((s) => setHasKey(hasOpenAiKey(s)))
    const onFocus = () => {
      void loadApiSettings().then((s) => setHasKey(hasOpenAiKey(s)))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('id')
    const safe =
      id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        ? id
        : null
    if (!safe) {
      setError('Missing or invalid recording id')
      return
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

  const plan: EditPlan = useMemo(
    () => ({
      inSec,
      outSec,
      cutStartSec: cutEnabled ? cutStart : null,
      cutEndSec: cutEnabled ? cutEnd : null,
      removeRanges: applySilences ? silenceRanges : [],
      noiseReduce,
    }),
    [inSec, outSec, cutEnabled, cutStart, cutEnd, applySilences, silenceRanges, noiseReduce],
  )

  const outDuration = estimateOutputDuration(plan)
  const chapters = useMemo(
    () => (transcript && showChapters ? chaptersFromTranscript(transcript) : []),
    [transcript, showChapters],
  )

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

  async function runExport(mode: 'download' | 'overwrite' | 'save-as') {
    if (!record) return
    setBusy(true)
    setProgress(0)
    setLog('Loading ffmpeg…')
    setError(null)
    try {
      const blob = await exportEditedVideo(
        record.blob,
        plan,
        (p) => setProgress(p),
        (msg) => setLog(msg),
      )
      const durationMs = outDuration * 1000
      if (mode === 'download') {
        downloadBlob(blob, recordingFilename({ ...record, mimeType: 'video/webm' }))
      } else if (mode === 'overwrite') {
        await updateRecordingBlob(record.id, blob, durationMs, undefined, true)
        await openLibraryTab(record.id)
      } else {
        const saved = await updateRecordingBlob(record.id, blob, durationMs, undefined, false)
        await openLibraryTab(saved.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  async function onDetectSilences() {
    if (!record) return
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
        setError('No silences found with current threshold. Try a higher threshold or shorter min duration.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Silence detection failed')
    } finally {
      setSilenceBusy(false)
    }
  }

  async function onTranscribe() {
    if (!record) return
    setTranscribeBusy(true)
    setError(null)
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
            Trim, cut selection, remove silences, transcribe — export runs locally via ffmpeg.wasm.
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
              <div
                className="playhead"
                style={{ left: `${duration ? (current / duration) * 100 : 0}%` }}
              />
            </div>
            <div className="timeline-legend muted">
              <span className="leg keep-leg">Keep</span>
              <span className="leg cut-leg">Cut selection</span>
              <span className="leg sil-leg">Silence</span>
            </div>
          </div>
        </div>

        <aside className="controls-panel">
          <section className="tool-section">
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

          <section className="tool-section">
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
              <button type="button" disabled={silenceBusy || busy} onClick={() => void onDetectSilences()}>
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

          <section className="tool-section">
            <h2>Export</h2>
            <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
              Output ≈ {secLabel(outDuration)}
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
          </section>

          {error && <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>}
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
              {transcribeBusy ? 'Transcribing…' : 'Transcribe'}
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
              Run Transcribe to generate captions. Uses your OpenAI key (Whisper). The recording
              itself stays local; only audio is sent to OpenAI for transcription.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}
