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
        showError(
          res.status === 404 ? 'Recording not found' : 'Could not load',
          data.error || 'This share link may have been removed.',
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
    hint.innerHTML =
      'If the video does not appear, your browser may block the Drive embed. ' +
      (share.driveWebViewLink
        ? `<a href="${share.driveWebViewLink}" target="_blank" rel="noopener">Open in Google Drive</a>.`
        : 'Open the link again later, or ask the owner to re-share.')
  }

  void main()
})()
