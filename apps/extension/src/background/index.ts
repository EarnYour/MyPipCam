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
import { openLibraryTab, openRecorderTab } from '../shared/navigation'
import {
  isContentScriptSender,
  isPipChannelToken,
  isPipFrameSender,
  isSafeRecordingId,
  isTrustedExtensionSender,
  sanitizeCssColor,
} from '../shared/security'
import type { RecordMode } from '../shared/types'

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

chrome.runtime.onInstalled.addListener(() => {
  console.log('[MyPipCam] installed')
})

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
  return chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  }) as Promise<chrome.runtime.ExtensionContext[]>
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
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [pipOverlayScript],
  })
}

/**
 * CRX content scripts load via async dynamic import(). executeScript resolves
 * before onMessage is registered — retry until the overlay listener answers.
 */
async function sendOverlayMessage<T extends { ok?: boolean }>(
  tabId: number,
  message: Record<string, unknown>,
  attempts = 25,
): Promise<T> {
  let lastErr = 'Overlay content script did not respond'
  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, message)) as T | undefined
      if (res != null) return res
      lastErr = 'Overlay returned an empty response'
    } catch (err) {
      lastErr = errMessage(err, 'Could not reach camera overlay in this tab')
    }
    await new Promise((r) => setTimeout(r, 40 + Math.min(i, 10) * 20))
  }
  throw new Error(lastErr)
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

