/**
 * Queue + flush uploads to the shared Google Drive library folder.
 * Local library remains the primary store; Drive is an optional cloud layer.
 */

import {
  enableAnyoneWithLink,
  ensureLibraryFolder,
  listLibraryFiles,
  uploadRecordingFile,
  downloadFileBlob,
  driveFileToRecordingMeta,
  type DriveFileMeta,
} from './driveApi'
import {
  clearDriveAuth,
  explainDriveAuthError,
  getAccessToken,
  hasDriveAuth,
} from './driveAuth'
import { isOAuthClientConfigured } from './driveConfig'
import {
  clearDriveSettings,
  loadDriveSettings,
  saveDriveSettings,
} from './driveSettings'
import type { RecordingMeta, RecordingRecord } from './types'

const STORAGE_PENDING_DRIVE = 'drivePendingUploadIds'

export async function getPendingDriveUploadIds(): Promise<string[]> {
  const result = await chrome.storage.local.get(STORAGE_PENDING_DRIVE)
  const ids = result[STORAGE_PENDING_DRIVE]
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
}

export async function addPendingDriveUploadId(id: string): Promise<void> {
  const current = await getPendingDriveUploadIds()
  if (current.includes(id)) return
  await chrome.storage.local.set({ [STORAGE_PENDING_DRIVE]: [...current, id] })
}

export async function removePendingDriveUploadId(id: string): Promise<void> {
  const current = await getPendingDriveUploadIds()
  const next = current.filter((x) => x !== id)
  if (next.length === 0) {
    await chrome.storage.local.remove(STORAGE_PENDING_DRIVE)
  } else {
    await chrome.storage.local.set({ [STORAGE_PENDING_DRIVE]: next })
  }
}

export type DriveConnectionStatus = {
  configured: boolean
  signedIn: boolean
  folderId: string | null
  folderName: string | null
  autoUpload: boolean
}

export async function getDriveConnectionStatus(): Promise<DriveConnectionStatus> {
  const settings = await loadDriveSettings()
  const configured = isOAuthClientConfigured()
  let signedIn = false
  if (configured) {
    try {
      // Status probes must not hang Settings / Library on identity messaging.
      signedIn = await Promise.race([
        hasDriveAuth(),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 1500)
        }),
      ])
    } catch {
      signedIn = false
    }
  }
  return {
    configured,
    signedIn,
    folderId: settings.folderId,
    folderName: settings.folderName,
    autoUpload: settings.autoUpload,
  }
}

/**
 * After interactive auth: create/find Drive folder and persist settings.
 * Pass `tokenAlreadyFetched` when the SW already started getAuthToken under the
 * user-gesture window (do not call interactive getAuthToken again first).
 */
async function connectGoogleDriveCore(opts?: {
  tokenAlreadyFetched?: boolean
}): Promise<DriveConnectionStatus> {
  if (!isOAuthClientConfigured()) {
    throw new Error(
      'Paste your Google OAuth client ID into apps/extension/src/shared/driveConfig.ts (see README).',
    )
  }
  if (!opts?.tokenAlreadyFetched) {
    await getAccessToken(true)
  }
  const settings = await loadDriveSettings()
  const folder = await ensureLibraryFolder(settings.folderId, true)
  await saveDriveSettings({
    folderId: folder.id,
    folderName: folder.name,
  })
  // Avoid re-probing identity (can race/timeout right after connect).
  return {
    configured: true,
    signedIn: true,
    folderId: folder.id,
    folderName: folder.name,
    autoUpload: settings.autoUpload,
  }
}

/**
 * Interactive connect — always messages the service worker (`CONNECT_GOOGLE`)
 * so chrome.identity.getAuthToken runs in the SW under the click gesture.
 */
export async function connectGoogleDrive(): Promise<DriveConnectionStatus> {
  if (!isOAuthClientConfigured()) {
    throw new Error(
      'Paste your Google OAuth client ID into apps/extension/src/shared/driveConfig.ts (see README).',
    )
  }

  // Already in the SW: run core directly (CONNECT_GOOGLE handler uses InBackground).
  if (typeof window === 'undefined') {
    return connectGoogleDriveCore()
  }

  let res:
    | { ok: true; status: DriveConnectionStatus }
    | { ok: false; error?: string; reason?: string; code?: string }
    | undefined
  try {
    res = (await chrome.runtime.sendMessage({ type: 'CONNECT_GOOGLE' })) as typeof res
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    throw new Error(explainDriveAuthError(raw || 'Could not reach background for Google Connect.'))
  }

  if (!res?.ok) {
    const raw =
      res?.error ||
      res?.reason ||
      (res == null
        ? 'No response from background (reload the extension on chrome://extensions).'
        : 'Could not connect Google Drive.')
    throw new Error(explainDriveAuthError(raw, res?.code))
  }
  return res.status
}

/**
 * SW-only entry used by CONNECT_GOOGLE.
 * Starts getAuthToken immediately (caller should kick it off in the sync
 * onMessage path when possible), then finishes folder setup.
 */
