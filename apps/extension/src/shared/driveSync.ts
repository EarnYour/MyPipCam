/**
 * Queue + flush uploads to the shared Google Drive library folder.
 * Local library remains the primary store; Drive is an optional cloud layer.
 */

import {
  enableAnyoneWithLink,
  ensureLibraryFolder,
  getVideoPlaybackStatus,
  listLibraryFiles,
  uploadRecordingFile,
  downloadFileBlob,
  driveFileToRecordingMeta,
  type DriveFileMeta,
  type DriveVideoPlaybackStatus,
} from './driveApi'
import {
  clearDriveAuth,
  explainDriveAuthError,
  getAccessToken,
  hasDriveAuth,
  INTERACTIVE_CONNECT_TIMEOUT_MS,
  openDriveConnectKeepAlive,
  raceTimeout,
  sendDriveAuthMessage,
} from './driveAuth'
import { isOAuthClientConfigured } from './driveConfig'
import {
  clearDriveSettings,
  loadDriveSettings,
  saveDriveSettings,
  type DriveSettings,
} from './driveSettings'
import type { RecordingMeta, RecordingRecord } from './types'

const STORAGE_PENDING_DRIVE = 'drivePendingUploadIds'
const STORAGE_LAST_DRIVE_ERROR = 'driveLastUploadError'
const STORAGE_DRIVE_TOAST = 'driveUploadToast'

export type DriveUploadToast = {
  message: string
  tone: 'ok' | 'warn'
  at: number
  recordingId?: string
}

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

export async function getLastDriveUploadError(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_LAST_DRIVE_ERROR)
  const raw = result[STORAGE_LAST_DRIVE_ERROR]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

export async function setLastDriveUploadError(message: string | null): Promise<void> {
  if (!message?.trim()) {
    await chrome.storage.local.remove(STORAGE_LAST_DRIVE_ERROR)
    return
  }
  await chrome.storage.local.set({ [STORAGE_LAST_DRIVE_ERROR]: message.trim() })
}

/** Library banner after auto-upload (session — survives tab open after stop). */
export async function setDriveUploadToast(toast: DriveUploadToast | null): Promise<void> {
  if (!toast) {
    await chrome.storage.session.remove(STORAGE_DRIVE_TOAST)
    return
  }
  await chrome.storage.session.set({ [STORAGE_DRIVE_TOAST]: toast })
}

export async function peekDriveUploadToast(): Promise<DriveUploadToast | null> {
  const result = await chrome.storage.session.get(STORAGE_DRIVE_TOAST)
  const raw = result[STORAGE_DRIVE_TOAST] as DriveUploadToast | undefined
  if (!raw || typeof raw.message !== 'string' || !raw.message.trim()) return null
  return {
    message: raw.message.trim(),
    tone: raw.tone === 'warn' ? 'warn' : 'ok',
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
    recordingId: typeof raw.recordingId === 'string' ? raw.recordingId : undefined,
  }
}

/** Read + clear so the banner shows once. */
export async function consumeDriveUploadToast(): Promise<DriveUploadToast | null> {
  const toast = await peekDriveUploadToast()
  if (toast) await setDriveUploadToast(null)
  return toast
}

export function driveUploadToastStorageKey(): string {
  return STORAGE_DRIVE_TOAST
}

/** Network / 5xx / rate-limit — safe to retry once. */
export function isTransientDriveUploadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/Drive API (429|500|502|503|504)\b/.test(msg)) return true
  if (/network|Failed to fetch|timeout|temporar|ECONNRESET|quota/i.test(msg)) return true
  return false
}

export type DriveConnectionStatus = {
  configured: boolean
  /**
   * Persisted Drive library folder from a prior successful Connect.
   * This is the UI "Connected" signal — do not require a live token probe
   * (probes often race/timeout and disagree with Settings after Connect).
   */
  linked: boolean
  /** Live OAuth token available without interactive consent. */
  signedIn: boolean
  folderId: string | null
  folderName: string | null
  autoUpload: boolean
}

/** True when the user has a Drive library folder configured (Settings + header). */
export function isDriveLinked(status: Pick<DriveConnectionStatus, 'folderId'>): boolean {
  return Boolean(status.folderId)
}

function statusFromSettings(
  settings: DriveSettings,
  opts: { configured: boolean; signedIn: boolean },
): DriveConnectionStatus {
  return {
    configured: opts.configured,
    linked: Boolean(settings.folderId),
    signedIn: opts.signedIn,
    folderId: settings.folderId,
    folderName: settings.folderName,
    autoUpload: settings.autoUpload,
  }
}

