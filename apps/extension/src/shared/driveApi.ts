import { getAccessToken, invalidateAccessToken } from './driveAuth'
import { DRIVE_LIBRARY_FOLDER_NAME } from './driveConfig'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'

export type DriveFileMeta = {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
  webContentLink?: string
  size?: string
  createdTime?: string
  appProperties?: Record<string, string>
  hasThumbnail?: boolean
  thumbnailLink?: string
  videoMediaMetadata?: {
    width?: number
    height?: number
    durationMillis?: string
  }
}

/**
 * Drive does NOT expose a processing percent. Playback readiness is inferred
 * from async metadata (videoMediaMetadata / thumbnail) after upload.
 */
export type DriveVideoPlaybackStatus = {
  fileId: string
  ready: boolean
  hasThumbnail: boolean
  hasThumbnailLink: boolean
  durationMillis: number | null
  width: number | null
  height: number | null
}

const VIDEO_READY_FIELDS =
  'id,mimeType,hasThumbnail,thumbnailLink,videoMediaMetadata(durationMillis,width,height)'

export function isDriveVideoPlaybackReady(
  meta: Pick<
    DriveFileMeta,
    'hasThumbnail' | 'thumbnailLink' | 'videoMediaMetadata'
  >,
): boolean {
  const duration = Number(meta.videoMediaMetadata?.durationMillis)
  if (Number.isFinite(duration) && duration > 0) return true
  if (meta.hasThumbnail === true) return true
  if (typeof meta.thumbnailLink === 'string' && meta.thumbnailLink.length > 0) {
    return true
  }
  return false
}

export function toDriveVideoPlaybackStatus(
  fileId: string,
  meta: DriveFileMeta,
): DriveVideoPlaybackStatus {
  const durationRaw = Number(meta.videoMediaMetadata?.durationMillis)
  const durationMillis =
    Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null
  return {
    fileId,
    ready: isDriveVideoPlaybackReady(meta),
    hasThumbnail: meta.hasThumbnail === true,
    hasThumbnailLink:
      typeof meta.thumbnailLink === 'string' && meta.thumbnailLink.length > 0,
    durationMillis,
    width: meta.videoMediaMetadata?.width ?? null,
    height: meta.videoMediaMetadata?.height ?? null,
  }
}

export type DriveRecordingProps = {
  mypipcamId: string
  title: string
  createdAt: string
  durationMs: string
  sizeBytes: string
  mimeType: string
}

