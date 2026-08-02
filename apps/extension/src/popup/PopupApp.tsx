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
  CAMERA_FILTERS,
  cameraFilterCss,
  normalizeCameraFilter,
  type CameraFilterId,
} from '../shared/cameraFilters'
import {
  listAudioInputs,
  listVideoInputs,
  loadPipSettings,
  savePipSettings,
  toMicOptions,
  unlockMediaDeviceLabels,
} from '../shared/settings'
import { openShareGuidanceTab, writeShareSession } from '../shared/shareSession'
import {
  BORDER_PRESETS,
  BORDER_WIDTH_OPTIONS,
  CAPTURE_QUALITY_OPTIONS,
  normalizeBorderWidth,
  normalizeCaptureQuality,
  type BackgroundEffect,
  type CaptureQuality,
  type RecordMode,
} from '../shared/types'

type LoomStatus = {
  recording: boolean
  tabId: number | null
  phase?: string | null
}

type DeviceOption = { deviceId: string; label: string }
type CaptureScope = 'tab' | 'cam'
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
    return 'Microphone blocked — turn Mic On to open the grant window, or turn Mic off to continue without it.'
  }
  if (/^could not start recording/i.test(detail)) return detail
  return `${fallback}: ${detail}`
}

function truncateLabel(label: string, max = 22): string {
  const t = label.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

function deriveRecordMode(scope: CaptureScope, cameraOn: boolean): RecordMode {
  if (scope === 'cam') return 'cam'
  return cameraOn ? 'screen-cam' : 'screen'
}

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M4.5 10.5 12 4l7.5 6.5V20a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-3v6H6A1.5 1.5 0 0 1 4.5 20v-9.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconRecord() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <rect x="3.5" y="7" width="13" height="10" rx="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16.5 10.5 20.5 8v8l-4-2.5v-3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

function IconTab() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <rect x="3.5" y="5" width="17" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 9h17" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function IconCam({ className }: { className?: string } = {}) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <rect x="3.5" y="7" width="12.5" height="10" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 10.5 20.5 8v8L16 13.5v-3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  )
}

function IconMic({ className }: { className?: string } = {}) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <rect x="9" y="3.5" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

function IconEffects() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M12 3.5 13.8 9.2 19.5 11 13.8 12.8 12 18.5 10.2 12.8 4.5 11 10.2 9.2 12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconBlur() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}

function IconMore() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <circle cx="6.5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="17.5" cy="12" r="1.4" fill="currentColor" />
    </svg>
  )
}