async function resolveTargetTab(explicitTabId?: number): Promise<
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
}> {
  if (starting) return { ok: false, reason: 'Already starting — wait a moment and try again.' }
  if (loomSession) {
    return {
      ok: false,
      reason: 'Already recording. Stop the current recording first.',
      tabId: loomSession.tabId,
    }
  }

  starting = true
  try {
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
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    const tab = resolved.tab
    if (!tab.id) {
      return {
        ok: false,
        reason: "Can't record this page. Open a normal website tab (https://…) and try again.",
      }
    }

    await ensureOffscreen()

    // Consume tabCapture token immediately — it expires in a few seconds and
    // cannot be obtained reliably after the 3s countdown (gesture is gone).
    let streamId: string | undefined
    if (recordMode !== 'cam') {
      try {
        streamId =
          options?.streamId?.trim() ||
          (await getTabStreamId(tab.id))
      } catch (err) {
        await closeOffscreen()
        return {
          ok: false,
          reason: errMessage(
            err,
            'Tab capture failed. Click Start on an https tab and try again.',
          ),
        }
      }
    }

    const prepareResult = await sendOffscreen<{ ok?: boolean; reason?: string }>({
      type: 'OFFSCREEN_PREPARE',
      streamId,
      includeMic,
      micDeviceId: micDeviceId ?? null,
      cameraDeviceId: cameraDeviceId ?? null,
      recordMode,
    })

    if (!prepareResult?.ok) {
      await closeOffscreen()
      return {
        ok: false,
        reason:
          prepareResult?.reason?.trim() ||
          'Could not prepare tab/camera capture in the recorder.',
      }
    }

    try {
      await injectOverlay(tab.id)
      await sendOverlayMessage(tab.id, {
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
    } catch (err) {
      await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
      await closeOffscreen()
      return {
        ok: false,
        reason: errMessage(err, 'Could not start camera overlay in this tab.'),
      }
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
    await chrome.storage.session.set({
      loomRecording: {
        tabId: tab.id,
        startedAt: loomSession.startedAt,
        phase: 'countdown',
        recordMode,
      },
    })
    await setRecordingBadge(true)

    return { ok: true, tabId: tab.id }
  } catch (err) {
    console.error('[MyPipCam] startLoomRecording failed:', err)
    if (loomSession) {
      await stopOverlay(loomSession.tabId)
      loomSession = null
    }
    try {
      await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
    } catch {
      /* ignore */
    }
    await closeOffscreen()
    await setRecordingBadge(false)
    await chrome.storage.session.remove('loomRecording')
    return {
      ok: false,
      reason: errMessage(err, 'Failed to start recording'),
    }
  } finally {
    starting = false
  }
}

/** Phase 2: countdown finished → start MediaRecorder on already-held streams. */
async function armCaptureAfterCountdown(): Promise<{ ok: boolean; reason?: string }> {
  if (armingCapture) return { ok: false, reason: 'already-arming' }
  const session = loomSession
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
    await chrome.storage.session.set({
      loomRecording: {
        tabId: session.tabId,
        startedAt: session.startedAt,
        phase: 'recording',
        recordMode: session.recordMode,
      },
    })

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
  try {
    await sendOffscreen({ type: 'OFFSCREEN_DISCARD' })
  } catch {
    /* ignore */
  }
  await closeOffscreen()
}

async function stopLoomRecording(): Promise<{
  ok: boolean
  id?: string
  reason?: string
}> {
  const session = loomSession
  loomSession = null
  await chrome.storage.session.remove('loomRecording')
  await setRecordingBadge(false)

  const tabId = session?.tabId
  await stopOverlay(tabId)

  // Countdown cancelled / never committed — nothing to save
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

    await closeOffscreen()

    if (!result?.ok) {
      return { ok: false, reason: result?.reason?.trim() || 'Could not stop recording.' }
    }

    const settings = await loadPipSettings()
    if (settings.openLibraryOnFinish && result.id) {
      await openLibraryTab(result.id)
    }

    return { ok: true, id: result.id }
  } catch (err) {
    await closeOffscreen()
    return {
      ok: false,
      reason: errMessage(err, 'Could not stop recording.'),
    }
  }
}

async function discardLoomRecording(): Promise<{ ok: boolean; reason?: string }> {
  const session = loomSession
  loomSession = null
  await chrome.storage.session.remove('loomRecording')
  await setRecordingBadge(false)
  await stopOverlay(session?.tabId)

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
  const session = loomSession
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
    await chrome.storage.session.set({
      loomRecording: {
        tabId: session.tabId,
        startedAt: session.startedAt,
        phase: 'countdown',
        recordMode: session.recordMode,
      },
    })
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
  if (!loomSession || loomSession.phase !== 'recording') {
    return { ok: false, reason: 'not-recording' }
  }
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_PAUSE',
  })
  if (res?.ok) {
    try {
      await chrome.tabs.sendMessage(loomSession.tabId, {
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
  if (!loomSession || loomSession.phase !== 'recording') {
    return { ok: false, reason: 'not-recording' }
  }
  const res = await sendOffscreen<{ ok?: boolean; reason?: string }>({
    type: 'OFFSCREEN_RESUME',
  })
  if (res?.ok) {
    try {
      await chrome.tabs.sendMessage(loomSession.tabId, {
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
  if (loomSession) {
    if (loomSession.phase === 'countdown') {
      await discardLoomRecording()
      return
    }
    await stopLoomRecording()
    return
  }
  await startLoomRecording()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (loomSession?.tabId === tabId) {
    void discardLoomRecording()
  }
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

  if (message?.type === 'PING') {
    replySafe(sendResponse, { ok: true })
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
    void (async () => {
      if (isPipChannelToken(message.token)) {
        await revokePipChannelToken(message.token)
      }
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
        const result = await startLoomRecording(tabId, {
          recordMode: message.recordMode,
          micDeviceId: message.micDeviceId,
          cameraDeviceId: message.cameraDeviceId,
          includeMic: message.includeMic,
          streamId: typeof message.streamId === 'string' ? message.streamId : null,
        })
        if (!result.ok) {
          console.error('[MyPipCam] START_LOOM_RECORDING failed:', result.reason)
        }
        sendResponse(result)
      } catch (err) {
        const reason = errMessage(err, 'Failed to start recording')
        console.error('[MyPipCam] START_LOOM_RECORDING threw:', reason, err)
        sendResponse({
          ok: false,
          reason,
        })
      }
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
        const result = await stopLoomRecording()
        sendResponse(result)
      } catch (err) {
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
      sendResponse(await discardLoomRecording())
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
    sendResponse({
      recording: Boolean(loomSession),
      phase: loomSession?.phase ?? null,
      tabId: loomSession?.tabId ?? null,
      startedAt: loomSession?.startedAt ?? null,
      recordMode: loomSession?.recordMode ?? null,
    })
    return false
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
    void savePipSettings({
      bubbleShape: message.bubbleShape === 'square' ? 'square' : 'circle',
    })
    sendResponse({ ok: true })
    return false
  }

  if (message?.type === 'LOOM_BUBBLE_EFFECT') {
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
      try {
        const resolved = await resolveTargetTab(message.tabId)
        if (!resolved.ok || !resolved.tab.id) {
          sendResponse({ ok: false, reason: resolved.ok ? 'no-tab' : resolved.reason })
          return
        }
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
        sendResponse({
          ok: false,
          reason: errMessage(err, 'inject-failed'),
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

  return false
})
