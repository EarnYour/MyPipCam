/**
 * Fallback recording HUD — extension window used when the page overlay
 * cannot be shown (inject/visibility failure). Controls talk to the SW.
 */

const statusEl = document.getElementById('status') as HTMLParagraphElement
const countEl = document.getElementById('count') as HTMLDivElement
const timerEl = document.getElementById('timer') as HTMLDivElement
const errEl = document.getElementById('err') as HTMLDivElement
const stopBtn = document.getElementById('stop') as HTMLButtonElement
const discardBtn = document.getElementById('discard') as HTMLButtonElement

let phase: 'countdown' | 'recording' | 'paused' | 'idle' = 'idle'
let countdownLeft = 3
let countdownTimer: number | null = null
let recordingStartedAt = 0
let tickTimer: number | null = null

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function setError(msg: string) {
  errEl.textContent = msg
}

function showCountdown(n: number) {
  phase = 'countdown'
  countEl.classList.remove('is-hidden')
  timerEl.classList.add('is-hidden')
  countEl.textContent = String(n)
  statusEl.textContent = 'Countdown — recording starts after 3…2…1'
}

function showRecording() {
  phase = 'recording'
  countEl.classList.add('is-hidden')
  timerEl.classList.remove('is-hidden')
  statusEl.textContent = 'Recording (fallback controls)'
  recordingStartedAt = Date.now()
  if (tickTimer != null) window.clearInterval(tickTimer)
  tickTimer = window.setInterval(() => {
    timerEl.textContent = formatDuration(Date.now() - recordingStartedAt)
  }, 250)
}

async function syncFromBackground() {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_LOOM_STATUS' })) as {
      recording?: boolean
      phase?: string | null
    } | null
    if (!res?.recording) {
      if (countdownTimer != null) {
        window.clearInterval(countdownTimer)
        countdownTimer = null
      }
      phase = 'idle'
      countEl.classList.add('is-hidden')
      statusEl.textContent = 'No active capture'
      return
    }
    if (res.phase === 'recording' || res.phase === 'paused') {
      if (countdownTimer != null) {
        window.clearInterval(countdownTimer)
        countdownTimer = null
      }
      showRecording()
      return
    }
    if (res.phase === 'countdown' && phase !== 'countdown') {
      beginLocalCountdown()
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Could not reach background')
  }
}

function beginLocalCountdown() {
  countdownLeft = 3
  showCountdown(countdownLeft)
  if (countdownTimer != null) window.clearInterval(countdownTimer)
  countdownTimer = window.setInterval(() => {
    countdownLeft -= 1
    if (countdownLeft <= 0) {
      if (countdownTimer != null) window.clearInterval(countdownTimer)
      countdownTimer = null
      // Page overlay normally fires LOOM_COUNTDOWN_DONE; HUD mirrors if needed.
      void chrome.runtime
        .sendMessage({ type: 'LOOM_COUNTDOWN_DONE' })
        .then((res: { ok?: boolean; reason?: string } | undefined) => {
          if (!res?.ok) {
            setError(res?.reason?.trim() || 'Could not start capture after countdown')
            return
          }
          showRecording()
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Countdown commit failed')
        })
      return
    }
    showCountdown(countdownLeft)
  }, 1000)
}

stopBtn.addEventListener('click', () => {
  void chrome.runtime
    .sendMessage({ type: 'STOP_LOOM_RECORDING' })
    .then(() => window.close())
    .catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Stop failed')
    })
})

discardBtn.addEventListener('click', () => {
  void chrome.runtime
    .sendMessage({ type: 'DISCARD_LOOM_RECORDING' })
    .then(() => window.close())
    .catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Discard failed')
    })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'HUD_SYNC') {
    if (message.phase === 'recording') showRecording()
    else if (message.phase === 'countdown') beginLocalCountdown()
    if (typeof message.reason === 'string' && message.reason.trim()) {
      setError(message.reason.trim())
    }
  }
})

console.log('[MyPipCam][start] fallback HUD opened')
// Don't start a local countdown until the background confirms the phase — an
// unconditional one here would fire LOOM_COUNTDOWN_DONE into a session that is
// already recording (double-commit) or has no active capture at all.
statusEl.textContent = 'Connecting…'
void syncFromBackground()
