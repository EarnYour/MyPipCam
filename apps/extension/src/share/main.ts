import {
  clearShareSession,
  readShareSession,
  type ShareSession,
} from '../shared/shareSession'

const statusEl = document.getElementById('status') as HTMLParagraphElement
const tabHintEl = document.getElementById('tabHint') as HTMLParagraphElement
const shareBtn = document.getElementById('shareBtn') as HTMLButtonElement
const cancelBtn = document.getElementById('cancelBtn') as HTMLButtonElement

let session: ShareSession | null = null
let starting = false

function setStatus(text: string, bad = false) {
  statusEl.textContent = text
  statusEl.classList.toggle('is-bad', bad)
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  return fallback
}

async function focusReturnTab(tabId: number) {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true })
    }
    await chrome.tabs.update(tabId, { active: true })
  } catch {
    /* tab may be gone */
  }
}

async function closeSelf() {
  const tab = await chrome.tabs.getCurrent()
  if (tab?.id != null) {
    await chrome.tabs.remove(tab.id).catch(() => undefined)
    return
  }
  window.close()
}

async function mintTabStreamId(): Promise<string> {
  const getMediaStreamId = chrome.tabCapture.getMediaStreamId as (options?: {
    targetTabId?: number
  }) => Promise<string>

  // No targetTabId → Chrome shows the native “Choose what to share” picker (tabs).
  try {
    const id = await getMediaStreamId()
    if (id) return id
  } catch (err) {
    console.warn('[MyPipCam][share] picker getMediaStreamId failed, trying target tab:', err)
  }

  if (!session) throw new Error('Missing share session')
  const id = await getMediaStreamId({ targetTabId: session.returnTabId })
  if (!id) throw new Error('No tab stream id from tabCapture')
  return id
}

async function startWithStream(streamId: string) {
  if (!session) throw new Error('Missing share session')
  setStatus('Starting countdown…')

  const res = (await chrome.runtime.sendMessage({
    type: 'START_LOOM_RECORDING',
    tabId: session.returnTabId,
    streamId,
    recordMode: session.recordMode,
    micDeviceId: session.includeMic ? session.micDeviceId : null,
    cameraDeviceId: session.cameraDeviceId,
    includeMic: session.includeMic,
  })) as { ok?: boolean; reason?: string; tabId?: number } | undefined

  if (!res?.ok) {
    throw new Error(res?.reason?.trim() || 'Could not start recording')
  }

  await clearShareSession()
  await focusReturnTab(res.tabId ?? session.returnTabId)
  await closeSelf()
}

async function chooseAndStart() {
  if (starting) return
  if (!session) {
    setStatus('No recording session found. Close this tab and start again from the popup.', true)
    return
  }
  starting = true
  shareBtn.disabled = true
  cancelBtn.disabled = true
  setStatus('Pick a Chrome Tab, then click Share…')

  try {
    const streamId = await mintTabStreamId()
    await startWithStream(streamId)
  } catch (err) {
    const detail = errMessage(err, 'Tab share cancelled or denied')
    console.error('[MyPipCam][share] failed:', detail, err)
    setStatus(
      /cancel|denied|abort|notallowed/i.test(detail)
        ? 'Share cancelled. Click Choose Chrome Tab to try again.'
        : detail,
      true,
    )
    shareBtn.disabled = false
    cancelBtn.disabled = false
    starting = false
  }
}

async function cancel() {
  await clearShareSession()
  if (session) await focusReturnTab(session.returnTabId)
  await closeSelf()
}

async function boot() {
  session = await readShareSession()
  if (!session || Date.now() - session.at > 120_000) {
    setStatus('Session expired. Close this tab and start again from MyPipCam.', true)
    shareBtn.disabled = true
    return
  }

  tabHintEl.textContent = session.returnTabTitle
    ? `Return tab: ${session.returnTabTitle}`
    : 'Recording your Chrome tab'

  // Auto-prompt once the page is ready (mirrors Loom opening the native picker).
  window.setTimeout(() => {
    void chooseAndStart()
  }, 180)
}

shareBtn.addEventListener('click', () => void chooseAndStart())
cancelBtn.addEventListener('click', () => void cancel())

void boot()
