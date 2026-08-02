/**
 * On-tab recording chrome (captured by tabCapture — dock may appear in video):
 * - Freely draggable circular camera bubble (extension-origin iframe)
 * - Left-edge collapsible dock: collapsed = timer+Stop only; expand for more
 * - Center-screen 3→2→1 countdown with Cancel / Skip
 *
 * Mounted in a closed Shadow DOM under a fixed max-z host — never the Popover
 * API (see ensureMount). Dock may appear in tabCapture (user-accepted tradeoff).
 */

import {
  createPipChannelToken,
  sanitizeCssColor,
} from '../shared/security'

/**
 * Prevent duplicate onMessage listeners when IIFE is re-injected.
 * A single thin dispatcher calls the latest handler body so extension reloads
 * pick up dock fixes without stacking listeners or keeping a stale pre-dock
 * TabOverlay class. DISPATCHER_KEY is new — older builds only set INSTALL_KEY.
 */
const INSTALL_KEY = '__mypipcamPipOverlayInstalled'
const DISPATCHER_KEY = '__mypipcamPipOverlayDispatcher'
const HANDLER_KEY = '__mypipcamPipOverlayHandle'
const INSTALL_VERSION = 2
type OverlayMessageHandler = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void,
) => boolean | void
declare global {
  interface Window {
    [INSTALL_KEY]?: number | boolean
    [DISPATCHER_KEY]?: boolean
    [HANDLER_KEY]?: OverlayMessageHandler
  }
}

type RecordMode = 'screen-cam' | 'screen' | 'cam'
type BubbleShape = 'circle' | 'square'
type BackgroundEffect = 'none' | 'blur'
type CameraFilterId =
  | 'none'
  | 'bw'
  | 'sepia'
  | 'warm'
  | 'cool'
  | 'contrast'
  | 'soft'

const CAMERA_FILTER_IDS = new Set<CameraFilterId>([
  'none',
  'bw',
  'sepia',
  'warm',
  'cool',
  'contrast',
  'soft',
])

function normalizeCameraFilter(value: unknown): CameraFilterId {
  return typeof value === 'string' && CAMERA_FILTER_IDS.has(value as CameraFilterId)
    ? (value as CameraFilterId)
    : 'none'
}

type BubbleState = {
  x: number
  y: number
  size: number
  shape: BubbleShape
  mirror: boolean
  borderColor: string
  shadow: boolean
  backgroundEffect: BackgroundEffect
  cameraFilter: CameraFilterId
  mode: 'live' | 'guide'
  recordMode: RecordMode
  cameraDeviceId: string | null
  phase: 'countdown' | 'recording' | 'paused'
}

const HOST_ID = 'mypipcam-tab-overlay-root'
const SIZE_MIN = 0.1
const SIZE_MAX = 0.35
const PIP_PAGE = 'src/pip/index.html'
const COUNTDOWN_FROM = 3
const SQUARE_RADIUS = '16%'
/** Floor so the bubble never collapses to an invisible speck. */
const BUBBLE_MIN_PX = 96

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

type OverlayMount = {
  host: HTMLElement
  /** Shadow container — page CSS cannot style descendants. */
  layer: HTMLDivElement
  shadow: ShadowRoot
}

let overlayMount: OverlayMount | null = null
let hostReattachObserver: MutationObserver | null = null

