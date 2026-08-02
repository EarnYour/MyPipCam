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
import { PipBubble, type BubbleApi } from './PipBubble'

type Phase = 'idle' | 'preparing' | 'recording' | 'saving' | 'done'

type LiveBubbleApi = BubbleApi & {
  updateSettings: (next: PipSettings) => void
  setDrawCamera: (on: boolean) => void
}

export function RecorderApp() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [settings, setSettings] = useState<PipSettings | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(true)
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)
  const [displaySurface, setDisplaySurface] = useState<string | undefined>()
  const [, setBubbleTick] = useState(0)
  const overlayTabIdRef = useRef<number | null>(null)

  const canvasHostRef = useRef<HTMLDivElement>(null)
  const bundleRef = useRef<CaptureBundle | null>(null)
  const stopDrawRef = useRef<(() => void) | null>(null)
  const bubbleApiRef = useRef<LiveBubbleApi | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef('video/webm')
  const startedAtRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const phaseRef = useRef<Phase>('idle')
  phaseRef.current = phase

  useEffect(() => {
    void (async () => {
      const s = await loadPipSettings()
      setSettings(s)
      try {
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
    setBubbleTick((n) => n + 1)
    const tabId = overlayTabIdRef.current
    if (tabId != null) {
      void chrome.runtime.sendMessage({
        type: 'UPDATE_TAB_OVERLAY',
        tabId,
        x: bubbleApiRef.current?.getBubbleRect().x ?? next.bubbleX,
        y: bubbleApiRef.current?.getBubbleRect().y ?? next.bubbleY,
        size: bubbleApiRef.current?.getBubbleRect().size ?? next.bubbleSize,
        mirror: next.mirror,
        borderColor: next.borderColor,
        shadow: next.shadow,
        bubbleShape: next.bubbleShape,
        backgroundEffect: next.backgroundEffect,
      })
    }
    return next
  }, [])

  const persistBubble = useCallback((patch: Partial<PipSettings>) => {
    void (async () => {
      const next = await savePipSettings(patch)
      setSettings(next)
      bubbleApiRef.current?.updateSettings(next)
      setBubbleTick((n) => n + 1)
      const tabId = overlayTabIdRef.current
      if (tabId != null) {
        const rect = bubbleApiRef.current?.getBubbleRect()
        void chrome.runtime.sendMessage({
          type: 'UPDATE_TAB_OVERLAY',
          tabId,
          x: rect?.x ?? next.bubbleX,
          y: rect?.y ?? next.bubbleY,
          size: rect?.size ?? next.bubbleSize,
          mirror: next.mirror,
          borderColor: next.borderColor,
          shadow: next.shadow,
          bubbleShape: next.bubbleShape,
          backgroundEffect: next.backgroundEffect,
        })
      }
    })()
  }, [])

  const stopTabOverlay = useCallback(() => {
    const tabId = overlayTabIdRef.current
    overlayTabIdRef.current = null
    if (tabId != null) {
      void chrome.runtime.sendMessage({ type: 'STOP_TAB_OVERLAY', tabId })
    }
    void chrome.storage.session.remove('pipOverlayLive')
  }, [])

  const cleanupCapture = useCallback(() => {
    stopTabOverlay()
    stopDrawRef.current?.()
    stopDrawRef.current = null
    stopStreams(bundleRef.current)
    bundleRef.current = null
    bubbleApiRef.current = null
    setCanvasEl(null)
    setDisplaySurface(undefined)
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (canvasHostRef.current) canvasHostRef.current.innerHTML = ''
  }, [stopTabOverlay])

  useEffect(() => () => cleanupCapture(), [cleanupCapture])

  // Tab overlay → compositor sync
  useEffect(() => {
    if (phase !== 'recording') return
    const onChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area !== 'session' || !changes.pipOverlayLive) return
      const live = changes.pipOverlayLive.newValue as
        | { x: number; y: number; size: number }
        | undefined
      if (!live || !bubbleApiRef.current) return
      bubbleApiRef.current.setBubbleNorm(live.x, live.y)
      bubbleApiRef.current.setBubbleSize(live.size)
      setSettings((s) =>
        s ? { ...s, bubbleX: live.x, bubbleY: live.y, bubbleSize: live.size } : s,
      )
      setBubbleTick((n) => n + 1)
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [phase])

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
        setBubbleSize: started.setBubbleSize,
        updateSettings: started.updateSettings,
        setDrawCamera: started.setDrawCamera,
      }

      if (canvasHostRef.current) {
        canvasHostRef.current.innerHTML = ''
        canvasHostRef.current.appendChild(started.bundle.canvas)
      }
      setCanvasEl(started.bundle.canvas)
      setDisplaySurface(started.displaySurface)
      setBubbleTick((n) => n + 1)

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
      setShowSettings(true)

      // Best-effort: inject a draggable bubble on an open http(s) tab (useful for tab capture)
      if (started.bundle.cameraStream) {
        try {
          const rect = started.getBubbleRect()
          const res = (await chrome.runtime.sendMessage({
            type: 'START_TAB_OVERLAY',
            x: rect.x,
            y: rect.y,
            size: rect.size,
            mirror: settings.mirror,
            borderColor: settings.borderColor,
            shadow: settings.shadow,
            bubbleShape: settings.bubbleShape,
            backgroundEffect: settings.backgroundEffect,
          })) as { ok?: boolean; tabId?: number; reason?: string }
          if (res?.ok && res.tabId != null) {
            overlayTabIdRef.current = res.tabId
          }
        } catch {
          /* overlay is optional */
        }
      }

      if (!started.bundle.cameraStream) {
        setToast('Recording without camera — allow camera access for PiP')
      } else if (started.displaySurface === 'browser') {
        setToast('Drag the bubble here or on your tab — recording follows live')
      } else {
        setToast('Drag the camera bubble on this stage · corner / scroll to resize')
      }
      window.setTimeout(() => setToast(null), 4500)
    } catch (err) {
      cleanupCapture()
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Could not start capture')
    }
  }

  async function stopRecording() {
    const recorder = recorderRef.current
    const bundle = bundleRef.current
    if (!recorder || !bundle || phaseRef.current === 'saving') return

    setPhase('saving')
    phaseRef.current = 'saving'
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
    if (bubble) {
      await savePipSettings({
        bubbleX: bubble.x,
        bubbleY: bubble.y,
        bubbleSize: bubble.size,
      })
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
      setSettings(s)
      if (s.openLibraryOnFinish) {
        await openLibraryTab(record.id)
      }
    } catch (err) {
      cleanupCapture()
      setPhase('idle')
      setError(err instanceof Error ? err.message : 'Failed to save recording')
    }
  }

  function syncTabOverlay(x: number, y: number, size: number) {
    const tabId = overlayTabIdRef.current
    if (tabId == null || !settings) return
    void chrome.runtime.sendMessage({
      type: 'UPDATE_TAB_OVERLAY',
      tabId,
      x,
      y,
      size,
      mirror: settings.mirror,
      borderColor: settings.borderColor,
      shadow: settings.shadow,
      bubbleShape: settings.bubbleShape,
      backgroundEffect: settings.backgroundEffect,
    })
  }

  function onSizeSlider(value: number) {
    bubbleApiRef.current?.setBubbleSize(value)
    syncTabOverlay(
      bubbleApiRef.current?.getBubbleRect().x ?? settings!.bubbleX,
      bubbleApiRef.current?.getBubbleRect().y ?? settings!.bubbleY,
      value,
    )
    void patchSettings({ bubbleSize: value })
  }

  if (!settings) {
    return <div className="recorder-shell muted">Loading…</div>
  }

  const recording = phase === 'recording' || phase === 'saving'
  const live = phase === 'preparing' || recording
  const surfaceHint =
    displaySurface === 'browser'
      ? 'Tab capture — drag on this live stage or on the injected tab bubble; the recording follows instantly.'
      : displaySurface === 'monitor' || displaySurface === 'window'
        ? 'Screen/window capture — Chrome can’t float a true OS overlay over other apps; drag & resize on this live stage (a tab bubble may still appear in a browser window for convenience).'
        : null

  return (
    <div className={`recorder-shell ${live ? 'is-live' : ''}`}>
      {toast && <div className="status-toast">{toast}</div>}

      {(phase === 'idle' || phase === 'done') && (
        <div className="idle-panel">
          <h1 className="brand">MyPipCam</h1>
          <p>
            Advanced screen / window capture. Prefer <strong>Start recording</strong> from the
            extension popup for Loom-style in-tab PiP (no big recorder window).
          </p>
          <button className="primary" onClick={() => void beginRecording()}>
            {phase === 'done' ? 'Record again' : 'Start screen capture'}
          </button>
          <div className="row" style={{ justifyContent: 'center', marginTop: '0.75rem' }}>
            <button type="button" className="ghost" onClick={() => void openLibraryTab()}>
              Open library
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}

      {live && (
        <div className="recorder-stage">
          <div className="canvas-host" ref={canvasHostRef} />
          {phase === 'recording' && canvasEl && bubbleApiRef.current && (
            <PipBubble
              canvas={canvasEl}
              cameraStream={bundleRef.current?.cameraStream ?? null}
              settings={settings}
              api={bubbleApiRef.current}
              onPersist={persistBubble}
              onLiveMove={syncTabOverlay}
            />
          )}
          {phase === 'preparing' && (
            <div className="stage-overlay muted">Starting capture…</div>
          )}
          {phase === 'saving' && (
            <div className="stage-overlay muted">Saving…</div>
          )}
        </div>
      )}

      {recording && (
        <div className="recorder-hud">
          <span className={`rec-dot ${phase === 'recording' ? '' : 'idle'}`} />
          <span className="timer">{formatDuration(elapsedMs)}</span>

          <label className="hud-size" title="Bubble size">
            <span>Size</span>
            <input
              type="range"
              min={0.1}
              max={0.35}
              step={0.01}
              value={settings.bubbleSize}
              disabled={phase === 'saving'}
              onChange={(e) => onSizeSlider(Number(e.target.value))}
            />
          </label>

          <div className="hud-swatches" title="Border color">
            {BORDER_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch ${settings.borderColor === color ? 'active' : ''}`}
                disabled={phase === 'saving'}
                style={{
                  background:
                    color === 'transparent'
                      ? 'repeating-conic-gradient(#888 0 25%, #222 0 50%) 0/8px 8px'
                      : color,
                }}
                onClick={() => void patchSettings({ borderColor: color })}
                title={color}
              />
            ))}
          </div>

          <div className="hud-swatches" title="Bubble shape" role="radiogroup" aria-label="Bubble shape">
            <button
              type="button"
              className={`swatch shape-swatch ${settings.bubbleShape !== 'square' ? 'active' : ''}`}
              disabled={phase === 'saving'}
              onClick={() => void patchSettings({ bubbleShape: 'circle' })}
              title="Circle"
            >
              ○
            </button>
            <button
              type="button"
              className={`swatch shape-swatch ${settings.bubbleShape === 'square' ? 'active' : ''}`}
              disabled={phase === 'saving'}
              onClick={() => void patchSettings({ bubbleShape: 'square' })}
              title="Square"
            >
              □
            </button>
          </div>

          <label className="hud-toggle">
            <input
              type="checkbox"
              checked={settings.mirror}
              disabled={phase === 'saving'}
              onChange={(e) => void patchSettings({ mirror: e.target.checked })}
            />
            Mirror
          </label>
          <label className="hud-toggle">
            <input
              type="checkbox"
              checked={settings.shadow}
              disabled={phase === 'saving'}
              onChange={(e) => void patchSettings({ shadow: e.target.checked })}
            />
            Shadow
          </label>
          <label className="hud-toggle">
            <input
              type="checkbox"
              checked={settings.backgroundEffect === 'blur'}
              disabled={phase === 'saving'}
              onChange={(e) =>
                void patchSettings({
                  backgroundEffect: e.target.checked ? 'blur' : 'none',
                })
              }
            />
            Blur BG
          </label>

          <button type="button" className="ghost" onClick={() => setShowSettings((v) => !v)}>
            {showSettings ? 'Hide' : 'More'}
          </button>
          <button
            className="primary"
            disabled={phase === 'saving'}
            onClick={() => void stopRecording()}
          >
            {phase === 'saving' ? 'Saving…' : 'Stop'}
          </button>
        </div>
      )}

      {surfaceHint && recording && <p className="surface-hint">{surfaceHint}</p>}

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

          {phase !== 'recording' && (
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
          )}

          {phase !== 'recording' && (
            <>
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
                <label style={{ marginTop: 8 }}>
                  Custom hex
                  <input
                    type="text"
                    spellCheck={false}
                    placeholder="#ffffff or transparent"
                    value={settings.borderColor}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      if (
                        v === 'transparent' ||
                        /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)
                      ) {
                        void patchSettings({ borderColor: v })
                      } else {
                        setSettings((s) => (s ? { ...s, borderColor: v } : s))
                      }
                    }}
                    onBlur={() => {
                      const v = settings.borderColor.trim()
                      if (
                        v !== 'transparent' &&
                        !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)
                      ) {
                        void patchSettings({ borderColor: '#ffffff' })
                      }
                    }}
                  />
                </label>
              </div>

              <div className="toggles">
                <label>
                  <input
                    type="radio"
                    name="bubble-shape"
                    checked={settings.bubbleShape !== 'square'}
                    onChange={() => void patchSettings({ bubbleShape: 'circle' })}
                  />
                  Circle
                </label>
                <label>
                  <input
                    type="radio"
                    name="bubble-shape"
                    checked={settings.bubbleShape === 'square'}
                    onChange={() => void patchSettings({ bubbleShape: 'square' })}
                  />
                  Square
                </label>
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
                    checked={settings.backgroundEffect === 'blur'}
                    onChange={(e) =>
                      void patchSettings({
                        backgroundEffect: e.target.checked ? 'blur' : 'none',
                      })
                    }
                  />
                  Blur background
                </label>
              </div>
            </>
          )}

          <div className="toggles">
            <label>
              <input
                type="checkbox"
                checked={settings.openLibraryOnFinish}
                onChange={(e) => void patchSettings({ openLibraryOnFinish: e.target.checked })}
              />
              Open library on finish
            </label>
          </div>

          {phase === 'recording' && (
            <p className="muted" style={{ fontSize: '0.75rem', margin: 0 }}>
              Tip: grab the live camera bubble on the preview. Use the corner handle or scroll
              wheel to resize — changes apply to the recording immediately.
            </p>
          )}

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
