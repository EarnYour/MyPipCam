import pipOverlayScript from '../content/pipOverlay.ts?script'
import {
  clearDriveAuthDirect,
  DriveAuthError,
  explainDriveAuthError,
  getAccessTokenDirect,
  hasDriveAuthDirect,
  invalidateAccessTokenDirect,
} from '../shared/driveAuth'
import { connectGoogleDriveInBackground } from '../shared/driveSync'
import { loadPipSettings, savePipSettings } from '../shared/settings'
import { openEditorTab, openLibraryTab, openRecorderTab } from '../shared/navigation'
import {
  isContentScriptSender,
  isPipChannelToken,
  isPipFrameSender,
  isSafeRecordingId,
  isTrustedExtensionSender,
  sanitizeCssColor,
} from '../shared/security'
import type { RecordMode } from '../shared/types'

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

type LoomSession = {
  tabId: number
  startedAt: number
  recordMode: RecordMode
  phase: 'countdown' | 'recording'
  micDeviceId: string | null
  cameraDeviceId: string | null
  includeMic: boolean
  /** True once offscreen has consumed tabCapture / cam streams. */
  prepared: boolean
}

let loomSession: LoomSession | null = null
let starting = false
let armingCapture = false
/** Fallback extension window when page overlay inject/visibility fails. */
let hudWindowId: number | null = null

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
      phase: rec.phase === 'recording' ? 'recording' : 'countdown',
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
  if (hudWindowId == null) return
  const id = hudWindowId
  hudWindowId = null
  try {
    await chrome.windows.remove(id)
  } catch {
    /* already closed */
  }
}

async function openFallbackHud(): Promise<{ ok: boolean; reason?: string }> {
  await closeHudWindow()
  try {
    const win = await chrome.windows.create({
      url: 'src/hud/index.html',
      type: 'popup',
      width: 300,
      height: 260,
      focused: true,
    })
    hudWindowId = typeof win?.id === 'number' ? win.id : null
    startLog('fallback HUD opened', { windowId: hudWindowId })
    return { ok: hudWindowId != null }
  } catch (err) {
    const reason = errMessage(err, 'Could not open fallback recording controls')
    startError('fallback HUD failed', reason)
    return { ok: false, reason }
  }
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
  startLog('injectOverlay', { tabId, script: pipOverlayScript })
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [pipOverlayScript],
  })
  startLog('injectOverlay executeScript resolved', { tabId })
}

/**
 * CRX content scripts load via async dynamic import(). executeScript resolves
 * before onMessage is registered — retry until the overlay listener answers.
 */
async function sendOverlayMessage<T extends { ok?: boolean; reason?: string }>(
  tabId: number,
  message: Record<string, unknown>,
  attempts = 30,
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
 * inject overlay + 3→2→1. MediaRecorder starts on LOOM_COUNTDOWN_DONE.
 * If page overlay is invisible/unreachable, open a fallback HUD window and
 * keep capture armed (never leave orphaned "Sharing…" with zero UI).
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

    startLog('OFFSCREEN_PREPARE…', { recordMode, includeMic })
    const prepareResult = await sendOffscreen<{ ok?: boolean; reason?: string }>({
      type: 'OFFSCREEN_PREPARE',
      streamId,
      includeMic,
      micDeviceId: micDeviceId ?? null,
      cameraDeviceId: cameraDeviceId ?? null,
      recordMode,
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
        shadow: settings.shadow,
        bubbleShape: settings.bubbleShape,
        backgroundEffect: settings.backgroundEffect,
        mode: 'live',
        recordMode,
        cameraDeviceId: cameraDeviceId ?? null,
        phase: 'countdown',
      })
      startLog('page overlay ready', overlayRes)
    } catch (err) {
      const reason = errMessage(err, 'Could not start camera overlay in this tab.')
      startError('page overlay failed — trying HUD fallback', reason)
      await showOverlayInjectFailureToast(tab.id, reason)
      const hud = await openFallbackHud()
      if (!hud.ok) {
        await teardownCaptureStreams(tab.id)
        const detail = `${reason} Fallback controls also failed: ${hud.reason || 'unknown'}`
        await notifyStartFailure(detail)
        // Do not focusCapturedTab here — that closes the popup before it can show the error.
        return { ok: false, reason: detail }
      }
      ui = 'hud'
    }

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
    startLog('session armed', { tabId: tab.id, ui })
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
  if (armingCapture) return { ok: false, reason: 'already-arming' }
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session || session.phase !== 'countdown') {
    return { ok: false, reason: 'no-countdown-session' }
  }

  armingCapture = true
  try {
    if (!session.prepared) {
      const reason = 'Capture was not armed before countdown. Try Start again.'
      await failCaptureKeepOverlay(session.tabId)
      return { ok: false, reason }
    }

    const startResult = await sendOffscreen<{ ok?: boolean; reason?: string }>({
      type: 'OFFSCREEN_COMMIT',
    })

    if (!startResult?.ok) {
      const detail =
        startResult?.reason?.trim() || 'Could not start MediaRecorder after countdown.'
      await failCaptureKeepOverlay(session.tabId)
      return { ok: false, reason: detail }
    }

    session.phase = 'recording'
    session.startedAt = Date.now()
    await persistLoomSession(session)

    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'PIP_OVERLAY_RECORDING_STARTED',
      })
    } catch {
      /* overlay may have been removed */
    }

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
  openEditor?: boolean
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
  await closeHudWindow()

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

    if (result.id && opts?.openEditor) {
      try {
        await openEditorTab(result.id, 'trim')
      } catch {
        await openLibraryTab(result.id)
      }
    } else {
      const settings = await loadPipSettings()
      if (settings.openLibraryOnFinish && result.id) {
        await openLibraryTab(result.id)
      }
    }

    return { ok: true, id: result.id }
  } catch (err) {
    try {
      await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
    } catch {
      /* ignore */
    }
    await closeOffscreen()
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

      reset = await sendOffscreen<{ ok?: boolean; reason?: string }>({
        type: 'OFFSCREEN_PREPARE',
        streamId,
        includeMic: session.includeMic,
        micDeviceId: session.micDeviceId,
        cameraDeviceId: session.cameraDeviceId,
        recordMode: session.recordMode,
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
      await failCaptureKeepOverlay(session.tabId)
      return {
        ok: false,
        reason: errMessage(err, 'Could not reset the recording overlay.'),
      }
    }

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
  if (!session || session.phase !== 'recording') {
    return { ok: false, reason: 'not-recording' }
  }
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_PAUSE',
  })
  if (res?.ok) {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'PIP_OVERLAY_PAUSED',
        paused: true,
      })
    } catch {
      /* ignore */
    }
  }
  return res?.ok ? { ok: true } : { ok: false, reason: res?.reason || 'pause-failed' }
}

