/**
 * MV3 service worker entry.
 *
 * Chrome forbids dynamic import() on ServiceWorkerGlobalScope. Use static
 * imports only — Vite/CRX may still emit separate ESM chunks, which is fine.
 */

import { STABLE_EXTENSION_ID } from '../shared/driveConfig'
import './main'

const KEEP_ALIVE_ALARM = 'mypipcam-sw-keepalive'

let mainReady = false
let bootError: string | null = null

function bootHealth() {
  const id = chrome.runtime.id
  return {
    ok: true as const,
    id,
    expectedId: STABLE_EXTENSION_ID,
    idMatch: id === STABLE_EXTENSION_ID,
    ready: mainReady,
    bootError,
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen') return false
  if (message?.type === 'PING') {
    try {
      sendResponse({ ...bootHealth(), ok: true })
    } catch {
      /* port closed */
    }
    return false
  }
  if (message?.type === 'GET_SW_HEALTH') {
    try {
      sendResponse(bootHealth())
    } catch {
      /* port closed */
    }
    return false
  }
  return false
})

chrome.runtime.onInstalled.addListener((details) => {
  const h = bootHealth()
  console.log('[MyPipCam] installed', details.reason, h)
  if (!h.idMatch) {
    console.error(
      '[MyPipCam] WRONG EXTENSION ID — load unpacked from apps/extension/dist so manifest.key is present. Expected',
      STABLE_EXTENSION_ID,
      'got',
      h.id,
    )
  }
})

chrome.runtime.onStartup.addListener(() => {
  console.log('[MyPipCam] SW startup', bootHealth())
})

// Keep the SW from going idle forever (1 min is Chrome's minimum period).
try {
  void chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 1 })
} catch (err) {
  console.warn('[MyPipCam] alarms unavailable:', err)
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEP_ALIVE_ALARM) return
  // Touch storage so Chrome sees SW activity.
  void chrome.storage.session.set({ swKeepAliveAt: Date.now() })
})

// Static import of ./main already evaluated successfully if we reach here.
mainReady = true
bootError = null
console.log('[MyPipCam] SW boot', bootHealth())
console.log('[MyPipCam] SW main ready', bootHealth())
