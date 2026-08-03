;(function () {
  var DEFAULT_EXT_ID = 'akpchobfndfddajiihkkdpnihihdicjc'
  var LIBRARY_PATH = 'src/library/index.html'
  var EXT_ID_RE = /^[a-p]{32}$/

  var params = new URLSearchParams(window.location.search)
  var extRaw = (params.get('ext') || DEFAULT_EXT_ID).trim().toLowerCase()
  var extId = EXT_ID_RE.test(extRaw) ? extRaw : DEFAULT_EXT_ID
  var recordingId = (params.get('id') || '').trim()

  var direct =
    'chrome-extension://' +
    extId +
    '/' +
    LIBRARY_PATH +
    (recordingId ? '?id=' + encodeURIComponent(recordingId) : '')

  var titleEl = document.getElementById('title')
  var bodyEl = document.getElementById('body')
  var actionsEl = document.getElementById('actions')
  var hintEl = document.getElementById('hint')
  var openDirectEl = document.getElementById('openDirect')
  var openExtsEl = document.getElementById('openExts')

  if (openDirectEl) openDirectEl.href = direct
  // chrome:// links from https pages often don't navigate; keep as copy tip.
  if (openExtsEl) {
    openExtsEl.addEventListener('click', function (e) {
      e.preventDefault()
      if (hintEl) {
        hintEl.hidden = false
        hintEl.textContent =
          'Paste chrome://extensions into the address bar, confirm MyPipCam is loaded, then try again.'
      }
    })
  }

  function showFallback(reason) {
    if (titleEl) titleEl.textContent = 'Couldn’t reach the extension'
    if (bodyEl) {
      bodyEl.textContent =
        'Load the MyPipCam extension in Chrome (Developer mode → Load unpacked → apps/extension/dist), then click Open extension page. If that shows ERR_BLOCKED_BY_CLIENT, disable your ad blocker for this tab or open Library from the extension popup.'
    }
    if (actionsEl) actionsEl.hidden = false
    if (hintEl) {
      hintEl.hidden = false
      hintEl.textContent =
        (reason ? reason + ' · ' : '') +
        'Direct URL: ' +
        direct
    }
  }

  function showSuccess() {
    if (titleEl) titleEl.textContent = 'Library opened'
    if (bodyEl) {
      bodyEl.textContent =
        'The MyPipCam Library tab should be in front. You can close this bridge tab.'
    }
    if (actionsEl) actionsEl.hidden = true
    if (hintEl) hintEl.hidden = true
  }

  function sendOpenLibrary() {
    return new Promise(function (resolve, reject) {
      if (
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.sendMessage !== 'function'
      ) {
        reject(new Error('Chrome runtime unavailable (open this page in Google Chrome).'))
        return
      }
      try {
        chrome.runtime.sendMessage(
          extId,
          { type: 'OPEN_LIBRARY', id: recordingId || undefined },
          function (response) {
            var err =
              chrome.runtime.lastError && chrome.runtime.lastError.message
            if (err) {
              reject(new Error(err))
              return
            }
            if (response && response.ok) {
              resolve(response)
              return
            }
            reject(
              new Error(
                (response && response.error) ||
                  'Extension did not open the library',
              ),
            )
          },
        )
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  sendOpenLibrary()
    .then(function () {
      showSuccess()
    })
    .catch(function (err) {
      showFallback(err && err.message ? err.message : String(err))
    })
})()
