/**
 * Injected into the active tab via chrome.scripting.executeScript.
 * Must stay import-free so Chrome can serialize it into the page world.
 *
 * Shows a brand-neutral dark scrim while the extension popup is open.
 * z-index sits just under the recording overlay (2147483647).
 */
export function applyPopupPageDim(visible: boolean): void {
  const ID = 'mypipcam-popup-dim'
  const existing = document.getElementById(ID)

  if (!visible) {
    existing?.remove()
    return
  }

  // Recording chrome owns the top layer — skip dim while it's mounted.
  if (document.getElementById('mypipcam-tab-overlay-root')) {
    existing?.remove()
    return
  }

  if (existing) return

  const el = document.createElement('div')
  el.id = ID
  el.setAttribute('data-mypipcam', 'popup-dim')
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'width:100vw',
    'height:100vh',
    'margin:0',
    'padding:0',
    'border:none',
    'z-index:2147483646',
    'background:rgba(0,0,0,0.5)',
    'pointer-events:auto',
    'cursor:default',
    'opacity:1',
    'visibility:visible',
  ].join(';')

  const block = (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
  }
  el.addEventListener('click', block, true)
  el.addEventListener('mousedown', block, true)
  el.addEventListener('mouseup', block, true)
  el.addEventListener('contextmenu', block, true)
  el.addEventListener('wheel', block, { capture: true, passive: false })
  el.addEventListener('touchstart', block, { capture: true, passive: false })

  const root = document.documentElement || document.body
  root.appendChild(el)
}