async function resumeLoomRecording(): Promise<{ ok: boolean; reason?: string }> {
  const session = (await hydrateLoomSession()) ?? loomSession
  if (!session || session.phase !== 'recording') {
    return { ok: false, reason: 'not-recording' }
  }
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_RESUME',
  })
  if (res?.ok) {
    try {
      await chrome.tabs.sendMessage(session.tabId, {
        type: 'PIP_OVERLAY_PAUSED',
        paused: false,
      })
    } catch {
      /* ignore */
    }
  }
  return res?.ok ? { ok: true } : { ok: false, reason: res?.reason || 'resume-failed' }
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
  if (result.ok && result.ui === 'page' && typeof result.tabId === 'number') {
    await focusCapturedTab(result.tabId)
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  // Hydrate first: after an MV3 SW restart the in-memory session is gone
  // while offscreen capture for the closed tab may still be live.
  void hydrateLoomSession().then(() => {
    if (loomSession?.tabId === tabId) {
      return discardLoomRecording()
    }
  })
})

/**
 * Library Settings opens this port for the duration of Connect Google so the
 * MV3 service worker is not killed while chrome.identity.getAuthToken waits
 * on the consent UI (often 30–120s).
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'drive-connect') return
  // Holding the port open is enough; ignore payload noise.
  port.onMessage.addListener(() => {})
})

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
          // Focus after reply so the popup receives ok before it is destroyed.
          if (result.ui === 'page' && typeof result.tabId === 'number') {
            const focusTabId = result.tabId
            setTimeout(() => {
              void focusCapturedTab(focusTabId)
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
        await focusCapturedTab(tabId)
      }
      sendResponse({ ok: true })
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
          openEditor: Boolean(message.openEditor),
          fallbackTabId: sender.tab?.id,
        })
        sendResponse(result)
      } catch (err) {
        // Last-resort teardown so Stop never leaves capture hanging.
        try {
          await teardownCaptureStreams(sender.tab?.id ?? null)
        } catch {
          /* ignore */
        }
        sendResponse({
          ok: false,
          reason: errMessage(err, 'Could not stop recording.'),
        })
      }
    })()
    return true
  }

  if (message?.type === 'PAUSE_LOOM_RECORDING') {
    void (async () => {
      sendResponse(await pauseLoomRecording())
    })()
    return true
  }

  if (message?.type === 'RESUME_LOOM_RECORDING') {
    void (async () => {
      sendResponse(await resumeLoomRecording())
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
    const x = typeof message.x === 'number' ? message.x : undefined
    const y = typeof message.y === 'number' ? message.y : undefined
    const size = typeof message.size === 'number' ? message.size : undefined
    void savePipSettings({
      bubbleX: x,
      bubbleY: y,
      bubbleSize: size,
    })
    sendResponse({ ok: true })
    return false
  }

  if (message?.type === 'LOOM_BUBBLE_SHAPE') {
    if (!isContentScriptSender(sender)) {
      sendResponse({ ok: false, reason: 'untrusted-sender' })
      return false
    }
    void savePipSettings({
      bubbleShape: message.bubbleShape === 'square' ? 'square' : 'circle',
    })
    sendResponse({ ok: true })
    return false
  }

  if (message?.type === 'LOOM_BUBBLE_EFFECT') {
    if (!isContentScriptSender(sender)) {
      sendResponse({ ok: false, reason: 'untrusted-sender' })
      return false
    }
    void savePipSettings({
      backgroundEffect: message.backgroundEffect === 'blur' ? 'blur' : 'none',
    })
    sendResponse({ ok: true })
    return false
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
          shadow: message.shadow,
          bubbleShape: message.bubbleShape,
          backgroundEffect: message.backgroundEffect,
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
          shadow: message.shadow,
          bubbleShape: message.bubbleShape,
          backgroundEffect: message.backgroundEffect,
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