function IconChevron() {
  return (
    <svg className="loom-scope-chevron" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M8 10l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconCursor({ className }: { className?: string } = {}) {
  return (
    <svg className={className} viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden>
      <path
        d="M5.5 4.5 10 18.5l2.2-5.3L18 11 5.5 4.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconBack() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
      <path
        d="M15 6 9 12l6 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function PopupApp() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [helper, setHelper] = useState<string | null>(null)
  const [scope, setScope] = useState<CaptureScope>('tab')
  const [cameraOn, setCameraOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>('none')
  const [cameraFilter, setCameraFilter] = useState<CameraFilterId>('none')
  const [borderColor, setBorderColor] = useState('#ffffff')
  const [borderWidth, setBorderWidth] = useState(3)
  const [captureCursor, setCaptureCursor] = useState(true)
  const [captureQuality, setCaptureQuality] = useState<CaptureQuality>('4k')
  const [effectsOpen, setEffectsOpen] = useState(false)
  const [micDeviceId, setMicDeviceId] = useState('')
  const [cameraDeviceId, setCameraDeviceId] = useState('')
  const [mics, setMics] = useState<DeviceOption[]>([])
  const [cameras, setCameras] = useState<DeviceOption[]>([])
  const [status, setStatus] = useState<LoomStatus>({ recording: false, tabId: null })
  const [micAccess, setMicAccess] = useState<MicAccess>('unknown')
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
      setMicOn(true)
      if (result.devices && result.devices.length > 0) setMics(result.devices)
      setHelper('Microphone allowed')
      await refreshMicsFromPopup()
      return true
    }
    if (result.status === 'denied' || result.status === 'error') {
      stopMicGrantPoll()
      setMicGrantWaiting(false)
      setMicAccess('denied')
      setMicOn(false)
      setHelper(
        result.reason && !/dismissed|denied|notallowed/i.test(result.reason)
          ? result.reason
          : 'Mic blocked — check Chrome mic settings, or leave Mic off',
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
      if (perm.state === 'granted') {
        setMicAccess((prev) => (prev === 'skipped' ? prev : 'granted'))
        setMicOn(true)
      } else if (perm.state === 'denied') {
        setMicAccess((prev) => (prev === 'skipped' ? prev : 'denied'))
      }
      perm.onchange = () => {
        if (perm.state === 'granted') {
          setMicAccess('granted')
          setMicOn(true)
        } else if (perm.state === 'denied') {
          setMicAccess('denied')
        } else {
          setMicAccess('unknown')
        }
      }
    } catch {
      /* permissions.query(microphone) unsupported in some Chromium builds */
    }
  }

  async function allowMicrophone() {
    setError(null)
    setMicGrantWaiting(true)
    setHelper('Grant window opened — Allow microphone there')
    stopMicGrantPoll()

    try {
      await writeMicGrantResult('pending')
      const url = chrome.runtime.getURL(MIC_GRANT_PAGE)
      const win = await chrome.windows.create({
        url,
        type: 'normal',
        width: 560,
        height: 480,
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
                setMicOn(false)
                setHelper('Grant window closed — turn Mic On to try again')
              }
              return
            }
          }

          if (Date.now() - startedAt > 120_000) {
            stopMicGrantPoll()
            setMicGrantWaiting(false)
            setHelper('Still waiting for mic allow — or turn Mic off')
          }
        })()
      }, 350)
    } catch (err) {
      setMicGrantWaiting(false)
      setMicAccess('denied')
      setMicOn(false)
      setHelper(errMessage(err, 'Could not open microphone permission window'))
    }
  }

  async function refreshMicsFromPopup() {
    try {
      const devices = await listAudioInputs({ unlock: false })
      const options = toMicOptions(devices)
      setMics(options)
      if (micDeviceId && !options.some((d) => d.deviceId === micDeviceId)) {
        setMicDeviceId('')
        await savePipSettings({ micDeviceId: null })
      }
    } catch {
      /* ignore */
    }
  }

  async function refreshMics() {
    if (micAccess === 'granted') {
      await refreshMicsFromPopup()
      return
    }
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LIST_MIC_DEVICES',
      })) as { ok?: boolean; devices?: DeviceOption[] }
      if (!res?.ok) {
        setMics([])
        return
      }
      setMics(res.devices ?? [])
    } catch {
      setMics([])
    }
  }

  async function refreshCameras() {
    try {
      const devices = await listVideoInputs({ unlock: true })
      const options = devices.map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label?.trim() || `Camera ${i + 1}`,
      }))
      setCameras(options)
      if (cameraDeviceId && !options.some((d) => d.deviceId === cameraDeviceId)) {
        setCameraDeviceId('')
        await savePipSettings({ cameraDeviceId: null })
      }
    } catch {
      setCameras([])
    }
  }

  async function allowCamera(): Promise<boolean> {
    setBusy(true)
    try {
      const ok = await unlockMediaDeviceLabels('video')
      if (!ok) {
        setHelper('Camera permission denied')
        setCameraOn(false)
        return false
      }
      await refreshCameras()
      setCameraOn(true)
      return true
    } catch (err) {
      setHelper(errMessage(err, 'Could not request camera access'))
      setCameraOn(false)
      return false
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void (async () => {
      const s = await loadPipSettings()
      const mode = s.recordMode || 'screen-cam'
      setScope(mode === 'cam' ? 'cam' : 'tab')
      setCameraOn(mode !== 'screen')
      setBackgroundEffect(s.backgroundEffect === 'blur' ? 'blur' : 'none')
      setCameraFilter(normalizeCameraFilter(s.cameraFilter))
      setBorderColor(s.borderColor || '#ffffff')
      setBorderWidth(normalizeBorderWidth(s.borderWidth))
      setCaptureCursor(s.captureCursor !== false)
      setCaptureQuality(normalizeCaptureQuality(s.captureQuality))
      setMicDeviceId(s.micDeviceId || '')
      setCameraDeviceId(s.cameraDeviceId || '')
      await probeMicPermissionState()
      const grant = await readMicGrantResult()
      await applyMicGrantResult(grant)
      await refreshMics()
      await refreshCameras()

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
      if ((area !== 'session' && area !== 'local') || !changes[MIC_GRANT_STORAGE_KEY]) return
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

  // Dim the active page while this popup is open (Loom-style). Port disconnect
  // clears the scrim; visibility/unload are backups if close is abrupt.
  useEffect(() => {
    let port: chrome.runtime.Port | null = null
    try {
      port = chrome.runtime.connect({ name: 'popup-dim' })
    } catch {
      return
    }

    const disconnectDim = () => {
      if (!port) return
      try {
        port.disconnect()
      } catch {
        /* already disconnected */
      }
      port = null
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') disconnectDim()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', disconnectDim)
    window.addEventListener('beforeunload', disconnectDim)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', disconnectDim)
      window.removeEventListener('beforeunload', disconnectDim)
      disconnectDim()
    }
  }, [])

  async function resolveActiveTab(): Promise<{ id: number; title: string; url: string } | null> {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = active?.url ?? ''
    if (!active?.id || (url && !/^https?:/i.test(url))) {
      setError("Can't record this page. Open a normal website tab (https://…) and try again.")
      return null
    }
    return {
      id: active.id,
      title: (active.title || 'This tab').slice(0, 80),
      url,
    }
  }

  async function persistSetup(mode: RecordMode) {
    await savePipSettings({
      recordMode: mode,
      micDeviceId: micDeviceId || null,
      cameraDeviceId: cameraDeviceId || null,
      backgroundEffect,
      cameraFilter,
      borderColor,
      borderWidth,
      captureCursor,
      captureQuality,
    })
  }

  async function onToggleCaptureCursor(next: boolean) {
    setCaptureCursor(next)
    await savePipSettings({ captureCursor: next })
    setHelper(
      next
        ? 'Mouse cursor will appear in tab recordings'
        : 'Mouse cursor hidden in tab recordings',
    )
  }

  async function onCaptureQualityChange(next: CaptureQuality) {
    setCaptureQuality(next)
    await savePipSettings({ captureQuality: next })
    const label = CAPTURE_QUALITY_OPTIONS.find((o) => o.id === next)?.label ?? next
    setHelper(`Tab capture quality: ${label} (camera PiP unchanged)`)
  }

  async function commitStart(tabId: number, streamId: string | null, mode: RecordMode, includeMic: boolean) {
    const res = (await chrome.runtime.sendMessage({
      type: 'START_LOOM_RECORDING',
      tabId,
      streamId,
      recordMode: mode,
      micDeviceId: includeMic ? micDeviceId || null : null,
      cameraDeviceId: cameraDeviceId || null,
      includeMic,
    })) as { ok?: boolean; reason?: string; tabId?: number } | undefined

    if (res == null) {
      try {
        const live = (await chrome.runtime.sendMessage({
          type: 'GET_LOOM_STATUS',
        })) as LoomStatus | undefined
        if (live?.recording) {
          await chrome.runtime
            .sendMessage({ type: 'FOCUS_CAPTURED_TAB', tabId: live.tabId ?? tabId })
            .catch(() => {})
          window.close()
          return
        }
      } catch {
        /* SW dead */
      }
      try {
        await chrome.runtime.sendMessage({ type: 'FORCE_STOP_CAPTURE', tabId })
      } catch {
        /* ignore */
      }
      setError(
        'Could not start recording: no response from background. Reload the extension on chrome://extensions and try again.',
      )
      return
    }
    if (!res.ok) {
      setError(
        formatStartError(
          `${res.reason?.trim() || 'Background returned ok:false'} If Chrome still shows “Sharing…”, click Stop sharing.`,
          'Could not start recording',
        ),
      )
      return
    }
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

  async function startRecording() {
    setBusy(true)
    setError(null)
    setHelper(null)
    try {
      const active = await resolveActiveTab()
      if (!active) return

      if (scope === 'cam' && !cameraOn) {
        setError('Turn Camera On for camera-only recording.')
        return
      }

      const mode = deriveRecordMode(scope, cameraOn)
      const wantsCam = mode === 'screen-cam' || mode === 'cam'
      const wantsMic = micOn

      if (wantsCam) {
        const ok = await allowCamera()
        if (!ok) {
          setError('Turn Camera On and allow access, or switch scope / turn camera off.')
          return
        }
      }

      let includeMic = false
      if (wantsMic) {
        await probeMicPermissionState()
        const grant = await readMicGrantResult()
        await applyMicGrantResult(grant)
        let micGranted = grant?.status === 'granted'
        if (!micGranted) {
          try {
            const perm = await navigator.permissions.query({
              name: 'microphone' as PermissionName,
            })
            micGranted = perm.state === 'granted'
          } catch {
            /* ignore */
          }
        }
        if (!micGranted) {
          await allowMicrophone()
          setError(
            'Allow microphone in the grant window, then click Start Recording again — or turn Mic off.',
          )
          return
        }
        setMicAccess('granted')
        includeMic = true
      } else {
        setMicAccess('skipped')
      }

      await persistSetup(mode)

      if (mode === 'cam') {
        await commitStart(active.id, null, mode, includeMic)
        return
      }

      await writeShareSession({
        returnTabId: active.id,
        returnTabTitle: active.title,
        recordMode: mode,
        micDeviceId: includeMic ? micDeviceId || null : null,
        cameraDeviceId: cameraDeviceId || null,
        includeMic,
        at: Date.now(),
      })
      await openShareGuidanceTab()
      window.close()
    } catch (err) {
      setError(formatStartError(errMessage(err, 'Unexpected error'), 'Could not start recording'))
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
        setError('Could not stop recording. Try Reload on chrome://extensions.')
        return
      }
      if (!res.ok) {
        setError(formatStartError(res.reason, 'Could not stop recording'))
        return
      }
      window.close()
    } catch (err) {
      setError(formatStartError(errMessage(err, 'Unexpected error'), 'Could not stop recording'))
    } finally {
      setBusy(false)
    }
  }

  async function onToggleCamera(next: boolean) {
    setError(null)
    if (!next) {
      setCameraOn(false)
      if (scope === 'tab') await savePipSettings({ recordMode: 'screen' })
      return
    }
    const ok = await allowCamera()
    if (ok && scope === 'tab') await savePipSettings({ recordMode: 'screen-cam' })
  }

  async function onToggleMic(next: boolean) {
    setError(null)
    if (!next) {
      setMicOn(false)
      setMicAccess('skipped')
      stopMicGrantPoll()
      setMicGrantWaiting(false)
      setHelper('Recording without microphone')
      return
    }
    setMicOn(true)
    if (micAccess === 'granted') {
      setHelper(null)
      return
    }
    await allowMicrophone()
  }

  async function onScopeChange(next: CaptureScope) {
    setScope(next)
    const mode = deriveRecordMode(next, cameraOn)
    await savePipSettings({ recordMode: mode })
  }

  async function onMicChange(id: string) {
    setMicDeviceId(id)
    await savePipSettings({ micDeviceId: id || null })
  }

  async function onCameraChange(id: string) {
    setCameraDeviceId(id)
    await savePipSettings({ cameraDeviceId: id || null })
  }

  async function toggleBlur() {
    const next: BackgroundEffect = backgroundEffect === 'blur' ? 'none' : 'blur'
    setBackgroundEffect(next)
    await savePipSettings({ backgroundEffect: next })
    try {
      await chrome.runtime.sendMessage({
        type: 'LOOM_BUBBLE_EFFECT',
        backgroundEffect: next,
      })
    } catch {
      /* SW may be asleep — settings already persisted */
    }
    setHelper(next === 'blur' ? 'Background blur on' : 'Background blur off')
  }

  async function selectCameraFilter(id: CameraFilterId) {
    const next = normalizeCameraFilter(id)
    setCameraFilter(next)
    await savePipSettings({ cameraFilter: next })
    try {
      await chrome.runtime.sendMessage({ type: 'LOOM_BUBBLE_FILTER', cameraFilter: next })
    } catch {
      /* SW may be asleep — settings already persisted */
    }
    setHelper(next === 'none' ? 'Filter cleared' : `Filter: ${CAMERA_FILTERS.find((f) => f.id === next)?.label}`)
  }

  async function selectBorderColor(color: string) {
    setBorderColor(color)
    await savePipSettings({ borderColor: color })
    try {
      await chrome.runtime.sendMessage({ type: 'LOOM_BUBBLE_BORDER', borderColor: color })
    } catch {
      /* SW may be asleep — settings already persisted */
    }
    setHelper(color === 'transparent' ? 'Border hidden' : `Border color: ${color}`)
  }

  async function selectBorderWidth(width: number) {
    const next = normalizeBorderWidth(width)
    setBorderWidth(next)
    await savePipSettings({ borderWidth: next })
    try {
      await chrome.runtime.sendMessage({ type: 'LOOM_BUBBLE_BORDER', borderWidth: next })
    } catch {
      /* SW may be asleep — settings already persisted */
    }
    const label = BORDER_WIDTH_OPTIONS.find((o) => o.id === next)?.label
    setHelper(next === 0 ? 'Border off' : `Border thickness: ${label ?? `${next}px`}`)
  }

  const cameraLabel =
    cameras.find((c) => c.deviceId === cameraDeviceId)?.label ||
    cameras[0]?.label ||
    (cameraOn ? 'System default camera' : 'Camera off')
  const micLabel =
    mics.find((m) => m.deviceId === micDeviceId)?.label ||
    mics[0]?.label ||
    (micAccess === 'granted' ? 'System default mic' : micGrantWaiting ? 'Waiting for allow…' : 'Microphone')

  if (effectsOpen) {
    return (
      <div className="popup">
        <header className="effects-header">
          <button
            type="button"
            className="effects-back"
            title="Back"
            aria-label="Back to record"
            onClick={() => setEffectsOpen(false)}
          >
            <IconBack />
          </button>
          <h1 className="effects-title">Effects</h1>
          <span className="effects-header-spacer" aria-hidden />
        </header>

        <div className="loom-body effects-body">
          <h2 className="effects-section-label">Filters</h2>
          <div className="effects-filter-grid" role="listbox" aria-label="Camera filters">
            {CAMERA_FILTERS.map((f) => {
              const selected = cameraFilter === f.id
              // Shared base so CSS filter (not the swatch paint) shows the look.
              const previewBase =
                'linear-gradient(145deg,#d8cfc4 0%,#8aa4b8 42%,#4a5a48 100%)'
              return (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`effects-filter ${selected ? 'is-selected' : ''}`}
                  title={f.label}
                  onClick={() => void selectCameraFilter(f.id)}
                >
                  <span
                    className="effects-filter-swatch"
                    style={{
                      background: f.id === 'none' ? f.swatch : previewBase,
                      filter: cameraFilterCss(f.id),
                    }}
                  >
                    {f.id === 'none' ? <span className="effects-filter-none">None</span> : null}
                  </span>
                  <span className="effects-filter-label">{f.label}</span>
                </button>
              )
            })}
          </div>

          <h2 className="effects-section-label">Border color</h2>
          <div className="effects-border-swatches" role="listbox" aria-label="Border color">
            {BORDER_PRESETS.map((color) => {
              const selected = borderColor === color
              return (
                <button
                  key={color}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`effects-border-swatch ${selected ? 'is-selected' : ''}`}
                  title={color}
                  style={{
                    background:
                      color === 'transparent'
                        ? 'repeating-conic-gradient(#888 0 25%, #ddd 0 50%) 0/8px 8px'
                        : color,
                  }}
                  onClick={() => void selectBorderColor(color)}
                />
              )
            })}
          </div>

          <h2 className="effects-section-label">Border thickness</h2>
          <div className="effects-border-widths" role="radiogroup" aria-label="Border thickness">
            {BORDER_WIDTH_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={borderWidth === opt.id}
                className={`effects-border-width ${borderWidth === opt.id ? 'is-selected' : ''}`}
                title={`${opt.label}${opt.id > 0 ? ` (${opt.id}px)` : ''}`}
                onClick={() => void selectBorderWidth(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {helper ? <p className="loom-helper">{helper}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="popup">
      <header className="loom-nav">
        <div className="loom-nav-tabs" aria-label="MyPipCam">
          <button
            type="button"
            className="loom-nav-btn"
            title="Library"
            aria-label="Home — open library"
            onClick={() => void openLibraryTab().then(() => window.close())}
          >
            <IconHome />
          </button>
          <button
            type="button"
            className="loom-nav-btn is-active"
            title="Record"
            aria-label="Record"
            aria-current="page"
          >
            <IconRecord />
          </button>
        </div>
        <button
          type="button"
          className="loom-nav-btn"
          title="Close"
          aria-label="Close"
          onClick={() => window.close()}
        >
          <IconClose />
        </button>
      </header>

      <div className="loom-body">
        {status.recording ? (
          <>
            <button
              type="button"
              className="loom-start is-stop"
              disabled={busy}
              onClick={() => void stop()}
            >
              {busy
                ? 'Stopping…'
                : status.phase === 'countdown'
                  ? 'Cancel countdown'
                  : 'Stop recording'}
            </button>
            <p className="loom-helper">Recording in progress on your tab</p>
          </>
        ) : (
          <>
            <div className="loom-scope">
              {scope === 'cam' ? <IconCam /> : <IconTab />}
              <span className="loom-scope-label">
                {scope === 'cam' ? 'Camera only' : 'Current tab'}
              </span>
              <IconChevron />
              <select
                className="loom-scope-select"
                aria-label="Capture scope"
                value={scope}
                onChange={(e) => void onScopeChange(e.target.value as CaptureScope)}
              >
                <option value="tab">Current tab</option>
                <option value="cam">Camera only</option>
              </select>
            </div>

            <div className="loom-devices">
              <div className={`loom-device ${cameraOn ? '' : 'is-off'}`}>
                <IconCam className="loom-device-icon" />
                <div className="loom-device-meta">
                  <span className="loom-device-name">{truncateLabel(cameraLabel)}</span>
                </div>
                <select
                  className="loom-device-select"
                  aria-label="Camera device"
                  disabled={!cameraOn}
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
                <button
                  type="button"
                  className={`loom-toggle ${cameraOn ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={cameraOn}
                  aria-label="Camera"
                  disabled={busy}
                  onClick={() => void onToggleCamera(!cameraOn)}
                />
              </div>

              <div className={`loom-device ${micOn ? '' : 'is-off'}`}>
                <IconMic className="loom-device-icon" />
                <div className="loom-device-meta">
                  <span className="loom-device-name">{truncateLabel(micLabel)}</span>
                </div>
                <select
                  className="loom-device-select"
                  aria-label="Microphone device"
                  disabled={!micOn || micAccess !== 'granted'}
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
                <button
                  type="button"
                  className={`loom-toggle ${micOn ? 'is-on' : ''}`}
                  role="switch"
                  aria-checked={micOn}
                  aria-label="Microphone"
                  disabled={busy || micGrantWaiting}
                  onClick={() => void onToggleMic(!micOn)}
                />
              </div>

              {scope === 'tab' ? (
                <>
                  <div className={`loom-device ${captureCursor ? '' : 'is-off'}`}>
                    <IconCursor className="loom-device-icon" />
                    <div className="loom-device-meta">
                      <span className="loom-device-name">Record mouse cursor</span>
                      <span className="loom-device-hint">
                        Tab/screen capture only — not the camera PiP
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`loom-toggle ${captureCursor ? 'is-on' : ''}`}
                      role="switch"
                      aria-checked={captureCursor}
                      aria-label="Record mouse cursor in tab capture"
                      title="Include the mouse cursor in tab/screen recordings (not the camera PiP)"
                      disabled={busy}
                      onClick={() => void onToggleCaptureCursor(!captureCursor)}
                    />
                  </div>

                  <div className="loom-quality">
                    <div className="loom-quality-head">
                      <span className="loom-device-name">Video quality</span>
                      <span className="loom-device-hint">
                        Tab capture resolution — camera PiP unchanged
                      </span>
                    </div>
                    <div
                      className="loom-quality-seg"
                      role="radiogroup"
                      aria-label="Tab recording quality"
                    >
                      {CAPTURE_QUALITY_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={captureQuality === opt.id}
                          className={`loom-quality-btn ${
                            captureQuality === opt.id ? 'is-active' : ''
                          }`}
                          disabled={busy}
                          title={`${opt.label} (${opt.width}×${opt.height})`}
                          onClick={() => void onCaptureQualityChange(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>

            <button
              type="button"
              className="loom-start"
              disabled={busy || micGrantWaiting}
              onClick={() => void startRecording()}
            >
              {busy ? 'Starting…' : micGrantWaiting ? 'Waiting for mic…' : 'Start Recording'}
            </button>
            {helper ? <p className="loom-helper">{helper}</p> : null}
          </>
        )}

        {error ? <p className="loom-error">{error}</p> : null}

        <div className="loom-footer">
          <button
            type="button"
            className={`loom-footer-btn ${cameraFilter !== 'none' ? 'is-active' : ''}`}
            title="Camera filters"
            onClick={() => {
              setHelper(null)
              setEffectsOpen(true)
            }}
          >
            <IconEffects />
            Effects
          </button>
          <button
            type="button"
            className={`loom-footer-btn ${backgroundEffect === 'blur' ? 'is-active' : ''}`}
            title="Background blur"
            onClick={() => void toggleBlur()}
          >
            <IconBlur />
            Blur
          </button>
          <button
            type="button"
            className="loom-footer-btn"
            title="Advanced recorder"
            onClick={() => void openRecorderTab().then(() => window.close())}
          >
            <IconMore />
            More
          </button>
        </div>
      </div>
    </div>
  )
}
