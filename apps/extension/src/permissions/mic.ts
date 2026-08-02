/**
 * Visible extension page for microphone permission.
 *
 * Must NOT call getUserMedia on bare page-load — Chrome often returns
 * "Permission dismissed" with no UI unless there is a real user gesture.
 * The Allow button click is that gesture.
 *
 * Always use plain { audio: true } — never empty deviceId: { exact }.
 */

import { writeMicGrantResult, type MicGrantDevice } from '../shared/micGrant'

const statusEl = document.getElementById('status') as HTMLParagraphElement
const helpEl = document.getElementById('help') as HTMLParagraphElement
const devicesEl = document.getElementById('devices') as HTMLUListElement
const allowBtn = document.getElementById('allow') as HTMLButtonElement
const closeBtn = document.getElementById('close') as HTMLButtonElement

const RESET_HELP =
  'Reset Chrome: open chrome://settings/content/microphone → find MyPipCam → Allow (or remove from Block). On macOS also: System Settings → Privacy & Security → Microphone → turn ON Google Chrome.'

let closeTimer: number | null = null

function setStatus(text: string, kind: 'pending' | 'ok' | 'bad') {
  statusEl.textContent = text
  statusEl.classList.toggle('is-ok', kind === 'ok')
  statusEl.classList.toggle('is-bad', kind === 'bad')
}

function showHelp(show: boolean) {
  helpEl.hidden = !show
  if (show) helpEl.textContent = RESET_HELP
}

function errDetail(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  return 'Microphone permission denied'
}

async function listMicDevices(): Promise<MicGrantDevice[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const inputs = all.filter((d) => d.kind === 'audioinput')
    const physical = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    const list = physical.length > 0 ? physical : inputs
    return list.map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label?.trim() || `Microphone ${i + 1}`,
    }))
  } catch {
    return []
  }
}

function renderDevices(devices: MicGrantDevice[]) {
  devicesEl.innerHTML = ''
  for (const d of devices.slice(0, 6)) {
    const li = document.createElement('li')
    li.textContent = d.label
    devicesEl.appendChild(li)
  }
}

async function notifyPopup(status: 'granted' | 'denied', reason?: string) {
  try {
    await chrome.runtime.sendMessage({
      type: 'MIC_GRANT_RESULT',
      status,
      reason,
    })
  } catch {
    /* popup may be closed — session storage is the source of truth */
  }
}

async function requestMic() {
  allowBtn.disabled = true
  showHelp(false)
  setStatus('Waiting for Chrome Allow dialog…', 'pending')
  await writeMicGrantResult('pending')

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot request microphone access here.')
    }

    // Plain audio only — do not pass deviceId: { exact }.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const t of stream.getTracks()) t.stop()

    const devices = await listMicDevices()
    renderDevices(devices)

    await writeMicGrantResult('granted', { devices })
    await notifyPopup('granted')

    setStatus(
      devices.length > 0
        ? `Microphone allowed (${devices.length} device${devices.length === 1 ? '' : 's'}). Closing…`
        : 'Microphone allowed. Closing…',
      'ok',
    )
    showHelp(false)
    allowBtn.textContent = 'Allowed'
    if (closeTimer != null) window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(() => window.close(), 1100)
  } catch (err) {
    const detail = errDetail(err)
    console.error('[MyPipCam] mic grant page failed:', detail, err)
    await writeMicGrantResult('denied', { reason: detail })
    await notifyPopup('denied', detail)

    setStatus(
      /dismissed|denied|notallowed/i.test(detail)
        ? 'Microphone blocked or dismissed — see reset steps below'
        : detail,
      'bad',
    )
    showHelp(true)
    allowBtn.disabled = false
    allowBtn.textContent = 'Try again'
  }
}

allowBtn.addEventListener('click', () => {
  void requestMic()
})

closeBtn.addEventListener('click', () => {
  window.close()
})

// Mark pending so the popup knows a grant window is open (do not call getUserMedia yet).
void writeMicGrantResult('pending')
setStatus('Ready — click Allow microphone', 'pending')
