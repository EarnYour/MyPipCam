/**
 * MV3 service worker entry — loads BEFORE the heavy main module.
 *
 * If main fails to import (crash loop), PING / GET_SW_HEALTH still answer so
 * Settings can show a real diagnosis instead of a silent "No response".
 */

import { STABLE_EXTENSION_ID } from '../shared/driveConfig'

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

// Register immediately — before dynamic import settles.
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

console.log('[MyPipCam] SW boot', bootHealth())

// Dynamic import keeps PING/health alive if main fails.
// vite.config.ts strips Vite's __vitePreload wrapper (document/window) from this
// chunk — without that, MV3 SW registration fails with "document is not defined".
void import('./main')
  .then(() => {
    mainReady = true
    bootError = null
    console.log('[MyPipCam] SW main ready', bootHealth())
  })
  .catch((err) => {
    mainReady = false
    bootError = err instanceof Error && err.message.trim() ? err.message.trim() : String(err)
    console.error('[MyPipCam] SW main FAILED to load — recording/Drive will not work:', err)
  })
