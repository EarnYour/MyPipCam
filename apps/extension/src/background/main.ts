// Force CRX to emit a classic IIFE at src/content/pipOverlay.js.
// IMPORTANT: never inject the import value. `*?script` is an alias for
// `*?script&loader` (hashed ESM loader under assets/) — executeScript cannot
// run those loaders. Always inject the stable IIFE path below.
import crxPipOverlayPath from '../content/pipOverlay.ts?script&iife'
import { applyPopupPageDim } from '../content/popupDimApply'
import {
  clearDriveAuthDirect,
  DriveAuthError,
  explainDriveAuthError,
  getAccessTokenDirect,
  hasDriveAuthDirect,
  invalidateAccessTokenDirect,
} from '../shared/driveAuth'
import { connectGoogleDriveInBackground } from '../shared/driveSync'
import {
  runDriveAutoUploadById,
  runPendingDriveAutoUploads,
} from '../shared/db'
import { normalizeCameraFilter } from '../shared/cameraFilters'
import { loadPipSettings, savePipSettings } from '../shared/settings'
import { openLibraryTab, openRecorderTab } from '../shared/navigation'
import {
  isContentScriptSender,
  isPipChannelToken,
  isPipFrameSender,
  isSafeRecordingId,
  isTrustedExtensionSender,
  sanitizeCssColor,
} from '../shared/security'
import { normalizeBorderWidth, type RecordMode } from '../shared/types'

// Content scripts (pipOverlay guide mode) write pipOverlayLive to session
// storage; without this, those writes reject and the recorder never sees them.
void chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch(() => {})

/** Short-lived tokens allowing the WAR PiP iframe to start the camera. */
const PIP_TOKEN_TTL_MS = 10 * 60 * 1000
const PIP_TOKEN_PREFIX = 'pipCh:'
/** In-memory cache so VALIDATE works even if session storage is briefly lagging. */
const pipTokenExpiry = new Map<string, number>()

async function registerPipChannelToken(token: string): Promise<void> {
  const exp = Date.now() + PIP_TOKEN_TTL_MS
  pipTokenExpiry.set(token, exp)
  await chrome.storage.session.set({ [`${PIP_TOKEN_PREFIX}${token}`]: exp })
}

async function revokePipChannelToken(token: string): Promise<void> {
  pipTokenExpiry.delete(token)
  await chrome.storage.session.remove(`${PIP_TOKEN_PREFIX}${token}`)
}

async function validatePipChannelToken(token: string): Promise<boolean> {
  const now = Date.now()
  const mem = pipTokenExpiry.get(token)
  if (typeof mem === 'number') {
    if (mem > now) return true
    pipTokenExpiry.delete(token)
  }

  const key = `${PIP_TOKEN_PREFIX}${token}`
  const result = await chrome.storage.session.get(key)
  const exp = result[key]
  if (typeof exp !== 'number' || exp <= now) {
    await chrome.storage.session.remove(key)
    pipTokenExpiry.delete(token)
    return false
  }
  pipTokenExpiry.set(token, exp)
  return true
}

const OFFSCREEN_URL = 'src/offscreen/index.html'
/**
 * Stable classic-script path written by CRX's IIFE content-script pass.
 * Must match dist/src/content/pipOverlay.js — never a hashed assets/*-loader-*.
 */
const PIP_OVERLAY_SCRIPT = 'src/content/pipOverlay.js'

type LoomSession = {
  tabId: number
  startedAt: number
  recordMode: RecordMode
  phase: 'countdown' | 'recording' | 'paused'
  micDeviceId: string | null
  cameraDeviceId: string | null
  includeMic: boolean
  /** True once offscreen has consumed tabCapture / cam streams. */
  prepared: boolean
}

let loomSession: LoomSession | null = null
let starting = false
let armingCapture = false
/** Optional fallback HUD window (only when page overlay fails). */
let hudWindowId: number | null = null
/** When popup window create fails, HUD opens as a normal tab instead. */
let hudTabId: number | null = null
/** Last driveCountdown flag — used if ENSURE_RECORDING_HUD opens fallback HUD. */
let hudDriveCountdown = false

type StoredLoomRecording = {
  tabId?: number
  startedAt?: number
  phase?: string
  recordMode?: RecordMode
  micDeviceId?: string | null
  cameraDeviceId?: string | null
  includeMic?: boolean
  prepared?: boolean
  ui?: string
}

/** Persist enough session state to survive MV3 service-worker restarts. */
async function persistLoomSession(session: LoomSession, ui?: string) {
  const payload: StoredLoomRecording = {
    tabId: session.tabId,
    startedAt: session.startedAt,
    phase: session.phase,
    recordMode: session.recordMode,
    micDeviceId: session.micDeviceId,
    cameraDeviceId: session.cameraDeviceId,
    includeMic: session.includeMic,
    prepared: session.prepared,
  }
  if (ui) payload.ui = ui
  await chrome.storage.session.set({ loomRecording: payload })
}

/**
 * MV3 kills the SW after idle; in-memory loomSession is lost while offscreen
 * capture + page overlay can still be live. Rehydrate from session storage.
 */
async function hydrateLoomSession(): Promise<LoomSession | null> {
  if (loomSession) return loomSession
  try {
    const stored = await chrome.storage.session.get('loomRecording')
    const rec = stored.loomRecording as StoredLoomRecording | undefined
    if (!rec || typeof rec.tabId !== 'number') return null
    loomSession = {
      tabId: rec.tabId,
      startedAt: typeof rec.startedAt === 'number' ? rec.startedAt : Date.now(),
      recordMode:
        rec.recordMode === 'screen' || rec.recordMode === 'cam'
          ? rec.recordMode
          : 'screen-cam',
      phase:
        rec.phase === 'paused'
          ? 'paused'
          : rec.phase === 'recording'
            ? 'recording'
            : 'countdown',
      micDeviceId: typeof rec.micDeviceId === 'string' ? rec.micDeviceId : null,
      cameraDeviceId:
        typeof rec.cameraDeviceId === 'string' ? rec.cameraDeviceId : null,
      includeMic: rec.includeMic !== false,
      prepared: rec.prepared !== false,
    }
    startLog('hydrated loomSession from storage', {
      tabId: loomSession.tabId,
      phase: loomSession.phase,
    })
    return loomSession
  } catch (err) {
    startWarn('hydrateLoomSession failed', err)
    return null
  }
}

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

function startLog(...args: unknown[]) {
  console.log('[MyPipCam][start]', ...args)
}

function startWarn(...args: unknown[]) {
  console.warn('[MyPipCam][start]', ...args)
}

function startError(...args: unknown[]) {
  console.error('[MyPipCam][start]', ...args)
}

async function persistLastStartError(reason: string | null) {
  try {
    if (!reason) {
      await chrome.storage.session.remove('lastStartError')
      return
    }
    await chrome.storage.session.set({
      lastStartError: { reason, at: Date.now() },
    })
  } catch {
    /* ignore */
  }
}

