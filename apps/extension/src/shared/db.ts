import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { RecordingMeta, RecordingRecord, TranscriptData } from './types'
import { defaultTitle } from './types'
import { isOAuthClientConfigured } from './driveConfig'
import {
  addPendingDriveUploadId,
  fetchDriveRecordingBlob,
  flushPendingDriveUploads,
  getLastDriveUploadError,
  getPendingDriveUploadIds,
  listDriveLibraryRecordings,
  setLastDriveUploadError,
  uploadRecordingToDrive,
} from './driveSync'
import { loadDriveSettings } from './driveSettings'
import {
  addPendingSyncId,
  deleteFromFolder,
  ensureLibraryPermission,
  getLibraryFolderAccess,
  getLibraryHandle,
  getPendingSyncIds,
  hasLibraryFolder,
  listFolderRecordings,
  readRecording as readFolderRecording,
  removePendingSyncId,
  renameInFolder,
  updateBlobInFolder,
  updateDriveMetaInFolder,
  updateTranscriptInFolder,
  writeRecordingToFolder,
  type LibraryFolderAccess,
} from './libraryFs'

interface MyPipCamDB extends DBSchema {
  recordings: {
    key: string
    value: RecordingRecord
    indexes: { 'by-created': number }
  }
}

const DB_NAME = 'mypipcam'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<MyPipCamDB>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<MyPipCamDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('recordings', { keyPath: 'id' })
        store.createIndex('by-created', 'createdAt')
      },
    })
  }
  return dbPromise
}

/** Prefer folder when a handle exists and permission is granted (no UI prompt). */
async function folderRootQuiet(): Promise<FileSystemDirectoryHandle | null> {
  if (!(await hasLibraryFolder())) return null
  return ensureLibraryPermission(undefined, { request: false })
}

/** Prefer folder; may prompt for permission (call from a user-gesture context). */
export async function folderRootInteractive(): Promise<FileSystemDirectoryHandle | null> {
  if (!(await hasLibraryFolder())) return null
  return ensureLibraryPermission(undefined, { request: true })
}

async function putIdb(record: RecordingRecord): Promise<void> {
  const db = await getDb()
  await db.put('recordings', record)
}

async function getIdb(id: string): Promise<RecordingRecord | undefined> {
  const db = await getDb()
  return db.get('recordings', id)
}

async function deleteIdb(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('recordings', id)
}

/** Flush IndexedDB recordings marked pending (or all given) into the library folder. */
export async function flushPendingToFolder(
  root?: FileSystemDirectoryHandle | null,
): Promise<number> {
  const permitted = root ?? (await folderRootInteractive())
  if (!permitted) return 0

  const pending = await getPendingSyncIds()
  let flushed = 0
  for (const id of pending) {
    const rec = await getIdb(id)
    if (!rec) {
      await removePendingSyncId(id)
      continue
    }
    try {
      await writeRecordingToFolder(rec, permitted)
      await deleteIdb(id)
      await removePendingSyncId(id)
      flushed += 1
    } catch {
      /* keep pending for next attempt */
    }
  }
  return flushed
}

/** One-shot migration: copy all IndexedDB recordings into the chosen folder. */
export async function migrateIdbToFolder(
  root?: FileSystemDirectoryHandle | null,
): Promise<number> {
  const permitted = root ?? (await folderRootInteractive())
  if (!permitted) return 0

  const db = await getDb()
  const all = await db.getAll('recordings')
  let moved = 0
  for (const rec of all) {
    try {
      await writeRecordingToFolder(rec, permitted)
      await deleteIdb(rec.id)
      await removePendingSyncId(rec.id)
      moved += 1
    } catch {
      await addPendingSyncId(rec.id)
    }
  }
  return moved
}

export async function saveRecording(input: {
  blob: Blob
  durationMs: number
  thumbnail?: Blob
  title?: string
  mimeType?: string
}): Promise<RecordingRecord> {
  const createdAt = Date.now()
  const record: RecordingRecord = {
    id: crypto.randomUUID(),
    title: input.title ?? defaultTitle(createdAt),
    createdAt,
    durationMs: input.durationMs,
    mimeType: input.mimeType ?? (input.blob.type || 'video/webm'),
    sizeBytes: input.blob.size,
    thumbnail: input.thumbnail,
    blob: input.blob,
  }

  const root = await folderRootQuiet()
  if (root) {
    try {
      await writeRecordingToFolder(record, root)
      // Must await: loom stop closes the offscreen doc immediately after save returns,
      // which aborts fire-and-forget Drive uploads mid-flight.
      await tryDriveUploadAfterSave(record)
      return record
    } catch {
      await putIdb(record)
      await addPendingSyncId(record.id)
      await tryDriveUploadAfterSave(record)
      return record
    }
  }

  // Folder configured but permission missing (e.g. offscreen) — queue for later sync.
  if (await hasLibraryFolder()) {
    await putIdb(record)
    await addPendingSyncId(record.id)
    await tryDriveUploadAfterSave(record)
    return record
  }

  await putIdb(record)
  await tryDriveUploadAfterSave(record)
  return record
}

