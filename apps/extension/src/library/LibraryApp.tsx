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
import {
  createOrGetShare,
  fetchShareStats,
  formatLastViewed,
  formatViewBadge,
} from '../shared/shareApi'
import { formatDate, formatDuration, type RecordingMeta } from '../shared/types'
import { SettingsPanel } from './SettingsPanel'

type SortKey = 'date' | 'title'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function readDetailIdFromUrl(): string | null {
  const raw = new URLSearchParams(window.location.search).get('id')
  return raw && UUID_RE.test(raw) ? raw : null
}

function writeDetailIdToUrl(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('id', id)
  else url.searchParams.delete('id')
  const next = `${url.pathname}${url.search}${url.hash}`
  const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (next !== cur) {
    window.history.pushState({}, '', next)
  }
}

export function LibraryApp() {
  const [items, setItems] = useState<RecordingMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('date')
  const [detailId, setDetailId] = useState<string | null>(() => readDetailIdFromUrl())
  const [playing, setPlaying] = useState<{ id: string; url: string; title: string } | null>(
    null,
  )
  const [playerLoading, setPlayerLoading] = useState(false)
  const [playerError, setPlayerError] = useState<string | null>(null)
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
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
      let list = await listRecordings()

      const shareIds = list.map((i) => i.shareId).filter((id): id is string => Boolean(id))
      if (shareIds.length > 0) {
        try {
          const stats = await fetchShareStats(shareIds)
          list = await Promise.all(
            list.map(async (item) => {
              if (!item.shareId) return item
              const s = stats[item.shareId]
              if (!s) return item
              const patch = {
                shareViewCount: s.viewCount,
                shareLastViewedAt: s.lastViewedAt,
              }
              try {
                await updateRecordingDriveMeta(item.id, patch)
              } catch {
                /* cache best-effort */
              }
              return { ...item, ...patch }
            }),
          )
        } catch {
          /* share API optional offline */
        }
      }

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

  const openDetail = useCallback((id: string) => {
    writeDetailIdToUrl(id)
    setDetailId(id)
  }, [])

  const closeDetail = useCallback(() => {
    writeDetailIdToUrl(null)
    setDetailId(null)
  }, [])

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('settings') === '1') {
      setSettingsOpen(true)
    }
    void refreshFolderName()
    void refresh()

    const onPopState = () => setDetailId(readDetailIdFromUrl())
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      Object.values(thumbUrls).forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshFolderName])

  // Load video when detail opens / changes.
  useEffect(() => {
    if (!detailId) {
      setPlaying((prev) => {
        if (prev) URL.revokeObjectURL(prev.url)
        return null
      })
      setPlayerLoading(false)
      setPlayerError(null)
      return
    }

    let cancelled = false
    setPlayerLoading(true)
    setPlayerError(null)

    void (async () => {
      try {
        const rec = await getRecording(detailId)
        if (cancelled) return
        if (!rec) {
          setPlaying((prev) => {
            if (prev) URL.revokeObjectURL(prev.url)
            return null
          })
          setPlayerError('Recording not found or could not be loaded.')
          return
        }
        const url = URL.createObjectURL(rec.blob)
        setPlaying((prev) => {
          if (prev) URL.revokeObjectURL(prev.url)
          return { id: detailId, url, title: rec.title }
        })
      } catch {
        if (!cancelled) {
          setPlaying((prev) => {
            if (prev) URL.revokeObjectURL(prev.url)
            return null
          })
          setPlayerError('Could not load this recording.')
        }
      } finally {
        if (!cancelled) setPlayerLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [detailId])

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

  const detailItem = useMemo(
    () => (detailId ? items.find((i) => i.id === detailId) ?? null : null),
    [detailId, items],
  )

  async function onRename(id: string, title: string) {
    await renameRecording(id, title)
    const next = title.trim()
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, title: next || i.title } : i)))
    setPlaying((p) => (p?.id === id ? { ...p, title: next || p.title } : p))
  }

  async function onDelete(id: string) {
    if (!window.confirm('Delete this recording? This cannot be undone.')) return
    await deleteRecording(id)
    if (detailId === id) closeDetail()
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

      // Drive “anyone with the link” so the watch page embed can play.
      const { webViewLink } = await shareRecordingOnDrive(driveFileId)

      // Register MyPipCam watch URL (view tracking). Copied link is /w/{shareId}, not raw Drive.
      const share = await createOrGetShare({
        recordingId: id,
        driveFileId,
        driveWebViewLink: webViewLink,
      })

      const patch = {
        driveFileId,
        driveWebViewLink: webViewLink,
        driveShared: true,
        shareId: share.id,
        shareViewCount: share.viewCount,
        shareLastViewedAt: share.lastViewedAt,
      }
      await updateRecordingDriveMeta(id, patch)
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))

      try {
        await navigator.clipboard.writeText(share.watchUrl)
        setBannerMsg(
          'MyPipCam link copied — anyone with the link can watch. Views show on this recording.',
        )
      } catch {
        setBannerMsg(`Share link: ${share.watchUrl}`)
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

  const showDetail = Boolean(detailId)

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

      {!folderName && !showDetail && (
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

      {showDetail ? (
        <RecordingDetail
          item={detailItem}
          detailId={detailId!}
          playing={playing}
          playerLoading={playerLoading}
          playerError={playerError}
          busyId={busyId}
          driveConnected={driveConnected}
          onBack={closeDetail}
          onRename={onRename}
          onDelete={onDelete}
          onDownload={onDownload}
          onUploadToDrive={onUploadToDrive}
          onShare={onShare}
          onEdit={(id) => void openEditorTab(id)}
        />
      ) : (
        <>
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
                  className="recording-card recording-card-clickable"
                  role="link"
                  tabIndex={0}
                  aria-label={`Open ${item.title}`}
                  onClick={() => openDetail(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openDetail(item.id)
                    }
                  }}
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
                    <h3 className="card-title">{item.title}</h3>
                    <div className="card-meta">
                      {formatDate(item.createdAt)} · {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                      {item.transcript ? ' · Transcript' : ''}
                      {item.driveOnly ? ' · Drive only' : ''}
                      {item.driveShared ? ' · Shared' : ''}
                      {(item.shareId || item.shareViewCount != null) &&
                        ` · ${formatViewBadge(item.shareViewCount)}`}
                    </div>
                    <div className="card-actions">
                      {!item.driveOnly && (
                        <button
                          type="button"
                          className="danger card-action-delete"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            void onDelete(item.id)
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
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

type DetailProps = {
  item: RecordingMeta | null
  detailId: string
  playing: { id: string; url: string; title: string } | null
  playerLoading: boolean
  playerError: string | null
  busyId: string | null
  driveConnected: boolean
  onBack: () => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onDownload: (id: string) => Promise<void>
  onUploadToDrive: (id: string) => Promise<void>
  onShare: (id: string) => Promise<void>
  onEdit: (id: string) => void
}

function RecordingDetail({
  item,
  detailId,
  playing,
  playerLoading,
  playerError,
  busyId,
  driveConnected,
  onBack,
  onRename,
  onDelete,
  onDownload,
  onUploadToDrive,
  onShare,
  onEdit,
}: DetailProps) {
  const title = item?.title ?? playing?.title ?? 'Recording'
  const busy = busyId === detailId
  const hasShareMeta = Boolean(item?.shareId) || item?.shareViewCount != null

  return (
    <section className="recording-detail" aria-label="Recording detail">
      <div className="detail-toolbar">
        <button type="button" className="ghost" onClick={onBack}>
          ← Back to library
        </button>
      </div>

      <div className="detail-player">
        {playerLoading && !playing ? (
          <div className="detail-player-placeholder muted">Loading video…</div>
        ) : playerError && !playing ? (
          <div className="detail-player-placeholder muted">{playerError}</div>
        ) : playing ? (
          <video key={playing.url} src={playing.url} controls autoPlay playsInline />
        ) : (
          <div className="detail-player-placeholder muted">No preview available.</div>
        )}
      </div>

      <div className="detail-body">
        <InlineRename
          title={title}
          as="h1"
          className="detail-title"
          onSave={(next) => onRename(detailId, next)}
        />

        {item ? (
          <div className="detail-meta">
            <span>{formatDate(item.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDuration(item.durationMs)}</span>
            <span aria-hidden="true">·</span>
            <span>{(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB</span>
            {item.transcript ? (
              <>
                <span aria-hidden="true">·</span>
                <span>Transcript</span>
              </>
            ) : null}
            {item.driveOnly ? (
              <>
                <span aria-hidden="true">·</span>
                <span>Drive only</span>
              </>
            ) : null}
            {item.driveFileId ? (
              <>
                <span aria-hidden="true">·</span>
                <span>On Drive</span>
              </>
            ) : null}
          </div>
        ) : (
          <div className="detail-meta muted">
            {playerLoading ? 'Loading details…' : 'Recording metadata unavailable.'}
          </div>
        )}

        {/* Slot for share view-tracking (populated when share meta exists). */}
        <div className="detail-views" data-slot="share-views">
          {hasShareMeta ? (
            <>
              <span className="detail-views-count">
                {formatViewBadge(item?.shareViewCount)}
              </span>
              <span className="detail-views-last muted">
                {formatLastViewed(item?.shareLastViewedAt)}
              </span>
            </>
          ) : item?.driveShared ? (
            <span className="muted">Views appear after the share page tracks opens.</span>
          ) : null}
        </div>

        <div className="detail-actions">
          {item && !item.driveOnly && (
            <button type="button" className="primary" onClick={() => onEdit(detailId)}>
              Edit
            </button>
          )}
          {driveConnected && (
            <button type="button" disabled={busy} onClick={() => void onShare(detailId)}>
              {busy ? 'Working…' : item?.driveShared ? 'Copy link' : 'Share'}
            </button>
          )}
          {driveConnected && item && !item.driveFileId && !item.driveOnly && (
            <button type="button" disabled={busy} onClick={() => void onUploadToDrive(detailId)}>
              {busy ? 'Uploading…' : 'Upload to Drive'}
            </button>
          )}
          {item?.driveWebViewLink && (
            <a
              className="button-link"
              href={item.driveWebViewLink}
              target="_blank"
              rel="noreferrer"
            >
              Open in Drive
            </a>
          )}
          <button type="button" onClick={() => void onDownload(detailId)}>
            Download
          </button>
          {item && !item.driveOnly && (
            <button type="button" className="danger" onClick={() => void onDelete(detailId)}>
              Delete
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
