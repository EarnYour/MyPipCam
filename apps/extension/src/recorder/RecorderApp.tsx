import { useCallback, useEffect, useRef, useState } from 'react'
import { saveRecording } from '../shared/db'
import { openLibraryTab } from '../shared/navigation'
import {
  listVideoInputs,
  loadPipSettings,
  savePipSettings,
} from '../shared/settings'
import { BORDER_PRESETS, formatDuration, type PipSettings } from '../shared/types'
import {
  captureThumbnail,
  createRecorder,
  startCapture,
  stopStreams,
  type CaptureBundle,
} from './capture'

type Phase = 'idle' | 'preparing' | 'recording' | 'saving' | 'done'

export function RecorderApp() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [settings, setSettings] = useState<PipSettings | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(true)

  const stageRef = useRef<HTMLDivElement>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const bundleRef = useRef<CaptureBundle | null>(null)
  const stopDrawRef = useRef<(() => void) | null>(null)
  const bubbleApiRef = useRef<{
    getBubbleRect: () => { x: number; y: number; size: number }
    setBubbleNorm: (x: number, y: number) => void
    updateSettings: (next: PipSettings) => void
  } | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef('video/webm')
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    void (async () => {
      const s = await loadPipSettings()
      setSettings(s)
      try {
        // Probe permission so labels populate
        const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        probe.getTracks().forEach((t) => t.stop())
      } catch {
        /* ignore */
      }
      setCameras(await listVideoInputs())
    })()
  }, [])

  const patchSettings = useCallback(async (patch: Partial<PipSettings>) => {
    const next = await savePipSettings(patch)
    setSettings(next)
    bubbleApiRef.current?.updateSettings(next)
    return next
  }, [])

  const cleanupCapture = useCallback(() => {
    stopDrawRef.current?.()
    stopDrawRef.current = null
    stopStreams(bundleRef.current)
    bundleRef.current = null
    bubbleApiRef.current = null
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (canvasHostRef.current) canvasHostRef.current.innerHTML = ''
  }, [])

  useEffect(() => () => cleanupCapture(), [cleanupCapture])

  async function beginRecording() {
    if (!settings) return
    setError(null)
    setPhase('preparing')
    try {
      const started = await startCapture(settings)
      bundleRef.current = started.bundle
      stopDrawRef.current = started.stopDraw
      bubbleApiRef.current = {
        getBubbleRect: started.getBubbleRect,
        setBubbleNorm: started.setBubbleNorm,
        updateSettings: started.updateSettings,
      }

      if (canvasHostRef.current) {
        canvasHostRef.current.innerHTML = ''
        canvasHostRef.current.appendChild(started.bundle.canvas)
      }

      const { recorder, mimeType, chunks } = createRecorder(started.bundle.canvasStream)
      recorderRef.current = recorder
      chunksRef.current = chunks
      mimeRef.current = mimeType

      started.bundle.displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        void stopRecording()
      })

      recorder.start(1000)
      startedAtRef.current = Date.now()
      setElapsedMs(0)
      timerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current)
      }, 250)
      setPhase('recording')
      setShowSettings(false)
      setToast('Recording… drag the dashed circle to move the camera bubble')
      window.setTimeout(() => setToast(null), 3500)
    } catch (err) {
      cleanupCapture()
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Could not start capture')
    }
  }

  async function stopRecording() {
    const recorder = recorderRef.current
    const bundle = bundleRef.current
    if (!recorder || !bundle || phase === 'saving') return

    setPhase('saving')
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }

    const durationMs = Date.now() - startedAtRef.current
    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: mimeRef.current }))
      }
      recorder.onerror = () => reject(new Error('Recorder failed'))
      try {
        if (recorder.state !== 'inactive') recorder.stop()
        else resolve(new Blob(chunksRef.current, { type: mimeRef.current }))
      } catch (e) {
        reject(e)
      }
    })

    const thumbnail = await captureThumbnail(bundle.canvas)
    const bubble = bubbleApiRef.current?.getBubbleRect()
    if (bubble && settings) {
      await savePipSettings({ bubbleX: bubble.x, bubbleY: bubble.y })
    }

    try {
      const record = await saveRecording({
        blob,
        durationMs,
        thumbnail,
        mimeType: mimeRef.current,
      })
      cleanupCapture()
      setPhase('done')
      setToast('Saved to library')
      const s = await loadPipSettings()
      if (s.openLibraryOnFinish) {
        await openLibraryTab(record.id)
      }
    } catch (err) {
      cleanupCapture()
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Failed to save recording')
    }
  }

  function onPipPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (phase !== 'recording' || !stageRef.current || !bundleRef.current) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const stage = stageRef.current.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const x = (ev.clientX - stage.left) / stage.width
      const y = (ev.clientY - stage.top) / stage.height
      bubbleApiRef.current?.setBubbleNorm(x, y)
      const handle = document.getElementById('pip-handle')
      const rect = bubbleApiRef.current?.getBubbleRect()
      if (handle && rect && bundleRef.current) {
        const sizePx = Math.min(bundleRef.current.width, bundleRef.current.height) * rect.size
        const scaleX = stage.width / bundleRef.current.width
        const scaleY = stage.height / bundleRef.current.height
        const displaySize = sizePx * Math.min(scaleX, scaleY)
        handle.style.width = `${displaySize}px`
        handle.style.height = `${displaySize}px`
        handle.style.left = `${rect.x * stage.width - displaySize / 2}px`
        handle.style.top = `${rect.y * stage.height - displaySize / 2}px`
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const rect = bubbleApiRef.current?.getBubbleRect()
      if (rect) void savePipSettings({ bubbleX: rect.x, bubbleY: rect.y })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Keep pip handle aligned while recording
  useEffect(() => {
    if (phase !== 'recording') return
    const id = window.setInterval(() => {
      const handle = document.getElementById('pip-handle')
      const stage = stageRef.current?.getBoundingClientRect()
      const rect = bubbleApiRef.current?.getBubbleRect()
      const bundle = bundleRef.current
      if (!handle || !stage || !rect || !bundle) return
      const sizePx = Math.min(bundle.width, bundle.height) * rect.size
      const scale = Math.min(stage.width / bundle.width, stage.height / bundle.height)
      const displaySize = sizePx * scale
      handle.style.width = `${displaySize}px`
      handle.style.height = `${displaySize}px`
      handle.style.left = `${rect.x * stage.width - displaySize / 2}px`
      handle.style.top = `${rect.y * stage.height - displaySize / 2}px`
    }, 100)
    return () => window.clearInterval(id)
  }, [phase])

  if (!settings) {
    return <div className="recorder-shell muted">Loading…</div>
  }

  return (
    <div className="recorder-shell">
      {toast && <div className="status-toast">{toast}</div>}

      {(phase === 'idle' || phase === 'done') && (
        <div className="idle-panel">
          <h1 className="brand">MyPipCam</h1>
          <p>
            Share a screen or window, then we composite your camera as a circular PiP and
            save the recording locally.
          </p>
          <button className="primary" onClick={() => void beginRecording()}>
            {phase === 'done' ? 'Record again' : 'Start capture'}
          </button>
          <div className="row" style={{ justifyContent: 'center', marginTop: '0.75rem' }}>
            <button type="button" className="ghost" onClick={() => void openLibraryTab()}>
              Open library
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {(phase === 'preparing' || phase === 'recording' || phase === 'saving') && (
        <div className="recorder-stage" ref={stageRef}>
          <div ref={canvasHostRef} />
          {phase === 'recording' && (
            <div
              id="pip-handle"
              className="pip-handle"
              onPointerDown={onPipPointerDown}
              title="Drag to reposition camera"
            />
          )}
        </div>
      )}

      {(phase === 'recording' || phase === 'saving') && (
        <div className="recorder-hud">
          <span className={`rec-dot ${phase === 'recording' ? '' : 'idle'}`} />
          <span className="timer">{formatDuration(elapsedMs)}</span>
          <button
            className="primary"
            disabled={phase === 'saving'}
            onClick={() => void stopRecording()}
          >
            {phase === 'saving' ? 'Saving…' : 'Stop'}
          </button>
          <button type="button" className="ghost" onClick={() => setShowSettings((v) => !v)}>
            Settings
          </button>
        </div>
      )}

      {showSettings && phase !== 'saving' && (
        <aside className="recorder-settings">
          <h2>Camera & bubble</h2>
          <label>
            Camera
            <select
              value={settings.cameraDeviceId ?? ''}
              onChange={(e) =>
                void patchSettings({ cameraDeviceId: e.target.value || null })
              }
            >
              <option value="">Default</option>
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Camera ${c.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>

          <label>
            Bubble size
            <input
              type="range"
              min={0.1}
              max={0.35}
              step={0.01}
              value={settings.bubbleSize}
              onChange={(e) => void patchSettings({ bubbleSize: Number(e.target.value) })}
            />
          </label>

          <div>
            <div className="muted" style={{ fontSize: '0.78rem', marginBottom: 6 }}>
              Border
            </div>
            <div className="swatches">
              {BORDER_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch ${settings.borderColor === color ? 'active' : ''}`}
                  style={{
                    background:
                      color === 'transparent'
                        ? 'repeating-conic-gradient(#888 0 25%, #222 0 50%) 0/10px 10px'
                        : color,
                  }}
                  onClick={() => void patchSettings({ borderColor: color })}
                  title={color}
                />
              ))}
            </div>
          </div>

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={settings.shadow}
                onChange={(e) => void patchSettings({ shadow: e.target.checked })}
              />
              Soft shadow
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.mirror}
                onChange={(e) => void patchSettings({ mirror: e.target.checked })}
              />
              Mirror camera
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.openLibraryOnFinish}
                onChange={(e) => void patchSettings({ openLibraryOnFinish: e.target.checked })}
              />
              Open library on finish
            </label>
          </div>

          {phase === 'idle' && (
            <button className="primary" onClick={() => void beginRecording()}>
              Start capture
            </button>
          )}
        </aside>
      )}
    </div>
  )
}
