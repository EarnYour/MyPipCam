import { useEffect, useState } from 'react'
import { openLibraryTab, openRecorderTab } from '../shared/navigation'
import { loadPipSettings, savePipSettings } from '../shared/settings'

export function PopupApp() {
  const [busy, setBusy] = useState(false)
  const [openOnFinish, setOpenOnFinish] = useState(true)

  useEffect(() => {
    void loadPipSettings().then((s) => setOpenOnFinish(s.openLibraryOnFinish))
  }, [])

  async function start() {
    setBusy(true)
    try {
      await openRecorderTab()
      window.close()
    } finally {
      setBusy(false)
    }
  }

  async function toggleOpenOnFinish(next: boolean) {
    setOpenOnFinish(next)
    await savePipSettings({ openLibraryOnFinish: next })
  }

  return (
    <div className="popup">
      <div className="popup-brand">
        <div className="popup-logo" aria-hidden />
        <div>
          <h1 className="brand">MyPipCam</h1>
          <p>Screen + camera PiP</p>
        </div>
      </div>

      <button className="primary" disabled={busy} onClick={() => void start()}>
        {busy ? 'Opening…' : 'Start recording'}
      </button>

      <div className="popup-actions">
        <button type="button" onClick={() => void openLibraryTab()}>
          Library
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => void openRecorderTab().then(() => window.close())}
        >
          Recorder
        </button>
      </div>

      <label>
        <input
          type="checkbox"
          checked={openOnFinish}
          onChange={(e) => void toggleOpenOnFinish(e.target.checked)}
        />
        Open library when done
      </label>

      <p className="popup-hint">Shortcut: ⌘⇧U / Ctrl+Shift+U</p>
    </div>
  )
}