async function authFetch(
  url: string,
  init: RequestInit = {},
  interactive = false,
): Promise<Response> {
  let token = await getAccessToken(interactive)
  const withAuth = (t: string): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${t}`,
    },
  })

  let res = await fetch(url, withAuth(token))
  if (res.status === 401) {
    await invalidateAccessToken(token)
    token = await getAccessToken(interactive)
    res = await fetch(url, withAuth(token))
  }
  return res
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!res.ok) {
    let detail = text
    try {
      const j = JSON.parse(text) as { error?: { message?: string } }
      detail = j.error?.message ?? text
    } catch {
      /* keep raw */
    }
    throw new Error(`Drive API ${res.status}: ${detail}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

/** Ensure a MyPipCam folder exists (app-created — works with drive.file). */
export async function ensureLibraryFolder(
  existingId?: string | null,
  interactive = true,
): Promise<{ id: string; name: string }> {
  if (existingId) {
    try {
      const file = await getFile(existingId, interactive)
      if (file.id) return { id: file.id, name: file.name || DRIVE_LIBRARY_FOLDER_NAME }
    } catch {
      /* folder missing or inaccessible — create/find below */
    }
  }

  const found = await findAppFolder(interactive)
  if (found) return found
  return createAppFolder(interactive)
}

async function findAppFolder(
  interactive = true,
): Promise<{ id: string; name: string } | null> {
  const q = [
    `name = '${DRIVE_LIBRARY_FOLDER_NAME}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false',
  ].join(' and ')
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    fields: 'files(id,name)',
    pageSize: '10',
  })
  const res = await authFetch(`${DRIVE_API}/files?${params}`, {}, interactive)
  const data = await parseJson<{ files?: DriveFileMeta[] }>(res)
  const first = data.files?.[0]
  return first?.id ? { id: first.id, name: first.name || DRIVE_LIBRARY_FOLDER_NAME } : null
}

async function createAppFolder(
  interactive = true,
): Promise<{ id: string; name: string }> {
  const res = await authFetch(
    `${DRIVE_API}/files?fields=id,name`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_LIBRARY_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { mypipcamLibrary: '1' },
      }),
    },
    interactive,
  )
  const file = await parseJson<DriveFileMeta>(res)
  if (!file.id) throw new Error('Failed to create Drive library folder.')
  return { id: file.id, name: file.name || DRIVE_LIBRARY_FOLDER_NAME }
}

export async function getFile(fileId: string, interactive = false): Promise<DriveFileMeta> {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,webViewLink,webContentLink,size,createdTime,appProperties',
  })
  const res = await authFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, {}, interactive)
  return parseJson<DriveFileMeta>(res)
}

/**
 * Pollable readiness probe for video playback / embed.
 * Uses drive.file — only works for files this app created or opened.
 */
export async function getVideoPlaybackStatus(
  fileId: string,
  interactive = false,
): Promise<DriveVideoPlaybackStatus> {
  const params = new URLSearchParams({ fields: VIDEO_READY_FIELDS })
  const res = await authFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`,
    {},
    interactive,
  )
  const meta = await parseJson<DriveFileMeta>(res)
  return toDriveVideoPlaybackStatus(fileId, meta)
}

/** List video files in the library folder that carry MyPipCam appProperties. */
export async function listLibraryFiles(
  folderId: string,
  interactive = false,
): Promise<DriveFileMeta[]> {
  const q = [
    `'${folderId}' in parents`,
    'trashed = false',
    `appProperties has { key='mypipcamId' }`,
  ].join(' and ')
  const params = new URLSearchParams({
    q,
    spaces: 'drive',
    fields:
      'files(id,name,mimeType,webViewLink,webContentLink,size,createdTime,appProperties)',
    pageSize: '200',
  })
  const res = await authFetch(`${DRIVE_API}/files?${params}`, {}, interactive)
  const data = await parseJson<{ files?: DriveFileMeta[] }>(res)
  return data.files ?? []
}

function safeDriveFileName(title: string, mimeType: string): string {
  const safe = title.replace(/[^\w\- .]+/g, '').trim() || 'recording'
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
  return `${safe}.${ext}`
}

/** Multipart upload of a recording into the library folder. */
export async function uploadRecordingFile(input: {
  folderId: string
  blob: Blob
  props: DriveRecordingProps
  interactive?: boolean
}): Promise<DriveFileMeta> {
  const interactive = input.interactive ?? false
  const metadata = {
    name: safeDriveFileName(input.props.title, input.props.mimeType),
    parents: [input.folderId],
    mimeType: input.blob.type || input.props.mimeType,
    appProperties: {
      mypipcamId: input.props.mypipcamId,
      title: input.props.title.slice(0, 120),
      createdAt: input.props.createdAt,
      durationMs: input.props.durationMs,
      sizeBytes: input.props.sizeBytes,
      mimeType: input.props.mimeType,
    },
  }

  const boundary = `mypipcam_${crypto.randomUUID().replace(/-/g, '')}`
  const metaPart = JSON.stringify(metadata)
  const preamble =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metaPart}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${metadata.mimeType}\r\n\r\n`

  const closing = `\r\n--${boundary}--`
  const body = new Blob([preamble, input.blob, closing], {
    type: `multipart/related; boundary=${boundary}`,
  })

  const params = new URLSearchParams({
    uploadType: 'multipart',
    fields: 'id,name,mimeType,webViewLink,webContentLink,size,appProperties',
  })

  const res = await authFetch(
    `${UPLOAD_API}/files?${params}`,
    { method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } },
    interactive,
  )
  return parseJson<DriveFileMeta>(res)
}

/** Anyone with the link can view. Returns updated webViewLink. */
export async function enableAnyoneWithLink(
  fileId: string,
  interactive = true,
): Promise<{ webViewLink: string }> {
  const createRes = await authFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'reader',
        type: 'anyone',
        allowFileDiscovery: false,
      }),
    },
    interactive,
  )
  if (!createRes.ok && createRes.status !== 409) {
    await parseJson(createRes)
  }

  const file = await getFile(fileId, interactive)
  const link = file.webViewLink
  if (!link) throw new Error('Share enabled but no webViewLink returned.')
  return { webViewLink: link }
}

/** Download file bytes (for play on Drive-only devices). */
export async function downloadFileBlob(
  fileId: string,
  interactive = false,
): Promise<Blob> {
  const res = await authFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    {},
    interactive,
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Drive download failed (${res.status}): ${text.slice(0, 200)}`)
  }
  return res.blob()
}

export function driveFileToRecordingMeta(file: DriveFileMeta): {
  id: string
  title: string
  createdAt: number
  durationMs: number
  mimeType: string
  sizeBytes: number
  driveFileId: string
  driveWebViewLink?: string
  driveShared?: boolean
  driveOnly?: boolean
} {
  const props = file.appProperties ?? {}
  const id = props.mypipcamId || file.id
  return {
    id,
    title: props.title || file.name || 'Recording',
    createdAt: Number(props.createdAt) || Date.parse(file.createdTime ?? '') || 0,
    durationMs: Number(props.durationMs) || 0,
    mimeType: props.mimeType || file.mimeType || 'video/webm',
    sizeBytes: Number(props.sizeBytes) || Number(file.size) || 0,
    driveFileId: file.id,
    driveWebViewLink: file.webViewLink,
    driveOnly: true,
  }
}