function overlayStyles(): string {
  return `
    /*
     * Host is a plain fixed full-viewport shell (no Popover API).
     * Popover left the host stuck under UA [popover]:not(:popover-open) {
     * display:none !important } which author CSS cannot override.
     */
    :host {
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: visible !important;
      background: transparent !important;
      color-scheme: normal !important;
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif !important;
    }
    * { box-sizing: border-box; }

    .mpc-layer {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* —— Circular camera bubble (Loom) —— */
    .mpc-bubble {
      position: fixed !important;
      border-radius: 50%;
      /* Visible so menu can extend outside; camera is clipped separately. */
      overflow: visible;
      pointer-events: auto !important;
      cursor: grab;
      touch-action: none;
      z-index: 2147483647 !important;
      user-select: none;
      -webkit-user-select: none;
      border: 3px solid #fff;
      background: #111312 !important;
      opacity: 1 !important;
      visibility: visible !important;
      min-width: ${BUBBLE_MIN_PX}px !important;
      min-height: ${BUBBLE_MIN_PX}px !important;
      /* Soft circular shadow — avoid a hard rectangular layer flash on hover. */
      box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25);
      isolation: isolate;
    }
    .mpc-bubble.is-square {
      border-radius: ${SQUARE_RADIUS};
    }
    .mpc-bubble.is-dragging { cursor: grabbing; }
    .mpc-bubble.is-hidden { display: none !important; }

    .mpc-bubble-clip {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      overflow: hidden;
      pointer-events: none;
      background: #111;
      /* Force circular compositing so the iframe never flashes as a square. */
      clip-path: circle(50% at 50% 50%);
      -webkit-clip-path: circle(50% at 50% 50%);
      transform: translateZ(0);
    }
    .mpc-bubble.is-square .mpc-bubble-clip {
      border-radius: ${SQUARE_RADIUS};
      clip-path: inset(0 round ${SQUARE_RADIUS});
      -webkit-clip-path: inset(0 round ${SQUARE_RADIUS});
    }

    .mpc-cam-frame {
      width: 100%;
      height: 100%;
      border: 0;
      display: block !important;
      pointer-events: none !important;
      background: #111;
    }

    /* Transparent drag hit-target above the iframe so drag never dies */
    .mpc-drag-surface {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      z-index: 1;
      pointer-events: auto;
      cursor: inherit;
      background: transparent;
    }
    .mpc-bubble.is-square .mpc-drag-surface {
      border-radius: ${SQUARE_RADIUS};
    }

    /*
     * Dots stay in layout (opacity only) so hover never toggles geometry and
     * cannot enter a show→leave→hide→enter flicker loop. Native title tooltips
     * are avoided (aria-label only) — those rectangular tips also flickered.
     */
    .mpc-menu-btn {
      position: absolute;
      left: 50%;
      bottom: 6%;
      transform: translateX(-50%);
      z-index: 3;
      pointer-events: auto;
      width: 36px;
      height: 22px;
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: 8px;
      background: rgba(28, 28, 30, 0.78);
      color: #fff;
      font: 700 14px/22px ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 1px;
      cursor: pointer;
      display: grid;
      place-items: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
      opacity: 0;
      transition: opacity 0.15s ease, background 0.12s ease;
    }
    .mpc-bubble:hover .mpc-menu-btn,
    .mpc-bubble.is-menu-open .mpc-menu-btn,
    .mpc-menu-btn:focus-visible {
      opacity: 1;
    }
    .mpc-menu-btn:hover { background: rgba(40,40,44,0.9); }

    .mpc-menu {
      position: absolute;
      left: 50%;
      bottom: calc(6% + 28px);
      transform: translateX(-50%);
      z-index: 4;
      pointer-events: auto;
      display: none;
      flex-direction: column;
      gap: 4px;
      padding: 6px;
      border-radius: 12px;
      background: rgba(18, 20, 24, 0.95);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 10px 28px rgba(0,0,0,0.4);
      min-width: 108px;
    }
    .mpc-menu.is-open { display: flex; }
    .mpc-menu button {
      all: unset;
      cursor: pointer;
      font: 600 11px/1.2 ui-sans-serif, system-ui, sans-serif;
      color: #f4f6f8;
      padding: 8px 10px;
      border-radius: 8px;
      text-align: center;
    }
    .mpc-menu button:hover { background: rgba(255,255,255,0.1); }

    /* —— Left collapsible dock: collapsed = timer + Stop only —— */
    .mpc-dock {
      position: fixed !important;
      left: 10px !important;
      top: 50% !important;
      transform: translateY(-50%) !important;
      z-index: 2147483647 !important;
      pointer-events: none;
      /* display:none while hidden — opacity alone can stay invisible under
         aggressive page compositing / capture overlays. */
      display: none;
      flex-direction: column;
      align-items: center;
      width: 48px;
      min-height: 96px;
      padding: 6px 5px 8px;
      gap: 4px;
      border-radius: 999px;
      background: rgba(17, 19, 18, 0.94) !important;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 10px 28px rgba(0,0,0,0.42);
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.18s ease;
    }
    .mpc-dock.is-visible {
      display: flex !important;
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }

    .mpc-dock-head {
      all: unset;
      box-sizing: border-box;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      border-radius: 12px;
      padding: 2px 0 1px;
    }
    .mpc-dock-head:hover { background: rgba(255,255,255,0.06); }
    .mpc-dock-head:focus-visible {
      outline: 2px solid rgba(255, 94, 41, 0.7);
      outline-offset: 1px;
    }

    .mpc-dock-rec {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #e11d2e;
      box-shadow: 0 0 0 2px rgba(225, 29, 46, 0.25);
      flex-shrink: 0;
    }
    .mpc-dock.is-paused .mpc-dock-rec {
      background: #8a8d88;
      box-shadow: none;
    }

    .mpc-dock-timer {
      color: #fff;
      font: 700 11px/1 ui-sans-serif, system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      text-align: center;
      letter-spacing: 0.02em;
      min-height: 1em;
    }

    .mpc-dock-chevron {
      width: 14px;
      height: 14px;
      color: rgba(255,255,255,0.55);
      display: grid;
      place-items: center;
    }
    .mpc-dock-chevron svg {
      width: 12px;
      height: 12px;
      display: block;
      transition: transform 0.15s ease;
    }
    .mpc-dock.is-expanded .mpc-dock-chevron svg {
      transform: rotate(180deg);
    }

    .mpc-dock-core,
    .mpc-dock-more {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 100%;
    }
    .mpc-dock-more {
      display: none;
      padding-top: 2px;
      border-top: 1px solid rgba(255,255,255,0.1);
      margin-top: 2px;
    }
    .mpc-dock.is-expanded .mpc-dock-more {
      display: flex;
    }

    .mpc-dock button.mpc-dock-btn {
      all: unset;
      box-sizing: border-box;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      cursor: pointer;
      color: #fff;
    }
    .mpc-dock button.mpc-dock-btn:hover { background: rgba(255,255,255,0.1); }
    .mpc-dock button.mpc-dock-btn:disabled { opacity: 0.45; cursor: default; }
    .mpc-dock button.mpc-dock-btn svg {
      width: 16px;
      height: 16px;
      display: block;
    }
    .mpc-dock .mpc-stop {
      background: #e11d2e;
      border-radius: 11px;
      width: 36px;
      height: 36px;
    }
    .mpc-dock .mpc-stop:hover { background: #c91828; }
    .mpc-dock .mpc-stop svg { width: 13px; height: 13px; }
    .mpc-dock .mpc-discard { color: #ffb4a8; }
    .mpc-dock .mpc-trim { position: relative; }
    .mpc-dock .mpc-trim-label {
      position: absolute;
      left: calc(100% + 8px);
      top: 50%;
      transform: translateY(-50%);
      white-space: nowrap;
      padding: 6px 10px;
      border-radius: 8px;
      background: rgba(17, 19, 18, 0.94);
      color: #fafaf7;
      font: 600 11px/1.2 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 6px 18px rgba(0,0,0,0.35);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.12s ease;
    }
    .mpc-dock.is-expanded .mpc-trim:hover .mpc-trim-label,
    .mpc-dock.is-expanded .mpc-trim:focus-visible .mpc-trim-label {
      opacity: 1;
    }

    /* Camera failure chip — visible even while dock is hidden during countdown */
    .mpc-cam-status {
      position: fixed !important;
      left: 12px !important;
      bottom: 24px !important;
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      max-width: min(280px, calc(100vw - 24px));
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(28, 12, 12, 0.94) !important;
      border: 1px solid rgba(255, 120, 100, 0.45);
      color: #ffe8e4 !important;
      font: 600 12px/1.35 ui-sans-serif, system-ui, sans-serif !important;
      box-shadow: 0 10px 28px rgba(0,0,0,0.4);
      opacity: 0;
      visibility: hidden;
      display: none;
    }
    .mpc-cam-status.is-visible {
      display: block !important;
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* Countdown with Cancel / Skip — hidden before MediaRecorder starts */
    .mpc-countdown {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      display: flex !important;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      background: rgba(8, 10, 14, 0.45);
    }
    .mpc-countdown.is-hidden { display: none !important; }
    .mpc-countdown-num {
      width: 132px;
      height: 132px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #ff5e29;
      border: none;
      color: #fff;
      font: 800 64px/1 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 18px 48px rgba(0,0,0,0.4);
      animation: mpc-pop 0.35s ease;
      pointer-events: none !important;
    }
    .mpc-countdown-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: auto !important;
    }
    .mpc-countdown-actions button {
      all: unset;
      cursor: pointer;
      font: 600 13px/1 ui-sans-serif, system-ui, sans-serif;
      color: #fff;
      padding: 10px 18px;
      border-radius: 999px;
      background: rgba(28,28,30,0.88);
      border: 1px solid rgba(255,255,255,0.14);
    }
    .mpc-countdown-actions button.mpc-countdown-skip {
      background: rgba(255, 94, 41, 0.28);
      border-color: rgba(255, 94, 41, 0.55);
      color: #ffe8e0;
    }
    .mpc-countdown-actions button:hover {
      background: rgba(40,40,44,0.95);
    }
    .mpc-countdown-actions button.mpc-countdown-skip:hover {
      background: rgba(255, 94, 41, 0.4);
    }
    .mpc-cam-fallback {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      display: grid;
      place-items: center;
      padding: 14%;
      text-align: center;
      color: #f4f6f8;
      font: 600 11px/1.35 ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(circle at 35% 30%, #2a3340, #12161c 70%);
      pointer-events: none;
    }
    .mpc-bubble.is-square .mpc-cam-fallback {
      border-radius: ${SQUARE_RADIUS};
    }
    .mpc-error-banner {
      position: fixed !important;
      left: 50% !important;
      bottom: 28px !important;
      transform: translateX(-50%);
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      max-width: min(440px, calc(100vw - 32px));
      padding: 12px 16px;
      border-radius: 12px;
      background: rgba(28, 12, 12, 0.94) !important;
      border: 1px solid rgba(255, 120, 100, 0.45);
      color: #ffe8e4 !important;
      font: 600 13px/1.4 ui-sans-serif, system-ui, sans-serif !important;
      box-shadow: 0 12px 32px rgba(0,0,0,0.4);
      text-align: center;
    }
    .mpc-error-banner button {
      all: unset;
      display: inline-block;
      margin-top: 8px;
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
      font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
      color: #fff;
    }
    @keyframes mpc-pop {
      from { transform: scale(0.7); opacity: 0.4; }
      to { transform: scale(1); opacity: 1; }
    }
  `
}

function applyHostInlineStyles(host: HTMLElement) {
  // Inline !important beats almost all page styles that target the host id.
  const props: Array<[string, string]> = [
    ['position', 'fixed'],
    ['inset', '0'],
    ['width', '100vw'],
    ['height', '100vh'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', 'none'],
    ['overflow', 'visible'],
    ['background', 'transparent'],
    ['display', 'block'],
    ['opacity', '1'],
    ['visibility', 'visible'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647'],
  ]
  for (const [k, v] of props) host.style.setProperty(k, v, 'important')
}

/** Strip any leftover popover attrs and force the fixed max-z shell styles. */
function prepareHostShell(host: HTMLElement) {
  try {
    if (typeof host.hidePopover === 'function' && host.matches(':popover-open')) {
      host.hidePopover()
    }
  } catch {
    /* ignore */
  }
  try {
    host.removeAttribute('popover')
  } catch {
    /* ignore */
  }
  applyHostInlineStyles(host)
}

function watchHostAttached(host: HTMLElement) {
  hostReattachObserver?.disconnect()
  // Only re-mount when the host is removed. Re-running host styles on every
  // page mutation causes PiP compositing flicker (glitchy square).
  hostReattachObserver = new MutationObserver(() => {
    if (host.isConnected) return
    const parent = document.body ?? document.documentElement
    if (!parent) return
    parent.appendChild(host)
    prepareHostShell(host)
  })
  hostReattachObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  })
}