export type DriveUploadAfterSaveResult = {
  attempted: boolean
  uploaded: boolean
  queued: boolean
  error: string | null
}

/**
 * Auto-upload after local save when Settings → Auto-upload is on and Drive is linked.
 * Always queues the id before uploading so Library can retry if auth/network fails.
 * Does not throw — callers should still await so the save context stays alive.
 */
export async function tryDriveUploadAfterSave(
  record: RecordingRecord,
): Promise<DriveUploadAfterSaveResult> {
  const skipped: DriveUploadAfterSaveResult = {
    attempted: false,
    uploaded: false,
    queued: false,
    error: null,
  }
  try {
    const settings = await loadDriveSettings()
    if (!isOAuthClientConfigured() || !settings.folderId || !settings.autoUpload) {
      return skipped
    }
    if (record.driveFileId) {
      return { attempted: false, uploaded: true, queued: false, error: null }
    }

    // Persist queue first — survives offscreen/SW teardown if upload is interrupted.
    await addPendingDriveUploadId(record.id)

    try {
      const result = await uploadRecordingToDrive(record, { interactive: false })
      await updateRecordingDriveMeta(record.id, {
        driveFileId: result.driveFileId,
        driveWebViewLink: result.driveWebViewLink,
        driveShared: result.driveShared,
      })
      await setLastDriveUploadError(null)
      return { attempted: true, uploaded: true, queued: false, error: null }
    } catch (err) {
      const error =
        err instanceof Error ? err.message : 'Could not upload recording to Google Drive.'
      await setLastDriveUploadError(error)
      return { attempted: true, uploaded: false, queued: true, error }
    }
  } catch (err) {
    const error =
      err instanceof Error ? err.message : 'Could not queue Drive upload.'
    await setLastDriveUploadError(error).catch(() => undefined)
    return { attempted: true, uploaded: false, queued: false, error }
  }
}

/** Pending auto-uploads + last error for Library banners. */
export async function getDriveUploadNotice(): Promise<{
  pendingCount: number
  lastError: string | null
}> {
  const [pending, lastError] = await Promise.all([
    getPendingDriveUploadIds(),
    getLastDriveUploadError(),
  ])
  return { pendingCount: pending.length, lastError }
}

export async function updateRecordingDriveMeta(
  id: string,
  patch: Pick<
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
  >,
): Promise<void> {
  const root = await folderRootQuiet()
  if (root) {
    try {
      await updateDriveMetaInFolder(id, patch, root)
      return
    } catch {
      /* fall through to IDB */
    }
  }

  const rec = await getIdb(id)
  if (!rec) return
  await putIdb({
    ...rec,
    driveFileId: patch.driveFileId ?? rec.driveFileId,
    driveWebViewLink: patch.driveWebViewLink ?? rec.driveWebViewLink,
    driveShared: patch.driveShared ?? rec.driveShared,
    driveProcessingStatus:
      patch.driveProcessingStatus !== undefined
        ? patch.driveProcessingStatus
        : rec.driveProcessingStatus,
    driveReadyAt:
      patch.driveReadyAt !== undefined ? patch.driveReadyAt : rec.driveReadyAt,
    shareId: patch.shareId ?? rec.shareId,
    shareViewCount:
      patch.shareViewCount !== undefined ? patch.shareViewCount : rec.shareViewCount,
    shareLastViewedAt:
      patch.shareLastViewedAt !== undefined
        ? patch.shareLastViewedAt
        : rec.shareLastViewedAt,
    shareExpiresAt:
      patch.shareExpiresAt !== undefined ? patch.shareExpiresAt : rec.shareExpiresAt,
  })
}

/** Flush queued Drive uploads (Library open / Settings). */
export async function flushDriveUploads(opts?: { interactive?: boolean }): Promise<number> {
  return flushPendingDriveUploads(getRecording, updateRecordingDriveMeta, opts)
}

export type LibraryListResult = {
  items: RecordingMeta[]
  folder: LibraryFolderAccess
  /** True when disk listing succeeded under a granted handle. */
  folderListed: boolean
  driveError: string | null
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const result = await listLibrary()
  return result.items
}

/** Local folder + IndexedDB + Drive merge, with access/error diagnostics for the UI. */
export async function listLibrary(): Promise<LibraryListResult> {
  let local: RecordingMeta[] = []
  let usedFolder = false
  const folder = await getLibraryFolderAccess()

  const root = await folderRootQuiet()
  if (root) {
    try {
      await flushPendingToFolder(root)
      local = await listFolderRecordings(root)
      usedFolder = true
    } catch {
      /* fall through to IDB */
    }
  }

  if (!usedFolder) {
    const db = await getDb()
    const all = await db.getAllFromIndex('recordings', 'by-created')
    local = all.map(({ blob: _blob, ...meta }) => meta)
  }

  const { items, driveError } = await mergeWithDriveLibrary(local)
  return {
    items,
    folder,
    folderListed: usedFolder,
    driveError,
  }
}

