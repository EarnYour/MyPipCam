import { useEffect, useState } from 'react'
import { openLibraryTab, openRecorderTab } from '../shared/navigation'
import {
  listVideoInputs,
  loadPipSettings,
  savePipSettings,
  unlockMediaDeviceLabels,
} from '../shared/settings'
import type { BackgroundEffect, BubbleShape, RecordMode } from '../shared/types'

type LoomStatus = {
  recording: boolean
  tabId: number | null
  phase?: string | null
}

type DeviceOption = { deviceId: string; label: string }

type PreflightStep = 'setup' | 'camera' | 'screen'

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

function needsCamera(mode: RecordMode): boolean {
  return mode === 'screen-cam' || mode === 'cam'
}

function needsScreen(mode: RecordMode): boolean {
  return mode === 'screen-cam' || mode === 'screen'
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
  const [cameraDeviceId, setCameraDeviceId] = useState<string>('')
  const [mics, setMics] = useState<DeviceOption[]>([])
  const [cameras, setCameras] = useState<DeviceOption[]>([])
  const [status, setStatus] = useState<LoomStatus>({ recording: false, tabId: null })
  const [micHint, setMicHint] = useState<string | null>(null)
  const [cameraHint, setCameraHint] = useState<string | null>(null)
  const [step, setStep] = useState<PreflightStep>('setup')
  const [targetTab, setTargetTab] = useState<{ id: number; title: string; url: string } | null>(
    null,
  )

  async function refreshMics() {
    setMicHint(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LIST_MIC_DEVICES',
      })) as {
        ok?: boolean
        devices?: DeviceOption[]
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

  async function refreshCameras() {
    setCameraHint(null)
    try {
      const devices = await listVideoInputs({ unlock: true })
      const options = devices.map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label?.trim() || `Camera ${i + 1}`,
      }))
      setCameras(options)
      if (options.length === 0) {
        setCameraHint('No cameras found. Allow camera access, then click Refresh cameras.')
      } else if (cameraDeviceId && !options.some((d) => d.deviceId === cameraDeviceId)) {
        setCameraDeviceId('')
        await savePipSettings({ cameraDeviceId: null })
      }
    } catch (err) {
      setCameras([])
      setCameraHint(errMessage(err, 'Could not list cameras'))
    }
  }

  async function allowCamera() {
    setCameraHint(null)
    setBusy(true)
    try {
      const ok = await unlockMediaDeviceLabels('video')
      if (!ok) {
        setCameraHint('Camera permission denied. Allow camera for this extension and try again.')
        return
      }
      await refreshCameras()
      setCameraHint(null)
    } catch (err) {
      setCameraHint(errMessage(err, 'Could not request camera access'))
    } finally {
      setBusy(false)
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
      setCameraDeviceId(s.cameraDeviceId || '')
      await refreshMics()
    })()

    void chrome.runtime
      .sendMessage({ type: 'GET_LOOM_STATUS' })
      .then((res: LoomStatus) => {
        if (res) setStatus(res)
      })
      .catch(() => undefined)
  }, [])

  async function resolveActiveTab(): Promise<{ id: number; title: string; url: string } | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? ''
    if (!tab?.id || (url && !/^https?:/i.test(url))) {
      setError(
        "Can't record this page. Open a normal website tab (https://…) and try again.",
      )
      return null
    }
    return {
      id: tab.id,
      title: (tab.title || 'This tab').slice(0, 80),
      url,
    }
  }

  async function persistSetup() {
    await savePipSettings({
      recordMode,
      micDeviceId: micDeviceId || null,
      cameraDeviceId: cameraDeviceId || null,
      bubbleShape,
      backgroundEffect,
    })
  }

  /** Begin Loom-like preflight: camera first (if needed), then screen, then start. */
  async function beginPreflight() {
    setBusy(true)
    setError(null)
    try {
      const tab = await resolveActiveTab()
      if (!tab) return
      setTargetTab(tab)
      await persistSetup()

      if (needsCamera(recordMode)) {
        await refreshCameras()
        await refreshMics()
        setStep('camera')
        return
      }
      if (needsScreen(recordMode)) {
        setStep('screen')
        return
      }
      await commitStart(tab.id, null)
    } catch (err) {
      setError(formatStartError(errMessage(err, 'Unexpected error'), 'Could not start recording'))
    } finally {
      setBusy(false)
    }
  }

  async function nextFromCamera() {
    setBusy(true)
    setError(null)
    try {
      await persistSetup()
      if (needsScreen(recordMode)) {
        if (!targetTab) {
          const tab = await resolveActiveTab()
          if (!tab) return
          setTargetTab(tab)
        }
        setStep('screen')
        return
      }
      const tab = targetTab ?? (await resolveActiveTab())
      if (!tab) return
      await commitStart(tab.id, null)
    } catch (err) {
      setError(formatStartError(errMessage(err, 'Unexpected error'), 'Could not continue'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Screen step: mint tabCapture streamId on this click (user gesture), then start.
   * Streams are prepared immediately; MediaRecorder waits for the on-page 3→2→1.
   */
  async function shareTabAndStart() {
    setBusy(true)
    setError(null)
    try {
      const tab = targetTab ?? (await resolveActiveTab())
      if (!tab) return

      await persistSetup()

      let streamId: string | null = null
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
          'Tab capture denied. Use an https tab and click Share tab again.',
        )
        console.error('[MyPipCam popup] tabCapture failed:', detail, err)
        setError(formatStartError(detail, 'Could not start recording'))
        return
      }

      await commitStart(tab.id, streamId)
    } catch (err) {
      const detail = errMessage(err, 'Unexpected error')
      console.error('[MyPipCam popup] screen step threw:', detail, err)
      setError(formatStartError(detail, 'Could not start recording'))
    } finally {
      setBusy(false)
    }
  }

  async function commitStart(tabId: number, streamId: string | null) {
    const res = (await chrome.runtime.sendMessage({
      type: 'START_LOOM_RECORDING',
      tabId,
      streamId,
      recordMode,
      micDeviceId: micDeviceId || null,
      cameraDeviceId: cameraDeviceId || null,
      includeMic: true,
    })) as { ok?: boolean; reason?: string } | undefined

    if (res == null) {
      // Stream may already be held by offscreen — force teardown so Sharing clears.
      try {
        await chrome.runtime.sendMessage({ type: 'FORCE_STOP_CAPTURE', tabId })
      } catch {
        /* SW dead */
      }
      setError(
        'Could not start recording: no response from background. Remove ALL MyPipCam copies on chrome://extensions, then Load unpacked → apps/extension/dist only. Confirm ID is akpchobfndfddajiihkkdpnihihdicjc, then click the service worker link and retry. If Chrome still says “Sharing…”, click Stop sharing in the toolbar.',
      )
      return
    }
    if (!res.ok) {
      const reason = res.reason?.trim() || 'Background returned ok:false with no reason'
      console.error('[MyPipCam popup] start failed:', reason)
      try {
        await chrome.runtime.sendMessage({ type: 'FORCE_STOP_CAPTURE', tabId })
      } catch {
        /* ignore */
      }
      setError(
        formatStartError(
          `${reason} If Chrome still shows “Sharing…”, click Stop sharing in the toolbar.`,
          'Could not start recording',
        ),
      )
      return
    }
    window.close()
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

  async function onCameraChange(id: string) {
    setCameraDeviceId(id)
    await savePipSettings({ cameraDeviceId: id || null })
  }

  function backToSetup() {
    setStep('setup')
    setError(null)
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
      ) : step === 'camera' ? (
        <>
          <p className="popup-step-label">Step 1 of {needsScreen(recordMode) ? 2 : 1} — Camera</p>
          <label className="popup-field">
            <span>Camera</span>
            <select
              value={cameraDeviceId}
              onFocus={() => void refreshCameras()}
              onChange={(e) => void onCameraChange(e.target.value)}
            >
              <option value="">System default</option>
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div className="popup-mic-row">
            <button type="button" className="ghost popup-mic-refresh" onClick={() => void allowCamera()}>
              Allow camera
            </button>
            <button type="button" className="ghost popup-mic-refresh" onClick={() => void refreshCameras()}>
              Refresh cameras
            </button>
          </div>
          {cameraHint ? <p className="popup-hint popup-hint-muted">{cameraHint}</p> : null}

          <label className="popup-field">
            <span>Microphone</span>
            <select
              value={micDeviceId}
              onFocus={() => void refreshMics()}
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

          <div className="popup-actions">
            <button type="button" className="ghost" disabled={busy} onClick={backToSetup}>
              Back
            </button>
            <button className="primary" disabled={busy} onClick={() => void nextFromCamera()}>
              {busy
                ? 'Working…'
                : needsScreen(recordMode)
                  ? 'Next: choose tab'
                  : 'Start countdown'}
            </button>
          </div>
        </>
      ) : step === 'screen' ? (
        <>
          <p className="popup-step-label">
            Step {needsCamera(recordMode) ? '2' : '1'} of {needsCamera(recordMode) ? 2 : 1} — Tab
          </p>
          <p className="popup-hint">
            Chrome will share the active tab for recording. Confirm this is the page you want:
          </p>
          <p className="popup-tab-card" title={targetTab?.url}>
            <strong>{targetTab?.title || 'Active tab'}</strong>
          </p>
          <p className="popup-hint popup-hint-muted">
            After you share, a 3→2→1 countdown runs on the page, then recording starts.
          </p>
          <div className="popup-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                setStep(needsCamera(recordMode) ? 'camera' : 'setup')
              }}
            >
              Back
            </button>
            <button className="primary" disabled={busy} onClick={() => void shareTabAndStart()}>
              {busy ? 'Starting…' : 'Share tab & start'}
            </button>
          </div>
        </>
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

          <button className="primary" disabled={busy} onClick={() => void beginPreflight()}>
            {busy ? 'Starting…' : 'Start recording'}
          </button>
          <p className="popup-hint">
            Loom-style: camera → share tab → 3→2→1 countdown → record.
          </p>
        </>
      )}

      {error && <p className="popup-error">{error}</p>}

      {step === 'setup' && !status.recording ? (
        <>
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

          <p className="popup-hint popup-hint-muted">
            Local only — no cloud share links, comments, or Loom AI in v1. Shortcut: ⌘⇧U /
            Ctrl+Shift+U
          </p>
        </>
      ) : null}
    </div>
  )
}
