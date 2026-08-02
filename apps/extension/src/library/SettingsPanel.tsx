import { useCallback, useEffect, useState } from 'react'
import {
  hasOpenAiKey,
  loadApiSettings,
  saveApiSettings,
} from '../shared/apiSettings'
import {
  clearLibraryFolder,
  getLibraryFolderName,
  pickLibraryFolder,
} from '../shared/libraryFs'
import { migrateIdbToFolder } from '../shared/db'
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  getDriveConnectionStatus,
  setDriveAutoUpload,
  type DriveConnectionStatus,
} from '../shared/driveSync'
import { DRIVE_LIBRARY_FOLDER_NAME, isOAuthClientConfigured } from '../shared/driveConfig'
import type { ApiSettings } from '../shared/types'

type Props = {
  open: boolean
  onClose: () => void
  onSaved?: (settings: ApiSettings) => void
  onLibraryFolderChanged?: (folderName: string | null) => void
  onDriveChanged?: () => void
}

export function SettingsPanel({
  open,
  onClose,
  onSaved,
  onLibraryFolderChanged,
  onDriveChanged,
}: Props) {
  const [openai, setOpenai] = useState('')
  const [folderName, setFolderName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const [driveBusy, setDriveBusy] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [folderMsg, setFolderMsg] = useState<string | null>(null)
  const [driveMsg, setDriveMsg] = useState<string | null>(null)
  const [drive, setDrive] = useState<DriveConnectionStatus | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refreshFolder = useCallback(async () => {
    try {
      const name = await getLibraryFolderName()
      setFolderName(name)
      return name
    } catch {
      setFolderName(null)
      return null
    }
  }, [])

  const refreshDrive = useCallback(async () => {
    try {
      // Never block Settings forever on identity / SW messaging.
      const status = await Promise.race([
        getDriveConnectionStatus(),
        new Promise<DriveConnectionStatus>((resolve) => {
          window.setTimeout(
            () =>
              resolve({
                configured: isOAuthClientConfigured(),
                signedIn: false,
                folderId: null,
                folderName: null,
                autoUpload: true,
              }),
            1500,
          )
        }),
      ])
      setDrive(status)
      return status
    } catch {
      setDrive({
        configured: isOAuthClientConfigured(),
        signedIn: false,
        folderId: null,
        folderName: null,
        autoUpload: true,
      })
      return null
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setLoaded(false)
      return
    }
    setSavedMsg(null)
    setFolderMsg(null)
    setDriveMsg(null)
    setLoaded(false)
    let cancelled = false
    void (async () => {
      try {
        // OpenAI + folder first — never gated on Drive connect status.
        const s = await loadApiSettings()
        if (cancelled) return
        setOpenai(s.openaiApiKey)
        await refreshFolder()
      } catch (err) {
        console.error('[MyPipCam] Settings load failed:', err)
      } finally {
        if (!cancelled) setLoaded(true)
      }
      // Drive status is best-effort after the panel is already usable.
      if (!cancelled) await refreshDrive()
    })()
    return () => {
      cancelled = true
    }
  }, [open, refreshFolder, refreshDrive])

  if (!open) return null

  async function onSave() {
    setSaving(true)
    setSavedMsg(null)
    try {
      const next = await saveApiSettings({ openaiApiKey: openai })
      onSaved?.(next)
      setSavedMsg(
        hasOpenAiKey(next)
          ? 'Saved. Keys stay on this device.'
          : 'Saved. Add an OpenAI key to enable Transcribe.',
      )
    } finally {
      setSaving(false)
    }
  }

  async function onChooseFolder() {
    setFolderBusy(true)
    setFolderMsg(null)
    try {
      const handle = await pickLibraryFolder()
      await refreshFolder()

      const shouldMigrate = window.confirm(
        `Use “${handle.name}” as your recording library?\n\n` +
          'Move existing browser recordings into this folder now?\n' +
          '(Recommended if you recorded before choosing a folder.)',
      )
      if (shouldMigrate) {
        const moved = await migrateIdbToFolder(handle)
        setFolderMsg(
          moved > 0
            ? `Folder set to “${handle.name}”. Moved ${moved} recording${moved === 1 ? '' : 's'}.`
            : `Folder set to “${handle.name}”. No browser recordings to move.`,
        )
      } else {
        setFolderMsg(
          `Folder set to “${handle.name}”. Pick the same folder in the Mac app to share recordings.`,
        )
      }
      onLibraryFolderChanged?.(handle.name)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setFolderMsg(null)
      } else {
        setFolderMsg(err instanceof Error ? err.message : 'Could not choose folder.')
      }
    } finally {
      setFolderBusy(false)
    }
  }

  async function onClearFolder() {
    if (
      !window.confirm(
        'Clear the library folder? New recordings will stay in this browser only until you choose a folder again. Files on disk are not deleted.',
      )
    ) {
      return
    }
    setFolderBusy(true)
    setFolderMsg(null)
    try {
      await clearLibraryFolder()
      await refreshFolder()
      onLibraryFolderChanged?.(null)
      setFolderMsg('Library folder cleared. Browser storage is used until you choose again.')
    } finally {
      setFolderBusy(false)
    }
  }

  async function onConnectDrive() {
    setDriveBusy(true)
    setDriveMsg(null)
    try {
      const status = await connectGoogleDrive()
      setDrive(status)
      setDriveMsg(
        `Connected. Library folder “${status.folderName || DRIVE_LIBRARY_FOLDER_NAME}” on Google Drive.` +
          ' Other Chrome browsers signed into the same Google account will share this folder via sync.',
      )
      onDriveChanged?.()
    } catch (err) {
      setDriveMsg(err instanceof Error ? err.message : 'Could not connect Google Drive.')
    } finally {
      setDriveBusy(false)
    }
  }

  async function onDisconnectDrive() {
    if (!window.confirm('Disconnect Google Drive? Local recordings stay on this device.')) {
      return
    }
    setDriveBusy(true)
    setDriveMsg(null)
    try {
      await disconnectGoogleDrive()
      await refreshDrive()
      setDriveMsg('Google Drive disconnected.')
      onDriveChanged?.()
    } catch (err) {
      setDriveMsg(err instanceof Error ? err.message : 'Could not disconnect.')
    } finally {
      setDriveBusy(false)
    }
  }

  async function onToggleAutoUpload(checked: boolean) {
    await setDriveAutoUpload(checked)
    await refreshDrive()
  }

  const driveConnected = Boolean(drive?.signedIn && drive.folderId)

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>Settings</h2>
            <p className="muted" style={{ margin: '0.25rem 0 0', fontSize: '0.85rem' }}>
              API keys are stored only in this browser via{' '}
              <code>chrome.storage.local</code> — they never leave your device and are not
              synced. Drive folder ID syncs with your Chrome profile.
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="settings-body">
            <section className="settings-section">
              <h3>Recording library</h3>
              <p className="muted feature-note">
                Pick a local folder (e.g. <code>Movies/MyPipCam</code>). Chrome writes recordings
                there; choose the same folder in the Mac app to browse and play them.
              </p>
              <p className="folder-status">
                {folderName ? (
                  <>
                    Current folder: <strong>{folderName}</strong>
                  </>
                ) : (
                  <>Not set — recordings stay in this browser only.</>
                )}
              </p>
              <div className="settings-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={folderBusy}
                  onClick={() => void onChooseFolder()}
                >
                  {folderBusy ? 'Working…' : 'Choose folder…'}
                </button>
                {folderName && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={folderBusy}
                    onClick={() => void onClearFolder()}
                  >
                    Clear
                  </button>
                )}
              </div>
              {folderMsg && <p className="settings-saved">{folderMsg}</p>}
            </section>

            <section className="settings-section">
              <h3>Google Drive</h3>
              <p className="muted feature-note">
                Optional cloud library. Creates a <code>{DRIVE_LIBRARY_FOLDER_NAME}</code> folder
                in your Drive (app-owned files only — <code>drive.file</code> scope). Use the same
                Chrome Google account on other computers to list and play shared uploads.
              </p>
              {!isOAuthClientConfigured() && (
                <p className="settings-warn">
                  OAuth client ID not set. Paste your Chrome-extension client ID into{' '}
                  <code>apps/extension/src/shared/driveConfig.ts</code>, rebuild, and reload the
                  extension. See the README “Google Drive setup” section.
                </p>
              )}
              <p className="folder-status">
                {driveConnected ? (
                  <>
                    Connected — Drive folder: <strong>{drive?.folderName || DRIVE_LIBRARY_FOLDER_NAME}</strong>
                  </>
                ) : (
                  <>Not connected</>
                )}
              </p>
              {driveConnected && (
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={drive?.autoUpload ?? true}
                    onChange={(e) => void onToggleAutoUpload(e.target.checked)}
                  />
                  Auto-upload new recordings to Drive
                </label>
              )}
              <div className="settings-actions">
                {driveConnected ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={driveBusy}
                    onClick={() => void onDisconnectDrive()}
                  >
                    {driveBusy ? 'Working…' : 'Disconnect'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={driveBusy || !isOAuthClientConfigured()}
                    onClick={() => void onConnectDrive()}
                  >
                    {driveBusy ? 'Connecting…' : 'Connect Google'}
                  </button>
                )}
              </div>
              {driveMsg && <p className="settings-saved">{driveMsg}</p>}
            </section>

            <section className="settings-section">
              <h3>OpenAI API key</h3>
              <p className="muted feature-note">
                Required for <strong>Transcribe</strong> and caption / transcript download.
                Uses Whisper (<code>whisper-1</code>).
              </p>
              <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>
                Get a key at{' '}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  platform.openai.com
                </a>
                .
              </p>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={openai}
                onChange={(e) => setOpenai(e.target.value)}
              />
            </section>

            <div className="settings-actions">
              <button type="button" className="primary" disabled={saving} onClick={() => void onSave()}>
                {saving ? 'Saving…' : 'Save key'}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setOpenai('')
                }}
              >
                Clear field
              </button>
            </div>
            {savedMsg && <p className="settings-saved">{savedMsg}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
