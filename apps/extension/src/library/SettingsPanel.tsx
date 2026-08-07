import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  hasOpenAiKey,
  loadApiSettings,
  saveApiSettings,
} from '../shared/apiSettings'
import {
  clearLibraryFolder,
  getLibraryFolderAccess,
  grantLibraryAccess,
  pickLibraryFolder,
} from '../shared/libraryFs'
import {
  flushDriveUploads,
  migrateIdbToFolder,
  syncFoldersAfterFolderPick,
} from '../shared/db'
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  getDriveConnectionStatus,
  isDriveLinked,
  setDriveAutoUpload,
  type DriveConnectionStatus,
} from '../shared/driveSync'
import { loadDriveSettings } from '../shared/driveSettings'
import {
  DRIVE_LIBRARY_FOLDER_NAME,
  expectedExtensionId,
  extensionInstallChannel,
  isKnownExtensionId,
  isOAuthClientConfigured,
  STABLE_EXTENSION_ID,
  type ExtensionInstallChannel,
} from '../shared/driveConfig'
import {
  bugReportGitHubUrl,
  bugReportMailtoUrl,
} from '../shared/bugReport'
import type { ApiSettings } from '../shared/types'

type Props = {
  open: boolean
  onClose: () => void
  onSaved?: (settings: ApiSettings) => void
  onLibraryFolderChanged?: (folderName: string | null) => void
  onDriveChanged?: (status?: DriveConnectionStatus) => void
}

