import { useEffect, useState } from 'react'
import { openLibraryTab, openRecorderTab } from '../shared/navigation'
import { loadPipSettings, savePipSettings } from '../shared/settings'
import type { BackgroundEffect, BubbleShape, RecordMode } from '../shared/types'

type LoomStatus = {
  recording: boolean
  tabId: number | null
  phase?: string | null
}

type MicOption = { deviceId: string; label: string }

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  try {
    const s = JSON.stringify(err)
    if (s && s !== '{}' && s !== 'null') return s
  } catch {
    /* ignore */
  }
  return fallback
}

function formatStartError(reason: string | undefined | null, fallback: string): string {
  const detail = typeof reason === 'string' ? reason.trim() : ''
  if (!detail) return fallback
  if (/^could not start recording/i.test(detail)) return detail
  return `${fallback}: ${detail}`
}

const MODES: { id: RecordMode; label: string; hint: string }[] = [
  { id: 'screen-cam', label: 'Tab + Cam', hint: 'This tab with circular camera PiP' },
  { id: 'screen', label: 'Tab only', hint: 'This tab without camera bubble' },
  { id: 'cam', label: 'Cam only', hint: 'Camera feed only (saved locally)' },
]

const SHAPES: { id: BubbleShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'square', label: 'Square' },
]

const EFFECTS: { id: BackgroundEffect; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'blur', label: 'Blur' },
]