async function notifyStartFailure(reason: string) {
  await persistLastStartError(reason)
  try {
    await chrome.notifications.create(`mypipcam-start-fail-${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'MyPipCam — could not start',
      message: reason.slice(0, 180),
      priority: 2,
    })
  } catch (err) {
    startWarn('notification failed', err)
  }
}

async function closeHudWindow() {
  const winId = hudWindowId
  const tabId = hudTabId
  hudWindowId = null
  hudTabId = null
  if (tabId != null) {
    try {
      await chrome.tabs.remove(tabId)
    } catch {
      /* already closed */
    }
  }
  if (winId != null) {
    try {
      await chrome.windows.remove(winId)
    } catch {
      /* already closed */
    }
  }
}

async function focusHudWindow(): Promise<boolean> {
  if (hudWindowId != null) {
    try {
      await chrome.windows.update(hudWindowId, { focused: true, drawAttention: true })
      return true
    } catch {
      hudWindowId = null
    }
  }
  if (hudTabId != null) {
    try {
      const tab = await chrome.tabs.get(hudTabId)
      await chrome.tabs.update(hudTabId, { active: true })
      if (typeof tab.windowId === 'number') {
        await chrome.windows.update(tab.windowId, { focused: true, drawAttention: true })
        hudWindowId = tab.windowId
      }
      return true
    } catch {
      hudTabId = null
    }
  }
  return false
}

/** Narrow Loom-style left dock — chrome.windows popup (no frameless option). */
const HUD_DOCK_WIDTH = 72
const HUD_DOCK_HEIGHT = 400

async function resolveHudAnchor(anchorTabId?: number): Promise<{ left: number; top: number }> {
  const height = HUD_DOCK_HEIGHT
  try {
    let win: chrome.windows.Window | undefined
    if (typeof anchorTabId === 'number') {
      const tab = await chrome.tabs.get(anchorTabId)
      if (typeof tab.windowId === 'number') {
        win = await chrome.windows.get(tab.windowId)
      }
    }
    if (!win) win = await chrome.windows.getLastFocused()
    // Prefer just outside the browser's left edge; clamp onto the display if needed.
    const besideLeft = (win.left ?? 0) - HUD_DOCK_WIDTH - 4
    const left = Math.max(0, besideLeft >= 0 ? besideLeft : (win.left ?? 0) + 6)
    const top = Math.max(
      0,
      (win.top ?? 0) + Math.round(((win.height ?? 800) - height) / 2),
    )
    return { left, top }
  } catch {
    return { left: 0, top: 120 }
  }
}

/**
 * Optional fallback HUD window — only used when the in-page overlay fails.
 * Happy path keeps controls docked in the page (may appear in tabCapture).
 */
async function openRecordingHud(options?: {
  driveCountdown?: boolean
  focused?: boolean
  anchorTabId?: number
  /** Reuse existing HUD if still open (just focus + sync). */
  reuse?: boolean
}): Promise<{ ok: boolean; reason?: string }> {
  const driveCountdown = Boolean(options?.driveCountdown)
  hudDriveCountdown = driveCountdown
  const qs = driveCountdown ? '?drive=1' : '?drive=0'
  const url = chrome.runtime.getURL(`src/hud/index.html${qs}`)

  if (options?.reuse !== false) {
    const focused = await focusHudWindow()
    if (focused) {
      startLog('recording HUD reused/focused', { windowId: hudWindowId, tabId: hudTabId })
      return { ok: true }
    }
  }

  await closeHudWindow()

  const { left, top } = await resolveHudAnchor(options?.anchorTabId)
  try {
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: HUD_DOCK_WIDTH,
      height: HUD_DOCK_HEIGHT,
      left,
      top,
      focused: true,
    })
    hudWindowId = typeof win?.id === 'number' ? win.id : null
    if (hudWindowId == null) {
      throw new Error('Recording controls window opened without an id')
    }
    // Second focus pass — create(..., focused:true) is flaky after tabCapture.
    await chrome.windows.update(hudWindowId, {
      focused: true,
      drawAttention: true,
      width: HUD_DOCK_WIDTH,
      height: HUD_DOCK_HEIGHT,
      left,
      top,
    })
    startLog('recording HUD opened', { windowId: hudWindowId, driveCountdown, left, top })
    return { ok: true }
  } catch (err) {
    const createReason = errMessage(err, 'Could not open recording controls window')
    startWarn('recording HUD popup failed — trying window/tab fallback', createReason)
    // Fallback 1: normal focused window (still outside the captured tab).
    try {
      const win = await chrome.windows.create({
        url,
        type: 'normal',
        width: HUD_DOCK_WIDTH + 16,
        height: HUD_DOCK_HEIGHT + 40,
        left,
        top,
        focused: true,
      })
      hudWindowId = typeof win?.id === 'number' ? win.id : null
      const tabs = win?.tabs
      hudTabId =
        tabs && tabs[0] && typeof tabs[0].id === 'number' ? tabs[0].id : null
      if (hudWindowId == null) throw new Error('Fallback HUD window missing id')
      await chrome.windows.update(hudWindowId, { focused: true, drawAttention: true })
      startLog('recording HUD opened as normal window', {
        windowId: hudWindowId,
        tabId: hudTabId,
      })
      return { ok: true }
    } catch (winErr) {
      startWarn(
        'recording HUD normal-window fallback failed — trying tab',
        errMessage(winErr, ''),
      )
    }
    // Fallback 2: focused tab the user can definitely see.
    try {
      const tab = await chrome.tabs.create({ url, active: true })
      hudTabId = typeof tab.id === 'number' ? tab.id : null
      if (typeof tab.windowId === 'number') hudWindowId = tab.windowId
      if (hudTabId == null) throw new Error('HUD tab opened without an id')
      await chrome.windows.update(tab.windowId!, { focused: true, drawAttention: true })
      startLog('recording HUD opened as tab', { tabId: hudTabId, windowId: hudWindowId })
      return { ok: true }
    } catch (tabErr) {
      const reason = errMessage(tabErr, createReason)
      startError('recording HUD failed', reason)
      return { ok: false, reason }
    }
  }
}

async function syncHud(phase: string, reason?: string) {
  try {
    await chrome.runtime.sendMessage({
      type: 'HUD_SYNC',
      phase,
      ...(reason ? { reason } : {}),
    })
  } catch {
    /* HUD may have closed */
  }
}

/** Focus the captured tab; do not steal focus for a separate HUD window. */
async function focusCapturedTabOnly(tabId: number) {
  await focusCapturedTab(tabId)
}

async function setRecordingBadge(on: boolean) {
  try {
    await chrome.action.setBadgeText({ text: on ? 'REC' : '' })
    await chrome.action.setBadgeBackgroundColor({ color: '#ff5e29' })
  } catch {
    /* ignore */
  }
}

/** Prefer getContexts over nested runtime.sendMessage pings (avoids SW self-reply races). */
async function listOffscreenContexts(): Promise<chrome.runtime.ExtensionContext[]> {
  try {
    const offscreenType =
      chrome.runtime.ContextType?.OFFSCREEN_DOCUMENT ??
      ('OFFSCREEN_DOCUMENT' as unknown as chrome.runtime.ContextType)
    return (await chrome.runtime.getContexts({
      contextTypes: [offscreenType],
    })) as chrome.runtime.ExtensionContext[]
  } catch (err) {
    console.warn('[MyPipCam] getContexts(OFFSCREEN_DOCUMENT) failed:', err)
    return []
  }
}

/** Bring the captured https tab forward so countdown/dock/PiP are visible. */
async function focusCapturedTab(tabId: number) {
  try {
    const tab = await chrome.tabs.get(tabId)
    await chrome.tabs.update(tabId, { active: true })
    if (typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
  } catch (err) {
    console.warn('[MyPipCam] focusCapturedTab failed:', err)
  }
}

async function ensureOffscreen(): Promise<void> {
  const existing = await listOffscreenContexts()
  if (existing.length > 0) return

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Record the active Chrome tab while the camera PiP overlay stays on-page.',
    })
  } catch (err) {
    const msg = errMessage(err, '')
    if (!/already exists|single offscreen/i.test(msg)) throw err
  }

  for (let i = 0; i < 40; i++) {
    const contexts = await listOffscreenContexts()
    if (contexts.length > 0) {
      // Brief settle so the offscreen module's onMessage listener is registered.
      await new Promise((r) => setTimeout(r, 30))
      return
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('Recorder failed to start (offscreen document not ready). Try again.')
}

async function closeOffscreen(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument()
  } catch {
    /* already closed */
  }
}

async function sendOffscreen<T extends { ok?: boolean; reason?: string }>(
  message: Record<string, unknown>,
): Promise<T> {
  const payload = { ...message, target: 'offscreen' }
  let lastErr = 'No response from offscreen recorder'
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = (await chrome.runtime.sendMessage(payload)) as T | undefined
      if (res != null) return res
      lastErr = 'Offscreen recorder returned an empty response'
    } catch (err) {
      lastErr = errMessage(err, 'Offscreen recorder message failed')
    }
    await new Promise((r) => setTimeout(r, 40 + attempt * 40))
  }
  return { ok: false, reason: lastErr } as T
}

async function listMicrophones(): Promise<{
  ok: boolean
  devices: { deviceId: string; label: string }[]
  reason?: string
}> {
  await ensureOffscreen()
  const res = await sendOffscreen<{
    ok?: boolean
    devices?: { deviceId: string; label: string }[]
    reason?: string
  }>({ type: 'OFFSCREEN_LIST_MICS' })
  if (!res?.ok) {
    return {
      ok: false,
      devices: [],
      reason: res?.reason || 'Could not list microphones',
    }
  }
  return { ok: true, devices: res.devices ?? [] }
}

async function ensureMicrophoneAccess(): Promise<{ ok: boolean; reason?: string }> {
  await ensureOffscreen()
  return sendOffscreen({ type: 'OFFSCREEN_ENSURE_MIC' })
}

async function injectOverlay(tabId: number) {
  // Defense: if CRX ever regresses to returning a loader path, ignore it.
  if (crxPipOverlayPath !== PIP_OVERLAY_SCRIPT) {
    startError('CRX overlay path mismatch — using stable IIFE path', {
      crxPath: crxPipOverlayPath,
      stablePath: PIP_OVERLAY_SCRIPT,
    })
  }
  if (/loader/i.test(crxPipOverlayPath) || /assets\//i.test(crxPipOverlayPath)) {
    startError('CRX returned forbidden overlay path shape', crxPipOverlayPath)
  }
  startLog('injectOverlay', {
    tabId,
    script: PIP_OVERLAY_SCRIPT,
    crxPath: crxPipOverlayPath,
  })
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [PIP_OVERLAY_SCRIPT],
  })
  startLog('injectOverlay executeScript resolved', { tabId, script: PIP_OVERLAY_SCRIPT })
}

/**
 * Overlay inject is IIFE (sync), but the tab may still be settling after
 * executeScript / share-picker focus — retry briefly until the listener answers.
 */
async function sendOverlayMessage<T extends { ok?: boolean; reason?: string }>(
  tabId: number,
  message: Record<string, unknown>,
  attempts = 20,
): Promise<T> {
  let lastErr = 'Overlay content script did not respond'
  startLog('sendOverlayMessage', { tabId, type: message.type, attempts })
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, message)) as T | undefined
      if (res != null) {
        if (res.ok === false) {
          throw new Error(
            typeof res.reason === 'string' && res.reason.trim()
              ? res.reason.trim()
              : 'Overlay refused to start',
          )
        }
        startLog('sendOverlayMessage ok', { tabId, type: message.type, attempt: i + 1, res })
        return res
      }
      lastErr = 'Overlay returned an empty response'
    } catch (err) {
      lastErr = errMessage(err, 'Could not reach camera overlay in this tab')
      // Hard failure from overlay mount — don't keep retrying.
      if (
        /failed to attach|could not mount|refused to start|no document\.body|not visible/i.test(
          lastErr,
        )
      ) {
        startError('sendOverlayMessage hard fail', { tabId, attempt: i + 1, lastErr })
        throw new Error(lastErr)
      }
    }
    await new Promise((r) => setTimeout(r, 40 + Math.min(i, 10) * 20))
  }
  startError('sendOverlayMessage exhausted', { tabId, type: message.type, lastErr })
  throw new Error(lastErr)
}

async function teardownCaptureStreams(tabId?: number | null) {
  startLog('teardownCaptureStreams', { tabId })
  try {
    await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
  } catch {
    /* ignore */
  }
  await closeOffscreen()
  await closeHudWindow()
  if (tabId != null) await stopOverlay(tabId)
  loomSession = null
  await setRecordingBadge(false)
  await chrome.storage.session.remove('loomRecording')
}

/**
 * Last-resort visible error when the Loom overlay never mounts — otherwise the
 * user only sees Chrome's "Sharing this tab" indicator with no countdown/UI.
 */
async function showOverlayInjectFailureToast(tabId: number, detail: string) {
  const text =
    detail.trim() ||
    'MyPipCam could not show the recording overlay on this page. Reload the extension and try another https tab.'
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (message: string) => {
        const ID = 'mypipcam-overlay-fail-toast'
        document.getElementById(ID)?.remove()
        const el = document.createElement('div')
        el.id = ID
        el.setAttribute('role', 'alert')
        el.textContent = message
        el.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:28px',
          'transform:translateX(-50%)',
          'z-index:2147483647',
          'max-width:min(440px,calc(100vw - 32px))',
          'padding:14px 16px',
          'border-radius:12px',
          'background:rgba(28,12,12,0.96)',
          'border:1px solid rgba(255,120,100,0.5)',
          'color:#ffe8e4',
          'font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif',
          'box-shadow:0 12px 32px rgba(0,0,0,0.45)',
          'text-align:center',
          'pointer-events:auto',
        ].join(';')
        const parent = document.body ?? document.documentElement
        parent.appendChild(el)
        window.setTimeout(() => el.remove(), 14000)
      },
      args: [
        `MyPipCam: recording UI failed to appear. ${text} (Sharing may still show — click Stop sharing in the Chrome toolbar if needed.)`,
      ],
    })
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (message: string) => {
          window.alert(message)
        },
        args: [`MyPipCam: recording UI failed — ${text}`],
      })
    } catch {
      /* page may be restricted */
    }
  }
}

async function stopOverlay(tabId: number | null | undefined) {
  if (tabId == null) return
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PIP_OVERLAY_STOP' })
  } catch {
    /* tab closed or no listener */
  }
}

function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false
  if (!/^https?:/i.test(url)) return false
  try {
    const host = new URL(url).hostname
    if (host === 'chrome.google.com' || host.endsWith('.chrome.google.com')) return false
  } catch {
    return false
  }
  return true
}

function restrictedPageReason(url: string | undefined): string {
  if (!url) {
    return "Can't record this page. Open a normal website tab (https://…) and try again."
  }
  if (/^chrome:\/\//i.test(url) || /^chrome-extension:\/\//i.test(url)) {
    return "Can't record Chrome system pages (chrome://…). Open a normal https website and try again."
  }
  if (/^https?:\/\/chrome\.google\.com\//i.test(url)) {
    return "Can't record the Chrome Web Store or Chrome NTP. Open a normal https website and try again."
  }
  if (/\.pdf($|\?)/i.test(url)) {
    return "Can't record PDF viewer tabs reliably. Open a normal https page and try again."
  }
  return "Can't record this page. Open a normal website tab (https://…) and try again."
}

async function resolveTargetTab(
  explicitTabId?: number,
  opts?: { fallbackToRecentTab?: boolean },
): Promise<
  | { ok: true; tab: chrome.tabs.Tab }
  | { ok: false; reason: string }
> {
  if (explicitTabId != null) {
    try {
      const tab = await chrome.tabs.get(explicitTabId)
      if (tab.id && isInjectableUrl(tab.url)) return { ok: true, tab }
      return { ok: false, reason: restrictedPageReason(tab.url) }
    } catch (err) {
      return {
        ok: false,
        reason: errMessage(err, 'Could not access the selected tab.'),
      }
    }
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (active?.id && isInjectableUrl(active.url)) return { ok: true, tab: active }

  // The advanced recorder calls from its own extension tab, so the active tab
  // is never injectable there — target the most recently used http(s) tab in
  // the window instead. Main record-start must NOT do this: capture targets
  // the active tab, and silently recording a different tab would be wrong.
  if (opts?.fallbackToRecentTab) {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    const recent = tabs
      .filter((t) => t.id != null && t.id !== active?.id && isInjectableUrl(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]
    if (recent) return { ok: true, tab: recent }
  }

  if (active?.url) return { ok: false, reason: restrictedPageReason(active.url) }

  return {
    ok: false,
    reason: "Can't record this page. Open a normal website tab (https://…) and try again.",
  }
}

async function getTabStreamId(tabId: number): Promise<string> {
  try {
    // Promise overload exists at runtime (MV3); @types/chrome still models callback-only.
    const getMediaStreamId = chrome.tabCapture.getMediaStreamId as (options: {
      targetTabId: number
    }) => Promise<string>
    const id = await getMediaStreamId({ targetTabId: tabId })
    if (!id) throw new Error('No tab stream id from tabCapture')
    return id
  } catch (err) {
    const detail = errMessage(err, '')
    // Chrome sometimes surfaces the failure only on lastError when using callbacks;
    // the promise API usually throws with a useful message.
    throw new Error(
      detail ||
        'Tab capture was denied. Click the extension icon on an https tab (user gesture required) and try again.',
    )
  }
}

/**
 * Phase 1 (must stay in the Start user-gesture chain):
 * mint/consume tabCapture streamId → hold MediaStreams in offscreen →
 * inject page PiP bubble + in-page dock + 3→2→1.
 * MediaRecorder starts on LOOM_COUNTDOWN_DONE.
 * HUD popup is fallback only when page overlay injection fails.
 */
async function startLoomRecording(
  explicitTabId?: number,
  options?: {
    recordMode?: RecordMode
    micDeviceId?: string | null
    cameraDeviceId?: string | null
    includeMic?: boolean
    /** Prefer streamId minted in the popup click handler (strongest gesture). */
    streamId?: string | null
  },
): Promise<{
  ok: boolean
  reason?: string
  tabId?: number
  ui?: 'page' | 'hud'
}> {
  if (starting) {
    startWarn('already starting')
    return { ok: false, reason: 'Already starting — wait a moment and try again.' }
  }
  if (loomSession) {
    startWarn('already recording', { tabId: loomSession.tabId })
    return {
      ok: false,
      reason: 'Already recording. Stop the current recording first.',
      tabId: loomSession.tabId,
    }
  }

  starting = true
  startLog('startLoomRecording begin', {
    explicitTabId,
    recordMode: options?.recordMode,
    hasStreamId: Boolean(options?.streamId?.trim()),
  })
  try {
    await persistLastStartError(null)
    const settings = await loadPipSettings()
    const recordMode: RecordMode =
      options?.recordMode ?? settings.recordMode ?? 'screen-cam'
    const micDeviceId =
      options?.micDeviceId !== undefined ? options.micDeviceId : settings.micDeviceId
    const cameraDeviceId =
      options?.cameraDeviceId !== undefined
        ? options.cameraDeviceId
        : settings.cameraDeviceId
    const includeMic = options?.includeMic ?? true

    await savePipSettings({
      recordMode,
      micDeviceId: micDeviceId ?? null,
      cameraDeviceId: cameraDeviceId ?? null,
    })

    const resolved = await resolveTargetTab(explicitTabId)
    if (!resolved.ok) {
      startError('resolveTargetTab failed', resolved.reason)
      await notifyStartFailure(resolved.reason)
      return { ok: false, reason: resolved.reason }
    }
    const tab = resolved.tab
    if (!tab.id) {
      const reason =
        "Can't record this page. Open a normal website tab (https://…) and try again."
      await notifyStartFailure(reason)
      return { ok: false, reason }
    }
    startLog('target tab', { tabId: tab.id, url: tab.url?.slice(0, 120) })

    startLog('ensureOffscreen…')
    await ensureOffscreen()
    startLog('offscreen ready')

    // Consume tabCapture token immediately — it expires in a few seconds and
    // cannot be obtained reliably after the 3s countdown (gesture is gone).
    let streamId: string | undefined
    if (recordMode !== 'cam') {
      try {
        streamId = options?.streamId?.trim() || (await getTabStreamId(tab.id))
        startLog('tabCapture streamId ready', {
          fromPopup: Boolean(options?.streamId?.trim()),
          length: streamId.length,
        })
      } catch (err) {
        const reason = errMessage(
          err,
          'Tab capture failed. Click Start on an https tab and try again.',
        )
        startError('tabCapture failed', reason)
        await closeOffscreen()
        await notifyStartFailure(reason)
        return { ok: false, reason }
      }
    }

    startLog('OFFSCREEN_PREPARE…', {
      recordMode,
      includeMic,
      captureCursor: settings.captureCursor !== false,
      captureQuality: settings.captureQuality,
    })
    const prepareResult = await sendOffscreen<{ ok?: boolean; reason?: string }>({
      type: 'OFFSCREEN_PREPARE',
      streamId,
      includeMic,
      micDeviceId: micDeviceId ?? null,
      cameraDeviceId: cameraDeviceId ?? null,
      recordMode,
      cameraFilter: settings.cameraFilter,
      captureCursor: settings.captureCursor !== false,
      captureQuality: settings.captureQuality,
    })

    if (!prepareResult?.ok) {
      const reason =
        prepareResult?.reason?.trim() ||
        'Could not prepare tab/camera capture in the recorder.'
      startError('OFFSCREEN_PREPARE failed', reason)
      await closeOffscreen()
      await notifyStartFailure(reason)
      return { ok: false, reason }
    }
    startLog('OFFSCREEN_PREPARE ok')

    let ui: 'page' | 'hud' = 'page'
    let pageOverlayOk = false
    try {
      await injectOverlay(tab.id)
      const overlayRes = await sendOverlayMessage<{
        ok?: boolean
        reason?: string
        visible?: boolean
        topLayer?: boolean
        countdownVisible?: boolean
      }>(tab.id, {
        type: 'PIP_OVERLAY_START',
        x: settings.bubbleX,
        y: settings.bubbleY,
        size: settings.bubbleSize,
        mirror: settings.mirror,
        borderColor: settings.borderColor,
        borderWidth: settings.borderWidth,
        shadow: settings.shadow,
        bubbleShape: settings.bubbleShape,
        backgroundEffect: settings.backgroundEffect,
        cameraFilter: settings.cameraFilter,
        mode: 'live',
        recordMode,
        cameraDeviceId: cameraDeviceId ?? null,
        phase: 'countdown',
      })
      startLog('page overlay ready', overlayRes)
      pageOverlayOk = true
    } catch (err) {
      const reason = errMessage(err, 'Could not start camera overlay in this tab.')
      startError('page overlay failed — HUD will drive countdown', reason)
      await showOverlayInjectFailureToast(tab.id, reason)
    }

    // Prefer in-page dock. Separate HUD only if page overlay could not mount.
    let hudOk = false
    if (!pageOverlayOk) {
      const hud = await openRecordingHud({
        driveCountdown: true,
        anchorTabId: tab.id,
        reuse: false,
      })
      hudOk = hud.ok
      if (!hud.ok) {
        await teardownCaptureStreams(tab.id)
        const detail = `Could not show recording UI. ${hud.reason || 'unknown'}`
        await notifyStartFailure(detail)
        return { ok: false, reason: detail }
      }
    } else {
      // Ensure a stale HUD from a prior session is not left open.
      await closeHudWindow()
    }
    ui = pageOverlayOk ? 'page' : 'hud'

    loomSession = {
      tabId: tab.id,
      startedAt: Date.now(),
      recordMode,
      phase: 'countdown',
      micDeviceId: micDeviceId ?? null,
      cameraDeviceId: cameraDeviceId ?? null,
      includeMic,
      prepared: true,
    }
    await persistLoomSession(loomSession, ui)
    await setRecordingBadge(true)
    startLog('session armed', { tabId: tab.id, ui, pageOverlayOk, hudOk })
    // Do NOT focusCapturedTab here — focusing steals focus from the action
    // popup, which destroys it before sendResponse is delivered. The popup then
    // sees a null response and FORCE_STOPs a successful start (zero UI).
    // Popup (or a deferred tick after reply) focuses the tab instead.

    return { ok: true, tabId: tab.id, ui }
  } catch (err) {
    const reason = errMessage(err, 'Failed to start recording')
    startError('startLoomRecording failed', reason, err)
    await teardownCaptureStreams(loomSession?.tabId)
    await notifyStartFailure(reason)
    return { ok: false, reason }
  } finally {
    starting = false
    startLog('startLoomRecording end', { starting: false, hasSession: Boolean(loomSession) })
  }
}

/** Phase 2: countdown finished → start MediaRecorder on already-held streams. */
async function armCaptureAfterCountdown(): Promise<{ ok: boolean; reason?: string }> {
  // Page + HUD may both fire LOOM_COUNTDOWN_DONE (Skip) — tolerate races.
  if (armingCapture) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50))
      const live = (await hydrateLoomSession()) ?? loomSession
      if (live?.phase === 'recording') return { ok: true }
      if (!armingCapture) break
    }
    const live = (await hydrateLoomSession()) ?? loomSession
    if (live?.phase === 'recording') return { ok: true }
    return { ok: false, reason: 'already-arming' }
  }

  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session) return { ok: false, reason: 'no-countdown-session' }
  if (session.phase === 'recording') return { ok: true }
  if (session.phase !== 'countdown') {
    return { ok: false, reason: 'no-countdown-session' }
  }

  armingCapture = true
  try {
    if (!session.prepared) {
      const reason = 'Capture was not armed before countdown. Try Start again.'
      await failCaptureKeepOverlay(session.tabId)
      await syncHud('countdown', reason)
      return { ok: false, reason }
    }

    const startResult = await sendOffscreen<{ ok?: boolean; reason?: string }>({
      type: 'OFFSCREEN_COMMIT',
    })

    if (!startResult?.ok) {
      const detail =
        startResult?.reason?.trim() || 'Could not start MediaRecorder after countdown.'
      await failCaptureKeepOverlay(session.tabId)
      await syncHud('countdown', detail)
      return { ok: false, reason: detail }
    }

    session.phase = 'recording'
    session.startedAt = Date.now()
    await persistLoomSession(session)

    // Retried notify — a single fire-and-forget sendMessage used to drop, and
    // with HUD fallback-only that left users with no Stop/timer dock.
    let dockOk = false
    try {
      const res = await sendOverlayMessage<{
        ok?: boolean
        dockVisible?: boolean
      }>(session.tabId, { type: 'PIP_OVERLAY_RECORDING_STARTED' }, 8)
      dockOk = Boolean(res?.ok && res.dockVisible !== false)
    } catch (err) {
      startWarn(
        'PIP_OVERLAY_RECORDING_STARTED failed',
        errMessage(err, 'overlay notify failed'),
      )
    }
    if (!dockOk) {
      // Last resort: open the separate HUD so Stop is never unreachable.
      startWarn('page dock notify failed — opening fallback HUD')
      await openRecordingHud({
        driveCountdown: false,
        anchorTabId: session.tabId,
        reuse: true,
      })
    }
    await syncHud('recording')

    return { ok: true }
  } catch (err) {
    const reason = errMessage(err, 'Failed to start capture')
    if (session) await failCaptureKeepOverlay(session.tabId)
    else await discardLoomRecording()
    return { ok: false, reason }
  } finally {
    armingCapture = false
  }
}

/** Drop session + offscreen streams but leave the page overlay so it can show the error. */
async function failCaptureKeepOverlay(_tabId: number) {
  loomSession = null
  await chrome.storage.session.remove('loomRecording')
  await setRecordingBadge(false)
  await closeHudWindow()
  try {
    await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
  } catch {
    /* ignore */
  }
  await closeOffscreen()
}

async function stopLoomRecording(opts?: {
  /** Content-script sender tab — used when SW restarted and session was lost. */
  fallbackTabId?: number
}): Promise<{
  ok: boolean
  id?: string
  reason?: string
}> {
  const session = (await hydrateLoomSession()) ?? loomSession
  const tabId =
    session?.tabId ??
    (typeof opts?.fallbackTabId === 'number' ? opts.fallbackTabId : null)

  loomSession = null
  await chrome.storage.session.remove('loomRecording')
  await setRecordingBadge(false)
  // Keep the HUD (often the STOP_LOOM_RECORDING sender) alive until save +
  // navigation finish. Closing it first drops the message port and lets MV3
  // suspend the SW before openLibraryTab runs.

  // Always tear down page chrome first so Stop never leaves a stuck dock/PiP.
  await stopOverlay(tabId)
  // Also try sender tab if it differs (hydrated id stale / wrong).
  if (
    typeof opts?.fallbackTabId === 'number' &&
    opts.fallbackTabId !== tabId
  ) {
    await stopOverlay(opts.fallbackTabId)
  }

  // Countdown cancelled / never committed — nothing to save, but still drop streams.
  if (!session || session.phase === 'countdown') {
    try {
      await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
    } catch {
      /* ignore */
    }
    await closeOffscreen()
    await closeHudWindow()
    return { ok: true }
  }

  try {
    const result = await sendOffscreen<{ ok?: boolean; id?: string; reason?: string }>({
      type: 'OFFSCREEN_STOP',
    })

    // If stop/save failed (e.g. recorder already gone after SW race), still
    // force-discard streams so Chrome's "Sharing…" banner clears.
    if (!result?.ok) {
      try {
        await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
      } catch {
        /* ignore */
      }
      await closeOffscreen()
      await closeHudWindow()
      // Treat empty/not-recording as a soft success after teardown — capture is dead.
      if (
        result?.reason === 'not-recording' ||
        result?.reason === 'empty-recording'
      ) {
        return { ok: true }
      }
      return {
        ok: false,
        reason: result?.reason?.trim() || 'Could not stop recording.',
      }
    }

    await closeOffscreen()

    // Open Library immediately after local save — never wait on Drive.
    // Trim/edit stays available from Library → Edit.
    if (result.id) {
      try {
        await openLibraryTab(result.id)
      } catch (err) {
        console.warn('[MyPipCam] openLibraryTab after stop failed:', err)
      }
    }

    // Upload in the SW after navigation — chrome.identity is reliable here and
    // avoids nested GET_DRIVE_TOKEN during OFFSCREEN_STOP. Fire-and-forget.
    if (result.id && isSafeRecordingId(result.id)) {
      void runDriveAutoUploadById(result.id).catch((err) => {
        console.error('[MyPipCam] Drive auto-upload failed:', err)
      })
    }

    await closeHudWindow()
    return { ok: true, id: result.id }
  } catch (err) {
    try {
      await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
    } catch {
      /* ignore */
    }
    await closeOffscreen()
    await closeHudWindow()
    return {
      ok: false,
      reason: errMessage(err, 'Could not stop recording.'),
    }
  }
}

async function discardLoomRecording(opts?: {
  fallbackTabId?: number
}): Promise<{ ok: boolean; reason?: string }> {
  const session = (await hydrateLoomSession()) ?? loomSession
  const tabId =
    session?.tabId ??
    (typeof opts?.fallbackTabId === 'number' ? opts.fallbackTabId : null)
  loomSession = null
  await chrome.storage.session.remove('loomRecording')
  await setRecordingBadge(false)
  await closeHudWindow()
  await stopOverlay(tabId)
  if (
    typeof opts?.fallbackTabId === 'number' &&
    opts.fallbackTabId !== tabId
  ) {
    await stopOverlay(opts.fallbackTabId)
  }

  try {
    await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
  } catch {
    /* ignore */
  }
  await closeOffscreen()
  return { ok: true }
}

/**
 * Discard the current take (no save), keep the on-page overlay/bubble, re-arm
 * capture, and re-run the countdown → commit pipeline with the same settings.
 */
async function restartLoomRecording(): Promise<{ ok: boolean; reason?: string }> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session) return { ok: false, reason: 'not-recording' }
  if (starting || armingCapture) {
    return { ok: false, reason: 'Already starting — wait a moment and try again.' }
  }

  starting = true
  try {
    // Prefer soft reset (keep streams) so we don't need a new tabCapture gesture.
    let reset = await sendOffscreen<{ ok?: boolean; reason?: string }>({
      type: 'OFFSCREEN_RESET',
    })

    if (!reset?.ok) {
      // Streams died — full re-prepare with the same session settings.
      try {
        await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
      } catch {
        /* ignore */
      }
      await ensureOffscreen()

      let streamId: string | undefined
      if (session.recordMode !== 'cam') {
        try {
          streamId = await getTabStreamId(session.tabId)
        } catch (err) {
          await failCaptureKeepOverlay(session.tabId)
          return {
            ok: false,
            reason: errMessage(
              err,
              'Could not re-capture this tab. Click Restart again or Start from the popup.',
            ),
          }
        }
      }

      const restartSettings = await loadPipSettings()
      reset = await sendOffscreen<{ ok?: boolean; reason?: string }>({
        type: 'OFFSCREEN_PREPARE',
        streamId,
        includeMic: session.includeMic,
        micDeviceId: session.micDeviceId,
        cameraDeviceId: session.cameraDeviceId,
        recordMode: session.recordMode,
        cameraFilter: restartSettings.cameraFilter,
        captureCursor: restartSettings.captureCursor !== false,
        captureQuality: restartSettings.captureQuality,
      })

      if (!reset?.ok) {
        const reason =
          reset?.reason?.trim() ||
          'Could not prepare a new take. Try Start again from the popup.'
        await failCaptureKeepOverlay(session.tabId)
        return { ok: false, reason }
      }
    }

    session.phase = 'countdown'
    session.prepared = true
    session.startedAt = Date.now()
    await persistLoomSession(session)
    await setRecordingBadge(true)

    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'PIP_OVERLAY_RESTART',
      })
    } catch (err) {
      // Page overlay optional — HUD can still drive countdown after restart.
      startWarn('page overlay restart failed', errMessage(err, 'overlay restart failed'))
    }
    await syncHud('countdown')

    return { ok: true }
  } catch (err) {
    const reason = errMessage(err, 'Could not restart recording.')
    if (loomSession) await failCaptureKeepOverlay(loomSession.tabId)
    return { ok: false, reason }
  } finally {
    starting = false
  }
}

async function pauseLoomRecording(): Promise<{ ok: boolean; reason?: string }> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session || (session.phase !== 'recording' && session.phase !== 'paused')) {
    return { ok: false, reason: 'not-recording' }
  }
  if (session.phase === 'paused') return { ok: true }

  await ensureOffscreen()
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_PAUSE',
  })
  if (res?.ok) {
    session.phase = 'paused'
    loomSession = session
    try {
      await persistLoomSession(session)
    } catch {
      /* ignore */
    }
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'PIP_OVERLAY_PAUSED',
        paused: true,
      })
    } catch {
      /* ignore */
    }
    await syncHud('paused')
    return { ok: true }
  }
  return { ok: false, reason: res?.reason || 'pause-failed' }
}

async function resumeLoomRecording(): Promise<{ ok: boolean; reason?: string }> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session || (session.phase !== 'recording' && session.phase !== 'paused')) {
    return { ok: false, reason: 'not-recording' }
  }

  await ensureOffscreen()
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_RESUME',
  })
  if (res?.ok) {
    session.phase = 'recording'
    loomSession = session
    try {
      await persistLoomSession(session)
    } catch {
      /* ignore */
    }
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'PIP_OVERLAY_PAUSED',
        paused: false,
      })
    } catch {
      /* ignore */
    }
    await syncHud('recording')
    return { ok: true }
  }
  return { ok: false, reason: res?.reason || 'resume-failed' }
}

/** Pause and open mid-take rewind & trim (Loom punch-in), not stop→editor. */
async function beginLoomRewind(): Promise<{
  ok: boolean
  durationMs?: number
  previewBlob?: Blob
  reason?: string
}> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session || (session.phase !== 'recording' && session.phase !== 'paused')) {
    return { ok: false, reason: 'not-recording' }
  }

  await ensureOffscreen()
  const res = await sendOffscreen<{
    ok?: boolean
    durationMs?: number
    previewBlob?: Blob
    reason?: string
  }>({ type: 'OFFSCREEN_REWIND_BEGIN' })

  if (!res?.ok) {
    return { ok: false, reason: res?.reason || 'Could not open rewind.' }
  }

  session.phase = 'paused'
  loomSession = session
  try {
    await persistLoomSession(session)
  } catch {
    /* ignore */
  }
  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: 'PIP_OVERLAY_PAUSED',
      paused: true,
    })
  } catch {
    /* ignore */
  }
  await syncHud('paused')
  return {
    ok: true,
    durationMs: res.durationMs,
    previewBlob: res.previewBlob,
  }
}

async function applyLoomRewind(keepMs: number): Promise<{
  ok: boolean
  durationMs?: number
  reason?: string
}> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session || (session.phase !== 'recording' && session.phase !== 'paused')) {
    return { ok: false, reason: 'not-recording' }
  }

  await ensureOffscreen()
  const res = await sendOffscreen<{
    ok?: boolean
    durationMs?: number
    reason?: string
  }>({ type: 'OFFSCREEN_REWIND_APPLY', keepMs })

  if (!res?.ok) {
    return { ok: false, reason: res?.reason || 'Could not trim take.' }
  }

  session.phase = 'recording'
  loomSession = session
  try {
    await persistLoomSession(session)
  } catch {
    /* ignore */
  }
  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: 'PIP_OVERLAY_REWIND_APPLIED',
      durationMs: res.durationMs ?? keepMs,
    })
  } catch {
    /* ignore */
  }
  await syncHud('recording')
  return { ok: true, durationMs: res.durationMs }
}

async function cancelLoomRewind(): Promise<{ ok: boolean; reason?: string }> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session) return { ok: false, reason: 'not-recording' }

  await ensureOffscreen()
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_REWIND_CANCEL',
  })
  if (!res?.ok) {
    return { ok: false, reason: res?.reason || 'Could not cancel rewind.' }
  }

  session.phase = 'recording'
  loomSession = session
  try {
    await persistLoomSession(session)
  } catch {
    /* ignore */
  }
  try {
    await chrome.tabs.sendMessage(session.tabId, {
      type: 'PIP_OVERLAY_PAUSED',
      paused: false,
    })
  } catch {
    /* ignore */
  }
  await syncHud('recording')
  return { ok: true }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-recording') return
  const session = (await hydrateLoomSession()) ?? loomSession
  if (session) {
    if (session.phase === 'countdown') {
      await discardLoomRecording()
      return
    }
    await stopLoomRecording()
    return
  }
  const result = await startLoomRecording()
  if (result.ok && typeof result.tabId === 'number') {
    await focusCapturedTabOnly(result.tabId)
  }
})

chrome.windows.onRemoved.addListener((windowId) => {
  if (hudWindowId !== windowId) return
  hudWindowId = null
  // Do not auto-reopen the separate HUD — in-page dock is the default UI.
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === hudTabId) {
    hudTabId = null
    // Fallback HUD tab closed — page dock (if any) remains the primary UI.
  }
  // Hydrate first: after an MV3 SW restart the in-memory session is gone
  // while offscreen capture for the closed tab may still be live, which left
  // the badge on REC and the offscreen document running with no way to stop.
  void (async () => {
    const session = (await hydrateLoomSession()) ?? loomSession
    if (session?.tabId === tabId) {
      await discardLoomRecording()
    }
  })()
})

/**
 * Library Settings opens this port for the duration of Connect Google so the
 * MV3 service worker is not killed while chrome.identity.getAuthToken waits
 * on the consent UI (often 30–120s).
 */
/** Tab currently showing the popup dim scrim (cleared on port disconnect). */
let popupDimTabId: number | null = null

async function setPopupPageDim(tabId: number, visible: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: applyPopupPageDim,
      args: [visible],
    })
  } catch {
    // Restricted pages (chrome://, Web Store, etc.) cannot be scripted — ignore.
  }
}

async function showPopupPageDimForActiveTab(): Promise<void> {
  const session = await hydrateLoomSession()
  if (session) return

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const url = tab?.url ?? ''
    if (!tab?.id || !/^https?:/i.test(url)) return
    popupDimTabId = tab.id
    await setPopupPageDim(tab.id, true)
  } catch {
    /* ignore */
  }
}

async function clearPopupPageDim(): Promise<void> {
  const tabId = popupDimTabId
  popupDimTabId = null
  if (tabId == null) return
  await setPopupPageDim(tabId, false)
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'drive-connect') {
    // Holding the port open is enough; ignore payload noise.
    port.onMessage.addListener(() => {})
    return
  }

  if (port.name !== 'popup-dim') return

  void showPopupPageDimForActiveTab()
  port.onDisconnect.addListener(() => {
    void clearPopupPageDim()
  })
})

// Periodic backlog drain — covers cases where the post-stop kick was missed.
try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'mypipcam-sw-keepalive') return
    void runPendingDriveAutoUploads().catch((err) => {
      console.warn('[MyPipCam] pending Drive auto-upload flush failed:', err)
    })
  })
} catch {
  /* alarms permission missing in unexpected builds */
}

function replySafe(
  sendResponse: (response: unknown) => void,
  payload: unknown,
): void {
  try {
    sendResponse(payload)
  } catch (err) {
    console.warn('[MyPipCam] sendResponse failed (message port closed):', err)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    return dispatchExtensionMessage(message, sender, sendResponse)
  } catch (err) {
    console.error('[MyPipCam] onMessage dispatch crashed:', err)
    replySafe(sendResponse, {
      ok: false,
      reason: errMessage(err, 'Background handler crashed'),
      error: errMessage(err, 'Background handler crashed'),
    })
    return false
  }
})

const OPEN_LIBRARY_BRIDGE_ORIGIN = 'https://mypipcam.earnyour.com'

/**
 * macOS “Open in Chrome…” lands on mypipcam.earnyour.com/open-library, which
 * messages us so we open Library with chrome.tabs.create (popup path). Direct
 * chrome-extension:// opens are often ERR_BLOCKED_BY_CLIENT under ad blockers.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  try {
    let origin = ''
    if (sender.url) {
      try {
        origin = new URL(sender.url).origin
      } catch {
        origin = ''
      }
    }
    if (origin !== OPEN_LIBRARY_BRIDGE_ORIGIN) {
      replySafe(sendResponse, { ok: false, error: 'forbidden-origin' })
      return false
    }
    if (message?.type !== 'OPEN_LIBRARY') {
      replySafe(sendResponse, { ok: false, error: 'unknown-type' })
      return false
    }

    const rawId = typeof message.id === 'string' ? message.id.trim() : ''
    if (rawId && !isSafeRecordingId(rawId)) {
      replySafe(sendResponse, { ok: false, error: 'invalid-id' })
      return false
    }

    void (async () => {
      try {
        await openLibraryTab(rawId || undefined)
        replySafe(sendResponse, { ok: true })
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          error: errMessage(err, 'Could not open library'),
        })
      }
    })()
    return true
  } catch (err) {
    console.error('[MyPipCam] onMessageExternal crashed:', err)
    replySafe(sendResponse, {
      ok: false,
      error: errMessage(err, 'External handler crashed'),
    })
    return false
  }
})

function dispatchExtensionMessage(
  message: Record<string, any>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  // Offscreen-targeted messages are handled by the offscreen document only.
  if (message?.target === 'offscreen') return false

  // Extension pages (library Settings), content scripts, and SW-internal
  // messages share chrome.runtime.id — all must be allowed for CONNECT_GOOGLE.
  if (!isTrustedExtensionSender(sender)) {
    replySafe(sendResponse, {
      ok: false,
      reason: 'untrusted-sender',
      error: 'Untrusted sender — reload MyPipCam from apps/extension/dist on chrome://extensions.',
    })
    return false
  }

  // PING / GET_SW_HEALTH answered by boot index.ts — do not double-reply.
  if (message?.type === 'PING' || message?.type === 'GET_SW_HEALTH') {
    return false
  }

  if (message?.type === 'REGISTER_PIP_CHANNEL') {
    // Only tab content scripts may mint camera-channel tokens (not WAR iframes).
    if (!isContentScriptSender(sender) || !isPipChannelToken(message.token)) {
      sendResponse({ ok: false, reason: 'invalid-pip-channel' })
      return false
    }
    void (async () => {
      try {
        await registerPipChannelToken(message.token)
        sendResponse({ ok: true })
      } catch (err) {
        console.error('[MyPipCam] REGISTER_PIP_CHANNEL failed:', err)
        sendResponse({ ok: false, reason: 'register-failed' })
      }
    })()
    return true
  }

  if (message?.type === 'REVOKE_PIP_CHANNEL') {
    // Same gate as REGISTER: only the content script that minted a token may
    // revoke it — a WAR iframe must not be able to kill another tab's channel.
    if (!isContentScriptSender(sender) || !isPipChannelToken(message.token)) {
      sendResponse({ ok: false, reason: 'invalid-pip-channel' })
      return false
    }
    void (async () => {
      await revokePipChannelToken(message.token)
      sendResponse({ ok: true })
    })()
    return true
  }

  if (message?.type === 'VALIDATE_PIP_CHANNEL') {
    // PiP iframe asks before getUserMedia. Token is the primary gate; URL check
    // is defense-in-depth when Chrome provides sender.url (sometimes omitted).
    if (!isPipChannelToken(message.token)) {
      sendResponse({ ok: false })
      return false
    }
    const url = sender.url ?? ''
    if (url && !isPipFrameSender(sender)) {
      sendResponse({ ok: false })
      return false
    }
    void (async () => {
      sendResponse({ ok: await validatePipChannelToken(message.token) })
    })()
    return true
  }

  if (message?.type === 'LIST_MIC_DEVICES') {
    void (async () => {
      try {
        const result = await listMicrophones()
        sendResponse(result)
      } catch (err) {
        sendResponse({
          ok: false,
          devices: [],
          reason: errMessage(err, 'Could not list microphones'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'ENSURE_MIC_ACCESS') {
    void (async () => {
      try {
        const result = await ensureMicrophoneAccess()
        sendResponse(result)
      } catch (err) {
        sendResponse({
          ok: false,
          reason: errMessage(err, 'Microphone permission failed'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'DRIVE_AUTO_UPLOAD') {
    void (async () => {
      const id = typeof message.id === 'string' ? message.id : ''
      if (!isSafeRecordingId(id)) {
        replySafe(sendResponse, { ok: false, reason: 'invalid-id' })
        return
      }
      try {
        const result = await runDriveAutoUploadById(id)
        replySafe(sendResponse, { ok: true, ...result })
      } catch (err) {
        console.error('[MyPipCam] DRIVE_AUTO_UPLOAD failed:', err)
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Drive auto-upload failed'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'GET_DRIVE_TOKEN') {
    void (async () => {
      try {
        const token = await getAccessTokenDirect(Boolean(message.interactive))
        sendResponse({ ok: true, token })
      } catch (err) {
        const raw = errMessage(err, 'Could not get Google auth token')
        console.error('[MyPipCam] GET_DRIVE_TOKEN failed:', raw, err)
        sendResponse({
          ok: false,
          error: explainDriveAuthError(
            raw,
            err instanceof DriveAuthError ? err.code : undefined,
          ),
          code: err instanceof DriveAuthError ? err.code : undefined,
        })
      }
    })()
    return true
  }

  if (message?.type === 'INVALIDATE_DRIVE_TOKEN') {
    void (async () => {
      try {
        const token = typeof message.token === 'string' ? message.token : ''
        if (token) await invalidateAccessTokenDirect(token)
        sendResponse({ ok: true })
      } catch (err) {
        sendResponse({
          ok: false,
          error: errMessage(err, 'Could not invalidate token'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'CLEAR_DRIVE_AUTH') {
    void (async () => {
      try {
        await clearDriveAuthDirect()
        sendResponse({ ok: true })
      } catch (err) {
        sendResponse({
          ok: false,
          error: errMessage(err, 'Could not clear Google auth'),
          code: err instanceof DriveAuthError ? err.code : undefined,
        })
      }
    })()
    return true
  }

  if (message?.type === 'HAS_DRIVE_AUTH') {
    void (async () => {
      try {
        sendResponse({ ok: true, value: await hasDriveAuthDirect() })
      } catch {
        sendResponse({ ok: true, value: false })
      }
    })()
    return true
  }

  if (message?.type === 'CONNECT_GOOGLE') {
    // Start interactive getAuthToken in the sync listener body so Chrome still
    // treats this as a user-gesture continuation from Settings → sendMessage.
    // Always return true + always reply (success, OAuth error, or timeout).
    const authPromise = getAccessTokenDirect(true)
    void (async () => {
      try {
        const status = await connectGoogleDriveInBackground(authPromise)
        replySafe(sendResponse, { ok: true, status })
      } catch (err) {
        const raw = errMessage(err, 'Could not connect Google Drive')
        console.error('[MyPipCam] CONNECT_GOOGLE failed:', raw, err)
        replySafe(sendResponse, {
          ok: false,
          error: explainDriveAuthError(
            raw,
            err instanceof DriveAuthError ? err.code : undefined,
          ),
          code: err instanceof DriveAuthError ? err.code : undefined,
        })
      }
    })()
    return true
  }

  if (message?.type === 'OPEN_LIBRARY') {
    void (async () => {
      const id =
        message.id != null && isSafeRecordingId(message.id) ? message.id : undefined
      await openLibraryTab(id)
      sendResponse({ ok: true })
    })()
    return true
  }

  if (message?.type === 'OPEN_RECORDER') {
    void (async () => {
      await openRecorderTab()
      sendResponse({ ok: true })
    })()
    return true
  }

  if (message?.type === 'START_LOOM_RECORDING') {
    void (async () => {
      try {
        const tabId =
          typeof message.tabId === 'number' ? message.tabId : sender.tab?.id
        startLog('START_LOOM_RECORDING message', { tabId, hasStreamId: Boolean(message.streamId) })
        const result = await startLoomRecording(tabId, {
          recordMode: message.recordMode,
          micDeviceId: message.micDeviceId,
          cameraDeviceId: message.cameraDeviceId,
          includeMic: message.includeMic,
          streamId: typeof message.streamId === 'string' ? message.streamId : null,
        })
        if (!result.ok) {
          startError('START_LOOM_RECORDING failed:', result.reason)
        } else {
          startLog('START_LOOM_RECORDING ok', result)
          // After reply: focus the captured tab so the in-page dock is visible.
          if (typeof result.tabId === 'number') {
            const focusTabId = result.tabId
            setTimeout(() => {
              void focusCapturedTabOnly(focusTabId)
            }, 50)
          }
        }
        sendResponse(result)
      } catch (err) {
        const reason = errMessage(err, 'Failed to start recording')
        startError('START_LOOM_RECORDING threw:', reason, err)
        await notifyStartFailure(reason)
        sendResponse({
          ok: false,
          reason,
        })
      }
    })()
    return true
  }

  if (message?.type === 'FOCUS_CAPTURED_TAB') {
    void (async () => {
      const tabId =
        typeof message.tabId === 'number' ? message.tabId : loomSession?.tabId
      if (typeof tabId === 'number') {
        startLog('FOCUS_CAPTURED_TAB', { tabId })
        await focusCapturedTabOnly(tabId)
      }
      sendResponse({ ok: true })
    })()
    return true
  }

  // Optional fallback only — happy path uses the in-page dock (default OFF).
  if (message?.type === 'ENSURE_RECORDING_HUD') {
    void (async () => {
      const session = (await hydrateLoomSession()) ?? loomSession
      if (!session) {
        sendResponse({ ok: false, reason: 'not-recording' })
        return
      }
      // Prefer page dock; only open HUD if overlay/dock chrome is missing.
      try {
        const status = (await chrome.tabs.sendMessage(session.tabId, {
          type: 'PIP_OVERLAY_STATUS',
        })) as {
          ok?: boolean
          visible?: boolean
          dockVisible?: boolean
          countdownVisible?: boolean
          phase?: string
        }
        const hostUp = Boolean(status?.ok || status?.visible)
        const hasCountdown = Boolean(status?.countdownVisible)
        const hasDock = Boolean(status?.dockVisible)
        if (hostUp && (hasDock || hasCountdown)) {
          sendResponse({ ok: true, ui: 'page' })
          return
        }
        if (hostUp && !hasDock && session.phase !== 'countdown') {
          startWarn('ENSURE_RECORDING_HUD: host up but dock not visible')
        }
      } catch {
        /* overlay missing — fall through to HUD */
      }
      const hud = await openRecordingHud({
        driveCountdown: hudDriveCountdown || session.phase === 'countdown',
        anchorTabId: session.tabId,
        reuse: true,
      })
      if (hud.ok) {
        await syncHud(
          session.phase === 'countdown'
            ? 'countdown'
            : session.phase === 'paused'
              ? 'paused'
              : 'recording',
        )
      }
      sendResponse(hud)
    })()
    return true
  }

  if (message?.type === 'GET_LAST_START_ERROR') {
    void (async () => {
      try {
        const stored = await chrome.storage.session.get('lastStartError')
        sendResponse({ ok: true, error: stored.lastStartError ?? null })
      } catch {
        sendResponse({ ok: true, error: null })
      }
    })()
    return true
  }

  if (message?.type === 'CLEAR_LAST_START_ERROR') {
    void (async () => {
      await persistLastStartError(null)
      sendResponse({ ok: true })
    })()
    return true
  }

  if (message?.type === 'LOOM_COUNTDOWN_DONE') {
    void (async () => {
      const result = await armCaptureAfterCountdown()
      if (!result.ok) {
        console.error('[MyPipCam] countdown→capture failed:', result.reason)
      }
      sendResponse(result)
    })()
    return true
  }

  if (message?.type === 'STOP_LOOM_RECORDING') {
    void (async () => {
      try {
        const result = await stopLoomRecording({
          fallbackTabId: sender.tab?.id,
        })
        replySafe(sendResponse, result)
      } catch (err) {
        // Last-resort teardown so Stop never leaves capture hanging.
        try {
          await teardownCaptureStreams(sender.tab?.id ?? null)
        } catch {
          /* ignore */
        }
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not stop recording.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'PAUSE_LOOM_RECORDING') {
    void (async () => {
      try {
        replySafe(sendResponse, await pauseLoomRecording())
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not pause recording.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'RESUME_LOOM_RECORDING') {
    void (async () => {
      try {
        replySafe(sendResponse, await resumeLoomRecording())
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not resume recording.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'BEGIN_LOOM_REWIND') {
    void (async () => {
      try {
        replySafe(sendResponse, await beginLoomRewind())
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not open rewind.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'APPLY_LOOM_REWIND') {
    void (async () => {
      try {
        const keepMs = Number(message.keepMs)
        replySafe(sendResponse, await applyLoomRewind(keepMs))
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not trim take.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'CANCEL_LOOM_REWIND') {
    void (async () => {
      try {
        replySafe(sendResponse, await cancelLoomRewind())
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not cancel rewind.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'DISCARD_LOOM_RECORDING') {
    void (async () => {
      sendResponse(
        await discardLoomRecording({ fallbackTabId: sender.tab?.id }),
      )
    })()
    return true
  }

  if (message?.type === 'RESTART_LOOM_RECORDING') {
    void (async () => {
      try {
        const result = await restartLoomRecording()
        if (!result.ok) {
          console.error('[MyPipCam] RESTART_LOOM_RECORDING failed:', result.reason)
        }
        sendResponse(result)
      } catch (err) {
        sendResponse({
          ok: false,
          reason: errMessage(err, 'Could not restart recording.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'GET_LOOM_STATUS') {
    void (async () => {
      const session = (await hydrateLoomSession()) ?? loomSession
      sendResponse({
        recording: Boolean(session),
        phase: session?.phase ?? null,
        tabId: session?.tabId ?? null,
        startedAt: session?.startedAt ?? null,
        recordMode: session?.recordMode ?? null,
      })
    })()
    return true
  }

  if (message?.type === 'LOOM_BUBBLE_MOVED') {
    if (!isContentScriptSender(sender)) {
      sendResponse({ ok: false, reason: 'untrusted-sender' })
      return false
    }
    const patch: {
      bubbleX?: number
      bubbleY?: number
      bubbleSize?: number
    } = {}
    if (typeof message.x === 'number' && Number.isFinite(message.x)) patch.bubbleX = message.x
    if (typeof message.y === 'number' && Number.isFinite(message.y)) patch.bubbleY = message.y
    if (typeof message.size === 'number' && Number.isFinite(message.size)) {
      patch.bubbleSize = message.size
    }
    if (Object.keys(patch).length > 0) void savePipSettings(patch)
    sendResponse({ ok: true })
    return false
  }

  if (message?.type === 'LOOM_BUBBLE_SHAPE') {
    if (!isContentScriptSender(sender)) {
      sendResponse({ ok: false, reason: 'untrusted-sender' })
      return false
    }
    const bubbleShape = message.bubbleShape === 'square' ? 'square' : 'circle'
    void (async () => {
      await savePipSettings({ bubbleShape })
      const session = (await hydrateLoomSession()) ?? loomSession
      if (session?.tabId) {
        try {
          await chrome.tabs.sendMessage(session.tabId, {
            type: 'PIP_OVERLAY_UPDATE',
            bubbleShape,
          })
        } catch {
          /* overlay may be gone */
        }
      }
      sendResponse({ ok: true })
    })()
    return true
  }

  if (message?.type === 'LOOM_BUBBLE_EFFECT') {
    if (!isContentScriptSender(sender)) {
      sendResponse({ ok: false, reason: 'untrusted-sender' })
      return false
    }
    const backgroundEffect = message.backgroundEffect === 'blur' ? 'blur' : 'none'
    void (async () => {
      await savePipSettings({ backgroundEffect })
      const session = (await hydrateLoomSession()) ?? loomSession
      if (session?.tabId) {
        try {
          await chrome.tabs.sendMessage(session.tabId, {
            type: 'PIP_OVERLAY_UPDATE',
            backgroundEffect,
          })
        } catch {
          /* overlay may be gone */
        }
      }
      sendResponse({ ok: true })
    })()
    return true
  }

  if (message?.type === 'LOOM_BUBBLE_FILTER') {
    if (!isContentScriptSender(sender)) {
      sendResponse({ ok: false, reason: 'untrusted-sender' })
      return false
    }
    const cameraFilter = normalizeCameraFilter(message.cameraFilter)
    void (async () => {
      await savePipSettings({ cameraFilter })
      const session = (await hydrateLoomSession()) ?? loomSession
      if (session?.tabId) {
        try {
          await chrome.tabs.sendMessage(session.tabId, {
            type: 'PIP_OVERLAY_UPDATE',
            cameraFilter,
          })
        } catch {
          /* overlay may be gone */
        }
      }
      sendResponse({ ok: true, cameraFilter })
    })()
    return true
  }

  if (message?.type === 'LOOM_BUBBLE_BORDER') {
    const patch: {
      borderColor?: string
      borderWidth?: number
      shadow?: boolean
      mirror?: boolean
    } = {}
    if (message.borderColor != null) {
      patch.borderColor = sanitizeCssColor(message.borderColor)
    }
    if (typeof message.borderWidth === 'number' && Number.isFinite(message.borderWidth)) {
      patch.borderWidth = normalizeBorderWidth(message.borderWidth)
    }
    if (typeof message.shadow === 'boolean') patch.shadow = message.shadow
    if (typeof message.mirror === 'boolean') patch.mirror = message.mirror
    void (async () => {
      if (Object.keys(patch).length > 0) await savePipSettings(patch)
      const session = (await hydrateLoomSession()) ?? loomSession
      if (session?.tabId && Object.keys(patch).length > 0) {
        try {
          await chrome.tabs.sendMessage(session.tabId, {
            type: 'PIP_OVERLAY_UPDATE',
            ...patch,
          })
        } catch {
          /* overlay may be gone */
        }
      }
      sendResponse({ ok: true, ...patch })
    })()
    return true
  }

  if (message?.type === 'LOOM_TAB_ENDED') {
    void stopLoomRecording()
    sendResponse({ ok: true })
    return false
  }

  // Legacy messages kept for advanced recorder window path
  if (message?.type === 'START_TAB_OVERLAY') {
    void (async () => {
      let toastTabId: number | undefined
      try {
        const resolved = await resolveTargetTab(message.tabId, {
          fallbackToRecentTab: true,
        })
        if (!resolved.ok || !resolved.tab.id) {
          sendResponse({ ok: false, reason: resolved.ok ? 'no-tab' : resolved.reason })
          return
        }
        toastTabId = resolved.tab.id
        try {
          await injectOverlay(resolved.tab.id)
        } catch {
          /* may already be injected */
        }
        await sendOverlayMessage(resolved.tab.id, {
          type: 'PIP_OVERLAY_START',
          x: message.x,
          y: message.y,
          size: message.size,
          mirror: message.mirror,
          borderColor: sanitizeCssColor(message.borderColor),
          borderWidth: normalizeBorderWidth(message.borderWidth),
          shadow: message.shadow,
          bubbleShape: message.bubbleShape,
          backgroundEffect: message.backgroundEffect,
          cameraFilter: normalizeCameraFilter(message.cameraFilter),
          mode: 'guide',
          recordMode: 'screen-cam',
          phase: 'recording',
        })
        sendResponse({ ok: true, tabId: resolved.tab.id })
      } catch (err) {
        const reason = errMessage(err, 'inject-failed')
        if (toastTabId != null) {
          await showOverlayInjectFailureToast(toastTabId, reason)
        }
        sendResponse({
          ok: false,
          reason,
        })
      }
    })()
    return true
  }

  if (message?.type === 'UPDATE_TAB_OVERLAY') {
    void (async () => {
      const tabId = message.tabId as number | undefined
      if (!tabId) {
        sendResponse({ ok: false })
        return
      }
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'PIP_OVERLAY_UPDATE',
          x: message.x,
          y: message.y,
          size: message.size,
          mirror: message.mirror,
          borderColor: sanitizeCssColor(message.borderColor),
          borderWidth:
            typeof message.borderWidth === 'number'
              ? normalizeBorderWidth(message.borderWidth)
              : undefined,
          shadow: message.shadow,
          bubbleShape: message.bubbleShape,
          backgroundEffect: message.backgroundEffect,
          cameraFilter: message.cameraFilter,
        })
        sendResponse({ ok: true })
      } catch {
        sendResponse({ ok: false })
      }
    })()
    return true
  }

  if (message?.type === 'STOP_TAB_OVERLAY') {
    void (async () => {
      await stopOverlay(message.tabId as number | undefined)
      sendResponse({ ok: true })
    })()
    return true
  }

  /**
   * Popup / Settings emergency stop: drop overlay + offscreen so Chrome's
   * "Sharing … to MyPipCam" banner clears when start partially succeeded.
   */
  if (message?.type === 'FORCE_STOP_CAPTURE') {
    void (async () => {
      try {
        const hydrated = await hydrateLoomSession()
        startLog('FORCE_STOP_CAPTURE', {
          tabId: message.tabId,
          hasSession: Boolean(hydrated ?? loomSession),
        })
        const tabId =
          typeof message.tabId === 'number'
            ? message.tabId
            : hydrated?.tabId ?? loomSession?.tabId ?? sender.tab?.id ?? null
        loomSession = null
        await chrome.storage.session.remove('loomRecording')
        await setRecordingBadge(false)
        await stopOverlay(tabId)
        if (typeof sender.tab?.id === 'number' && sender.tab.id !== tabId) {
          await stopOverlay(sender.tab.id)
        }
        await teardownCaptureStreams(tabId)
        replySafe(sendResponse, { ok: true })
      } catch (err) {
        replySafe(sendResponse, {
          ok: false,
          reason: errMessage(err, 'Could not stop capture'),
        })
      }
    })()
    return true
  }

  return false
}
