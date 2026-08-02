/**
 * Visible extension page for microphone permission.
 *
 * Must run getUserMedia from a real click (user gesture). Page-load calls are
 * often "Permission dismissed" with no UI. Prefer a normal window/tab (not a
 * type:popup chrome window) so Chrome can show the Allow bubble.
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
  'Still blocked? 1) chrome://settings/content/microphone → MyPipCam → Allow (remove from Block). 2) macOS System Settings → Privacy & Security → Microphone → turn ON Google Chrome. Then click Allow microphone again.'

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
  for (const d of devices.slice(0, 8)) {
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
    /* popup may be closed — storage is the source of truth */
  }
}

async function requestMic() {
  allowBtn.disabled = true
  showHelp(false)
  setStatus('Look for Chrome’s Allow prompt at the top of this window…', 'pending')
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
        ? `Microphone allowed (${devices.length} device${devices.length === 1 ? '' : 's'}). You can close this and continue in the popup.`
        : 'Microphone allowed. You can close this and continue in the popup.',
      'ok',
    )
    showHelp(false)
    allowBtn.textContent = 'Allowed ✓'
    if (closeTimer != null) window.clearTimeout(closeTimer)
    closeTimer = window.setTimeout(() => {
      try {
        window.close()
      } catch {
        /* tab may not close itself */
      }
    }, 1400)
  } catch (err) {
    const detail = errDetail(err)
    console.error('[MyPipCam] mic grant page failed:', detail, err)
    await writeMicGrantResult('denied', { reason: detail })
    await notifyPopup('denied', detail)

    setStatus(
      /dismissed|denied|notallowed/i.test(detail)
        ? 'No Allow dialog / blocked — follow reset steps below'
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

void writeMicGrantResult('pending')
setStatus('Ready — click Allow microphone', 'pending')
allowBtn.focus()