export async function getDriveConnectionStatus(): Promise<DriveConnectionStatus> {
  const settings = await loadDriveSettings()
  const configured = isOAuthClientConfigured()
  let signedIn = false
  if (configured && settings.folderId) {
    try {
      // Status probes must not hang Settings / Library on identity messaging.
      signedIn = await Promise.race([
        hasDriveAuth(),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 2500)
        }),
      ])
    } catch {
      signedIn = false
    }
  }
  return statusFromSettings(settings, { configured, signedIn })
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
      'Set VITE_GOOGLE_OAUTH_CLIENT_ID in apps/extension/.env.local, rebuild, and reload (see README).',
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
    linked: true,
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
      'Set VITE_GOOGLE_OAUTH_CLIENT_ID in apps/extension/.env.local, rebuild, and reload (see README).',
    )
  }

  // Already in the SW: run core directly (CONNECT_GOOGLE handler uses InBackground).
  if (typeof window === 'undefined') {
    return connectGoogleDriveCore()
  }

  // Keep the SW awake for the full consent window; wake with a cheap ping first.
  const keepAlive = openDriveConnectKeepAlive()
  try {
    try {
      await chrome.runtime.sendMessage({ type: 'PING' })
    } catch {
      /* SW may still handle CONNECT_GOOGLE after connect() woke it */
    }

    type ConnectRes =
      | { ok: true; status: DriveConnectionStatus }
      | { ok: false; error?: string; reason?: string; code?: string }

    const res = await sendDriveAuthMessage<ConnectRes>(
      { type: 'CONNECT_GOOGLE' },
      INTERACTIVE_CONNECT_TIMEOUT_MS,
    )

    if (!res.ok) {
      const raw = res.error || res.reason || 'Could not connect Google Drive.'
      throw new Error(explainDriveAuthError(raw, res.code))
    }
    return res.status
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error(
      explainDriveAuthError(
        String(err || 'Could not reach background for Google Connect.'),
      ),
    )
  } finally {
    try {
      keepAlive?.disconnect()
    } catch {
      /* ignore */
    }
  }
}

/**
 * SW-only entry used by CONNECT_GOOGLE.
 * Starts getAuthToken immediately (caller should kick it off in the sync
 * onMessage path when possible), then finishes folder setup.
 * Always settles within INTERACTIVE_CONNECT_TIMEOUT_MS so sendResponse fires.
 */
export async function connectGoogleDriveInBackground(
  authPromise?: Promise<string>,
): Promise<DriveConnectionStatus> {
  const run = authPromise
    ? authPromise.then(() => connectGoogleDriveCore({ tokenAlreadyFetched: true }))
    : connectGoogleDriveCore()
  return raceTimeout(
    run,
    INTERACTIVE_CONNECT_TIMEOUT_MS,
    'Google sign-in timed out. Finish the consent window within two minutes, or click Connect Google again.',
  )
}

export async function disconnectGoogleDrive(): Promise<void> {
  await clearDriveAuth()
  await clearDriveSettings()
  await chrome.storage.local.remove([STORAGE_PENDING_DRIVE, STORAGE_LAST_DRIVE_ERROR])
}

export async function setDriveAutoUpload(autoUpload: boolean): Promise<void> {
  await saveDriveSettings({ autoUpload })
}

export type DriveUploadResult = {
  driveFileId: string
  driveWebViewLink?: string
  driveShared: boolean
}