export async function connectGoogleDriveInBackground(
  authPromise?: Promise<string>,
): Promise<DriveConnectionStatus> {
  if (authPromise) {
    await authPromise
    return connectGoogleDriveCore({ tokenAlreadyFetched: true })
  }
  return connectGoogleDriveCore()
}

export async function disconnectGoogleDrive(): Promise<void> {
  await clearDriveAuth()
  await clearDriveSettings()
  await chrome.storage.local.remove(STORAGE_PENDING_DRIVE)
}

export async function setDriveAutoUpload(autoUpload: boolean): Promise<void> {
  await saveDriveSettings({ autoUpload })
}

export type DriveUploadResult = {
  driveFileId: string
  driveWebViewLink?: string
  driveShared: boolean
}

/** Upload one recording; caller persists returned Drive fields onto local meta. */
export async function uploadRecordingToDrive(
  record: RecordingRecord,
  opts?: { interactive?: boolean },
): Promise<DriveUploadResult> {
  const interactive = opts?.interactive ?? false
  const settings = await loadDriveSettings()
  const folder = await ensureLibraryFolder(settings.folderId, interactive)
  if (folder.id !== settings.folderId) {
    await saveDriveSettings({ folderId: folder.id, folderName: folder.name })
  }

  if (record.driveFileId) {
    const link = record.driveWebViewLink
    return {
      driveFileId: record.driveFileId,
      driveWebViewLink: link,
      driveShared: Boolean(record.driveShared),
    }
  }

  const file = await uploadRecordingFile({
    folderId: folder.id,
    blob: record.blob,
    props: {
      mypipcamId: record.id,
      title: record.title,
      createdAt: String(record.createdAt),
      durationMs: String(record.durationMs),
      sizeBytes: String(record.sizeBytes),
      mimeType: record.mimeType,
    },
    interactive,
  })

  await removePendingDriveUploadId(record.id)

  return {
    driveFileId: file.id,
    driveWebViewLink: file.webViewLink,
    driveShared: false,
  }
}

/**
 * After local save: queue for Drive and attempt silent upload when auto-upload is on.
 * Prefer db.tryDriveUploadAfterSave which also persists Drive meta — this helper
 * only queues + uploads without writing meta (used if callers handle persist).
 */
export async function maybeQueueDriveUpload(record: RecordingRecord): Promise<DriveUploadResult | null> {
  try {
    const status = await getDriveConnectionStatus()
    if (!status.configured || !status.folderId) return null
    if (!status.autoUpload) return null
    if (record.driveFileId) {
      return {
        driveFileId: record.driveFileId,
        driveWebViewLink: record.driveWebViewLink,
        driveShared: Boolean(record.driveShared),
      }
    }

    await addPendingDriveUploadId(record.id)
    if (!(await hasDriveAuth())) return null

    return await uploadRecordingToDrive(record, { interactive: false })
  } catch {
    return null
  }
}

export type PersistDriveMetaFn = (
  id: string,
  patch: Pick<RecordingMeta, 'driveFileId' | 'driveWebViewLink' | 'driveShared'>,
) => Promise<void>

export type LoadRecordingFn = (id: string) => Promise<RecordingRecord | undefined>

/** Retry pending Drive uploads (call from Library with interactive token OK). */
export async function flushPendingDriveUploads(
  loadRecording: LoadRecordingFn,
  persistDriveMeta: PersistDriveMetaFn,
  opts?: { interactive?: boolean },
): Promise<number> {
  const interactive = opts?.interactive ?? true
  const status = await getDriveConnectionStatus()
  if (!status.configured || !status.folderId) return 0
  if (!(await hasDriveAuth()) && !interactive) return 0

  const pending = await getPendingDriveUploadIds()
  let uploaded = 0

  for (const id of pending) {
    const rec = await loadRecording(id)
    if (!rec) {
      await removePendingDriveUploadId(id)
      continue
    }
    if (rec.driveFileId) {
      await removePendingDriveUploadId(id)
      continue
    }
    try {
      const result = await uploadRecordingToDrive(rec, { interactive })
      await persistDriveMeta(id, {
        driveFileId: result.driveFileId,
        driveWebViewLink: result.driveWebViewLink,
        driveShared: result.driveShared,
      })
      uploaded += 1
    } catch {
      /* keep pending */
    }
  }
  return uploaded
}

export async function shareRecordingOnDrive(
  driveFileId: string,
): Promise<{ webViewLink: string }> {
  return enableAnyoneWithLink(driveFileId, true)
}

export async function listDriveLibraryRecordings(): Promise<
  Array<ReturnType<typeof driveFileToRecordingMeta>>
> {
  const settings = await loadDriveSettings()
  if (!settings.folderId) return []
  if (!(await hasDriveAuth())) return []
  try {
    const files = await listLibraryFiles(settings.folderId, false)
    return files.map(driveFileToRecordingMeta)
  } catch {
    return []
  }
}

export async function fetchDriveRecordingBlob(driveFileId: string): Promise<Blob> {
  return downloadFileBlob(driveFileId, true)
}

export type { DriveFileMeta }
