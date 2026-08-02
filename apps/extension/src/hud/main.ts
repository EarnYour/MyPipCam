/**
 * Recording control HUD — extension popup window (outside tabCapture).
 *
 * When `?drive=1`, this window owns the 3→2→1 countdown (page overlay failed).
 * Otherwise the page overlay drives countdown; HUD mirrors status and provides
 * stop / pause / trim / restart / discard so chrome is never baked into video.
 */

const params = new URLSearchParams(location.search)
/** True when this window must fire LOOM_COUNTDOWN_DONE (no page overlay). */
const driveCountdown = params.get('drive') === '1'

const statusEl = document.getElementById('status') as HTMLParagraphElement
const countEl = document.getElementById('count') as HTMLDivElement
const timerEl = document.getElementById('timer') as HTMLDivElement
const errEl = document.getElementById('err') as HTMLDivElement
const countdownActions = document.getElementById('countdownActions') as HTMLDivElement
const recActions = document.getElementById('recActions') as HTMLDivElement
const stopBtn = document.getElementById('stop') as HTMLButtonElement
const discardBtn = document.getElementById('discard') as HTMLButtonElement
const pauseBtn = document.getElementById('pause') as HTMLButtonElement
const trimBtn = document.getElementById('trim') as HTMLButtonElement
const restartBtn = document.getElementById('restart') as HTMLButtonElement
const cancelCountdownBtn = document.getElementById('cancelCountdown') as HTMLButtonElement
const skipCountdownBtn = document.getElementById('skipCountdown') as HTMLButtonElement

let phase: 'countdown' | 'recording' | 'paused' | 'idle' = 'idle'
let countdownLeft = 3
let countdownTimer: number | null = null
let recordingStartedAt = 0
let pausedAccumMs = 0
let pauseStartedAt = 0
let tickTimer: number | null = null
let busy = false
let localCountdownActive = false

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function setError(msg: string) {
  errEl.textContent = msg
}

function setBusy(next: boolean) {
  busy = next
  for (const btn of [
    stopBtn,
    discardBtn,
    pauseBtn,
    trimBtn,
    restartBtn,
    cancelCountdownBtn,
    skipCountdownBtn,
  ]) {
    btn.disabled = next
  }
}

function clearCountdownTimer() {
  if (countdownTimer != null) {
    window.clearInterval(countdownTimer)
    countdownTimer = null
  }
  localCountdownActive = false
}

function showCountdown(n: number) {
  phase = 'countdown'
  countEl.classList.remove('is-hidden')
  timerEl.classList.add('is-hidden')
  countdownActions.classList.remove('is-hidden')
  recActions.classList.add('is-hidden')
  countEl.textContent = String(n)
  statusEl.textContent = driveCountdown
    ? 'Countdown — recording starts after 3…2…1'
    : 'Countdown on page — use Cancel / Skip here'
}

function elapsedMs(): number {
  let elapsed = Date.now() - recordingStartedAt - pausedAccumMs
  if (phase === 'paused' && pauseStartedAt) {
    elapsed = pauseStartedAt - recordingStartedAt - pausedAccumMs
  }
  return Math.max(0, elapsed)
}

function showRecording(opts?: { resumeClock?: boolean }) {
  phase = 'recording'
  clearCountdownTimer()
  countEl.classList.add('is-hidden')
  timerEl.classList.remove('is-hidden')
  countdownActions.classList.add('is-hidden')
  recActions.classList.remove('is-hidden')
  statusEl.textContent = 'Recording'
  pauseBtn.textContent = 'Pause'
  if (!opts?.resumeClock || !recordingStartedAt) {
    recordingStartedAt = Date.now()
    pausedAccumMs = 0
    pauseStartedAt = 0
  }
  if (tickTimer != null) window.clearInterval(tickTimer)
  tickTimer = window.setInterval(() => {
    timerEl.textContent = formatDuration(elapsedMs())
  }, 250)
  timerEl.textContent = formatDuration(elapsedMs())
  setBusy(false)
}

function showPaused() {
  if (phase !== 'paused') {
    pauseStartedAt = Date.now()
  }
  phase = 'paused'
  statusEl.textContent = 'Paused'
  pauseBtn.textContent = 'Resume'
  timerEl.textContent = formatDuration(elapsedMs())
}

function commitCountdown() {
  clearCountdownTimer()
  countEl.classList.add('is-hidden')
  countdownActions.classList.add('is-hidden')
  statusEl.textContent = 'Starting capture…'
  void chrome.runtime
    .sendMessage({ type: 'LOOM_COUNTDOWN_DONE' })
    .then((res: { ok?: boolean; reason?: string } | undefined) => {
      if (!res?.ok) {
        setError(res?.reason?.trim() || 'Could not start capture after countdown')
        setBusy(false)
        return
      }
      showRecording()
    })
    .catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Countdown commit failed')
      setBusy(false)
    })
}

