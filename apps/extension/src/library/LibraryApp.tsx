import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteRecording,
  downloadBlob,
  flushDriveUploads,
  flushPendingToFolder,
  folderRootInteractive,
  getRecording,
  listRecordings,
  migrateIdbToFolder,
  recordingFilename,
  renameRecording,
  updateRecordingDriveMeta,
} from '../shared/db'
import { InlineRename } from '../shared/InlineRename'
import {
  getLibraryFolderName,
  hasLibraryFolder,
  pickLibraryFolder,
} from '../shared/libraryFs'
import { openEditorTab, openRecorderTab } from '../shared/navigation'
import {
  getDriveConnectionStatus,
  shareRecordingOnDrive,
  uploadRecordingToDrive,
} from '../shared/driveSync'
import { formatDate, formatDuration, type RecordingMeta } from '../shared/types'
import { SettingsPanel } from './SettingsPanel'

type SortKey = 'date' | 'title'

export function LibraryApp() {
  const [items, setItems] = useState<RecordingMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('date')
  const [playing, setPlaying] = useState<{ id: string; url: string; title: string } | null>(
    null,
  )
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [folderName, setFolderName] = useState<string | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const [bannerMsg, setBannerMsg] = useState<string | null>(null)
  const [driveConnected, setDriveConnected] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refreshFolderName = useCallback(async () => {
    setFolderName(await getLibraryFolderName())
  }, [])

  const refreshDriveStatus = useCallback(async () => {
    const status = await getDriveConnectionStatus()
    setDriveConnected(Boolean(status.signedIn && status.folderId))
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      if (await hasLibraryFolder()) {
        const root = await folderRootInteractive()
        if (root) {
          await flushPendingToFolder(root)
        }
      }
      try {
        await flushDriveUploads({ interactive: false })
      } catch {
        /* optional */
      }
      await refreshDriveStatus()
      const list = await listRecordings()
      setItems(list)
      const urls: Record<string, string> = {}
      for (const item of list) {
        if (item.thumbnail) {
          urls[item.id] = URL.createObjectURL(item.thumbnail)
        }
      }
      setThumbUrls((prev) => {
        Object.values(prev).forEach((u) => URL.revokeObjectURL(u))
        return urls
      })
    } finally {
      setLoading(false)
    }
  }, [refreshDriveStatus])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const rawId = params.get('id')
    const safeId =
      rawId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawId)
        ? rawId
        : null
    setHighlightId(safeId)
    if (params.get('settings') === '1') setSettingsOpen(true)
    void refreshFolderName()
    void refresh()
    return () => {
      Object.values(thumbUrls).forEach((u) => URL.revokeObjectURL(u))
      if (playing) URL.revokeObjectURL(playing.url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshFolderName])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let next = items
    if (q) next = next.filter((i) => i.title.toLowerCase().includes(q))
    next = [...next].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title)
      return b.createdAt - a.createdAt
    })
    return next
  }, [items, query, sort])

  async function onPlay(id: string) {
    const rec = await getRecording(id)
    if (!rec) return
    if (playing) URL.revokeObjectURL(playing.url)
    setPlaying({ id, url: URL.createObjectURL(rec.blob), title: rec.title })
  }

  async function onRename(id: string, title: string) {
    await renameRecording(id, title)
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, title: title.trim() || i.title } : i)))
    setPlaying((p) => (p?.id === id ? { ...p, title: title.trim() || p.title } : p))
  }

  async function onDelete(id: string) {
    if (!window.confirm('Delete this recording? This cannot be undone.')) return
    await deleteRecording(id)
    if (playing?.id === id) {
      URL.revokeObjectURL(playing.url)
      setPlaying(null)
    }
    await refresh()
  }

  async function onDownload(id: string) {
    const rec = await getRecording(id)
    if (!rec) return
    downloadBlob(rec.blob, recordingFilename(rec))
  }

  async function onUploadToDrive(id: string) {
    setBusyId(id)
    setBannerMsg(null)
    try {
      const rec = await getRecording(id)
      if (!rec) throw new Error('Recording not found.')
      const result = await uploadRecordingToDrive(rec, { interactive: true })
      await updateRecordingDriveMeta(id, {
        driveFileId: result.driveFileId,
        driveWebViewLink: result.driveWebViewLink,
        driveShared: result.driveShared,
      })
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? {
                ...i,
                driveFileId: result.driveFileId,
                driveWebViewLink: result.driveWebViewLink,
                driveShared: result.driveShared,
                driveOnly: undefined,
              }
            : i,
        ),
      )
      setBannerMsg('Uploaded to Google Drive.')
    } catch (err) {
      setBannerMsg(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setBusyId(null)
    }
  }

  async function onShare(id: string) {
    setBusyId(id)
    setBannerMsg(null)
    try {
      let item = items.find((i) => i.id === id)
      let driveFileId = item?.driveFileId

      if (!driveFileId) {
        const rec = await getRecording(id)
        if (!rec) throw new Error('Recording not found.')
        const uploaded = await uploadRecordingToDrive(rec, { interactive: true })
        driveFileId = uploaded.driveFileId
        await updateRecordingDriveMeta(id, {
          driveFileId: uploaded.driveFileId,
          driveWebViewLink: uploaded.driveWebViewLink,
          driveShared: uploaded.driveShared,
        })
        item = {
          ...(item ?? rec),
          driveFileId: uploaded.driveFileId,
          driveWebViewLink: uploaded.driveWebViewLink,
        }
      }

      const { webViewLink } = await shareRecordingOnDrive(driveFileId)
      await updateRecordingDriveMeta(id, {
        driveFileId,
        driveWebViewLink: webViewLink,
        driveShared: true,
      })
      setItems((prev) =>
        prev.map((i) =>
          i.id === id
            ? { ...i, driveFileId, driveWebViewLink: webViewLink, driveShared: true }
            : i,
        ),
      )

      try {
        await navigator.clipboard.writeText(webViewLink)
        setBannerMsg('Share link copied — anyone with the link can view.')
      } catch {
        setBannerMsg(`Share link: ${webViewLink}`)
      }
    } catch (err) {
      setBannerMsg(err instanceof Error ? err.message : 'Could not share.')
    } finally {
      setBusyId(null)
    }
  }

  async function onChooseFolderFromBanner() {
    setFolderBusy(true)
    setBannerMsg(null)
    try {
      const handle = await pickLibraryFolder()
      await refreshFolderName()
      const shouldMigrate = window.confirm(
        `Use “${handle.name}” as your recording library?\n\n` +
          'Move existing browser recordings into this folder now?',
      )
      if (shouldMigrate) {
        const moved = await migrateIdbToFolder(handle)
        setBannerMsg(
          moved > 0
            ? `Moved ${moved} recording${moved === 1 ? '' : 's'} into “${handle.name}”.`
            : `Folder set to “${handle.name}”.`,
        )
      } else {
        setBannerMsg(`Folder set to “${handle.name}”.`)
      }
      await refresh()
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setBannerMsg(err instanceof Error ? err.message : 'Could not choose folder.')
      }
    } finally {
      setFolderBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="brand">MyPipCam Library</h1>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            {folderName
              ? `Shared folder “${folderName}” — pick the same path in the Mac app to browse these clips.`
              : 'Local recordings only — nothing leaves this browser unless you use cloud features.'}
            {driveConnected ? ' Google Drive connected.' : ''}
          </p>
        </div>
        <div className="row">
          <button type="button" className="ghost" onClick={() => setSettingsOpen(true)} title="Settings">
            Settings
          </button>
          <button type="button" className="primary" onClick={() => void openRecorderTab()}>
            New recording
          </button>
        </div>
      </header>

      {!folderName && (
        <div className="library-banner" role="status">
          <div>
            <strong>Choose a shared library folder</strong>
            <p className="muted" style={{ margin: '0.2rem 0 0' }}>
              Optional — recordings stay in this browser until you pick a folder. Suggested:{' '}
              <code>Movies/MyPipCam</code>. Use the same folder in the Mac app.
            </p>
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={folderBusy}
              onClick={() => void onChooseFolderFromBanner()}
            >
              {folderBusy ? 'Working…' : 'Choose folder…'}
            </button>
            <button type="button" className="ghost" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
        </div>
      )}

      {bannerMsg && (
        <div className="library-banner library-banner-ok" role="status">
          <p style={{ margin: 0 }}>{bannerMsg}</p>
          <button type="button" className="ghost" onClick={() => setBannerMsg(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="search-row">
        <input
          type="search"
          placeholder="Search titles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="date">Newest first</option>
          <option value="title">Title A–Z</option>
        </select>
      </div>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : filtered.length === 0 ? (
        <div className="empty">
          <h2>No recordings yet</h2>
          <p>
            {folderName
              ? `Nothing in “${folderName}” yet. Capture a clip and it will appear here and on disk.`
              : 'Capture your screen with a camera PiP, then manage clips here.'}
          </p>
          <button className="primary" onClick={() => void openRecorderTab()}>
            Start a recording
          </button>
        </div>
      ) : (
        <div className="library-grid">
          {filtered.map((item) => (
            <article
              key={item.id}
              className={`recording-card ${highlightId === item.id ? 'highlight' : ''}`}
            >
              <div className="thumb">
                {thumbUrls[item.id] ? (
                  <img src={thumbUrls[item.id]} alt="" />
                ) : (
                  <div style={{ width: '100%', height: '100%', background: '#111312' }} />
                )}
                <span className="duration">{formatDuration(item.durationMs)}</span>
                {item.driveFileId && (
                  <span className="drive-badge" title="On Google Drive">
                    Drive
                  </span>
                )}
              </div>
              <div className="card-body">
                <InlineRename
                  title={item.title}
                  as="h3"
                  className="card-title"
                  onSave={(next) => onRename(item.id, next)}
                />
                <div className="card-meta">
                  {formatDate(item.createdAt)} · {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                  {item.transcript ? ' · Transcript' : ''}
                  {item.driveOnly ? ' · Drive only' : ''}
                  {item.driveShared ? ' · Shared' : ''}
                </div>
                <div className="card-actions">
                  <button type="button" onClick={() => void onPlay(item.id)}>
                    Play
                  </button>
                  {!item.driveOnly && (
                    <button type="button" onClick={() => void openEditorTab(item.id)}>
                      Edit
                    </button>
                  )}
                  <button type="button" onClick={() => void onDownload(item.id)}>
                    Download
                  </button>
                  {driveConnected && !item.driveFileId && !item.driveOnly && (
                    <button
                      type="button"
                      disabled={busyId === item.id}
                      onClick={() => void onUploadToDrive(item.id)}
                    >
                      {busyId === item.id ? 'Uploading…' : 'Upload to Drive'}
                    </button>
                  )}
                  {driveConnected && (
                    <button
                      type="button"
                      disabled={busyId === item.id}
                      onClick={() => void onShare(item.id)}
                    >
                      {busyId === item.id ? 'Working…' : item.driveShared ? 'Copy link' : 'Share'}
                    </button>
                  )}
                  {!item.driveOnly && (
                    <button type="button" className="danger" onClick={() => void onDelete(item.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {playing && (
        <div
          className="player-modal"
          onClick={() => {
            URL.revokeObjectURL(playing.url)
            setPlaying(null)
          }}
        >
          <div className="player-modal-inner" onClick={(e) => e.stopPropagation()}>
            <video src={playing.url} controls autoPlay />
            <div className="player-modal-bar">
              <strong>{playing.title}</strong>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  URL.revokeObjectURL(playing.url)
                  setPlaying(null)
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLibraryFolderChanged={(name) => {
          setFolderName(name)
          void refresh()
        }}
        onDriveChanged={() => {
          void refresh()
        }}
      />
    </div>
  )
}