async function uploadRecordingToDriveOnce(
  record: RecordingRecord,
  interactive: boolean,
): Promise<DriveUploadResult> {
  // Already uploaded — skip the ensureLibraryFolder round-trips entirely.
  if (record.driveFileId) {
    return {
      driveFileId: record.driveFileId,
      driveWebViewLink: record.driveWebViewLink,
      driveShared: Boolean(record.driveShared),
    }
  }

  const settings = await loadDriveSettings()
  const folder = await ensureLibraryFolder(settings.folderId, interactive)
  if (folder.id !== settings.folderId) {
    await saveDriveSettings({ folderId: folder.id, folderName: folder.name })
  }

  if (!record.blob || record.blob.size < 1) {
    throw new Error('Recording blob missing — cannot upload to Google Drive.')
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
  await setLastDriveUploadError(null)

  return {
    driveFileId: file.id,
    driveWebViewLink: file.webViewLink,
    driveShared: false,
  }
}

/** Upload one recording; retries once on transient network/5xx failures. */
export async function uploadRecordingToDrive(
  record: RecordingRecord,
  opts?: { interactive?: boolean },
): Promise<DriveUploadResult> {
  const interactive = opts?.interactive ?? false
  try {
    return await uploadRecordingToDriveOnce(record, interactive)
  } catch (err) {
    if (!isTransientDriveUploadError(err)) throw err
    await sleep(900)
    return await uploadRecordingToDriveOnce(record, interactive)
  }
}

/**
 * Ask the MV3 service worker to upload a queued recording (fire-and-forget).
 * Must NOT await upload from offscreen during OFFSCREEN_STOP — that nests
 * messaging while the SW is blocked on stop and causes silent auth timeouts.
 */
export function requestBackgroundDriveUpload(recordingId: string): void {
  try {
    void chrome.runtime
      .sendMessage({
        type: 'DRIVE_AUTO_UPLOAD',
        id: recordingId,
      })
      .catch(() => {
        /* SW will pick up pending ids on next alarm / Library open */
      })
  } catch {
    /* ignore */
  }
}

/**
 * After local save: queue for Drive and attempt silent upload when auto-upload is on.
 * Prefer db.tryDriveUploadAfterSave which also persists Drive meta — this helper
 * only queues + uploads without writing meta (used if callers handle persist).
 */
export async function maybeQueueDriveUpload(record: RecordingRecord): Promise<DriveUploadResult | null> {
  try {
    const settings = await loadDriveSettings()
    if (!isOAuthClientConfigured() || !settings.folderId || !settings.autoUpload) {
      return null
    }
    if (record.driveFileId) {
      return {
        driveFileId: record.driveFileId,
        driveWebViewLink: record.driveWebViewLink,
        driveShared: Boolean(record.driveShared),
      }
    }

    // Persist queue before upload so retries survive if this context is torn down.
    await addPendingDriveUploadId(record.id)
    if (!(await hasDriveAuth())) {
      await setLastDriveUploadError(
        'Drive session expired — open Library and reconnect Google Drive to finish uploading.',
      )
      return null
    }

    return await uploadRecordingToDrive(record, { interactive: false })
  } catch (err) {
    await setLastDriveUploadError(
      err instanceof Error ? err.message : 'Could not upload recording to Google Drive.',
    )
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
    } catch (err) {
      await setLastDriveUploadError(
        err instanceof Error ? err.message : 'Could not upload recording to Google Drive.',
      )
      /* keep pending for next flush */
    }
  }
  if (uploaded > 0 && (await getPendingDriveUploadIds()).length === 0) {
    await setLastDriveUploadError(null)
  }
  return uploaded
}

export async function shareRecordingOnDrive(
  driveFileId: string,
): Promise<{ webViewLink: string }> {
  return enableAnyoneWithLink(driveFileId, true)
}

const DEFAULT_READY_MAX_WAIT_MS = 3 * 60_000
const DEFAULT_READY_INTERVAL_MS = 2500

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll Drive files.get until video metadata/thumbnail signals playback readiness.
 * Binary only — Drive exposes no processing percent.
 */
export async function waitForDriveVideoReady(
  driveFileId: string,
  opts?: {
    interactive?: boolean
    maxWaitMs?: number
    intervalMs?: number
    onStatus?: (status: DriveVideoPlaybackStatus) => void
    signal?: AbortSignal
  },
): Promise<DriveVideoPlaybackStatus> {
  const interactive = opts?.interactive ?? false
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_READY_MAX_WAIT_MS
  const baseInterval = opts?.intervalMs ?? DEFAULT_READY_INTERVAL_MS
  const started = Date.now()
  let attempt = 0
  let last: DriveVideoPlaybackStatus = {
    fileId: driveFileId,
    ready: false,
    hasThumbnail: false,
    hasThumbnailLink: false,
    durationMillis: null,
    width: null,
    height: null,
  }

  while (Date.now() - started < maxWaitMs) {
    if (opts?.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    last = await getVideoPlaybackStatus(driveFileId, interactive)
    opts?.onStatus?.(last)
    if (last.ready) return last

    attempt += 1
    const delay = Math.min(12_000, baseInterval + attempt * 750)
    const remaining = maxWaitMs - (Date.now() - started)
    if (remaining <= 0) break
    await sleep(Math.min(delay, remaining), opts?.signal)
  }

  return last
}

export type { DriveVideoPlaybackStatus }

export type DriveLibraryListResult = {
  items: Array<ReturnType<typeof driveFileToRecordingMeta>>
  error: string | null
}

export async function listDriveLibraryRecordings(): Promise<DriveLibraryListResult> {
  const settings = await loadDriveSettings()
  if (!settings.folderId) return { items: [], error: null }
  try {
    if (!(await hasDriveAuth())) {
      return {
        items: [],
        error: 'Drive session expired — reconnect Google Drive to list cloud recordings.',
      }
    }
    const files = await listLibraryFiles(settings.folderId, false)
    return { items: files.map(driveFileToRecordingMeta), error: null }
  } catch (err) {
    return {
      items: [],
      error:
        err instanceof Error
          ? err.message
          : 'Could not list Google Drive recordings.',
    }
  }
}

export async function fetchDriveRecordingBlob(driveFileId: string): Promise<Blob> {
  return downloadFileBlob(driveFileId, true)
}

export type { DriveFileMeta }
