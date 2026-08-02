chrome.runtime.onInstalled.addListener(() => {
  console.log('[MyPipCam] installed')
})

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start-recording') {
    const { openRecorderTab } = await import('../shared/navigation')
    await openRecorderTab()
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'OPEN_LIBRARY') {
    void (async () => {
      const { openLibraryTab } = await import('../shared/navigation')
      await openLibraryTab(message.id)
      sendResponse({ ok: true })
    })()
    return true
  }
  if (message?.type === 'OPEN_RECORDER') {
    void (async () => {
      const { openRecorderTab } = await import('../shared/navigation')
      await openRecorderTab()
      sendResponse({ ok: true })
    })()
    return true
  }
  return false
})
