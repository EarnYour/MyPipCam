export function extensionPageUrl(path: string): string {
  return chrome.runtime.getURL(path)
}

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

export async function openLibraryTab(highlightId?: string): Promise<chrome.tabs.Tab> {
  const base = extensionPageUrl('src/library/index.html')
  const url = highlightId ? `${base}?id=${encodeURIComponent(highlightId)}` : base
  return chrome.tabs.create({ url, active: true })
}

export async function openEditorTab(id: string): Promise<chrome.tabs.Tab> {
  const url = `${extensionPageUrl('src/editor/index.html')}?id=${encodeURIComponent(id)}`
  return chrome.tabs.create({ url, active: true })
}