function beginLocalCountdown() {
  if (localCountdownActive) return
  localCountdownActive = true
  countdownLeft = 3
  showCountdown(countdownLeft)
  clearCountdownTimer()
  localCountdownActive = true
  countdownTimer = window.setInterval(() => {
    countdownLeft -= 1
    if (countdownLeft <= 0) {
      clearCountdownTimer()
      if (driveCountdown) {
        commitCountdown()
      }
      // When page drives countdown, wait for HUD_SYNC recording.
      return
    }
    showCountdown(countdownLeft)
  }, 1000)
}

async function syncFromBackground() {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_LOOM_STATUS' })) as {
      recording?: boolean
      phase?: string | null
      startedAt?: number | null
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
      if (typeof res.startedAt === 'number' && res.startedAt > 0) {
        recordingStartedAt = res.startedAt
      }
      showRecording({ resumeClock: true })
      if (res.phase === 'paused') showPaused()
      return
    }
    if (res.phase === 'countdown') {
      if (driveCountdown) beginLocalCountdown()
      else showCountdown(3)
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Could not reach background')
  }
}

stopBtn.addEventListener('click', () => {
  if (busy) return
  setBusy(true)
  void chrome.runtime
    .sendMessage({ type: 'STOP_LOOM_RECORDING' })
    .then(() => window.close())
    .catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Stop failed')
    })
})

discardBtn.addEventListener('click', () => {
  if (busy) return
  setBusy(true)
  void chrome.runtime
    .sendMessage({ type: 'DISCARD_LOOM_RECORDING' })
    .then(() => window.close())
    .catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Discard failed')
    })
})

cancelCountdownBtn.addEventListener('click', () => {
  if (busy) return
  setBusy(true)
  clearCountdownTimer()
  void chrome.runtime
    .sendMessage({ type: 'DISCARD_LOOM_RECORDING', fromCountdown: true })
    .then(() => window.close())
    .catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Cancel failed')
    })
})

skipCountdownBtn.addEventListener('click', () => {
  if (busy || phase !== 'countdown') return
  setBusy(true)
  clearCountdownTimer()
  // Always ask SW to commit — safe if page already fired LOOM_COUNTDOWN_DONE.
  commitCountdown()
})

pauseBtn.addEventListener('click', () => {
  if (busy || phase === 'countdown') return
  const pausing = phase !== 'paused'
  setBusy(true)
  void chrome.runtime
    .sendMessage({ type: pausing ? 'PAUSE_LOOM_RECORDING' : 'RESUME_LOOM_RECORDING' })
    .then((res: { ok?: boolean; reason?: string } | undefined) => {
      setBusy(false)
      if (!res?.ok) {
        setError(res?.reason?.trim() || (pausing ? 'Pause failed' : 'Resume failed'))
        return
      }
      if (pausing) showPaused()
      else {
        if (pauseStartedAt) {
          pausedAccumMs += Date.now() - pauseStartedAt
          pauseStartedAt = 0
        }
        phase = 'recording'
        statusEl.textContent = 'Recording'
        pauseBtn.textContent = 'Pause'
      }
    })
    .catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Pause failed')
    })
})

trimBtn.addEventListener('click', () => {
  if (busy || phase === 'countdown') return
  const ok = window.confirm(
    'Stop and trim in editor?\n\nRecording will save, then open so you can trim the end.',
  )
  if (!ok) return
  setBusy(true)
  void chrome.runtime
    .sendMessage({ type: 'STOP_LOOM_RECORDING', openEditor: true })
    .then((res: { ok?: boolean; reason?: string } | undefined) => {
      if (!res?.ok) {
        setBusy(false)
        setError(res?.reason?.trim() || 'Could not stop recording to trim.')
        return
      }
      window.close()
    })
    .catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Trim failed')
    })
})

restartBtn.addEventListener('click', () => {
  if (busy || phase === 'countdown') return
  setBusy(true)
  void chrome.runtime
    .sendMessage({ type: 'RESTART_LOOM_RECORDING' })
    .then((res: { ok?: boolean; reason?: string } | undefined) => {
      if (!res?.ok) {
        setBusy(false)
        setError(res?.reason?.trim() || 'Could not restart recording.')
        return
      }
      recordingStartedAt = 0
      pausedAccumMs = 0
      pauseStartedAt = 0
      if (driveCountdown) beginLocalCountdown()
      else showCountdown(3)
      setBusy(false)
    })
    .catch((err: unknown) => {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Restart failed')
    })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'HUD_SYNC') {
    if (message.phase === 'recording') showRecording({ resumeClock: true })
    else if (message.phase === 'paused') {
      showRecording({ resumeClock: true })
      showPaused()
    } else if (message.phase === 'countdown') {
      if (driveCountdown) beginLocalCountdown()
      else showCountdown(3)
    }
    if (typeof message.reason === 'string' && message.reason.trim()) {
      setError(message.reason.trim())
    }
  }
})

console.log('[MyPipCam][start] recording HUD opened', { driveCountdown })
// Only a HUD opened with ?drive=1 owns the countdown, so committing it here
// can't double-fire against a session the page overlay is already driving.
if (driveCountdown) {
  beginLocalCountdown()
} else {
  showCountdown(3)
}
void syncFromBackground()
