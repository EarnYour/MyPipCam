import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hasOpenAiKey, loadApiSettings } from '../shared/apiSettings'
import {
  deleteRecording,
  downloadBlob,
  flushDriveUploads,
  flushPendingToFolder,
  folderRootInteractive,
  getDriveUploadNotice,
  getRecording,
  listLibrary,
  migrateIdbToFolder,
  recordingFilename,
  renameRecording,
  updateRecordingDriveMeta,
  updateRecordingTranscript,
} from '../shared/db'
import { InlineRename } from '../shared/InlineRename'
import {
  getLibraryFolderName,
  hasLibraryFolder,
  pickLibraryFolder,
} from '../shared/libraryFs'
import {
  openEditorTab,
  openRecorderTab,
  type EditorFocus,
} from '../shared/navigation'
import { isOAuthClientConfigured } from '../shared/driveConfig'
import { getVideoPlaybackStatus } from '../shared/driveApi'
import {
  connectGoogleDrive,
  consumeDriveUploadToast,
  driveUploadToastStorageKey,
  getDriveConnectionStatus,
  isDriveLinked,
  shareRecordingOnDrive,
  uploadRecordingToDrive,
  waitForDriveVideoReady,
  type DriveConnectionStatus,
} from '../shared/driveSync'
import {
  createOrGetShare,
  DEFAULT_SHARE_TTL_DAYS,
  fetchShareStats,
  formatLastViewed,
  formatShareExpiry,
  isShareExpired,
  renewShare,
  updateShareProcessing,
} from '../shared/shareApi'
import { watchUrlForShareId } from '../shared/shareConfig'
import { formatDate, formatDuration, type RecordingMeta } from '../shared/types'
import { transcribeWithOpenAI } from '../editor/transcribe'
import { SettingsPanel } from './SettingsPanel'

type DetailTab = 'edit' | 'activity' | 'transcript' | 'settings'

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const
const PLAYBACK_RATE_STORAGE_KEY = 'mypipcam.library.playbackRate'

function formatPlaybackRate(rate: number): string {
  return `${rate}x`
}

function readStoredPlaybackRate(): number {
  try {
    const raw = localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY)
    const n = raw == null ? NaN : Number(raw)
    return (PLAYBACK_RATES as readonly number[]).includes(n) ? n : 1
  } catch {
    return 1
  }
}

function persistPlaybackRate(rate: number) {
  try {
    localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(rate))
  } catch {
    /* ignore quota / private mode */
  }
}

