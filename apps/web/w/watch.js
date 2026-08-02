;(function () {
  const statusEl = document.getElementById('status')
  const placeholder = document.getElementById('placeholder')
  const placeholderTitle = document.getElementById('placeholderTitle')
  const placeholderBody = document.getElementById('placeholderBody')
  const player = document.getElementById('player')
  const hint = document.getElementById('hint')

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

  function showError(title, body) {
    statusEl.textContent = 'Unavailable'
    placeholderTitle.textContent = title
    placeholderBody.textContent = body
    placeholder.hidden = false
    player.hidden = true
  }

  async function recordView(shareId) {
    try {
      await fetch(`/api/shares/${encodeURIComponent(shareId)}/view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      })
    } catch {
      /* view tracking is best-effort */
    }
  }

  async function main() {
    const shareId = shareIdFromPath()
    if (!shareId || shareId.length < 8) {
      showError('Link not found', 'This share URL is incomplete or invalid.')
      return
    }

    let share
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(shareId)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 429) {
          showError('Too many requests', 'Please wait a moment and reload this page.')
          return
        }
        const expired = /expired/i.test(String(data.error || ''))
        showError(
          expired
            ? 'Link expired'
            : res.status === 404
              ? 'Recording not found'
              : 'Could not load',
          expired
            ? 'Share links expire 30 days after they are created. Ask the owner to share it again.'
            : data.error || 'This share link may have been removed.',
        )
        return
      }
      share = data.share
    } catch {
      showError('Could not load', 'Check your connection and try again.')
      return
    }

    // Count the page open as a view (Loom-style).
    void recordView(shareId)

    const fileId = share.driveFileId
    if (!fileId) {
      showError(
        'Video unavailable',
        'This share has no Drive file attached yet. Ask the owner to re-share from MyPipCam.',
      )
      return
    }

    statusEl.textContent = 'Shared recording'
    placeholder.hidden = true
    player.hidden = false
    player.src = drivePreviewUrl(fileId)

    hint.hidden = false
    hint.textContent = 'If the video does not appear, your browser may block the Drive embed. '
    const driveLink = safeDriveLink(share.driveWebViewLink)
    if (driveLink) {
      const a = document.createElement('a')
      a.href = driveLink
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = 'Open in Google Drive'
      hint.appendChild(a)
      hint.appendChild(document.createTextNode('.'))
    } else {
      hint.appendChild(
        document.createTextNode('Open the link again later, or ask the owner to re-share.'),
      )
    }
  }

  void main()
})()