type OverlayVisibility = {
  ok: boolean
  connected: boolean
  visible: boolean
  topLayer: boolean
  width: number
  height: number
  display: string
  countdownVisible: boolean
  dockVisible: boolean
  phase: string | null
}

function readHostVisibility(
  phase: string | null,
  countdownVisible: boolean,
  dockVisible = false,
): OverlayVisibility {
  const host = overlayMount?.host
  if (!host?.isConnected) {
    return {
      ok: false,
      connected: false,
      visible: false,
      topLayer: false,
      width: 0,
      height: 0,
      display: 'missing',
      countdownVisible: false,
      dockVisible: false,
      phase,
    }
  }
  const rect = host.getBoundingClientRect()
  const cs = getComputedStyle(host)
  // Legacy field: we no longer use Popover; report fixed-shell as "topLayer".
  const topLayer = !host.hasAttribute('popover') && cs.position === 'fixed'
  const display = cs.display
  const visible =
    display !== 'none' &&
    cs.visibility !== 'hidden' &&
    cs.opacity !== '0' &&
    rect.width >= 40 &&
    rect.height >= 40
  return {
    ok: visible,
    connected: true,
    visible,
    topLayer,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    display,
    countdownVisible,
    dockVisible,
    phase,
  }
}

function ensureMount(): OverlayMount {
  if (overlayMount?.host.isConnected) {
    prepareHostShell(overlayMount.host)
    return overlayMount
  }

  // Drop any leftover host from older builds (stuck closed popover, etc.).
  const stale = document.getElementById(HOST_ID)
  if (stale) {
    try {
      if (typeof (stale as HTMLElement).hidePopover === 'function') {
        ;(stale as HTMLElement).hidePopover()
      }
    } catch {
      /* ignore */
    }
    try {
      stale.removeAttribute('popover')
    } catch {
      /* ignore */
    }
    stale.remove()
  }

  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-mypipcam', 'overlay')
  // Never use the Popover API here — see overlayStyles() comment.
  host.removeAttribute('popover')
  applyHostInlineStyles(host)

  // Closed shadow: page CSS cannot hide/move our countdown/bubble.
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = overlayStyles()
  const layer = document.createElement('div')
  layer.className = 'mpc-layer'
  shadow.append(style, layer)

  const parent = document.body ?? document.documentElement
  if (!parent) {
    throw new Error('Page has no document.body — cannot mount recording overlay')
  }
  parent.appendChild(host)
  prepareHostShell(host)
  console.log('[MyPipCam][start] overlay host mounted', { topLayer: false, id: HOST_ID })
  watchHostAttached(host)

  overlayMount = { host, layer, shadow }
  return overlayMount
}

function ensureRoot(): HTMLDivElement {
  return ensureMount().layer
}