function formatDetailViews(viewCount: number | undefined): string {
  const n = viewCount ?? 0
  if (n <= 0) return '0 views'
  return n === 1 ? '1 view' : `${n} views`
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function ShareLinkField({
  url,
  copyLabel = 'Copy',
  className,
}: {
  url: string
  copyLabel?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div className={className ? `share-link-field ${className}` : 'share-link-field'}>
      <input
        type="text"
        className="share-link-input"
        value={url}
        readOnly
        aria-label="Share link"
        onFocus={(e) => e.currentTarget.select()}
        onClick={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        className="share-link-copy"
        onClick={() => {
          void copyText(url).then((ok) => {
            if (ok) setCopied(true)
          })
        }}
      >
        {copied ? 'Copied' : copyLabel}
      </button>
    </div>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) {
    const m = Math.round(diff / 60_000)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (diff < 86_400_000) {
    const h = Math.round(diff / 3_600_000)
    return `about ${h} hour${h === 1 ? '' : 's'} ago`
  }
  if (diff < 7 * 86_400_000) {
    const d = Math.round(diff / 86_400_000)
    return `${d} day${d === 1 ? '' : 's'} ago`
  }
  return formatDate(ts)
}

function formatDurationBadge(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec} sec`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (totalSec < 3600) {
    return s === 0 ? `${m} min` : `${m}:${s.toString().padStart(2, '0')}`
  }
  return formatDuration(ms)
}

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
  const [bannerShareUrl, setBannerShareUrl] = useState<string | null>(null)
  const [bannerTone, setBannerTone] = useState<'ok' | 'warn'>('ok')
  const [driveConnected, setDriveConnected] = useState(false)
  const [driveSignedIn, setDriveSignedIn] = useState(false)
  const [driveConnectBusy, setDriveConnectBusy] = useState(false)
  const [drivePendingCount, setDrivePendingCount] = useState(0)
  const [driveUploadError, setDriveUploadError] = useState<string | null>(null)
  const [driveRetryBusy, setDriveRetryBusy] = useState(false)
  const [folderAccessNeeded, setFolderAccessNeeded] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const showBanner = useCallback(
    (msg: string | null, shareUrl: string | null = null, tone: 'ok' | 'warn' = 'ok') => {
      setBannerMsg(msg)
      setBannerShareUrl(shareUrl)
      setBannerTone(tone)
    },
    [],
  )

  const refreshDriveUploadNotice = useCallback(async () => {
    const notice = await getDriveUploadNotice()
    setDrivePendingCount(notice.pendingCount)
    setDriveUploadError(notice.lastError)
    return notice
  }, [])

  const applyDriveStatus = useCallback((status: DriveConnectionStatus) => {
    setDriveConnected(isDriveLinked(status))
    setDriveSignedIn(Boolean(status.signedIn))
  }, [])

  const refreshFolderName = useCallback(async () => {
    setFolderName(await getLibraryFolderName())
  }, [])

  const refreshDriveStatus = useCallback(async () => {
    const status = await getDriveConnectionStatus()
    applyDriveStatus(status)
    return status
  }, [applyDriveStatus])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      if (await hasLibraryFolder()) {
        // May no-op without a user gesture; grant banner handles re-prompt.
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
      await refreshDriveUploadNotice()
      const listed = await listLibrary()
      setFolderName(listed.folder.folderName)
      setFolderAccessNeeded(
        listed.folder.hasHandle && listed.folder.permission !== 'granted',
      )
      if (listed.driveError && listed.items.length === 0) {
        showBanner(listed.driveError, null, 'warn')
      }
      let list = listed.items

      const shareIds = list.map((i) => i.shareId).filter((id): id is string => Boolean(id))
      if (shareIds.length > 0) {
        try {
          const stats = await fetchShareStats(shareIds)
          list = await Promise.all(
            list.map(async (item) => {
              if (!item.shareId) return item
              const s = stats[item.shareId]
              if (!s) return item
              const patch: Pick<
                RecordingMeta,
                | 'shareViewCount'
                | 'shareLastViewedAt'
                | 'shareExpiresAt'
                | 'driveProcessingStatus'
                | 'driveReadyAt'
              > = {
                shareViewCount: s.viewCount,
                shareLastViewedAt: s.lastViewedAt,
                shareExpiresAt: s.expiresAt ?? null,
              }
              if (s.processingStatus === 'ready' || s.processingStatus === 'processing') {
                patch.driveProcessingStatus = s.processingStatus
              }
              if (s.driveReadyAt) {
                const t = Date.parse(s.driveReadyAt)
                if (Number.isFinite(t)) patch.driveReadyAt = t
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

      // One-shot Drive readiness check for shares still marked processing.
      const processing = list.filter(
        (i) =>
          i.driveFileId &&
          i.driveProcessingStatus === 'processing' &&
          i.shareId,
      )
      if (processing.length > 0) {
        try {
          const driveStatus = await getDriveConnectionStatus()
          if (driveStatus.signedIn) {
            list = await Promise.all(
              list.map(async (item) => {
                if (
                  !item.driveFileId ||
                  item.driveProcessingStatus !== 'processing' ||
                  !item.shareId
                ) {
                  return item
                }
                try {
                  const ready = await getVideoPlaybackStatus(item.driveFileId, false)
                  if (!ready.ready) return item
                  const driveReadyAt = Date.now()
                  const patch = {
                    driveProcessingStatus: 'ready' as const,
                    driveReadyAt,
                  }
                  try {
                    await updateShareProcessing({
                      shareId: item.shareId,
                      processingStatus: 'ready',
                      driveReadyAt: new Date(driveReadyAt).toISOString(),
                    })
                  } catch {
                    /* local still updated */
                  }
                  await updateRecordingDriveMeta(item.id, patch)
                  return { ...item, ...patch }
                } catch {
                  return item
                }
              }),
            )
          }
        } catch {
          /* optional */
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
    } catch (err) {
      // Without this the rejection is unhandled and the library silently shows
      // "No recordings yet", which reads as data loss.
      setBannerMsg(
        err instanceof Error ? err.message : 'Could not load the library. Try reloading.',
      )
    } finally {
      setLoading(false)
    }
  }, [refreshDriveStatus, refreshDriveUploadNotice, showBanner])

  const onRetryDriveUploads = useCallback(async () => {
    setDriveRetryBusy(true)
    showBanner(null)
    try {
      const uploaded = await flushDriveUploads({ interactive: true })
      const notice = await refreshDriveUploadNotice()
      if (notice.pendingCount === 0) {
        showBanner(
          uploaded > 0
            ? `Uploaded ${uploaded} recording${uploaded === 1 ? '' : 's'} to Google Drive.`
            : 'Google Drive is up to date.',
        )
      } else {
        showBanner(
          notice.lastError ||
            `${notice.pendingCount} recording${notice.pendingCount === 1 ? '' : 's'} still waiting to upload.`,
          null,
          'warn',
        )
      }
      await refresh()
    } catch (err) {
      showBanner(
        err instanceof Error ? err.message : 'Could not upload to Google Drive.',
        null,
        'warn',
      )
      await refreshDriveUploadNotice()
    } finally {
      setDriveRetryBusy(false)
    }
  }, [refresh, refreshDriveUploadNotice, showBanner])

  const onConnectDriveFromHeader = useCallback(async () => {
    if (!isOAuthClientConfigured()) {
      setSettingsOpen(true)
      return
    }
    setDriveConnectBusy(true)
    try {
      const status = await connectGoogleDrive()
      applyDriveStatus(status)
      // User gesture still fresh — flush any auto-upload backlog interactively.
      try {
        await flushDriveUploads({ interactive: true })
      } catch {
        /* banner below */
      }
      await refreshDriveUploadNotice()
      showBanner('Google Drive connected.')
      await refresh()
    } catch (err) {
      showBanner(
        err instanceof Error ? err.message : 'Could not connect Google Drive.',
        null,
        'warn',
      )
      setSettingsOpen(true)
    } finally {
      setDriveConnectBusy(false)
    }
  }, [applyDriveStatus, refresh, refreshDriveUploadNotice, showBanner])

  const onGrantFolderAccess = useCallback(async () => {
    setFolderBusy(true)
    showBanner(null)
    try {
      const root = await folderRootInteractive()
      if (!root) {
        showBanner('Folder access expired — Choose folder again in Settings.')
        setFolderAccessNeeded(true)
        setSettingsOpen(true)
        return
      }
      setFolderAccessNeeded(false)
      await refreshFolderName()
      await refresh()
    } finally {
      setFolderBusy(false)
    }
  }, [refresh, refreshFolderName, showBanner])

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

    const showDriveToast = async () => {
      const toast = await consumeDriveUploadToast()
      if (!toast) return
      showBanner(toast.message, null, toast.tone)
      await refreshDriveUploadNotice()
      if (toast.tone === 'ok') await refresh()
    }
    void showDriveToast()

    const onPopState = () => setDetailId(readDetailIdFromUrl())
    const onStorage: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area === 'session' && changes[driveUploadToastStorageKey()]) {
        void showDriveToast()
      }
      if (area === 'local' && (changes.drivePendingUploadIds || changes.driveLastUploadError)) {
        void refreshDriveUploadNotice()
      }
    }
    chrome.storage.onChanged.addListener(onStorage)
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      chrome.storage.onChanged.removeListener(onStorage)
      Object.values(thumbUrls).forEach((u) => URL.revokeObjectURL(u))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshFolderName, refreshDriveUploadNotice, showBanner])

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
    showBanner(null)
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
      showBanner('Uploaded to Google Drive.')
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setBusyId(null)
    }
  }

  async function onShare(id: string) {
    setBusyId(id)
    showBanner(null)
    try {
      let item = items.find((i) => i.id === id)
      let driveFileId = item?.driveFileId

      if (!driveFileId) {
        showBanner('Uploading to Google Drive…')
        const rec = await getRecording(id)
        if (!rec) throw new Error('Recording not found.')
        const uploaded = await uploadRecordingToDrive(rec, { interactive: true })
        driveFileId = uploaded.driveFileId
        await updateRecordingDriveMeta(id, {
          driveFileId: uploaded.driveFileId,
          driveWebViewLink: uploaded.driveWebViewLink,
          driveShared: uploaded.driveShared,
          driveProcessingStatus: 'processing',
        })
        item = {
          ...(item ?? rec),
          driveFileId: uploaded.driveFileId,
          driveWebViewLink: uploaded.driveWebViewLink,
          driveProcessingStatus: 'processing',
        }
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, ...item!, driveOnly: undefined } : i)),
        )
      }

      // Drive “anyone with the link” so the watch page embed can play.
      showBanner('Processing on Google Drive… (no percent — checking until ready)')
      const { webViewLink } = await shareRecordingOnDrive(driveFileId)

      // Register MyPipCam watch URL (view tracking). Copied link is /w/{shareId}, not raw Drive.
      // Links expire after 30 days; re-share auto-renews only when already expired.
      const shouldRenew = isShareExpired(item?.shareExpiresAt)
      let share = await createOrGetShare({
        recordingId: id,
        driveFileId,
        driveWebViewLink: webViewLink,
        processingStatus:
          item?.driveProcessingStatus === 'ready' ? 'ready' : 'processing',
        driveReadyAt:
          item?.driveReadyAt != null
            ? new Date(item.driveReadyAt).toISOString()
            : null,
        renew: shouldRenew,
        expiresInDays: DEFAULT_SHARE_TTL_DAYS,
      })

      const alreadyReady = item?.driveProcessingStatus === 'ready' && item.driveReadyAt
      let driveReadyAt = item?.driveReadyAt
      let driveProcessingStatus: RecordingMeta['driveProcessingStatus'] =
        alreadyReady ? 'ready' : 'processing'

      if (!alreadyReady) {
        const status = await waitForDriveVideoReady(driveFileId, {
          interactive: true,
          onStatus: (s) => {
            if (!s.ready) {
              showBanner(
                'Processing on Google Drive… Waiting for playback readiness.',
                share.watchUrl,
              )
            }
          },
        })
        if (status.ready) {
          driveReadyAt = Date.now()
          driveProcessingStatus = 'ready'
          try {
            share = await updateShareProcessing({
              shareId: share.id,
              processingStatus: 'ready',
              driveReadyAt: new Date(driveReadyAt).toISOString(),
            })
          } catch {
            /* local status still updated; watch page may keep soft-refreshing */
          }
        } else {
          driveProcessingStatus = 'processing'
        }
      }

      const patch: Pick<
        RecordingMeta,
        | 'driveFileId'
        | 'driveWebViewLink'
        | 'driveShared'
        | 'driveProcessingStatus'
        | 'driveReadyAt'
        | 'shareId'
        | 'shareViewCount'
        | 'shareLastViewedAt'
        | 'shareExpiresAt'
      > = {
        driveFileId,
        driveWebViewLink: webViewLink,
        driveShared: true,
        driveProcessingStatus,
        driveReadyAt,
        shareId: share.id,
        shareViewCount: share.viewCount,
        shareLastViewedAt: share.lastViewedAt,
        shareExpiresAt: share.expiresAt ?? null,
      }
      await updateRecordingDriveMeta(id, patch)
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))

      const expiryNote = formatShareExpiry(share.expiresAt)
      const copied = await copyText(share.watchUrl)
      if (driveProcessingStatus === 'ready') {
        showBanner(
          copied
            ? `Link copied — ${expiryNote}. Anyone with it can watch.`
            : `Watch link ready — ${expiryNote}. Copy below.`,
          share.watchUrl,
        )
      } else {
        showBanner(
          copied
            ? `Link copied — Google Drive is still processing playback. ${expiryNote}.`
            : `Share link created — Google Drive is still processing. ${expiryNote}.`,
          share.watchUrl,
        )
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        showBanner('Share cancelled.')
      } else {
        showBanner(err instanceof Error ? err.message : 'Could not share.')
      }
    } finally {
      setBusyId(null)
    }
  }

  async function onRenewShare(id: string) {
    const item = items.find((i) => i.id === id)
    if (!item?.shareId) {
      await onShare(id)
      return
    }
    setBusyId(id)
    showBanner(null)
    try {
      const share = await renewShare({
        shareId: item.shareId,
        expiresInDays: DEFAULT_SHARE_TTL_DAYS,
      })
      const patch: Pick<
        RecordingMeta,
        'shareExpiresAt' | 'shareViewCount' | 'shareLastViewedAt'
      > = {
        shareExpiresAt: share.expiresAt ?? null,
        shareViewCount: share.viewCount,
        shareLastViewedAt: share.lastViewedAt,
      }
      await updateRecordingDriveMeta(id, patch)
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
      const copied = await copyText(share.watchUrl)
      showBanner(
        copied
          ? `Link renewed — ${formatShareExpiry(share.expiresAt)}. Copied to clipboard.`
          : `Link renewed — ${formatShareExpiry(share.expiresAt)}.`,
        share.watchUrl,
      )
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Could not renew share link.')
    } finally {
      setBusyId(null)
    }
  }

  async function onChooseFolderFromBanner() {
    setFolderBusy(true)
    showBanner(null)
    try {
      const handle = await pickLibraryFolder()
      await refreshFolderName()
      const shouldMigrate = window.confirm(
        `Use “${handle.name}” as your recording library?\n\n` +
          'Move existing browser recordings into this folder now?',
      )
      if (shouldMigrate) {
        const moved = await migrateIdbToFolder(handle)
        showBanner(
          moved > 0
            ? `Moved ${moved} recording${moved === 1 ? '' : 's'} into “${handle.name}”.`
            : `Folder set to “${handle.name}”.`,
        )
      } else {
        showBanner(`Folder set to “${handle.name}”.`)
      }
      await refresh()
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        showBanner(err instanceof Error ? err.message : 'Could not choose folder.')
      }
    } finally {
      setFolderBusy(false)
    }
  }

  const showDetail = Boolean(detailId)

  async function onTranscribe(id: string) {
    setBusyId(id)
    showBanner(null)
    try {
      const settings = await loadApiSettings()
      if (!hasOpenAiKey(settings)) {
        setSettingsOpen(true)
        showBanner('Add your OpenAI API key in Settings to generate a transcript.')
        return
      }
      const rec = await getRecording(id)
      if (!rec) throw new Error('Recording not found.')
      const result = await transcribeWithOpenAI(
        rec.blob,
        settings.openaiApiKey,
        recordingFilename(rec),
      )
      await updateRecordingTranscript(id, result)
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, transcript: result } : i)))
      showBanner('Transcript ready.')
    } catch (err) {
      showBanner(err instanceof Error ? err.message : 'Transcription failed.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className={`page ${showDetail ? 'page-detail' : ''}`}>
      {!showDetail && (
        <header className="page-header">
          <div>
            <h1 className="brand">MyPipCam Library</h1>
            <p className="library-status muted">
              <span>
                {folderName ? `Folder: ${folderName}` : 'No local folder'}
                {' · '}
                {driveConnected
                  ? driveSignedIn
                    ? 'Google Drive connected'
                    : 'Google Drive connected (reconnect to sync)'
                  : 'Google Drive not connected'}
              </span>
              {(!driveConnected || !driveSignedIn) && (
                <button
                  type="button"
                  className="library-status-connect"
                  disabled={driveConnectBusy}
                  onClick={() => void onConnectDriveFromHeader()}
                >
                  {driveConnectBusy
                    ? 'Connecting…'
                    : driveConnected
                      ? 'Reconnect'
                      : 'Connect Google Drive'}
                </button>
              )}
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
      )}

      {folderAccessNeeded && !showDetail && (
        <div className="library-banner" role="status">
          <div>
            <strong>Folder access expired</strong>
            <p className="muted" style={{ margin: '0.2rem 0 0' }}>
              Chrome needs permission again to read “{folderName || 'your library folder'}”
              (recordings on disk are still there). Grant access or choose the folder again.
            </p>
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={folderBusy}
              onClick={() => void onGrantFolderAccess()}
            >
              {folderBusy ? 'Working…' : 'Grant folder access'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={folderBusy}
              onClick={() => setSettingsOpen(true)}
            >
              Choose folder again
            </button>
          </div>
        </div>
      )}

      {!folderName && !folderAccessNeeded && !showDetail && (
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

      {drivePendingCount > 0 && driveConnected && !showDetail && (
        <div className="library-banner library-banner-warn" role="status">
          <div>
            <strong>
              {drivePendingCount === 1
                ? '1 recording waiting to upload'
                : `${drivePendingCount} recordings waiting to upload`}
            </strong>
            <p className="muted" style={{ margin: '0.2rem 0 0' }}>
              {driveUploadError ||
                (driveSignedIn
                  ? 'Auto-upload to Google Drive did not finish. Retry to upload now.'
                  : 'Reconnect Google Drive to finish auto-upload.')}
            </p>
          </div>
          <div className="row">
            {driveSignedIn ? (
              <button
                type="button"
                className="primary"
                disabled={driveRetryBusy}
                onClick={() => void onRetryDriveUploads()}
              >
                {driveRetryBusy ? 'Uploading…' : 'Retry upload'}
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={driveConnectBusy}
                onClick={() => void onConnectDriveFromHeader()}
              >
                {driveConnectBusy ? 'Connecting…' : 'Reconnect'}
              </button>
            )}
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDrivePendingCount(0)
                setDriveUploadError(null)
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {bannerMsg && (
        <div
          className={
            bannerTone === 'warn'
              ? 'library-banner library-banner-warn'
              : 'library-banner library-banner-ok'
          }
          role="status"
        >
          <div className="library-banner-body">
            <p style={{ margin: 0 }}>{bannerMsg}</p>
            {bannerShareUrl ? (
              <div className="library-banner-actions">
                <ShareLinkField
                  url={bannerShareUrl}
                  copyLabel="Copy again"
                  className="library-banner-share"
                />
                <button
                  type="button"
                  className="library-banner-dismiss"
                  aria-label="Dismiss"
                  onClick={() => showBanner(null)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="library-banner-dismiss"
                aria-label="Dismiss"
                onClick={() => showBanner(null)}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
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
          onShare={async (id) => {
            if (!driveConnected) {
              showBanner('Connect Google Drive in Settings to share a MyPipCam link.')
              setSettingsOpen(true)
              return
            }
            await onShare(id)
          }}
          onRenewShare={(id) => void onRenewShare(id)}
          onEdit={(id, focus) => void openEditorTab(id, focus)}
          onOpenSettings={() => setSettingsOpen(true)}
          onTranscribe={onTranscribe}
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
                {folderAccessNeeded
                  ? `Can’t read “${folderName || 'your folder'}” until you grant access. Recordings on disk will show up after you click Grant folder access.`
                  : folderName
                    ? `Nothing in “${folderName}” yet. Capture a clip and it will appear here and on disk.`
                    : 'Capture your screen with a camera PiP, then manage clips here.'}
              </p>
              {folderAccessNeeded ? (
                <button
                  className="primary"
                  disabled={folderBusy}
                  onClick={() => void onGrantFolderAccess()}
                >
                  {folderBusy ? 'Working…' : 'Grant folder access'}
                </button>
              ) : (
                <button className="primary" onClick={() => void openRecorderTab()}>
                  Start a recording
                </button>
              )}
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
                      <div className="thumb-fallback" />
                    )}
                    <span className="duration">{formatDurationBadge(item.durationMs)}</span>
                    {item.driveFileId && (
                      <span className="drive-badge" title="On Google Drive">
                        Drive
                      </span>
                    )}
                  </div>
                  <div className="card-body">
                    <div className="card-meta card-meta-top">
                      <span>You · {formatRelativeTime(item.createdAt)}</span>
                      <span className="card-share-status">
                        {item.driveProcessingStatus === 'processing'
                          ? 'Processing on Drive…'
                          : item.driveShared || item.shareId
                            ? item.driveProcessingStatus === 'ready'
                              ? 'Link ready'
                              : 'Shared'
                            : 'Not shared'}
                      </span>
                    </div>
                    <h3 className="card-title">{item.title}</h3>
                    <div className="card-stats">
                      <span className="card-stat" title="Views">
                        <span aria-hidden="true">👁</span>
                        {item.shareViewCount ?? 0}
                      </span>
                      {item.transcript ? (
                        <span className="card-stat" title="Has transcript">
                          Transcript
                        </span>
                      ) : null}
                      <span className="card-stat muted">
                        {(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                      </span>
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
          setFolderAccessNeeded(false)
          void refresh()
        }}
        onDriveChanged={(status) => {
          if (status) applyDriveStatus(status)
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
  onRenewShare: (id: string) => void
  onEdit: (id: string, focus?: EditorFocus) => void
  onOpenSettings: () => void
  onTranscribe: (id: string) => Promise<void>
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
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
  onRenewShare,
  onEdit,
  onOpenSettings,
  onTranscribe,
}: DetailProps) {
  const title = item?.title ?? playing?.title ?? 'Recording'
  const busy = busyId === detailId
  const hasShareMeta = Boolean(item?.shareId) || item?.shareViewCount != null
  const shareUrl = item?.shareId ? watchUrlForShareId(item.shareId) : null
  const shareExpired = isShareExpired(item?.shareExpiresAt)
  const expiryLabel = item?.shareId
    ? formatShareExpiry(item.shareExpiresAt)
    : null
  const [tab, setTab] = useState<DetailTab>('edit')
  const [playbackRate, setPlaybackRate] = useState(readStoredPlaybackRate)
  const [speedOpen, setSpeedOpen] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const speedMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTab('edit')
    setSpeedOpen(false)
  }, [detailId])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = playbackRate
  }, [playbackRate, playing?.url])

  useEffect(() => {
    if (!speedOpen) return
    function onPointerDown(e: MouseEvent) {
      if (speedMenuRef.current && !speedMenuRef.current.contains(e.target as Node)) {
        setSpeedOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSpeedOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [speedOpen])

  function rewind20() {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, v.currentTime - 20)
  }

  function selectPlaybackRate(rate: number) {
    setPlaybackRate(rate)
    persistPlaybackRate(rate)
    setSpeedOpen(false)
  }

  const canEdit = Boolean(item && !item.driveOnly)

  return (
    <section className="recording-detail" aria-label="Recording detail">
      <button type="button" className="ghost detail-back" onClick={onBack}>
        ← Library
      </button>

      <header className="detail-header">
        <div className="detail-header-titles">
          <InlineRename
            title={title}
            as="h1"
            className="detail-title"
            onSave={(next) => onRename(detailId, next)}
          />
          <div className="detail-meta-row">
            <div className="detail-meta-left muted">
              <span>You</span>
              <span aria-hidden="true">·</span>
              <span>
                {item ? formatRelativeTime(item.createdAt) : playerLoading ? 'Loading…' : '—'}
              </span>
              {item ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatDuration(item.durationMs)}</span>
                </>
              ) : null}
            </div>
            <div className="detail-views" data-slot="share-views">
              <span className="detail-views-count">{formatDetailViews(item?.shareViewCount)}</span>
            </div>
          </div>
        </div>
        <div className="detail-header-actions">
          {item?.driveProcessingStatus === 'processing' ? (
            <span className="detail-share-chip detail-share-chip-processing" role="status">
              Processing
            </span>
          ) : null}
          <button
            type="button"
            className="primary detail-share-btn"
            disabled={busy}
            onClick={() => void onShare(detailId)}
            title={item?.shareId || item?.driveShared ? 'Copy share link' : 'Share this recording'}
          >
            <ShareIcon />
            {busy
              ? item?.driveProcessingStatus === 'processing' || !item?.shareId
                ? 'Processing…'
                : 'Working…'
              : 'Share'}
          </button>
        </div>
      </header>

      {shareUrl ? (
        <div className="detail-share-block">
          <div className="detail-share-link-stack">
            <ShareLinkField url={shareUrl} copyLabel="Copy" />
            <div className="detail-share-expiry-row">
              <span
                className={
                  shareExpired
                    ? 'detail-share-expiry detail-share-expiry-expired'
                    : 'detail-share-expiry'
                }
              >
                {expiryLabel}
                {!shareExpired ? ' · Links last 30 days' : null}
              </span>
              <button
                type="button"
                className="ghost detail-share-renew"
                disabled={busy}
                onClick={() => onRenewShare(detailId)}
              >
                {busy ? 'Working…' : shareExpired ? 'Renew link' : 'Renew'}
              </button>
            </div>
          </div>
        </div>
      ) : item?.driveProcessingStatus === 'processing' ? (
        <p className="detail-drive-status" role="status">
          Processing on Google Drive… we check until playback looks ready.
        </p>
      ) : null}

      <div className="detail-layout">
        <div className="detail-main">
          <div className="detail-player">
            {playerLoading && !playing ? (
              <div className="detail-player-placeholder muted">Loading video…</div>
            ) : playerError && !playing ? (
              <div className="detail-player-placeholder muted">{playerError}</div>
            ) : playing ? (
              <video
                ref={videoRef}
                key={playing.url}
                src={playing.url}
                controls
                autoPlay
                playsInline
                onLoadedMetadata={(e) => {
                  e.currentTarget.playbackRate = playbackRate
                }}
              />
            ) : (
              <div className="detail-player-placeholder muted">No preview available.</div>
            )}
          </div>

          <div className="detail-player-bar">
            <button
              type="button"
              className="detail-rewind-btn"
              disabled={!playing}
              onClick={rewind20}
              title="Rewind 20 seconds"
            >
              <span className="detail-rewind-icon" aria-hidden="true">
                ↺
              </span>
              20 sec
            </button>
            <div className="detail-speed" ref={speedMenuRef}>
              <button
                type="button"
                className="detail-speed-btn"
                disabled={!playing}
                aria-haspopup="listbox"
                aria-expanded={speedOpen}
                aria-label={`Playback speed ${formatPlaybackRate(playbackRate)}`}
                title="Playback speed"
                onClick={() => setSpeedOpen((open) => !open)}
              >
                {formatPlaybackRate(playbackRate)}
                <span className="detail-speed-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {speedOpen ? (
                <ul className="detail-speed-menu" role="listbox" aria-label="Playback speed">
                  {PLAYBACK_RATES.map((rate) => (
                    <li key={rate} role="presentation">
                      <button
                        type="button"
                        role="option"
                        aria-selected={rate === playbackRate}
                        className={`detail-speed-option ${rate === playbackRate ? 'is-selected' : ''}`}
                        onClick={() => selectPlaybackRate(rate)}
                      >
                        {formatPlaybackRate(rate)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {item ? (
              <div className="detail-meta">
                <span>{formatDate(item.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span>{(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB</span>
              </div>
            ) : (
              <div className="detail-meta muted">
                {playerLoading ? 'Loading details…' : 'Recording metadata unavailable.'}
              </div>
            )}
          </div>
        </div>

        <aside className="detail-sidebar" aria-label="Recording tools">
          <div className="detail-tabs" role="tablist">
            {(
              [
                ['edit', 'Edit'],
                ['activity', 'Activity'],
                ['transcript', 'Transcript'],
                ['settings', 'Settings'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`detail-tab ${tab === id ? 'is-active' : ''}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="detail-tab-panel" role="tabpanel">
            {tab === 'edit' && (
              <div className="detail-panel-stack">
                <section className="detail-section">
                  <h2 className="detail-section-label">Make edits</h2>
                  <ul className="detail-action-list">
                    <li>
                      <button
                        type="button"
                        className="detail-action-row"
                        disabled={!canEdit}
                        onClick={() => onEdit(detailId, 'trim')}
                      >
                        <span className="detail-action-icon" aria-hidden="true">
                          ✂
                        </span>
                        <span className="detail-action-copy">
                          <strong>Edit and trim video</strong>
                          <span className="muted">Cut start/end or remove a selection</span>
                        </span>
                        <span className="detail-action-chevron" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        className="detail-action-row"
                        disabled={!canEdit}
                        onClick={() => onEdit(detailId, 'silence')}
                      >
                        <span className="detail-action-icon" aria-hidden="true">
                          ✨
                        </span>
                        <span className="detail-action-copy">
                          <strong>Remove silences</strong>
                          <span className="muted">Auto-detect pauses, then export the cut</span>
                        </span>
                        <span className="detail-action-chevron" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        className="detail-action-row"
                        disabled={!canEdit}
                        onClick={() => onEdit(detailId, 'filler')}
                        title="Opens editor — needs OpenAI key for transcript word timings"
                      >
                        <span className="detail-action-icon" aria-hidden="true">
                          🎙
                        </span>
                        <span className="detail-action-copy">
                          <strong>Remove filler words</strong>
                          <span className="muted">
                            Cut um/uh/like via transcript timings (OpenAI key)
                          </span>
                        </span>
                        <span className="detail-action-chevron" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                  </ul>
                  {!canEdit && (
                    <p className="muted detail-panel-copy">
                      Editing needs a local copy of this recording.
                    </p>
                  )}
                </section>

                <section className="detail-section">
                  <h2 className="detail-section-label">Take action</h2>
                  <ul className="detail-action-list">
                    <li>
                      <button
                        type="button"
                        className="detail-action-row"
                        onClick={() => void onDownload(detailId)}
                      >
                        <span className="detail-action-icon" aria-hidden="true">
                          ↓
                        </span>
                        <span className="detail-action-copy">
                          <strong>Download</strong>
                          <span className="muted">Save the video file to this computer</span>
                        </span>
                      </button>
                    </li>
                    <li>
                      <button
                        type="button"
                        className="detail-action-row"
                        onClick={() => setTab('transcript')}
                      >
                        <span className="detail-action-icon" aria-hidden="true">
                          Aa
                        </span>
                        <span className="detail-action-copy">
                          <strong>Transcript</strong>
                          <span className="muted">
                            {item?.transcript ? 'View or regenerate captions' : 'Generate captions'}
                          </span>
                        </span>
                        <span className="detail-action-chevron" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                  </ul>
                </section>

                <section className="detail-section">
                  <h2 className="detail-section-label">Recent activity</h2>
                  {hasShareMeta ? (
                    <div className="detail-stat-card">
                      <strong>{formatDetailViews(item?.shareViewCount)}</strong>
                      <span className="muted">
                        {formatLastViewed(item?.shareLastViewedAt)}
                      </span>
                    </div>
                  ) : (
                    <p className="muted detail-panel-copy">
                      Share a MyPipCam link to start tracking views.
                    </p>
                  )}
                </section>
              </div>
            )}

            {tab === 'activity' && (
              <div className="detail-panel-stack">
                <div>
                  <h2 className="detail-panel-title">Activity</h2>
                  <p className="muted detail-panel-copy">
                    Views from your MyPipCam share link.
                  </p>
                </div>
                {hasShareMeta ? (
                  <ul className="detail-activity-list">
                    <li>
                      <strong>{formatDetailViews(item?.shareViewCount)}</strong>
                      <span className="muted">
                        {formatLastViewed(item?.shareLastViewedAt)}
                      </span>
                    </li>
                  </ul>
                ) : (
                  <p className="muted">Views appear when you share a MyPipCam link.</p>
                )}
              </div>
            )}

            {tab === 'transcript' && (
              <div className="detail-panel-stack">
                <div>
                  <h2 className="detail-panel-title">Transcript</h2>
                  <p className="muted detail-panel-copy">
                    Captions stay on-device. Transcription uses your OpenAI key (Whisper).
                  </p>
                </div>
                {item?.transcript ? (
                  <div className="detail-transcript">
                    {item.transcript.segments.length > 0 ? (
                      item.transcript.segments.map((seg, i) => (
                        <p key={i} className="detail-transcript-seg">
                          <span className="muted mono">
                            {formatDuration(seg.start * 1000)}
                          </span>
                          {seg.text}
                        </p>
                      ))
                    ) : (
                      <p className="detail-transcript-plain">{item.transcript.text}</p>
                    )}
                  </div>
                ) : (
                  <p className="muted">No transcript yet.</p>
                )}
                {item && !item.driveOnly && (
                  <button
                    type="button"
                    className="primary detail-panel-action"
                    disabled={busy}
                    onClick={() => void onTranscribe(detailId)}
                  >
                    {busy
                      ? 'Working…'
                      : item.transcript
                        ? 'Re-generate transcript'
                        : 'Generate transcript'}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost detail-panel-action"
                  onClick={onOpenSettings}
                >
                  Open API key settings
                </button>
              </div>
            )}

            {tab === 'settings' && (
              <div className="detail-panel-stack">
                <div>
                  <h2 className="detail-panel-title">Settings</h2>
                  <p className="muted detail-panel-copy">
                    Rename, manage Drive, or delete this recording.
                  </p>
                </div>
                {shareUrl ? (
                  <div className="detail-settings-share">
                    <h3 className="detail-section-label">Share link</h3>
                    <ShareLinkField url={shareUrl} copyLabel="Copy" />
                    <div className="detail-share-expiry-row">
                      <span
                        className={
                          shareExpired
                            ? 'detail-share-expiry detail-share-expiry-expired'
                            : 'detail-share-expiry'
                        }
                      >
                        {expiryLabel}
                        {!shareExpired ? ' · Default 30 days' : null}
                      </span>
                      <button
                        type="button"
                        className="ghost detail-share-renew"
                        disabled={busy}
                        onClick={() => onRenewShare(detailId)}
                      >
                        {busy ? 'Working…' : 'Renew'}
                      </button>
                    </div>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="detail-panel-action"
                  onClick={onOpenSettings}
                >
                  Library &amp; Drive settings
                </button>
                {driveConnected && item && !item.driveFileId && !item.driveOnly && (
                  <button
                    type="button"
                    className="detail-panel-action"
                    disabled={busy}
                    onClick={() => void onUploadToDrive(detailId)}
                  >
                    {busy ? 'Uploading…' : 'Upload to Drive'}
                  </button>
                )}
                {item?.driveWebViewLink && (
                  <a
                    className="button-link detail-panel-action"
                    href={item.driveWebViewLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Drive
                  </a>
                )}
                {item && !item.driveOnly && (
                  <button
                    type="button"
                    className="danger detail-panel-action"
                    onClick={() => void onDelete(detailId)}
                  >
                    Delete recording
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  )
}
