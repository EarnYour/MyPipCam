;(function () {
  const statusEl = document.getElementById('status')
  const placeholder = document.getElementById('placeholder')
  const placeholderTitle = document.getElementById('placeholderTitle')
  const placeholderBody = document.getElementById('placeholderBody')
  const player = document.getElementById('player')
  const hint = document.getElementById('hint')
  const processingBanner = document.getElementById('processingBanner')
  const processingTitle = document.getElementById('processingTitle')
  const processingBody = document.getElementById('processingBody')

  const POLL_MS = 8_000
  const IFRAME_REFRESH_MS = 20_000
  const RECENT_MS = 20 * 60_000
  const MAX_SOFT_POLL_MS = 15 * 60_000

  let pollTimer = null
  let iframeTimer = null
  let softPollStarted = 0

  function shareIdFromPath() {
    const parts = window.location.pathname.split('/').filter(Boolean)
    // /w/{shareId}
    if (parts[0] === 'w' && parts[1]) return parts[1]
    const q = new URLSearchParams(window.location.search).get('id')
    return q || ''
  }

  function drivePreviewUrl(fileId) {
    return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`
  }

  // Share data comes from the API but is ultimately caller-supplied; only
  // render links that are genuinely Google Drive URLs.
  function safeDriveLink(link) {
    if (typeof link !== 'string') return null
    try {
      const url = new URL(link)
      if (
        url.protocol === 'https:' &&
        (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com')
      ) {
        return url.href
      }
    } catch {
      /* fall through */
    }
    return null
  }

  /** Build "<lead><a>Open in Google Drive</a>." without ever parsing HTML. */
  function setDriveHint(lead, link, fallbackText) {
    const href = safeDriveLink(link)
    hint.textContent = ''
    if (!href) {
      hint.textContent = lead + (fallbackText || '')
      return
    }
    hint.appendChild(document.createTextNode(lead))
    const a = document.createElement('a')
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = 'Open in Google Drive'
    hint.appendChild(a)
    hint.appendChild(document.createTextNode('.'))
  }

  function showError(title, body, opts) {
    stopPolling()
    statusEl.textContent = opts?.status || 'Unavailable'
    placeholderTitle.textContent = title
    placeholderBody.textContent = body
    placeholder.hidden = false
    placeholder.classList.toggle('placeholder-expired', Boolean(opts?.expired))
    player.hidden = true
    player.removeAttribute('src')
    player.src = 'about:blank'
    if (processingBanner) processingBanner.hidden = true
    if (hint) {
      if (opts?.expired) {
        hint.hidden = false
        hint.textContent = 'Ask the owner to renew the link from MyPipCam Library, or '
        const a = document.createElement('a')
        a.href = '/'
        a.textContent = 'record with MyPipCam'
        hint.appendChild(a)
        hint.appendChild(document.createTextNode('.'))
      } else {
        hint.hidden = true
        hint.textContent = ''
      }
    }
  }

  function isRecent(iso) {
    const t = Date.parse(iso || '')
    if (!Number.isFinite(t)) return false
    return Date.now() - t < RECENT_MS
  }

  function isProcessing(share) {
    if (share.processingStatus === 'ready' || share.driveReadyAt) return false
    if (share.processingStatus === 'processing') return true
    // Legacy shares without status: soft-refresh for a while after create.
    return isRecent(share.createdAt)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (iframeTimer) {
      clearInterval(iframeTimer)
      iframeTimer = null
    }
  }

  function setProcessingUi(active, share) {
    if (!processingBanner) return
    if (!active) {
      processingBanner.hidden = true
      return
    }
    processingBanner.hidden = false
    if (processingTitle) {
      processingTitle.textContent = 'Still processing on Google Drive'
    }
    if (processingBody) {
      processingBody.textContent =
        'Google does not publish a progress percent. This page checks again automatically — hang tight.'
    }
    statusEl.textContent = 'Processing…'
    if (share?.driveWebViewLink && hint && safeDriveLink(share.driveWebViewLink)) {
      hint.hidden = false
      setDriveHint('You can also try ', share.driveWebViewLink)
    }
  }

  function showPlayer(fileId, share, opts) {
    const processing = Boolean(opts?.processing)
    placeholder.hidden = true
    player.hidden = false
    const url = drivePreviewUrl(fileId)
    if (opts?.forceReload) {
      // Re-mount iframe so Drive re-checks playback readiness (no query hacks).
      player.src = 'about:blank'
      window.setTimeout(function () {
        player.src = url
      }, 50)
    } else if (!player.src || player.src === 'about:blank' || !player.src.includes(fileId)) {
      player.src = url
    }

    setProcessingUi(processing, share)
    if (!processing) {
      statusEl.textContent = 'Shared recording'
      hint.hidden = false
      setDriveHint(
        'If the video does not appear, your browser may block the Drive embed. ',
        share.driveWebViewLink,
        'Open the link again later, or ask the owner to re-share.',
      )
    }
  }

  async function recordView(shareId) {
    try {
      await fetch('/api/shares/' + encodeURIComponent(shareId) + '/view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      })
    } catch {
      /* view tracking is best-effort */
    }
  }

  async function fetchShare(shareId) {
    const res = await fetch('/api/shares/' + encodeURIComponent(shareId))
    const data = await res.json().catch(function () {
      return {}
    })
    if (!res.ok) {
      const err = new Error(data.error || 'Could not load share')
      err.status = res.status
      err.expired = Boolean(data.expired || res.status === 410)
      throw err
    }
    if (data.share && data.share.expired) {
      const err = new Error('This link has expired')
      err.status = 410
      err.expired = true
      throw err
    }
    return data.share
  }

  function startSoftPolling(shareId, fileId, initialShare) {
    stopPolling()
    softPollStarted = Date.now()

    async function tick(forceReload) {
      if (Date.now() - softPollStarted > MAX_SOFT_POLL_MS) {
        stopPolling()
        showPlayer(fileId, initialShare, { processing: false })
        return
      }
      try {
        const share = await fetchShare(shareId)
        const processing = isProcessing(share)
        showPlayer(fileId, share, { processing: processing, forceReload: forceReload })
        if (!processing) stopPolling()
      } catch {
        /* keep trying */
      }
    }

    pollTimer = setInterval(function () {
      void tick(false)
    }, POLL_MS)
    iframeTimer = setInterval(function () {
      void tick(true)
    }, IFRAME_REFRESH_MS)
  }

  async function main() {
    const shareId = shareIdFromPath()
    if (!shareId || shareId.length < 8) {
      showError('Link not found', 'This share URL is incomplete or invalid.')
      return
    }

    let share
    try {
      share = await fetchShare(shareId)
    } catch (err) {
      if (err && err.expired) {
        showError(
          'This link has expired',
          'MyPipCam share links expire after 30 days. Ask the owner to renew it from their Library.',
          { expired: true, status: 'Expired' },
        )
        return
      }
      if (err && err.status === 429) {
        showError('Too many requests', 'Please wait a moment and reload this page.')
        return
      }
      showError(
        err && err.status === 404 ? 'Recording not found' : 'Could not load',
        (err && err.message) || 'This share link may have been removed.',
      )
      return
    }

    // Count the page open as a view (Loom-style). Skip if somehow expired.
    if (!share.expired) {
      void recordView(shareId)
    }

    const fileId = share.driveFileId
    if (!fileId) {
      showError(
        'Video unavailable',
        'This share has no Drive file attached yet. Ask the owner to re-share from MyPipCam.',
      )
      return
    }

    const processing = isProcessing(share)
    showPlayer(fileId, share, { processing: processing })
    if (processing) {
      startSoftPolling(shareId, fileId, share)
    }
  }

  void main()
})()