/** Merge local items with Drive library listing (other browsers / devices). */
async function mergeWithDriveLibrary(
  local: RecordingMeta[],
): Promise<{ items: RecordingMeta[]; driveError: string | null }> {
  const byId = new Map(local.map((item) => [item.id, item]))
  let driveError: string | null = null
  try {
    const listed = await listDriveLibraryRecordings()
    driveError = listed.error
    for (const d of listed.items) {
      const existing = byId.get(d.id)
      if (existing) {
        byId.set(d.id, {
          ...existing,
          driveFileId: existing.driveFileId ?? d.driveFileId,
          driveWebViewLink: existing.driveWebViewLink ?? d.driveWebViewLink,
          driveShared: existing.driveShared ?? d.driveShared,
          driveOnly: undefined,
        })
      } else {
        byId.set(d.id, {
          id: d.id,
          title: d.title,
          createdAt: d.createdAt,
          durationMs: d.durationMs,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          driveFileId: d.driveFileId,
          driveWebViewLink: d.driveWebViewLink,
          driveShared: d.driveShared,
          driveOnly: true,
        })
      }
    }
  } catch (err) {
    driveError =
      err instanceof Error ? err.message : 'Could not list Google Drive recordings.'
  }

  return {
    items: [...byId.values()].sort((a, b) => b.createdAt - a.createdAt),
    driveError,
  }
}

export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
  const root = await folderRootQuiet()
  if (root) {
    try {
      const fromFolder = await readFolderRecording(id, root)
      if (fromFolder) return fromFolder
    } catch {
      /* fall through */
    }
  }
  const fromIdb = await getIdb(id)
  if (fromIdb) return fromIdb

  // Drive-only item (synced from another browser) — download for play.
  try {
    const { items: driveItems } = await listDriveLibraryRecordings()
    const remote = driveItems.find((d) => d.id === id)
    if (!remote?.driveFileId) return undefined
    const blob = await fetchDriveRecordingBlob(remote.driveFileId)
    return {
      id: remote.id,
      title: remote.title,
      createdAt: remote.createdAt,
      durationMs: remote.durationMs,
      mimeType: remote.mimeType,
      sizeBytes: remote.sizeBytes || blob.size,
      blob,
      driveFileId: remote.driveFileId,
      driveWebViewLink: remote.driveWebViewLink,
      driveShared: remote.driveShared,
      driveOnly: true,
    }
  } catch {
    return undefined
  }
}

export async function renameRecording(id: string, title: string): Promise<void> {
  const root = await folderRootQuiet()
  if (root) {
    try {
      await renameInFolder(id, title, root)
      return
    } catch {
      /* fall through */
    }
  }

  const rec = await getIdb(id)
  if (!rec) throw new Error('Recording not found')
  await putIdb({ ...rec, title: title.trim() || rec.title })
}

export async function deleteRecording(id: string): Promise<void> {
  const root = await folderRootQuiet()
  if (root) {
    try {
      await deleteFromFolder(id, root)
    } catch {
      /* still clear IDB / pending */
    }
  }
  await deleteIdb(id)
  await removePendingSyncId(id)
}

export async function updateRecordingBlob(
  id: string,
  blob: Blob,
  durationMs: number,
  thumbnail?: Blob,
  overwrite = true,
): Promise<RecordingRecord> {
  if (!overwrite) {
    const existing = (await getRecording(id)) ?? (await getIdb(id))
    if (!existing) throw new Error('Recording not found')
    return saveRecording({
      blob,
      durationMs,
      thumbnail,
      title: `${existing.title} (edited)`,
      mimeType: blob.type || existing.mimeType,
    })
  }

  const root = await folderRootQuiet()
  if (root) {
    try {
      return await updateBlobInFolder(id, blob, durationMs, thumbnail, root)
    } catch {
      /* fall through */
    }
  }

  const existing = await getIdb(id)
  if (!existing) {
    // Folder-only recording that couldn't update — try read folder with request path later.
    const handle = await getLibraryHandle()
    if (handle) {
      throw new Error('Recording not found in browser cache; open Library to re-grant folder access.')
    }
    throw new Error('Recording not found')
  }

  const updated: RecordingRecord = {
    ...existing,
    blob,
    durationMs,
    sizeBytes: blob.size,
    mimeType: blob.type || existing.mimeType,
    thumbnail: thumbnail ?? existing.thumbnail,
  }
  await putIdb(updated)
  if (await hasLibraryFolder()) await addPendingSyncId(id)
  return updated
}

export async function updateRecordingTranscript(
  id: string,
  transcript: TranscriptData | undefined,
): Promise<void> {
  const root = await folderRootQuiet()
  if (root) {
    try {
      await updateTranscriptInFolder(id, transcript, root)
      return
    } catch {
      /* fall through */
    }
  }

  const rec = await getIdb(id)
  if (!rec) throw new Error('Recording not found')
  await putIdb({ ...rec, transcript })
  if (await hasLibraryFolder()) await addPendingSyncId(id)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function recordingFilename(rec: Pick<RecordingMeta, 'title' | 'mimeType'>): string {
  const safe = rec.title.replace(/[^\w\- ]+/g, '').trim() || 'recording'
  const ext = rec.mimeType.includes('mp4') ? 'mp4' : 'webm'
  return `${safe}.${ext}`
}
