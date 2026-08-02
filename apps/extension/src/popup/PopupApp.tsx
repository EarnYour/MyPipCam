import { useEffect, useRef, useState } from 'react'
import {
  MIC_GRANT_PAGE,
  MIC_GRANT_STORAGE_KEY,
  readMicGrantResult,
  writeMicGrantResult,
  type MicGrantResult,
} from '../shared/micGrant'
import { openLibraryTab, openRecorderTab } from '../shared/navigation'
import {
  listAudioInputs,
  listVideoInputs,
  loadPipSettings,
  savePipSettings,
  toMicOptions,
  unlockMediaDeviceLabels,
} from '../shared/settings'
import type { BackgroundEffect, BubbleShape, RecordMode } from '../shared/types'

type LoomStatus = {
  recording: boolean
  tabId: number | null
  phase?: string | null
}

type DeviceOption = { deviceId: string; label: string }

type PreflightStep = 'setup' | 'camera' | 'mic' | 'screen'
/** Mic must be granted via the visible grant window — popup/offscreen cannot show Allow. */
type MicAccess = 'unknown' | 'granted' | 'denied' | 'skipped'

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
  if (/permission dismissed|notallowed|permission denied/i.test(detail)) {
    return 'Permission dismissed — click Allow microphone to open the permission window, or choose Continue without mic. You can also check chrome://settings/content/microphone.'
  }
  if (/^could not start recording/i.test(detail)) return detail
  return `${fallback}: ${detail}`
}

function micAccessLabel(access: MicAccess): string {
  switch (access) {
    case 'granted':
      return 'Allowed'
    case 'denied':
      return 'Blocked'
    case 'skipped':
      return 'Recording without mic'
    default:
      return 'Not asked yet'
  }
}

function totalSteps(mode: RecordMode): number {
  let n = 1 // mic
  if (needsCamera(mode)) n += 1
  if (needsScreen(mode)) n += 1
  return n
}