export function PopupApp() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openOnFinish, setOpenOnFinish] = useState(true)
  const [recordMode, setRecordMode] = useState<RecordMode>('screen-cam')
  const [bubbleShape, setBubbleShape] = useState<BubbleShape>('circle')
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>('none')
  const [micDeviceId, setMicDeviceId] = useState<string>('')
  const [mics, setMics] = useState<MicOption[]>([])
  const [status, setStatus] = useState<LoomStatus>({ recording: false, tabId: null })

  const [micHint, setMicHint] = useState<string | null>(null)

  async function refreshMics() {
    setMicHint(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LIST_MIC_DEVICES',
      })) as {
        ok?: boolean
        devices?: MicOption[]
        reason?: string
      }
      if (!res?.ok) {
        setMics([])
        setMicHint(
          res?.reason ||
            'Allow microphone for MyPipCam, then click Refresh mics.',
        )
        return
      }
      const devices = res.devices ?? []
      setMics(devices)
      if (devices.length === 0) {
        setMicHint('No microphones found. Check Chrome mic permission for MyPipCam.')
      } else if (micDeviceId && !devices.some((d) => d.deviceId === micDeviceId)) {
        setMicDeviceId('')
        await savePipSettings({ micDeviceId: null })
      }
    } catch (err) {
      setMics([])
      setMicHint(errMessage(err, 'Could not list microphones'))
    }
  }

  useEffect(() => {
    void (async () => {
      const s = await loadPipSettings()
      setOpenOnFinish(s.openLibraryOnFinish)
      setRecordMode(s.recordMode || 'screen-cam')
      setBubbleShape(s.bubbleShape === 'square' ? 'square' : 'circle')
      setBackgroundEffect(s.backgroundEffect === 'blur' ? 'blur' : 'none')
      setMicDeviceId(s.micDeviceId || '')
      await refreshMics()
    })()

    void chrome.runtime
      .sendMessage({ type: 'GET_LOOM_STATUS' })
      .then((res: LoomStatus) => {
        if (res) setStatus(res)
      })
      .catch(() => undefined)
  }, [])

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      const url = tab?.url ?? ''
      if (!tab?.id || (url && !/^https?:/i.test(url))) {
        setError(
          "Can't record this page. Open a normal website tab (https://…) and try again.",
        )
        return
      }

      await savePipSettings({
        recordMode,
        micDeviceId: micDeviceId || null,
        bubbleShape,
        backgroundEffect,
      })

      // Mint tabCapture token in the popup click handler (strongest user gesture).
      // The token must be consumed by getUserMedia within a few seconds — background
      // prepares offscreen immediately; MediaRecorder waits for the on-page countdown.
      let streamId: string | null = null
      if (recordMode !== 'cam') {
        try {
          const getMediaStreamId = chrome.tabCapture.getMediaStreamId as (options: {
            targetTabId: number
          }) => Promise<string>
          streamId = await getMediaStreamId({ targetTabId: tab.id })
          if (!streamId) {
            setError(
              formatStartError(
                'No tab stream id from tabCapture',
                'Could not start recording',
              ),
            )
            return
          }
        } catch (err) {
          const detail = errMessage(
            err,
            'Tab capture denied. Use an https tab and click Start again.',
          )
          console.error('[MyPipCam popup] tabCapture failed:', detail, err)
          setError(formatStartError(detail, 'Could not start recording'))
          return
        }
      }

      const res = (await chrome.runtime.sendMessage({
        type: 'START_LOOM_RECORDING',
        tabId: tab.id,
        streamId,
        recordMode,
        micDeviceId: micDeviceId || null,
        includeMic: true,
      })) as { ok?: boolean; reason?: string } | undefined

      if (res == null) {
        setError(
          'Could not start recording: no response from background. Open chrome://extensions, click Reload on MyPipCam, then try again.',
        )
        return
      }
      if (!res.ok) {
        const reason = res.reason?.trim() || 'Background returned ok:false with no reason'
        console.error('[MyPipCam popup] start failed:', reason)
        setError(formatStartError(reason, 'Could not start recording'))
        return
      }
      window.close()
    } catch (err) {
      const detail = errMessage(err, 'Unexpected error')
      console.error('[MyPipCam popup] start threw:', detail, err)
      setError(formatStartError(detail, 'Could not start recording'))
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'STOP_LOOM_RECORDING',
      })) as { ok?: boolean; reason?: string } | undefined
      if (res == null) {
        setError(
          'Could not stop recording: no response from background. Try Reload on chrome://extensions.',
        )
        return
      }
      if (!res.ok) {
        setError(
          formatStartError(
            res.reason?.trim() || 'Background returned ok:false with no reason',
            'Could not stop recording',
          ),
        )
        return
      }
      window.close()
    } catch (err) {
      setError(formatStartError(errMessage(err, 'Unexpected error'), 'Could not stop recording'))
    } finally {
      setBusy(false)
    }
  }

  async function toggleOpenOnFinish(next: boolean) {
    setOpenOnFinish(next)
    await savePipSettings({ openLibraryOnFinish: next })
  }

  async function onModeChange(mode: RecordMode) {
    setRecordMode(mode)
    await savePipSettings({ recordMode: mode })
  }

  async function onShapeChange(shape: BubbleShape) {
    setBubbleShape(shape)
    await savePipSettings({ bubbleShape: shape })
  }

  async function onEffectChange(effect: BackgroundEffect) {
    setBackgroundEffect(effect)
    await savePipSettings({ backgroundEffect: effect })
  }

  async function onMicChange(id: string) {
    setMicDeviceId(id)
    await savePipSettings({ micDeviceId: id || null })
  }

  return (
    <div className="popup">
      <div className="popup-brand">
        <img className="popup-logo" src="/icons/icon48.png" width={28} height={28} alt="" aria-hidden />
        <div>
          <h1 className="brand">MyPipCam</h1>
          <p>Local Loom-style tab recorder</p>
        </div>
      </div>

      {status.recording ? (
        <button className="primary stop" disabled={busy} onClick={() => void stop()}>
          {busy ? 'Stopping…' : status.phase === 'countdown' ? 'Cancel countdown' : 'Stop recording'}
        </button>
      ) : (
        <>
          <div className="popup-modes" role="radiogroup" aria-label="Capture mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={recordMode === m.id}
                className={`popup-mode ${recordMode === m.id ? 'is-active' : ''}`}
                title={m.hint}
                onClick={() => void onModeChange(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="popup-shapes" role="radiogroup" aria-label="Camera bubble shape">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={bubbleShape === s.id}
                className={`popup-shape ${bubbleShape === s.id ? 'is-active' : ''}`}
                onClick={() => void onShapeChange(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="popup-shapes" role="radiogroup" aria-label="Background effect">
            {EFFECTS.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={backgroundEffect === e.id}
                className={`popup-shape ${backgroundEffect === e.id ? 'is-active' : ''}`}
                title={
                  e.id === 'blur'
                    ? 'Blur background behind you (person stays sharp)'
                    : 'No background effect'
                }
                onClick={() => void onEffectChange(e.id)}
              >
                {e.label}
              </button>
            ))}
          </div>

          <label className="popup-field">
            <span>Microphone</span>
            <select
              value={micDeviceId}
              onFocus={() => void refreshMics()}
              onMouseDown={() => void refreshMics()}
              onChange={(e) => void onMicChange(e.target.value)}
            >
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="popup-mic-row">
            <button type="button" className="ghost popup-mic-refresh" onClick={() => void refreshMics()}>
              Refresh mics
            </button>
            {mics.length > 0 ? (
              <span className="popup-mic-count">{mics.length} found</span>
            ) : null}
          </div>
          {micHint ? <p className="popup-hint popup-hint-muted">{micHint}</p> : null}

          <button className="primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start recording'}
          </button>
        </>
      )}

      {error && <p className="popup-error">{error}</p>}

      <div className="popup-actions">
        <button type="button" onClick={() => void openLibraryTab()}>
          Library
        </button>
        <button
          type="button"
          className="ghost"
          title="Screen / window capture with a separate live stage (advanced)"
          onClick={() => void openRecorderTab().then(() => window.close())}
        >
          Advanced
        </button>
      </div>

      <label>
        <input
          type="checkbox"
          checked={openOnFinish}
          onChange={(e) => void toggleOpenOnFinish(e.target.checked)}
        />
        Open library when done
      </label>

      <p className="popup-hint">
        3→2→1 countdown, then drag the camera bubble. Left dock: stop / pause / restart / discard.
        Shortcut: ⌘⇧U / Ctrl+Shift+U
      </p>
      <p className="popup-hint popup-hint-muted">
        Local only — no cloud share links, comments, or Loom AI in v1.
      </p>
    </div>
  )
}
