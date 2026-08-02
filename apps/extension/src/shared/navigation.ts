export function extensionPageUrl(path: string): string {
  return chrome.runtime.getURL(path)
}

/** Advanced screen/window capture UI (not the primary Loom-in-tab path). */
export async function openRecorderTab(): Promise<chrome.tabs.Tab> {
  const url = extensionPageUrl('src/recorder/index.html')
  const existing = await chrome.tabs.query({ url })
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true })
    if (existing[0].windowId != null) {
      await chrome.windows.update(existing[0].windowId, { focused: true })
    }
    return existing[0]
  }

  return chrome.tabs.create({ url, active: true })
}

export async function openLibraryTab(
  highlightId?: string,
  openSettings = false,
): Promise<chrome.tabs.Tab> {
  const base = extensionPageUrl('src/library/index.html')
  const params = new URLSearchParams()
  if (highlightId) params.set('id', highlightId)
  if (openSettings) params.set('settings', '1')
  const qs = params.toString()
  const url = qs ? `${base}?${qs}` : base
  return chrome.tabs.create({ url, active: true })
}

export async function openEditorTab(id: string): Promise<chrome.tabs.Tab> {
  // IDs are UUID folder names; reject anything else before putting it in a URL.
  const safe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id.trim(),
  )
    ? id.trim()
    : ''
  if (!safe) throw new Error('Invalid recording id')
  const url = `${extensionPageUrl('src/editor/index.html')}?id=${encodeURIComponent(safe)}`
  return chrome.tabs.create({ url, active: true })
}