function stepIndex(step: PreflightStep, mode: RecordMode): number {
  let i = 1
  if (step === 'camera') return i
  if (needsCamera(mode)) i += 1
  if (step === 'mic') return i
  i += 1
  if (step === 'screen') return i
  return i
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
  const [micAccess, setMicAccess] = useState<MicAccess>('unknown')
  const [targetTab, setTargetTab] = useState<{ id: number; title: string; url: string } | null>(
    null,
  )
  const micGrantPollRef = useRef<number | null>(null)
  const micGrantWindowIdRef = useRef<number | null>(null)
  const [micGrantWaiting, setMicGrantWaiting] = useState(false)

  function stopMicGrantPoll() {
    if (micGrantPollRef.current != null) {
      window.clearInterval(micGrantPollRef.current)
      micGrantPollRef.current = null
    }
  }

  async function applyMicGrantResult(result: MicGrantResult | null): Promise<boolean> {
    if (!result) return false
    if (result.status === 'granted') {
      stopMicGrantPoll()
      setMicGrantWaiting(false)
      setMicAccess('granted')
      if (result.devices && result.devices.length > 0) {
        setMics(result.devices)
      }
      setMicHint('Microphone allowed. Pick a device if needed, then continue.')
      await refreshMicsFromPopup()
      return true
    }
    if (result.status === 'denied' || result.status === 'error') {
      stopMicGrantPoll()
      setMicGrantWaiting(false)
      setMicAccess('denied')
      setMicHint(
        result.reason && !/dismissed|denied|notallowed/i.test(result.reason)
          ? result.reason
          : 'Microphone blocked. In the grant window click Allow again, or reset: chrome://settings/content/microphone → remove MyPipCam if blocked. macOS: System Settings → Privacy & Security → Microphone → Google Chrome ON. Or Continue without mic.',
      )
      return true
    }
    return false
  }

  async function probeMicPermissionState() {
    try {
      const perm = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      })
      if (perm.state === 'granted') setMicAccess((prev) => (prev === 'skipped' ? prev : 'granted'))
      else if (perm.state === 'denied') setMicAccess((prev) => (prev === 'skipped' ? prev : 'denied'))
      else if (micAccess !== 'skipped' && micAccess !== 'granted') setMicAccess('unknown')
      perm.onchange = () => {
        if (perm.state === 'granted') setMicAccess('granted')
        else if (perm.state === 'denied') setMicAccess('denied')
        else setMicAccess('unknown')
      }
    } catch {
      /* permissions.query(microphone) unsupported in some Chromium builds */
    }
  }

  /**
   * Open a dedicated extension window. Popup getUserMedia fails with
   * "Permission dismissed" / no Chrome Allow UI — the grant page button works.
   */
  async function allowMicrophone() {
    setError(null)
    setMicGrantWaiting(true)
    setMicHint('Permission window opened — click Allow microphone there, then Allow in Chrome’s dialog.')
    stopMicGrantPoll()

    try {
      await writeMicGrantResult('pending')

      const url = chrome.runtime.getURL(MIC_GRANT_PAGE)
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: 440,
        height: 340,
        focused: true,
      })
      micGrantWindowIdRef.current = typeof win?.id === 'number' ? win.id : null

      const startedAt = Date.now()
      micGrantPollRef.current = window.setInterval(() => {
        void (async () => {
          const result = await readMicGrantResult()
          if (await applyMicGrantResult(result)) return

          const winId = micGrantWindowIdRef.current
          if (winId != null) {
            try {
              await chrome.windows.get(winId)
            } catch {
              stopMicGrantPoll()
              const latest = await readMicGrantResult()
              if (!(await applyMicGrantResult(latest))) {
                setMicGrantWaiting(false)
                setMicAccess((prev) => (prev === 'granted' || prev === 'skipped' ? prev : 'denied'))
                setMicHint(
                  'Permission window closed before Allow. Click Allow microphone again, or Continue without mic.',
                )
              }
              return
            }
          }

          if (Date.now() - startedAt > 120_000) {
            stopMicGrantPoll()
            setMicGrantWaiting(false)
            setMicHint(
              'Still waiting — click Allow microphone in the permission window (then Chrome’s Allow), or Continue without mic.',
            )
          }
        })()
      }, 350)
    } catch (err) {
      setMicGrantWaiting(false)
      setMicAccess('denied')
      const detail = errMessage(err, 'Could not open microphone permission window')
      console.error('[MyPipCam][start] open mic grant window failed:', detail, err)
      setMicHint(detail)
    }
  }

  async function refreshMicsFromPopup() {
    try {
      const devices = await listAudioInputs({ unlock: false })
      const options = toMicOptions(devices)
      setMics(options)
      if (options.length === 0) {
        setMicHint((h) => h || 'No microphones found after grant. Check system input devices.')
      } else if (micDeviceId && !options.some((d) => d.deviceId === micDeviceId)) {
        setMicDeviceId('')
        await savePipSettings({ micDeviceId: null })
      }
    } catch (err) {
      setMicHint(errMessage(err, 'Could not list microphones'))
    }
  }

  async function refreshMics() {
    setMicHint(null)
    // Prefer popup-side enumeration after a visible grant (avoids offscreen probe).
    if (micAccess === 'granted') {
      await refreshMicsFromPopup()
      return
    }
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
            'Click Allow microphone first (Allow in the permission window).',
        )
        return
      }
      const devices = res.devices ?? []
      setMics(devices)
      if (devices.length === 0) {
        setMicHint('No microphones found. Click Allow microphone above.')
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
      await probeMicPermissionState()
      // Popup often closes when the grant window opens — pick up the result on reopen.
      const grant = await readMicGrantResult()
      if (await applyMicGrantResult(grant)) {
        /* status/hint set */
      }
      await refreshMics()

      // Surface start failures that happened after the popup was destroyed
      // (e.g. focus race) so the next open is not a silent dead end.
      try {
        const last = (await chrome.runtime.sendMessage({
          type: 'GET_LAST_START_ERROR',
        })) as { error?: { reason?: string; at?: number } | null }
        const reason = last?.error?.reason?.trim()
        const at = last?.error?.at
        if (reason && typeof at === 'number' && Date.now() - at < 60_000) {
          setError(formatStartError(reason, 'Could not start recording'))
          await chrome.runtime.sendMessage({ type: 'CLEAR_LAST_START_ERROR' }).catch(() => {})
        }
      } catch {
        /* ignore */
      }
    })()

    void chrome.runtime
      .sendMessage({ type: 'GET_LOOM_STATUS' })
      .then((res: LoomStatus) => {
        if (res) setStatus(res)
      })
      .catch(() => undefined)

    const onStorageChanged: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== 'session' || !changes[MIC_GRANT_STORAGE_KEY]) return
      const next = changes[MIC_GRANT_STORAGE_KEY].newValue as MicGrantResult | undefined
      void applyMicGrantResult(next ?? null)
    }
    chrome.storage.onChanged.addListener(onStorageChanged)

    const onMessage = (
      message: { type?: string; status?: string; reason?: string },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => {
      if (message?.type !== 'MIC_GRANT_RESULT') return
      void (async () => {
        await applyMicGrantResult({
          status: message.status === 'granted' ? 'granted' : 'denied',
          reason: message.reason,
          at: Date.now(),
        })
        sendResponse({ ok: true })
      })()
      return true
    }
    chrome.runtime.onMessage.addListener(onMessage)

    return () => {
      stopMicGrantPoll()
      chrome.storage.onChanged.removeListener(onStorageChanged)
      chrome.runtime.onMessage.removeListener(onMessage)
    }
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

  function goToMicStep() {
    void (async () => {
      await probeMicPermissionState()
      const grant = await readMicGrantResult()
      await applyMicGrantResult(grant)
    })()
    setStep('mic')
  }

  function advanceAfterMic() {
    if (needsScreen(recordMode)) {
      setStep('screen')
      return
    }
    void (async () => {
      const tab = targetTab ?? (await resolveActiveTab())
      if (!tab) return
      await commitStart(tab.id, null)
    })()
  }

  /** Begin Loom-like preflight: camera → mic (visible Allow) → share tab → countdown. */
  async function beginPreflight() {
    setBusy(true)
    setError(null)
    try {
      const tab = await resolveActiveTab()
      if (!tab) return
      setTargetTab(tab)
      await persistSetup()
      await probeMicPermissionState()

      if (needsCamera(recordMode)) {
        await refreshCameras()
        setStep('camera')
        return
      }
      goToMicStep()
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
      if (!targetTab) {
        const tab = await resolveActiveTab()
        if (!tab) return
        setTargetTab(tab)
      }
      goToMicStep()
    } catch (err) {
      setError(formatStartError(errMessage(err, 'Unexpected error'), 'Could not continue'))
    } finally {
      setBusy(false)
    }
  }

  async function continueWithMic() {
    setError(null)
    if (micAccess !== 'granted' && micAccess !== 'skipped') {
      setError('Click Allow microphone (use the permission window), or Continue without mic.')
      return
    }
    stopMicGrantPoll()
    setMicGrantWaiting(false)
    await persistSetup()
    advanceAfterMic()
  }

  async function continueWithoutMic() {
    setError(null)
    stopMicGrantPoll()
    setMicGrantWaiting(false)
    setMicAccess('skipped')
    setMicHint('Continuing without microphone. Tab audio may still be captured.')
    await persistSetup()
    advanceAfterMic()
  }

  /**
   * Screen step: mint tabCapture streamId on this click (user gesture), then start.
   * Streams are prepared immediately; MediaRecorder waits for the on-page 3→2→1.
   */
  async function shareTabAndStart() {
    setBusy(true)
    setError(null)
    try {
      if (micAccess !== 'granted' && micAccess !== 'skipped') {
        setError('Allow microphone first, or choose Continue without mic.')
        setStep('mic')
        return
      }

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
    const includeMic = micAccess === 'granted'
    console.log('[MyPipCam][start] popup commitStart', {
      tabId,
      hasStreamId: Boolean(streamId),
      includeMic,
      micAccess,
    })
    const res = (await chrome.runtime.sendMessage({
      type: 'START_LOOM_RECORDING',
      tabId,
      streamId,
      recordMode,
      micDeviceId: includeMic ? micDeviceId || null : null,
      cameraDeviceId: cameraDeviceId || null,
      includeMic,
    })) as { ok?: boolean; reason?: string; tabId?: number; ui?: string } | undefined

    if (res == null) {
      // Popup may have been destroyed mid-flight; check whether start actually armed.
      try {
        const status = (await chrome.runtime.sendMessage({
          type: 'GET_LOOM_STATUS',
        })) as LoomStatus | undefined
        if (status?.recording) {
          console.log('[MyPipCam][start] popup got null response but session is live — not force-stopping')
          try {
            await chrome.runtime.sendMessage({
              type: 'FOCUS_CAPTURED_TAB',
              tabId: status.tabId ?? tabId,
            })
          } catch {
            /* ignore */
          }
          window.close()
          return
        }
      } catch {
        /* SW dead */
      }
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
      console.error('[MyPipCam][start] popup start failed:', reason)
      // Background already tears down on failure; only force-stop if Sharing lingers.
      try {
        const status = (await chrome.runtime.sendMessage({
          type: 'GET_LOOM_STATUS',
        })) as LoomStatus | undefined
        if (status?.recording) {
          await chrome.runtime.sendMessage({ type: 'FORCE_STOP_CAPTURE', tabId })
        }
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
    console.log('[MyPipCam][start] popup start ok', res)
    try {
      await chrome.runtime.sendMessage({
        type: 'FOCUS_CAPTURED_TAB',
        tabId: res.tabId ?? tabId,
      })
    } catch {
      /* ignore */
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
          <p className="popup-step-label">
            Step {stepIndex('camera', recordMode)} of {totalSteps(recordMode)} — Camera
          </p>
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

          <div className="popup-actions">
            <button type="button" className="ghost" disabled={busy} onClick={backToSetup}>
              Back
            </button>
            <button className="primary" disabled={busy} onClick={() => void nextFromCamera()}>
              {busy ? 'Working…' : 'Next: microphone'}
            </button>
          </div>
        </>
      ) : step === 'mic' ? (
        <>
          <p className="popup-step-label">
            Step {stepIndex('mic', recordMode)} of {totalSteps(recordMode)} — Microphone
          </p>
          <p className="popup-hint">
            Opens a permission window — click <strong>Allow microphone</strong> there so Chrome can
            show its Allow dialog. (This popup cannot.)
          </p>
          <p className={`popup-mic-status is-${micAccess}`} role="status">
            Status: <strong>{micAccessLabel(micAccess)}</strong>
          </p>
          <button
            type="button"
            className="primary"
            disabled={micGrantWaiting}
            onClick={() => void allowMicrophone()}
          >
            {micGrantWaiting ? 'Waiting for grant window…' : 'Allow microphone'}
          </button>
          <label className="popup-field">
            <span>Microphone device</span>
            <select
              value={micDeviceId}
              disabled={micAccess !== 'granted'}
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
          {micHint ? <p className="popup-hint popup-hint-muted">{micHint}</p> : null}
          <div className="popup-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setError(null)
                setStep(needsCamera(recordMode) ? 'camera' : 'setup')
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void continueWithoutMic()}
            >
              Continue without mic
            </button>
            <button
              className="primary"
              disabled={micAccess !== 'granted' && micAccess !== 'skipped'}
              onClick={() => void continueWithMic()}
            >
              {needsScreen(recordMode) ? 'Next: choose tab' : 'Start countdown'}
            </button>
          </div>
        </>
      ) : step === 'screen' ? (
        <>
          <p className="popup-step-label">
            Step {stepIndex('screen', recordMode)} of {totalSteps(recordMode)} — Tab
          </p>
          <p className="popup-hint">
            Chrome will share the active tab for recording. Confirm this is the page you want:
          </p>
          <p className="popup-tab-card" title={targetTab?.url}>
            <strong>{targetTab?.title || 'Active tab'}</strong>
          </p>
          <p className="popup-hint popup-hint-muted">
            Mic: {micAccessLabel(micAccess)}. After you share, a 3→2→1 countdown runs on the page.
          </p>
          <div className="popup-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setError(null)
                setStep('mic')
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
            Loom-style: camera → allow mic → share tab → 3→2→1 countdown → record.
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