function StatusChip({
  tone,
  children,
}: {
  tone: 'success' | 'neutral' | 'warn'
  children: ReactNode
}) {
  return <span className={`settings-chip settings-chip-${tone}`}>{children}</span>
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
  const [folderHasHandle, setFolderHasHandle] = useState(false)
  const [folderPermissionOk, setFolderPermissionOk] = useState(true)
  const [saving, setSaving] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const [driveBusy, setDriveBusy] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [folderMsg, setFolderMsg] = useState<string | null>(null)
  const [driveMsg, setDriveMsg] = useState<string | null>(null)
  const [driveErr, setDriveErr] = useState(false)
  const [drive, setDrive] = useState<DriveConnectionStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [swHealth, setSwHealth] = useState<{
    id: string
    channel: ExtensionInstallChannel
    expectedId: string
    idMatch: boolean
    ready: boolean
    bootError: string | null
    reachable: boolean
    detail?: string
  } | null>(null)

  const refreshSwHealth = useCallback(async () => {
    const liveId = chrome.runtime.id
    const channel = extensionInstallChannel(liveId)
    const expectedId = expectedExtensionId(liveId)
    const idMatch = isKnownExtensionId(liveId)
    try {
      const res = (await Promise.race([
        chrome.runtime.sendMessage({ type: 'GET_SW_HEALTH' }) as Promise<{
          ok?: boolean
          id?: string
          channel?: ExtensionInstallChannel
          expectedId?: string
          idMatch?: boolean
          ready?: boolean
          bootError?: string | null
        }>,
        new Promise<null>((resolve) => {
          window.setTimeout(() => resolve(null), 2000)
        }),
      ])) as {
        ok?: boolean
        id?: string
        channel?: ExtensionInstallChannel
        expectedId?: string
        idMatch?: boolean
        ready?: boolean
        bootError?: string | null
      } | null

      if (!res) {
        setSwHealth({
          id: liveId,
          channel,
          expectedId,
          idMatch,
          ready: false,
          bootError: null,
          reachable: false,
          detail: 'No response from service worker within 2s.',
        })
        return
      }
      const id = res.id || liveId
      setSwHealth({
        id,
        channel: res.channel ?? extensionInstallChannel(id),
        expectedId: res.expectedId || expectedExtensionId(id),
        idMatch: res.idMatch ?? isKnownExtensionId(id),
        ready: Boolean(res.ready),
        bootError: res.bootError ?? null,
        reachable: true,
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setSwHealth({
        id: liveId,
        channel,
        expectedId,
        idMatch,
        ready: false,
        bootError: null,
        reachable: false,
        detail,
      })
    }
  }, [])

  const refreshFolder = useCallback(async () => {
    try {
      const access = await getLibraryFolderAccess()
      setFolderName(access.folderName)
      setFolderHasHandle(access.hasHandle)
      setFolderPermissionOk(!access.hasHandle || access.permission === 'granted')
      return access.folderName
    } catch {
      setFolderName(null)
      setFolderHasHandle(false)
      setFolderPermissionOk(true)
      return null
    }
  }, [])

  const refreshDrive = useCallback(async () => {
    try {
      const settings = await loadDriveSettings()
      // Never block Settings forever on identity / SW messaging.
      // Keep persisted folderId on timeout so UI stays aligned with Library header.
      const status = await Promise.race([
        getDriveConnectionStatus(),
        new Promise<DriveConnectionStatus>((resolve) => {
          window.setTimeout(
            () =>
              resolve({
                configured: isOAuthClientConfigured(),
                linked: Boolean(settings.folderId),
                signedIn: false,
                folderId: settings.folderId,
                folderName: settings.folderName,
                autoUpload: settings.autoUpload,
              }),
            2500,
          )
        }),
      ])
      setDrive(status)
      return status
    } catch {
      const settings = await loadDriveSettings().catch(() => null)
      const fallback: DriveConnectionStatus = {
        configured: isOAuthClientConfigured(),
        linked: Boolean(settings?.folderId),
        signedIn: false,
        folderId: settings?.folderId ?? null,
        folderName: settings?.folderName ?? null,
        autoUpload: settings?.autoUpload ?? true,
      }
      setDrive(fallback)
      return fallback
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setLoaded(false)
      setAdvancedOpen(false)
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
      // Health + Drive are best-effort after the panel is already usable.
      if (!cancelled) {
        await refreshSwHealth()
        await refreshDrive()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, refreshFolder, refreshDrive, refreshSwHealth])

  if (!open) return null

  async function onSave() {
    setSaving(true)
    setSavedMsg(null)
    try {
      const next = await saveApiSettings({ openaiApiKey: openai })
      onSaved?.(next)
      setSavedMsg(hasOpenAiKey(next) ? 'Key saved.' : 'Cleared.')
    } finally {
      setSaving(false)
    }
  }

  async function onGrantFolder() {
    setFolderBusy(true)
    setFolderMsg(null)
    try {
      const handle = await grantLibraryAccess()
      if (!handle) {
        setFolderMsg(
          'Permission denied. Click Grant again and choose Allow (preferably “Allow on every visit”).',
        )
        await refreshFolder()
        return
      }
      await refreshFolder()
      setFolderMsg(`Access restored to “${handle.name}”.`)
      onLibraryFolderChanged?.(handle.name)
    } catch (err) {
      setFolderMsg(err instanceof Error ? err.message : 'Could not grant folder access.')
    } finally {
      setFolderBusy(false)
    }
  }

  async function onChooseFolder() {
    setFolderBusy(true)
    setFolderMsg(null)
    try {
      const handle = await pickLibraryFolder()
      await syncFoldersAfterFolderPick(handle)
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
            ? `Folder set. Moved ${moved} recording${moved === 1 ? '' : 's'}.`
            : `Folder set to “${handle.name}”.`,
        )
      } else {
        setFolderMsg(`Folder set to “${handle.name}”.`)
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
      setFolderMsg('Folder cleared.')
    } finally {
      setFolderBusy(false)
    }
  }

  async function onConnectDrive() {
    setDriveBusy(true)
    setDriveMsg(null)
    setDriveErr(false)
    try {
      const status = await connectGoogleDrive()
      setDrive(status)
      setDriveErr(false)
      // Flush backlog while the connect gesture / token is fresh.
      try {
        await flushDriveUploads({ interactive: true })
      } catch {
        /* Library banner surfaces remaining pending */
      }
      setDriveMsg(`Connected — ${status.folderName || DRIVE_LIBRARY_FOLDER_NAME}`)
      onDriveChanged?.(status)
    } catch (err) {
      const raw =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'Could not connect Google Drive.'
      setDriveErr(true)
      setDriveMsg(raw)
      console.error('[MyPipCam] Connect Google failed:', err)
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
    setDriveErr(false)
    try {
      await disconnectGoogleDrive()
      const status = await refreshDrive()
      setDriveMsg('Disconnected.')
      onDriveChanged?.(status ?? undefined)
    } catch (err) {
      setDriveErr(true)
      setDriveMsg(err instanceof Error ? err.message : 'Could not disconnect.')
    } finally {
      setDriveBusy(false)
    }
  }

  async function onToggleAutoUpload(checked: boolean) {
    await setDriveAutoUpload(checked)
    const status = await refreshDrive()
    if (checked && status?.linked) {
      try {
        await flushDriveUploads({ interactive: true })
      } catch {
        /* Library banner surfaces remaining pending */
      }
      onDriveChanged?.(status)
    }
  }

  const driveConnected = Boolean(drive && isDriveLinked(drive))
  const driveNeedsReconnect = driveConnected && !drive?.signedIn
  const keySet = openai.trim().length > 0
  const swRuntimeOk = Boolean(swHealth?.reachable && swHealth.ready)
  const swChannel = swHealth?.channel ?? extensionInstallChannel()
  const swIsStore = swChannel === 'store'
  // Store / stable unpacked: healthy when SW is up. Never alarm store users for ID.
  // Random unpacked IDs: soft “Local build” note — not “Needs attention”.
  const swOk = Boolean(swRuntimeOk && swHealth?.idMatch)
  const swNeedsAttention = Boolean(swHealth && !swRuntimeOk)
  const swLocalDevNote = Boolean(
    swHealth && swRuntimeOk && swChannel === 'dev-other',
  )

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {!loaded ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="settings-body">
            <section className="settings-section">
              <div className="settings-section-head">
                <h3>Local folder</h3>
                <p className="settings-hint">Where new recordings are saved on this device.</p>
              </div>
              <div className="settings-row">
                <div className="settings-status-line">
                  {folderName ? (
                    <>
                      <span className="settings-status-label">{folderName}</span>
                      {folderPermissionOk ? (
                        <StatusChip tone="success">
                          <span className="settings-chip-check" aria-hidden="true">
                            ✓
                          </span>
                          Set
                        </StatusChip>
                      ) : (
                        <StatusChip tone="warn">Access expired</StatusChip>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="settings-status-label muted">No folder</span>
                      <StatusChip tone="neutral">Browser only</StatusChip>
                    </>
                  )}
                </div>
                <div className="settings-actions">
                  {!folderPermissionOk && folderHasHandle && (
                    <button
                      type="button"
                      className="primary"
                      disabled={folderBusy}
                      onClick={() => void onGrantFolder()}
                    >
                      {folderBusy
                        ? 'Working…'
                        : `Grant access to ${folderName || 'folder'}`}
                    </button>
                  )}
                  <button
                    type="button"
                    className={
                      !folderPermissionOk && folderHasHandle ? 'ghost' : 'primary'
                    }
                    disabled={folderBusy}
                    onClick={() => void onChooseFolder()}
                  >
                    {folderBusy
                      ? 'Working…'
                      : folderName
                        ? folderPermissionOk
                          ? 'Change…'
                          : folderHasHandle
                            ? 'Change folder…'
                            : 'Choose folder again…'
                        : 'Choose folder…'}
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
              </div>
              {!folderPermissionOk && folderHasHandle && folderName && (
                <p className="settings-warn">
                  Chrome still knows “{folderName}” — grant access with one click (no need to
                  re-pick). Prefer <em>Allow on every visit</em> when prompted.
                </p>
              )}
              {!folderPermissionOk && !folderHasHandle && folderName && (
                <p className="settings-warn">
                  Saved folder name “{folderName}” but the directory handle is missing — choose
                  the folder again once.
                </p>
              )}
              {folderMsg && <p className="settings-saved">{folderMsg}</p>}
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <h3>Google Drive</h3>
                <p className="settings-hint">Optional sync via your Chrome Google account.</p>
              </div>
              {!isOAuthClientConfigured() && (
                <p className="settings-warn">
                  OAuth client missing. Set <code>VITE_GOOGLE_OAUTH_CLIENT_ID</code> in{' '}
                  <code>.env.local</code>, rebuild, and reload.
                </p>
              )}
              <div className="settings-row">
                <div className="settings-status-line">
                  {driveConnected ? (
                    <>
                      <StatusChip tone={driveNeedsReconnect ? 'warn' : 'success'}>
                        {!driveNeedsReconnect && (
                          <span className="settings-chip-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                        {driveNeedsReconnect ? 'Reconnect needed' : 'Connected'}
                      </StatusChip>
                      <span className="settings-status-meta">
                        {drive?.folderName || DRIVE_LIBRARY_FOLDER_NAME}
                      </span>
                    </>
                  ) : (
                    <StatusChip tone="neutral">Not connected</StatusChip>
                  )}
                </div>
                <div className="settings-actions">
                  {driveConnected && !driveNeedsReconnect ? (
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
                      {driveBusy
                        ? 'Connecting…'
                        : driveNeedsReconnect
                          ? 'Reconnect'
                          : 'Connect'}
                    </button>
                  )}
                  {driveNeedsReconnect && (
                    <button
                      type="button"
                      className="ghost"
                      disabled={driveBusy}
                      onClick={() => void onDisconnectDrive()}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              </div>
              {driveConnected && (
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={drive?.autoUpload ?? true}
                    onChange={(e) => void onToggleAutoUpload(e.target.checked)}
                  />
                  Auto-upload new recordings
                </label>
              )}
              {driveMsg && (
                <p className={driveErr ? 'settings-warn' : 'settings-saved'}>{driveMsg}</p>
              )}
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <h3>OpenAI</h3>
                <p className="settings-hint">
                  For Transcribe ·{' '}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Get a key
                  </a>
                </p>
              </div>
              <div className="settings-status-line settings-status-line-spaced">
                {keySet ? (
                  <StatusChip tone="success">
                    <span className="settings-chip-check" aria-hidden="true">
                      ✓
                    </span>
                    Key set
                  </StatusChip>
                ) : (
                  <StatusChip tone="neutral">Not set</StatusChip>
                )}
              </div>
              <div className="settings-key-row">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-…"
                  value={openai}
                  onChange={(e) => setOpenai(e.target.value)}
                />
                <div className="settings-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => void onSave()}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  {keySet && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setOpenai('')
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              {savedMsg && <p className="settings-saved">{savedMsg}</p>}
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <h3>Report a bug</h3>
                <p className="settings-hint">
                  Found a bug? Report it — we actually read these.
                </p>
              </div>
              <div className="settings-actions">
                <a
                  className="settings-link-btn primary"
                  href={bugReportGitHubUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open GitHub issue
                </a>
                <a
                  className="settings-link-btn ghost"
                  href={bugReportMailtoUrl()}
                >
                  Email instead
                </a>
              </div>
              <p className="settings-hint settings-feedback-meta">
                Prefills version, install channel, and a short browser string — no API
                keys or Drive tokens.
              </p>
            </section>

            <details
              className="settings-advanced"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary className="settings-advanced-summary">
                <span className="settings-advanced-label">Advanced</span>
                {swHealth && (
                  <StatusChip
                    tone={
                      swOk
                        ? 'success'
                        : swNeedsAttention
                          ? 'warn'
                          : swLocalDevNote
                            ? 'neutral'
                            : 'neutral'
                    }
                  >
                    {swOk
                      ? swIsStore
                        ? 'Store install'
                        : 'Healthy'
                      : swNeedsAttention
                        ? 'Needs attention'
                        : swLocalDevNote
                          ? 'Local build'
                          : 'Checking…'}
                  </StatusChip>
                )}
              </summary>
              <div className="settings-advanced-body">
                <p className="settings-hint">
                  Chrome Web Store installs update automatically.
                  {swIsStore ? null : (
                    <>
                      {' '}
                      <span className="muted">
                        Developers: Load unpacked from <code>apps/extension/dist</code>{' '}
                        after build (stable local ID{' '}
                        <code>{STABLE_EXTENSION_ID}</code>).
                      </span>
                    </>
                  )}
                </p>
                {swHealth && (
                  <div className="settings-health-meta">
                    <div>
                      {swIsStore ? 'Chrome Web Store' : 'Install'} · ID{' '}
                      <code>{swHealth.id}</code>
                      {swLocalDevNote && (
                        <span className="muted">
                          {' '}
                          (random ID — dist missing manifest <code>key</code>)
                        </span>
                      )}
                    </div>
                    <div>
                      Service worker:{' '}
                      {!swHealth.reachable
                        ? 'unreachable'
                        : swHealth.ready
                          ? 'ready'
                          : 'booting / main failed'}
                      {swHealth.bootError ? ` — ${swHealth.bootError}` : ''}
                      {swHealth.detail ? ` — ${swHealth.detail}` : ''}
                    </div>
                  </div>
                )}
                {swNeedsAttention && swIsStore && (
                  <p className="settings-warn">
                    Reload MyPipCam on chrome://extensions, or reinstall from the{' '}
                    <a
                      href="https://chromewebstore.google.com/detail/mypipcam/meiehjfjcaahfjcdneoegjkmajbfghmm"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Chrome Web Store
                    </a>
                    .
                  </p>
                )}
                {swNeedsAttention && !swIsStore && (
                  <p className="settings-warn">
                    On chrome://extensions → Reload MyPipCam. For local builds, Load
                    unpacked → <code>apps/extension/dist</code> (confirm ID{' '}
                    <code>{STABLE_EXTENSION_ID}</code>).
                  </p>
                )}
                {swLocalDevNote && (
                  <p className="settings-hint">
                    Optional for Drive OAuth: rebuild so <code>manifest.key</code> is
                    present, then Load unpacked → <code>apps/extension/dist</code>{' '}
                    (ID <code>{STABLE_EXTENSION_ID}</code>).
                  </p>
                )}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
