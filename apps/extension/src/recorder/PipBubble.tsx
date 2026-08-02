import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cameraFilterCss } from '../shared/cameraFilters'
import type { PipSettings } from '../shared/types'

export type BubbleApi = {
  getBubbleRect: () => { x: number; y: number; size: number }
  setBubbleNorm: (x: number, y: number) => void
  setBubbleSize: (size: number) => void
}

type Props = {
  canvas: HTMLCanvasElement
  cameraStream: MediaStream | null
  settings: PipSettings
  api: BubbleApi
  onPersist: (patch: Partial<PipSettings>) => void
  onLiveMove?: (x: number, y: number, size: number) => void
}

const SIZE_MIN = 0.1
const SIZE_MAX = 0.35

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Map canvas-pixel bubble geometry onto the on-screen canvas box (letterbox-safe, viewport coords). */
export function canvasBubbleDisplayRect(
  canvas: HTMLCanvasElement,
  normX: number,
  normY: number,
  size: number,
) {
  const rect = canvas.getBoundingClientRect()
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const contentW = canvas.width * scale
  const contentH = canvas.height * scale
  const offsetX = (rect.width - contentW) / 2
  const offsetY = (rect.height - contentH) / 2
  const diameter = Math.min(canvas.width, canvas.height) * size * scale
  return {
    left: rect.left + offsetX + normX * contentW - diameter / 2,
    top: rect.top + offsetY + normY * contentH - diameter / 2,
    size: diameter,
    contentW,
    contentH,
    offsetX,
    offsetY,
    scale,
    rect,
  }
}

export function clientToBubbleNorm(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
) {
  const rect = canvas.getBoundingClientRect()
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
  const contentW = canvas.width * scale
  const contentH = canvas.height * scale
  const offsetX = (rect.width - contentW) / 2
  const offsetY = (rect.height - contentH) / 2
  const x = (clientX - rect.left - offsetX) / contentW
  const y = (clientY - rect.top - offsetY) / contentH
  return {
    x: clamp(x, 0.05, 0.95),
    y: clamp(y, 0.05, 0.95),
  }
}

export function PipBubble({ canvas, cameraStream, settings, api, onPersist, onLiveMove }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [, bump] = useState(0)
  const [dragging, setDragging] = useState<'move' | 'resize' | null>(null)
  const dragRef = useRef<'move' | 'resize' | null>(null)

  // Keep overlay geometry synced to layout / scroll
  useEffect(() => {
    const onResize = () => bump((n) => n + 1)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    const ro = new ResizeObserver(onResize)
    ro.observe(canvas)
    // Re-sync while size is driven from the HUD slider
    const id = window.setInterval(onResize, 250)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
      ro.disconnect()
      window.clearInterval(id)
    }
  }, [canvas])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraStream) return
    video.srcObject = cameraStream
    void video.play().catch(() => undefined)
    return () => {
      video.srcObject = null
    }
  }, [cameraStream])

  const rect = api.getBubbleRect()
  const display = canvasBubbleDisplayRect(canvas, rect.x, rect.y, rect.size)

  function persistPosition() {
    const next = api.getBubbleRect()
    onPersist({ bubbleX: next.x, bubbleY: next.y, bubbleSize: next.size })
  }

  function onMovePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = 'move'
    setDragging('move')
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onResizePointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = 'resize'
    setDragging('resize')
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return
    if (dragRef.current === 'move') {
      const { x, y } = clientToBubbleNorm(canvas, e.clientX, e.clientY)
      api.setBubbleNorm(x, y)
      const rect = api.getBubbleRect()
      onLiveMove?.(rect.x, rect.y, rect.size)
      bump((n) => n + 1)
      return
    }

    // Resize from center: distance from bubble center → size
    const box = canvas.getBoundingClientRect()
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height)
    const contentW = canvas.width * scale
    const contentH = canvas.height * scale
    const offsetX = (box.width - contentW) / 2
    const offsetY = (box.height - contentH) / 2
    const cur = api.getBubbleRect()
    const cx = box.left + offsetX + cur.x * contentW
    const cy = box.top + offsetY + cur.y * contentH
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy)
    const diameterCanvas = (dist * 2) / scale
    const nextSize = clamp(
      diameterCanvas / Math.min(canvas.width, canvas.height),
      SIZE_MIN,
      SIZE_MAX,
    )
    api.setBubbleSize(nextSize)
    const rect = api.getBubbleRect()
    onLiveMove?.(rect.x, rect.y, rect.size)
    bump((n) => n + 1)
  }

  function onPointerUp(e: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(null)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    persistPosition()
  }

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const cur = api.getBubbleRect()
    const delta = e.deltaY > 0 ? -0.01 : 0.01
    const next = clamp(cur.size + delta, SIZE_MIN, SIZE_MAX)
    api.setBubbleSize(next)
    const rect = api.getBubbleRect()
    onLiveMove?.(rect.x, rect.y, rect.size)
    onPersist({ bubbleSize: next })
  }

  if (!cameraStream) return null

  return (
    <div
      ref={rootRef}
      className={`pip-bubble ${dragging ? 'is-dragging' : ''} ${settings.bubbleShape === 'square' ? 'is-square' : ''}`}
      style={{
        width: display.size,
        height: display.size,
        left: display.left,
        top: display.top,
        borderWidth: Math.max(0, settings.borderWidth),
        borderStyle: settings.borderWidth > 0 ? 'solid' : 'none',
        borderColor:
          settings.borderColor === 'transparent'
            ? 'rgba(255,255,255,0.35)'
            : settings.borderColor,
        boxShadow: settings.shadow ? '0 10px 28px rgba(0,0,0,0.45)' : 'none',
      }}
      onPointerDown={onMovePointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      title="Drag to move · scroll or corner to resize"
      role="slider"
      aria-label="Camera bubble position and size"
    >
      <video
        ref={videoRef}
        className={`pip-bubble-video ${settings.mirror ? 'mirror' : ''} ${
          settings.backgroundEffect === 'blur' ? 'is-blur-proxy' : ''
        }`}
        style={{ filter: cameraFilterCss(settings.cameraFilter) }}
        muted
        playsInline
        autoPlay
      />
      <div className="pip-bubble-ring" aria-hidden />
      <button
        type="button"
        className="pip-resize-handle"
        aria-label="Resize camera bubble"
        onPointerDown={onResizePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}