function removeRoot() {
  hostReattachObserver?.disconnect()
  hostReattachObserver = null
  overlayMount?.host.remove()
  document.getElementById(HOST_ID)?.remove()
  overlayMount = null
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function pipFrameUrl(
  mirror: boolean,
  cameraDeviceId: string | null,
  backgroundEffect: BackgroundEffect,
  cameraFilter: CameraFilterId,
  channelToken: string,
): string {
  const url = new URL(chrome.runtime.getURL(PIP_PAGE))
  url.searchParams.set('mirror', mirror ? '1' : '0')
  url.searchParams.set('effect', backgroundEffect === 'blur' ? 'blur' : 'none')
  url.searchParams.set('filter', normalizeCameraFilter(cameraFilter))
  url.searchParams.set('ch', channelToken)
  if (cameraDeviceId) url.searchParams.set('deviceId', cameraDeviceId)
  return url.toString()
}

function iconStop(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
}
function iconPause(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`
}
function iconPlay(): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`
}
function iconTrash(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/></svg>`
}
function iconRestart(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 109-9"/><path d="M3 5v7h7"/></svg>`
}
function iconTrim(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14l-5-5 5-5"/><path d="M4 9h10a5 5 0 010 10H9"/></svg>`
}
function iconChevron(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`
}

class TabOverlay {
  private root: HTMLDivElement
  private bubble: HTMLDivElement
  private dragSurface: HTMLDivElement | null = null
  private frame: HTMLIFrameElement | null = null
  private menuBtn: HTMLButtonElement | null = null
  private menu: HTMLDivElement | null = null
  private dock: HTMLDivElement
  private dockHead: HTMLButtonElement
  private timerEl: HTMLSpanElement
  private stopBtn: HTMLButtonElement
  private pauseBtn: HTMLButtonElement
  private trimBtn: HTMLButtonElement
  private restartBtn: HTMLButtonElement
  private discardBtn: HTMLButtonElement
  private countdownEl: HTMLDivElement
  private countdownNum: HTMLDivElement
  private camClip: HTMLDivElement | null = null
  private camFallback: HTMLDivElement | null = null
  private camStatusEl: HTMLDivElement | null = null
  private errorBanner: HTMLDivElement | null = null
  private state: BubbleState
  private pipChannelToken: string
  private recordingStartedAt = 0
  private pausedAccumMs = 0
  private pauseStartedAt = 0
  private timerId: number | null = null
  private countdownId: number | null = null
  private camWatchId: number | null = null
  private collapseTimerId: number | null = null
  private stopping = false
  private restarting = false
  private dockExpanded = false
  private dragging = false
  private menuOpen = false
  private camReady = false

  constructor(initial: BubbleState) {
    this.state = {
      ...initial,
      borderColor: sanitizeCssColor(initial.borderColor),
      // Clamp size so Tab+Cam never mounts a zero/near-zero bubble.
      size: clamp(initial.size || 0.18, SIZE_MIN, SIZE_MAX),
      x: clamp(initial.x ?? 0.82, 0.05, 0.95),
      y: clamp(initial.y ?? 0.78, 0.08, 0.95),
    }
    this.pipChannelToken = createPipChannelToken()
    this.root = ensureRoot()
    this.root.replaceChildren()

    // —— Bubble ——
    this.bubble = document.createElement('div')
    this.bubble.className = 'mpc-bubble'
    if (this.state.recordMode === 'screen') this.bubble.classList.add('is-hidden')
    else this.bubble.classList.remove('is-hidden')
    // aria-label only — native title tooltips are rectangular and flicker on hover.
    this.bubble.setAttribute('aria-label', 'Camera bubble — drag to move')
    this.bubble.removeAttribute('title')

    if (this.state.mode === 'guide') {
      this.bubble.style.background = 'rgba(12,16,22,0.28)'
      const label = document.createElement('div')
      label.textContent = 'PiP'
      label.style.cssText =
        'position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:600 12px/1.2 system-ui,sans-serif;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,.65);'
      this.dragSurface = document.createElement('div')
      this.dragSurface.className = 'mpc-drag-surface'
      this.bubble.append(label, this.dragSurface)
    } else if (this.state.recordMode !== 'screen') {
      const clip = document.createElement('div')
      clip.className = 'mpc-bubble-clip'
      this.camClip = clip
      this.frame = document.createElement('iframe')
      this.frame.className = 'mpc-cam-frame'
      this.frame.allow = 'camera; microphone'
      this.frame.setAttribute('allow', 'camera; microphone')
      this.frame.setAttribute('aria-label', 'MyPipCam camera')
      this.frame.removeAttribute('title')
      this.frame.tabIndex = -1
      // Critical: never let the iframe eat pointer events
      this.frame.style.pointerEvents = 'none'
      this.frame.addEventListener('error', () => {
        this.showCamBlockedFallback(
          'This site blocks the camera overlay (CSP). Try Advanced or another page.',
        )
      })
      clip.appendChild(this.frame)
      void this.mountPipFrame()

      this.dragSurface = document.createElement('div')
      this.dragSurface.className = 'mpc-drag-surface'
      this.dragSurface.setAttribute('aria-label', 'Drag camera bubble')

      this.menuBtn = document.createElement('button')
      this.menuBtn.type = 'button'
      this.menuBtn.className = 'mpc-menu-btn'
      this.menuBtn.textContent = '···'
      this.menuBtn.setAttribute('aria-label', 'Camera bubble options')
      this.menuBtn.removeAttribute('title')

      this.menu = document.createElement('div')
      this.menu.className = 'mpc-menu'
      const sizeSm = document.createElement('button')
      sizeSm.type = 'button'
      sizeSm.textContent = 'Small'
      const sizeMd = document.createElement('button')
      sizeMd.type = 'button'
      sizeMd.textContent = 'Medium'
      const sizeLg = document.createElement('button')
      sizeLg.type = 'button'
      sizeLg.textContent = 'Large'
      const shapeCircle = document.createElement('button')
      shapeCircle.type = 'button'
      shapeCircle.textContent = 'Circle'
      const shapeSquare = document.createElement('button')
      shapeSquare.type = 'button'
      shapeSquare.textContent = 'Square'
      const effectNone = document.createElement('button')
      effectNone.type = 'button'
      effectNone.textContent = 'BG: None'
      const effectBlur = document.createElement('button')
      effectBlur.type = 'button'
      effectBlur.textContent = 'BG: Blur'
      this.menu.append(
        sizeSm,
        sizeMd,
        sizeLg,
        shapeCircle,
        shapeSquare,
        effectNone,
        effectBlur,
      )

      // pointerdown (not click): document capture closeMenu + drag surface can
      // swallow click during live tabCapture; apply on pointerdown instead.
      const bindMenuAction = (btn: HTMLButtonElement, action: () => void) => {
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          action()
        })
      }
      bindMenuAction(sizeSm, () => this.setSize(0.12))
      bindMenuAction(sizeMd, () => this.setSize(0.18))
      bindMenuAction(sizeLg, () => this.setSize(0.26))
      bindMenuAction(shapeCircle, () => this.setShape('circle'))
      bindMenuAction(shapeSquare, () => this.setShape('square'))
      bindMenuAction(effectNone, () => this.setBackgroundEffect('none'))
      bindMenuAction(effectBlur, () => this.setBackgroundEffect('blur'))
      this.menuBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.toggleMenu()
      })

      this.bubble.append(clip, this.dragSurface, this.menuBtn, this.menu)
      window.addEventListener('message', this.onPipMessage)
      this.camWatchId = window.setTimeout(() => {
        if (!this.camReady) {
          this.showCamBlockedFallback(
            'Camera overlay blocked on this page. Tab still records — try Advanced for screen+cam.',
          )
        }
      }, 2500)
    }

    // —— Collapsible left dock (collapsed = timer + Stop) ——
    this.dock = document.createElement('div')
    this.dock.className = 'mpc-dock'
    this.dock.setAttribute('role', 'toolbar')
    this.dock.setAttribute('aria-label', 'Recording controls')

    this.dockHead = document.createElement('button')
    this.dockHead.type = 'button'
    this.dockHead.className = 'mpc-dock-head'
    this.dockHead.title = 'More recording controls'
    this.dockHead.setAttribute('aria-expanded', 'false')
    this.dockHead.setAttribute('aria-label', 'Expand recording controls')

    const recDot = document.createElement('span')
    recDot.className = 'mpc-dock-rec'
    recDot.setAttribute('aria-hidden', 'true')

    this.timerEl = document.createElement('span')
    this.timerEl.className = 'mpc-dock-timer'
    this.timerEl.textContent = '0:00'

    const chevron = document.createElement('span')
    chevron.className = 'mpc-dock-chevron'
    chevron.innerHTML = iconChevron()
    chevron.setAttribute('aria-hidden', 'true')

    this.dockHead.append(recDot, this.timerEl, chevron)

    const core = document.createElement('div')
    core.className = 'mpc-dock-core'
    this.stopBtn = document.createElement('button')
    this.stopBtn.type = 'button'
    this.stopBtn.className = 'mpc-dock-btn mpc-stop'
    this.stopBtn.title = 'Stop & save'
    this.stopBtn.setAttribute('aria-label', 'Stop and save')
    this.stopBtn.innerHTML = iconStop()
    core.appendChild(this.stopBtn)

    const more = document.createElement('div')
    more.className = 'mpc-dock-more'

    this.pauseBtn = document.createElement('button')
    this.pauseBtn.type = 'button'
    this.pauseBtn.className = 'mpc-dock-btn'
    this.pauseBtn.title = 'Pause'
    this.pauseBtn.setAttribute('aria-label', 'Pause recording')
    this.pauseBtn.innerHTML = iconPause()

    this.trimBtn = document.createElement('button')
    this.trimBtn.type = 'button'
    this.trimBtn.className = 'mpc-dock-btn mpc-trim'
    this.trimBtn.title = 'Rewind & Trim'
    this.trimBtn.setAttribute('aria-label', 'Rewind and trim — stop and open editor')
    this.trimBtn.innerHTML = `${iconTrim()}<span class="mpc-trim-label">Rewind &amp; Trim</span>`

    this.restartBtn = document.createElement('button')
    this.restartBtn.type = 'button'
    this.restartBtn.className = 'mpc-dock-btn'
    this.restartBtn.title = 'Restart'
    this.restartBtn.setAttribute('aria-label', 'Restart recording')
    this.restartBtn.innerHTML = iconRestart()

    this.discardBtn = document.createElement('button')
    this.discardBtn.type = 'button'
    this.discardBtn.className = 'mpc-dock-btn mpc-discard'
    this.discardBtn.title = 'Discard'
    this.discardBtn.setAttribute('aria-label', 'Discard recording')
    this.discardBtn.innerHTML = iconTrash()

    more.append(this.pauseBtn, this.trimBtn, this.restartBtn, this.discardBtn)
    this.dock.append(this.dockHead, core, more)

    // —— Countdown with Cancel / Skip ——
    this.countdownEl = document.createElement('div')
    this.countdownEl.className = 'mpc-countdown'

    this.countdownNum = document.createElement('div')
    this.countdownNum.className = 'mpc-countdown-num'
    this.countdownNum.textContent = String(COUNTDOWN_FROM)

    const countdownActions = document.createElement('div')
    countdownActions.className = 'mpc-countdown-actions'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault()
      void this.requestDiscard(true)
    })
    const skipBtn = document.createElement('button')
    skipBtn.type = 'button'
    skipBtn.className = 'mpc-countdown-skip'
    skipBtn.textContent = 'Skip'
    skipBtn.addEventListener('click', (e) => {
      e.preventDefault()
      this.finishCountdown()
    })
    countdownActions.append(cancelBtn, skipBtn)
    this.countdownEl.append(this.countdownNum, countdownActions)

    this.camStatusEl = document.createElement('div')
    this.camStatusEl.className = 'mpc-cam-status'
    this.camStatusEl.setAttribute('role', 'status')

    this.root.append(this.bubble, this.dock, this.countdownEl, this.camStatusEl)

    // Drag from bubble / drag surface (never from menu)
    const dragTarget = this.dragSurface ?? this.bubble
    dragTarget.addEventListener('pointerdown', (e) => this.onMoveDown(e))
    this.bubble.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })

    this.dockHead.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.setDockExpanded(!this.dockExpanded)
    })
    this.stopBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.requestStop()
    })
    this.pauseBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.togglePause()
    })
    this.trimBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.requestTrimAndStop()
    })
    this.restartBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.requestRestart()
    })
    this.discardBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void this.requestDiscard(false)
    })

    document.addEventListener('pointerdown', this.onDocPointerDown, true)

    this.apply()

    if (this.state.phase === 'countdown') {
      this.startCountdown()
    } else {
      this.enterRecordingUi()
    }
  }

  private async mountPipFrame() {
    try {
      let registered = false
      for (let attempt = 0; attempt < 8; attempt++) {
        const res = (await chrome.runtime.sendMessage({
          type: 'REGISTER_PIP_CHANNEL',
          token: this.pipChannelToken,
        })) as { ok?: boolean; reason?: string } | undefined
        if (res?.ok) {
          registered = true
          break
        }
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
      }
      if (!registered) {
        this.showCamBlockedFallback(
          'Camera overlay unavailable — channel register failed. Reload the extension and try again.',
        )
        return
      }
    } catch {
      this.showCamBlockedFallback('Camera overlay unavailable')
      return
    }
    if (!this.frame) return
    this.frame.src = pipFrameUrl(
      this.state.mirror,
      this.state.cameraDeviceId,
      this.state.backgroundEffect,
      this.state.cameraFilter,
      this.pipChannelToken,
    )
  }

  private onDocPointerDown = (e: PointerEvent) => {
    // Closed shadow retargets target to the host — use composedPath.
    const path = e.composedPath()
    if (this.menuOpen && this.menu && this.menuBtn) {
      if (!path.includes(this.menu) && !path.includes(this.menuBtn)) {
        this.closeMenu()
      }
    }
    if (this.dockExpanded && !path.includes(this.dock)) {
      this.setDockExpanded(false)
    }
  }

  private onPipMessage = (event: MessageEvent) => {
    if (event.source !== this.frame?.contentWindow) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type !== 'MPC_PIP_CAMERA') return
    // Prefer token match; still accept failure notices if token was never minted.
    if (data.token != null && data.token !== this.pipChannelToken) return
    if (data.ok) {
      this.camReady = true
      if (this.camWatchId != null) {
        window.clearTimeout(this.camWatchId)
        this.camWatchId = null
      }
      this.camFallback?.remove()
      this.camFallback = null
      this.camStatusEl?.classList.remove('is-visible')
      if (this.frame) this.frame.style.display = 'block'
      return
    }
    const reason =
      typeof data.reason === 'string' && data.reason.trim()
        ? data.reason.trim()
        : 'Camera unavailable'
    this.showCamBlockedFallback(`Camera: ${reason}`)
  }

  showError(reason: string) {
    if (this.countdownId != null) {
      window.clearInterval(this.countdownId)
      this.countdownId = null
    }
    this.clearCollapseTimer()
    this.countdownEl.classList.add('is-hidden')
    this.hideDock()
    this.setDockExpanded(false)
    this.errorBanner?.remove()
    const banner = document.createElement('div')
    banner.className = 'mpc-error-banner'
    banner.setAttribute('role', 'alert')
    const text = document.createElement('div')
    text.textContent = reason
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', () => {
      this.dispose()
      clearOverlaySingleton()
    })
    banner.append(text, dismiss)
    this.root.appendChild(banner)
    this.errorBanner = banner
  }

  getVisibility(): OverlayVisibility {
    const host = overlayMount?.host
    if (host) prepareHostShell(host)
    const countdownVisible =
      this.state.phase === 'countdown' &&
      this.countdownEl.isConnected &&
      !this.countdownEl.classList.contains('is-hidden')
    const dockVisible = this.isDockPainted()
    return readHostVisibility(this.state.phase, countdownVisible, dockVisible)
  }

  /** True when the left dock is actually painted (not just mounted). */
  private isDockPainted(): boolean {
    if (!this.dock.isConnected) return false
    if (!this.dock.classList.contains('is-visible')) return false
    const rect = this.dock.getBoundingClientRect()
    const cs = getComputedStyle(this.dock)
    return (
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      cs.opacity !== '0' &&
      rect.width >= 24 &&
      rect.height >= 48
    )
  }

  private showCamBlockedFallback(message: string) {
    if (this.camReady) return
    if (this.camWatchId != null) {
      window.clearTimeout(this.camWatchId)
      this.camWatchId = null
    }
    if (this.frame) this.frame.style.display = 'none'
    if (!this.camFallback && this.camClip) {
      this.camFallback = document.createElement('div')
      this.camFallback.className = 'mpc-cam-fallback'
      this.camClip.appendChild(this.camFallback)
    }
    if (this.camFallback) this.camFallback.textContent = message
    if (this.camStatusEl) {
      this.camStatusEl.textContent = message
      this.camStatusEl.classList.add('is-visible')
    }
  }

  update(partial: Partial<BubbleState>) {
    const prevMirror = this.state.mirror
    const prevDevice = this.state.cameraDeviceId
    const prevEffect = this.state.backgroundEffect
    const prevFilter = this.state.cameraFilter
    // Only apply defined keys — PIP_OVERLAY_UPDATE often sends a partial
    // (e.g. cameraFilter alone). Spreading undefined wiped size/x/y to NaN and
    // made mid-recording Small/Medium/Large + shape appear broken.
    const next: Partial<BubbleState> = {}
    for (const key of Object.keys(partial) as Array<keyof BubbleState>) {
      const value = partial[key]
      if (value !== undefined) {
        ;(next as Record<string, unknown>)[key] = value
      }
    }
    if (next.borderColor != null) {
      next.borderColor = sanitizeCssColor(next.borderColor)
    }
    if (next.cameraFilter != null) {
      next.cameraFilter = normalizeCameraFilter(next.cameraFilter)
    }
    this.state = { ...this.state, ...next }
    // Recover from a previously corrupted size (NaN / non-finite).
    if (!Number.isFinite(this.state.size)) {
      this.state.size = clamp(0.18, SIZE_MIN, SIZE_MAX)
    }
    if (!Number.isFinite(this.state.x)) this.state.x = 0.82
    if (!Number.isFinite(this.state.y)) this.state.y = 0.78
    if (this.state.recordMode === 'screen') this.bubble.classList.add('is-hidden')
    else this.bubble.classList.remove('is-hidden')
    this.apply()
    if (
      this.frame &&
      ((next.mirror != null && next.mirror !== prevMirror) ||
        (next.cameraDeviceId !== undefined && next.cameraDeviceId !== prevDevice))
    ) {
      this.frame.contentWindow?.postMessage(
        {
          type: 'MPC_PIP_MIRROR',
          token: this.pipChannelToken,
          mirror: this.state.mirror,
          deviceId: this.state.cameraDeviceId,
        },
        '*',
      )
    }
    if (
      this.frame &&
      next.backgroundEffect != null &&
      next.backgroundEffect !== prevEffect
    ) {
      this.frame.contentWindow?.postMessage(
        {
          type: 'MPC_PIP_EFFECT',
          token: this.pipChannelToken,
          effect: this.state.backgroundEffect,
        },
        '*',
      )
    }
    if (
      this.frame &&
      next.cameraFilter != null &&
      next.cameraFilter !== prevFilter
    ) {
      this.frame.contentWindow?.postMessage(
        {
          type: 'MPC_PIP_FILTER',
          token: this.pipChannelToken,
          filter: this.state.cameraFilter,
        },
        '*',
      )
    }
    if (next.phase === 'recording' && this.state.phase === 'recording') {
      this.enterRecordingUi()
    }
    if (next.phase === 'paused') {
      this.setPausedUi(true)
    }
  }

  /** Called by background when MediaRecorder has actually started. */
  beginRecordingClock() {
    this.state.phase = 'recording'
    this.recordingStartedAt = Date.now()
    this.pausedAccumMs = 0
    this.pauseStartedAt = 0
    this.restarting = false
    this.setDockBusy(false)
    this.setPausedUi(false)
    this.enterRecordingUi()
  }

  /**
   * Soft restart: keep bubble/dock mounted, reset timer, re-run 3→2→1.
   * Capture streams were already re-armed by the background.
   */
  beginRestartCountdown() {
    if (this.countdownId != null) {
      window.clearInterval(this.countdownId)
      this.countdownId = null
    }
    if (this.timerId != null) {
      window.clearInterval(this.timerId)
      this.timerId = null
    }
    this.clearCollapseTimer()
    this.errorBanner?.remove()
    this.errorBanner = null
    this.restarting = false
    this.stopping = false
    this.recordingStartedAt = 0
    this.pausedAccumMs = 0
    this.pauseStartedAt = 0
    this.timerEl.textContent = '0:00'
    this.state.phase = 'countdown'
    this.pauseBtn.innerHTML = iconPause()
    this.pauseBtn.title = 'Pause'
    this.pauseBtn.setAttribute('aria-label', 'Pause recording')
    this.setDockBusy(false)
    this.setDockExpanded(false)
    this.dock.classList.remove('is-paused')
    this.hideDock()
    if (!this.countdownEl.isConnected) {
      this.root.appendChild(this.countdownEl)
    }
    this.startCountdown()
  }

  setPausedUi(paused: boolean) {
    this.state.phase = paused ? 'paused' : 'recording'
    this.dock.classList.toggle('is-paused', paused)
    if (paused) {
      this.pauseStartedAt = Date.now()
      this.pauseBtn.innerHTML = iconPlay()
      this.pauseBtn.title = 'Resume'
      this.pauseBtn.setAttribute('aria-label', 'Resume recording')
    } else {
      if (this.pauseStartedAt) {
        this.pausedAccumMs += Date.now() - this.pauseStartedAt
        this.pauseStartedAt = 0
      }
      this.pauseBtn.innerHTML = iconPause()
      this.pauseBtn.title = 'Pause'
      this.pauseBtn.setAttribute('aria-label', 'Pause recording')
    }
    this.tickTimer()
  }

  private enterRecordingUi() {
    // Hide countdown before frames are committed; show tiny collapsed dock.
    this.countdownEl.classList.add('is-hidden')
    this.countdownEl.remove()
    this.setDockExpanded(false)
    this.revealDock()
    if (this.timerId == null) {
      this.timerId = window.setInterval(() => this.tickTimer(), 250)
    }
    this.tickTimer()
  }

  /**
   * Force the collapsed left dock onto the page. Uses class + inline
   * !important so a missed RECORDING_STARTED message or page CSS cannot
   * leave Stop/timer invisible after countdown.
   */
  private revealDock() {
    if (!this.dock.isConnected) {
      this.root.appendChild(this.dock)
    }
    this.dock.classList.add('is-visible')
    const props: Array<[string, string]> = [
      ['display', 'flex'],
      ['opacity', '1'],
      ['visibility', 'visible'],
      ['pointer-events', 'auto'],
      ['position', 'fixed'],
      ['left', '10px'],
      ['top', '50%'],
      ['transform', 'translateY(-50%)'],
      ['z-index', '2147483647'],
    ]
    for (const [k, v] of props) this.dock.style.setProperty(k, v, 'important')
    const host = overlayMount?.host
    if (host) prepareHostShell(host)
  }

  private hideDock() {
    this.dock.classList.remove('is-visible')
    this.dock.style.removeProperty('display')
    this.dock.style.removeProperty('opacity')
    this.dock.style.removeProperty('visibility')
    this.dock.style.removeProperty('pointer-events')
  }

  private tickTimer() {
    if (this.state.phase === 'countdown') {
      this.timerEl.textContent = '0:00'
      return
    }
    let elapsed = Date.now() - this.recordingStartedAt - this.pausedAccumMs
    if (this.state.phase === 'paused' && this.pauseStartedAt) {
      elapsed = this.pauseStartedAt - this.recordingStartedAt - this.pausedAccumMs
    }
    this.timerEl.textContent = formatDuration(Math.max(0, elapsed))
  }

  private setDockExpanded(expanded: boolean) {
    this.clearCollapseTimer()
    this.dockExpanded = expanded
    this.dock.classList.toggle('is-expanded', expanded)
    this.dockHead.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    this.dockHead.setAttribute(
      'aria-label',
      expanded ? 'Collapse recording controls' : 'Expand recording controls',
    )
    this.dockHead.title = expanded ? 'Hide extra controls' : 'More recording controls'
  }

  private scheduleDockCollapse(ms = 2200) {
    this.clearCollapseTimer()
    this.collapseTimerId = window.setTimeout(() => {
      this.collapseTimerId = null
      this.setDockExpanded(false)
    }, ms)
  }

  private clearCollapseTimer() {
    if (this.collapseTimerId != null) {
      window.clearTimeout(this.collapseTimerId)
      this.collapseTimerId = null
    }
  }

  private finishCountdown() {
    if (this.countdownId != null) {
      window.clearInterval(this.countdownId)
      this.countdownId = null
    }
    // Hide countdown AND show dock immediately — do not wait for
    // PIP_OVERLAY_RECORDING_STARTED (that message can fail silently and used
    // to leave users with zero controls after the HUD was made fallback-only).
    this.enterRecordingUi()
    void (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({
          type: 'LOOM_COUNTDOWN_DONE',
        })) as { ok?: boolean; reason?: string } | undefined
        if (!res?.ok) {
          this.showError(
            res?.reason?.trim() ||
              'Could not start capture after countdown. Try Start again.',
          )
          return
        }
        // Belt-and-suspenders: ensure dock stays painted even if the SW's
        // RECORDING_STARTED ping was dropped.
        this.enterRecordingUi()
      } catch (err) {
        const msg =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : 'Could not start capture after countdown.'
        this.showError(msg)
      }
    })()
  }

  private startCountdown() {
    let n = COUNTDOWN_FROM
    if (!this.countdownEl.isConnected) {
      this.root.appendChild(this.countdownEl)
    }
    this.countdownEl.classList.remove('is-hidden')
    this.hideDock()
    this.setDockExpanded(false)
    const show = () => {
      this.countdownNum.textContent = String(n)
      this.countdownNum.style.animation = 'none'
      // reflow to restart animation
      void this.countdownNum.offsetWidth
      this.countdownNum.style.animation = ''
    }
    show()
    this.countdownId = window.setInterval(() => {
      n -= 1
      if (n <= 0) {
        this.finishCountdown()
        return
      }
      show()
    }, 1000)
  }

  private async requestStop() {
    if (this.stopping || this.restarting) return
    this.stopping = true
    this.setDockBusy(true)
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_LOOM_RECORDING' })
    } catch {
      this.stopping = false
      this.setDockBusy(false)
    }
  }

  private async requestTrimAndStop() {
    if (this.stopping || this.restarting) return
    if (this.state.phase === 'countdown') return
    const ok = window.confirm(
      'Stop and trim in editor?\n\nRecording will save, then open so you can trim the end.',
    )
    if (!ok) return
    this.stopping = true
    this.setDockBusy(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'STOP_LOOM_RECORDING',
        openEditor: true,
      })) as { ok?: boolean; reason?: string } | undefined
      if (!res?.ok) {
        this.stopping = false
        this.setDockBusy(false)
        this.showError(res?.reason?.trim() || 'Could not stop recording to trim.')
      }
    } catch {
      this.stopping = false
      this.setDockBusy(false)
    }
  }

  private async togglePause() {
    if (this.state.phase === 'countdown' || this.stopping || this.restarting) return
    const pausing = this.state.phase !== 'paused'
    try {
      const res = (await chrome.runtime.sendMessage({
        type: pausing ? 'PAUSE_LOOM_RECORDING' : 'RESUME_LOOM_RECORDING',
      })) as { ok?: boolean } | undefined
      if (res?.ok) {
        this.setPausedUi(pausing)
        this.scheduleDockCollapse()
      }
    } catch {
      /* ignore */
    }
  }

  private async requestRestart() {
    if (this.stopping || this.restarting) return
    if (this.state.phase === 'countdown') return
    this.restarting = true
    this.setDockBusy(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'RESTART_LOOM_RECORDING',
      })) as { ok?: boolean; reason?: string } | undefined
      if (!res?.ok) {
        this.restarting = false
        this.setDockBusy(false)
        this.showError(
          res?.reason?.trim() || 'Could not restart recording. Try Start again.',
        )
      }
      // On success, background sends PIP_OVERLAY_RESTART → beginRestartCountdown()
    } catch (err) {
      this.restarting = false
      this.setDockBusy(false)
      const msg =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'Could not restart recording.'
      this.showError(msg)
    }
  }

  private setDockBusy(busy: boolean) {
    this.stopBtn.disabled = busy
    this.pauseBtn.disabled = busy
    this.trimBtn.disabled = busy
    this.restartBtn.disabled = busy
    this.discardBtn.disabled = busy
    this.dockHead.disabled = busy
  }

  private async requestDiscard(fromCountdown: boolean) {
    if (this.restarting && !fromCountdown) return
    if (this.countdownId != null) {
      window.clearInterval(this.countdownId)
      this.countdownId = null
    }
    try {
      await chrome.runtime.sendMessage({
        type: 'DISCARD_LOOM_RECORDING',
        fromCountdown,
      })
    } catch {
      this.dispose()
    }
  }

  private apply() {
    if (!Number.isFinite(this.state.size)) {
      this.state.size = clamp(0.18, SIZE_MIN, SIZE_MAX)
    }
    if (!Number.isFinite(this.state.x)) this.state.x = 0.82
    if (!Number.isFinite(this.state.y)) this.state.y = 0.78
    const vw = window.innerWidth
    const vh = window.innerHeight
    const diameter = Math.max(BUBBLE_MIN_PX, Math.min(vw, vh) * this.state.size)
    // position: fixed — left/top are viewport coordinates
    const left = this.state.x * vw - diameter / 2
    const top = this.state.y * vh - diameter / 2
    this.bubble.style.setProperty('width', `${diameter}px`, 'important')
    this.bubble.style.setProperty('height', `${diameter}px`, 'important')
    this.bubble.style.setProperty(
      'left',
      `${clamp(left, 4, Math.max(4, vw - diameter - 4))}px`,
      'important',
    )
    this.bubble.style.setProperty(
      'top',
      `${clamp(top, 4, Math.max(4, vh - diameter - 4))}px`,
      'important',
    )
    if (this.state.recordMode === 'screen') {
      this.bubble.style.setProperty('display', 'none', 'important')
    } else {
      this.bubble.style.setProperty('display', 'block', 'important')
      this.bubble.style.setProperty('opacity', '1', 'important')
      this.bubble.style.setProperty('visibility', 'visible', 'important')
    }
    this.bubble.style.borderColor =
      this.state.borderColor === 'transparent' ? 'rgba(255,255,255,0.55)' : this.state.borderColor
    this.bubble.style.boxShadow = this.state.shadow
      ? '0 12px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)'
      : 'none'
    this.bubble.classList.toggle('is-square', this.state.shape === 'square')
  }

  private persist() {
    if (this.state.mode === 'live') {
      try {
        void chrome.runtime.sendMessage({
          type: 'LOOM_BUBBLE_MOVED',
          x: this.state.x,
          y: this.state.y,
          size: this.state.size,
        })
      } catch {
        /* SW asleep — local visual already updated */
      }
      return
    }
    try {
      void chrome.storage.session.set({
        pipOverlayLive: {
          x: this.state.x,
          y: this.state.y,
          size: this.state.size,
          at: Date.now(),
        },
      })
    } catch {
      /* ignore */
    }
  }

  private setSize(size: number) {
    this.state.size = clamp(size, SIZE_MIN, SIZE_MAX)
    this.apply()
    this.persist()
    this.closeMenu()
  }

  private setShape(shape: BubbleShape) {
    this.state.shape = shape
    this.apply()
    try {
      void chrome.runtime.sendMessage({
        type: 'LOOM_BUBBLE_SHAPE',
        bubbleShape: shape,
      })
    } catch {
      /* SW asleep — local visual already updated */
    }
    this.closeMenu()
  }

  private setBackgroundEffect(effect: BackgroundEffect) {
    this.state.backgroundEffect = effect
    try {
      this.frame?.contentWindow?.postMessage(
        { type: 'MPC_PIP_EFFECT', token: this.pipChannelToken, effect },
        '*',
      )
    } catch {
      /* iframe may be gone */
    }
    try {
      void chrome.runtime.sendMessage({
        type: 'LOOM_BUBBLE_EFFECT',
        backgroundEffect: effect,
      })
    } catch {
      /* SW asleep — local visual already updated */
    }
    this.closeMenu()
  }

  private syncMenuPointerGate() {
    // While the menu is open, disable the full-bubble drag hit-target so it
    // cannot steal pointerdown from Small/Medium/Large (common during capture).
    if (this.dragSurface) {
      this.dragSurface.style.pointerEvents = this.menuOpen ? 'none' : 'auto'
    }
  }

  private toggleMenu() {
    this.menuOpen = !this.menuOpen
    this.menu?.classList.toggle('is-open', this.menuOpen)
    this.bubble.classList.toggle('is-menu-open', this.menuOpen)
    this.syncMenuPointerGate()
  }

  private closeMenu() {
    this.menuOpen = false
    this.menu?.classList.remove('is-open')
    this.bubble.classList.remove('is-menu-open')
    this.syncMenuPointerGate()
  }

  private onMoveDown(e: PointerEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('.mpc-menu-btn') || target.closest('.mpc-menu')) return
    // Menu open + click on bubble chrome: dismiss only — don't start a drag.
    if (this.menuOpen) {
      e.preventDefault()
      e.stopPropagation()
      this.closeMenu()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    this.closeMenu()
    this.dragging = true
    this.bubble.classList.add('is-dragging')

    const pointerId = e.pointerId
    const surface = this.dragSurface ?? this.bubble
    try {
      surface.setPointerCapture(pointerId)
    } catch {
      /* ignore */
    }

    // Offset so the bubble doesn't jump to cursor center on grab
    const rect = this.bubble.getBoundingClientRect()
    const offsetX = e.clientX - (rect.left + rect.width / 2)
    const offsetY = e.clientY - (rect.top + rect.height / 2)

    const move = (ev: PointerEvent) => {
      if (!this.dragging) return
      const cx = ev.clientX - offsetX
      const cy = ev.clientY - offsetY
      this.state.x = clamp(cx / window.innerWidth, 0.05, 0.95)
      this.state.y = clamp(cy / window.innerHeight, 0.08, 0.95)
      this.apply()
    }
    const up = (ev: PointerEvent) => {
      this.dragging = false
      this.bubble.classList.remove('is-dragging')
      try {
        surface.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      surface.removeEventListener('pointermove', move)
      surface.removeEventListener('pointerup', up)
      surface.removeEventListener('pointercancel', up)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      this.persist()
    }

    // Listen on both surface (capture target) and window as fallback
    surface.addEventListener('pointermove', move)
    surface.addEventListener('pointerup', up)
    surface.addEventListener('pointercancel', up)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  private onWheel(e: WheelEvent) {
    if (this.state.recordMode === 'screen') return
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.01 : 0.01
    this.state.size = clamp(this.state.size + delta, SIZE_MIN, SIZE_MAX)
    this.apply()
    this.persist()
  }

  dispose() {
    if (this.timerId != null) window.clearInterval(this.timerId)
    if (this.countdownId != null) window.clearInterval(this.countdownId)
    if (this.camWatchId != null) window.clearTimeout(this.camWatchId)
    this.clearCollapseTimer()
    document.removeEventListener('pointerdown', this.onDocPointerDown, true)
    window.removeEventListener('message', this.onPipMessage)
    void chrome.runtime.sendMessage({
      type: 'REVOKE_PIP_CHANNEL',
      token: this.pipChannelToken,
    })
    try {
      this.frame?.contentWindow?.postMessage(
        { type: 'MPC_PIP_STOP', token: this.pipChannelToken },
        '*',
      )
    } catch {
      /* ignore */
    }
    this.frame = null
    this.errorBanner = null
    removeRoot()
  }
}

let overlay: TabOverlay | null = null

function clearOverlaySingleton() {
  overlay = null
}

const priorInstall = window[INSTALL_KEY]
if (priorInstall != null && priorInstall !== INSTALL_VERSION) {
  // Older injected build — drop its host so the new dock markup can mount cleanly.
  overlay = null
  try {
    removeRoot()
  } catch {
    /* ignore */
  }
}

window[HANDLER_KEY] = (message, _sender, sendResponse) => {
  if (message?.type === 'PIP_OVERLAY_START') {
    try {
      console.log('[MyPipCam][start] PIP_OVERLAY_START received', {
        phase: message.phase,
        recordMode: message.recordMode,
        href: location.href.slice(0, 120),
      })
      overlay?.dispose()
      overlay = new TabOverlay({
        x: message.x ?? 0.82,
        y: message.y ?? 0.78,
        size: message.size ?? 0.18,
        shape: message.bubbleShape === 'square' ? 'square' : 'circle',
        mirror: message.mirror ?? true,
        borderColor: sanitizeCssColor(message.borderColor ?? '#ffffff'),
        shadow: message.shadow ?? true,
        backgroundEffect: message.backgroundEffect === 'blur' ? 'blur' : 'none',
        cameraFilter: normalizeCameraFilter(message.cameraFilter),
        mode: message.mode === 'guide' ? 'guide' : 'live',
        recordMode: (message.recordMode as RecordMode) || 'screen-cam',
        cameraDeviceId: message.cameraDeviceId ?? null,
        phase: message.phase === 'recording' ? 'recording' : 'countdown',
      })
      // Sanity: host must be in the document and not zero-sized.
      const host = overlayMount?.host
      if (!host?.isConnected) {
        throw new Error('Recording overlay failed to attach to the page')
      }
      // One frame lets layout settle after mount before the visibility probe.
      requestAnimationFrame(() => {
        try {
          if (!overlay) throw new Error('Recording overlay disappeared after mount')
          const visibility = overlay.getVisibility()
          console.log('[MyPipCam][start] overlay visibility after mount', visibility)
          if (!visibility.visible) {
            throw new Error(
              `Recording overlay mounted but is not visible (display=${visibility.display}, ${visibility.width}x${visibility.height}, topLayer=${visibility.topLayer})`,
            )
          }
          const { ok: _ok, ...rest } = visibility
          sendResponse({ ...rest, ok: true })
        } catch (err) {
          try {
            overlay?.dispose()
          } catch {
            /* ignore */
          }
          overlay = null
          const reason =
            err instanceof Error && err.message.trim()
              ? err.message.trim()
              : 'Could not mount recording overlay'
          console.error('[MyPipCam][start] PIP_OVERLAY_START visible-check failed:', reason, err)
          sendResponse({ ok: false, reason })
        }
      })
    } catch (err) {
      try {
        overlay?.dispose()
      } catch {
        /* ignore */
      }
      overlay = null
      const reason =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : 'Could not mount recording overlay'
      console.error('[MyPipCam][start] PIP_OVERLAY_START failed:', reason, err)
      sendResponse({ ok: false, reason })
    }
    return true
  }
  if (message?.type === 'PIP_OVERLAY_STATUS') {
    if (!overlay) {
      const missing = readHostVisibility(null, false)
      const { ok: _ok, ...rest } = missing
      sendResponse({
        ...rest,
        ok: false,
        reason: 'no-overlay',
      })
      return true
    }
    const visibility = overlay.getVisibility()
    const { ok: _ok, ...rest } = visibility
    sendResponse({ ...rest, ok: visibility.visible })
    return true
  }
  if (message?.type === 'PIP_OVERLAY_RECORDING_STARTED') {
    if (!overlay) {
      sendResponse({ ok: false, reason: 'no-overlay', dockVisible: false })
      return true
    }
    overlay.beginRecordingClock()
    const visibility = overlay.getVisibility()
    sendResponse({
      ok: true,
      dockVisible: visibility.dockVisible,
      phase: visibility.phase,
    })
    return true
  }
  if (message?.type === 'PIP_OVERLAY_RESTART' && overlay) {
    overlay.beginRestartCountdown()
    sendResponse({ ok: true })
    return true
  }
  if (message?.type === 'PIP_OVERLAY_ERROR') {
    const reason =
      typeof message.reason === 'string' && message.reason.trim()
        ? message.reason.trim()
        : 'Recording failed'
    if (overlay) {
      overlay.showError(reason)
    } else {
      const root = ensureRoot()
      root.replaceChildren()
      const banner = document.createElement('div')
      banner.className = 'mpc-error-banner'
      banner.setAttribute('role', 'alert')
      const text = document.createElement('div')
      text.textContent = reason
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.textContent = 'Dismiss'
      dismiss.addEventListener('click', () => removeRoot())
      banner.append(text, dismiss)
      root.appendChild(banner)
      window.setTimeout(() => removeRoot(), 12000)
    }
    sendResponse({ ok: true })
    return true
  }
  if (message?.type === 'PIP_OVERLAY_PAUSED' && overlay) {
    overlay.setPausedUi(Boolean(message.paused))
    sendResponse({ ok: true })
    return true
  }
  if (message?.type === 'PIP_OVERLAY_UPDATE' && overlay) {
    const patch: Partial<BubbleState> = {}
    if (typeof message.x === 'number' && Number.isFinite(message.x)) patch.x = message.x
    if (typeof message.y === 'number' && Number.isFinite(message.y)) patch.y = message.y
    if (typeof message.size === 'number' && Number.isFinite(message.size)) {
      patch.size = message.size
    }
    if (typeof message.mirror === 'boolean') patch.mirror = message.mirror
    if (message.borderColor != null) patch.borderColor = message.borderColor
    if (typeof message.shadow === 'boolean') patch.shadow = message.shadow
    if (message.cameraDeviceId === null || typeof message.cameraDeviceId === 'string') {
      patch.cameraDeviceId = message.cameraDeviceId
    }
    if (message.bubbleShape === 'square' || message.bubbleShape === 'circle') {
      patch.shape = message.bubbleShape
    }
    if (message.backgroundEffect === 'blur' || message.backgroundEffect === 'none') {
      patch.backgroundEffect = message.backgroundEffect
    }
    if (message.cameraFilter != null) {
      patch.cameraFilter = normalizeCameraFilter(message.cameraFilter)
    }
    overlay.update(patch)
    sendResponse({ ok: true })
    return true
  }
  if (message?.type === 'PIP_OVERLAY_STOP') {
    overlay?.dispose()
    overlay = null
    sendResponse({ ok: true })
    return true
  }
  return false
}

window[INSTALL_KEY] = INSTALL_VERSION
if (!window[DISPATCHER_KEY]) {
  window[DISPATCHER_KEY] = true
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handle = window[HANDLER_KEY]
    if (!handle) return false
    return handle(message, sender, sendResponse) ?? false
  })
}
