;(function () {
  // Unpacked dist with manifest `key` (local / Load unpacked).
  var UNPACKED_EXT_ID = 'akpchobfndfddajiihkkdpnihihdicjc'
  // Chrome Web Store listing (published zip without `key`).
  var STORE_EXT_ID = 'moalajbpehfocfeecpleceplighfhim'
  var LIBRARY_PATH = 'src/library/index.html'
  var EXT_ID_RE = /^[a-p]{32}$/

  var params = new URLSearchParams(window.location.search)
  var extParam = (params.get('ext') || '').trim().toLowerCase()
  var hasExplicitExt = EXT_ID_RE.test(extParam)
  // Default to published store ID; unpacked remains a fallback (and via ?ext=).
  var primaryId = hasExplicitExt ? extParam : STORE_EXT_ID
  var recordingId = (params.get('id') || '').trim()

  var titleEl = document.getElementById('title')
  var bodyEl = document.getElementById('body')
  var actionsEl = document.getElementById('actions')
  var hintEl = document.getElementById('hint')
  var openDirectEl = document.getElementById('openDirect')
  var openExtsEl = document.getElementById('openExts')

  function directUrl(extId) {
    return (
      'chrome-extension://' +
      extId +
      '/' +
      LIBRARY_PATH +
      (recordingId ? '?id=' + encodeURIComponent(recordingId) : '')
    )
  }

  function setDirectHref(extId) {
    if (openDirectEl) openDirectEl.href = directUrl(extId)
  }

  setDirectHref(primaryId)

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

  function showFallback(reason, extId) {
    if (titleEl) titleEl.textContent = 'Couldn’t reach the extension'
    if (bodyEl) {
      bodyEl.textContent =
        'Install MyPipCam from the Chrome Web Store, or Load unpacked → apps/extension/dist, then click Open extension page. If that shows ERR_BLOCKED_BY_CLIENT, disable your ad blocker for this tab or open Library from the extension popup.'
    }
    if (actionsEl) actionsEl.hidden = false
    if (hintEl) {
      hintEl.hidden = false
      hintEl.textContent =
        (reason ? reason + ' · ' : '') +
        'Tried ID ' +
        extId +
        ' · Direct URL: ' +
        directUrl(extId) +
        ' · Store ID: ' +
        STORE_EXT_ID +
        ' · Unpacked ID: ' +
        UNPACKED_EXT_ID
    }
    setDirectHref(extId)
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

  function sendOpenLibrary(extId) {
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

  function tryIds(ids, index, lastErr) {
    if (index >= ids.length) {
      showFallback(
        lastErr && lastErr.message ? lastErr.message : String(lastErr || ''),
        ids[ids.length - 1] || primaryId,
      )
      return
    }
    var extId = ids[index]
    setDirectHref(extId)
    sendOpenLibrary(extId)
      .then(function () {
        showSuccess()
      })
      .catch(function (err) {
        tryIds(ids, index + 1, err)
      })
  }

  // Explicit ?ext= uses that ID only. Otherwise try store (published) then unpacked.
  var ids = hasExplicitExt
    ? [primaryId]
    : primaryId === UNPACKED_EXT_ID
      ? [UNPACKED_EXT_ID, STORE_EXT_ID]
      : [STORE_EXT_ID, UNPACKED_EXT_ID]

  tryIds(ids, 0, null)
})()
