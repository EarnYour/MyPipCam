/**
 * Shared on-disk library via the File System Access API.
 *
 * Layout (must match the macOS app):
 *   <LibraryRoot>/
 *     .mypipcam-library
 *     recordings/<uuid>/{meta.json, video.webm|mp4, thumb.jpg?, transcript.json?}
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { isSafeRecordingId } from './security'
import type { RecordingMeta, RecordingRecord, TranscriptData } from './types'

export const LIBRARY_MARKER = '.mypipcam-library'
export const LIBRARY_MARKER_VERSION = 1
export const RECORDINGS_DIR = 'recordings'

const HANDLE_DB = 'mypipcam-fs'
const HANDLE_DB_VERSION = 1
const HANDLE_STORE = 'handles'
const HANDLE_KEY = 'libraryRoot'

const STORAGE_FOLDER_NAME = 'libraryFolderName'
const STORAGE_PENDING_IDS = 'libraryPendingSyncIds'

type DiskMeta = {
  id: string
  title: string
  createdAt: number
  durationMs: number
  mimeType: string
  sizeBytes: number
  driveFileId?: string
  driveWebViewLink?: string
  driveShared?: boolean
}

interface HandleDB extends DBSchema {
  handles: {
    key: string
    value: FileSystemDirectoryHandle
  }
}

let handleDbPromise: Promise<IDBPDatabase<HandleDB>> | null = null

function getHandleDb() {
  if (!handleDbPromise) {
    handleDbPromise = openDB<HandleDB>(HANDLE_DB, HANDLE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(HANDLE_STORE)) {
          db.createObjectStore(HANDLE_STORE)
        }
      },
    })
  }
  return handleDbPromise
}

function videoFileName(mimeType: string): 'video.mp4' | 'video.webm' {
  return mimeType.includes('mp4') ? 'video.mp4' : 'video.webm'
}

function toDiskMeta(rec: RecordingMeta | RecordingRecord): DiskMeta {
  const meta: DiskMeta = {
    id: rec.id,
    title: rec.title,
    createdAt: rec.createdAt,
    durationMs: rec.durationMs,
    mimeType: rec.mimeType,
    sizeBytes: rec.sizeBytes,
  }
  if (rec.driveFileId) meta.driveFileId = rec.driveFileId
  if (rec.driveWebViewLink) meta.driveWebViewLink = rec.driveWebViewLink
  if (rec.driveShared != null) meta.driveShared = rec.driveShared
  return meta
}

async function writeTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  text: string,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(text)
  await writable.close()
}

async function writeBlobFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(blob)
  await writable.close()
}

async function readJsonFile<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | undefined> {
  try {
    const file = await dir.getFileHandle(name)
    const text = await (await file.getFile()).text()
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

async function readBlobFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Blob | undefined> {
  try {
    const file = await dir.getFileHandle(name)
    return await file.getFile()
  } catch {
    return undefined
  }
}

async function removeIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: true })
  } catch {
    /* missing is fine */
  }
}

async function ensureLibraryStructure(root: FileSystemDirectoryHandle): Promise<void> {
  await writeTextFile(
    root,
    LIBRARY_MARKER,
    JSON.stringify({ version: LIBRARY_MARKER_VERSION }, null, 2) + '\n',
  )
  await root.getDirectoryHandle(RECORDINGS_DIR, { create: true })
}

export async function persistLibraryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await getHandleDb()
  await db.put(HANDLE_STORE, handle, HANDLE_KEY)
  await chrome.storage.local.set({ [STORAGE_FOLDER_NAME]: handle.name })
}

export async function getLibraryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await getHandleDb()
  const handle = await db.get(HANDLE_STORE, HANDLE_KEY)
  return handle ?? null
}

export async function getLibraryFolderName(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_FOLDER_NAME)
  const name = result[STORAGE_FOLDER_NAME]
  return typeof name === 'string' && name.length > 0 ? name : null
}

export async function clearLibraryFolder(): Promise<void> {
  const db = await getHandleDb()
  await db.delete(HANDLE_STORE, HANDLE_KEY)
  await chrome.storage.local.remove([STORAGE_FOLDER_NAME, STORAGE_PENDING_IDS])
}

export async function hasLibraryFolder(): Promise<boolean> {
  return (await getLibraryHandle()) !== null
}

export async function ensureLibraryPermission(
  handle?: FileSystemDirectoryHandle | null,
  opts?: { request?: boolean },
): Promise<FileSystemDirectoryHandle | null> {
  const root = handle ?? (await getLibraryHandle())
  if (!root) return null

  const mode = { mode: 'readwrite' as const }
  let state = await root.queryPermission(mode)
  if (state === 'granted') return root

  if (opts?.request !== false) {
    state = await root.requestPermission(mode)
  }
  return state === 'granted' ? root : null
}

/** User-gesture directory picker. Creates marker + recordings/ and persists the handle. */
export async function pickLibraryFolder(): Promise<FileSystemDirectoryHandle> {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
  const permitted = await ensureLibraryPermission(handle, { request: true })
  if (!permitted) {
    throw new Error('Permission to the chosen folder was denied.')
  }
  await ensureLibraryStructure(permitted)
  await persistLibraryHandle(permitted)
  return permitted
}

export async function getPendingSyncIds(): Promise<string[]> {
  const result = await chrome.storage.local.get(STORAGE_PENDING_IDS)
  const ids = result[STORAGE_PENDING_IDS]
  return Array.isArray(ids)
    ? ids.filter((id): id is string => isSafeRecordingId(id))
    : []
}

export async function addPendingSyncId(id: string): Promise<void> {
  if (!isSafeRecordingId(id)) return
  const current = await getPendingSyncIds()
  if (current.includes(id)) return
  await chrome.storage.local.set({ [STORAGE_PENDING_IDS]: [...current, id] })
}

export async function removePendingSyncId(id: string): Promise<void> {
  const current = await getPendingSyncIds()
  const next = current.filter((x) => x !== id)
  if (next.length === 0) {
    await chrome.storage.local.remove(STORAGE_PENDING_IDS)
  } else {
    await chrome.storage.local.set({ [STORAGE_PENDING_IDS]: next })
  }
}

export async function writeRecordingToFolder(
  record: RecordingRecord,
  root?: FileSystemDirectoryHandle,
): Promise<void> {
  if (!isSafeRecordingId(record.id)) {
    throw new Error('Invalid recording id')
  }
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  await ensureLibraryStructure(permitted)
  const recordings = await permitted.getDirectoryHandle(RECORDINGS_DIR, { create: true })
  const dir = await recordings.getDirectoryHandle(record.id, { create: true })

  await writeTextFile(dir, 'meta.json', JSON.stringify(toDiskMeta(record), null, 2) + '\n')
  await writeBlobFile(dir, videoFileName(record.mimeType), record.blob)

  // Drop the alternate extension if mime changed.
  const other = videoFileName(record.mimeType) === 'video.mp4' ? 'video.webm' : 'video.mp4'
  await removeIfExists(dir, other)

  if (record.thumbnail) {
    await writeBlobFile(dir, 'thumb.jpg', record.thumbnail)
  } else {
    await removeIfExists(dir, 'thumb.jpg')
  }

  if (record.transcript) {
    await writeTextFile(dir, 'transcript.json', JSON.stringify(record.transcript, null, 2) + '\n')
  } else {
    await removeIfExists(dir, 'transcript.json')
  }
}

async function readRecordingFromDir(
  dir: FileSystemDirectoryHandle,
  fallbackId: string,
): Promise<RecordingRecord | undefined> {
  const meta = await readJsonFile<DiskMeta>(dir, 'meta.json')
  if (!meta?.id || !isSafeRecordingId(meta.id)) return undefined
  if (!isSafeRecordingId(fallbackId) && fallbackId !== meta.id) return undefined

  let video = await readBlobFile(dir, 'video.webm')
  let mimeType = meta.mimeType || 'video/webm'
  if (!video) {
    video = await readBlobFile(dir, 'video.mp4')
    if (video) mimeType = meta.mimeType || 'video/mp4'
  }
  if (!video) return undefined

  const thumbnail = await readBlobFile(dir, 'thumb.jpg')
  const transcript = await readJsonFile<TranscriptData>(dir, 'transcript.json')

  return {
    id: meta.id,
    title: typeof meta.title === 'string' ? meta.title.slice(0, 200) : 'Recording',
    createdAt: meta.createdAt || 0,
    durationMs: meta.durationMs || 0,
    mimeType,
    sizeBytes: meta.sizeBytes || video.size,
    thumbnail,
    transcript,
    blob: video,
    driveFileId: meta.driveFileId,
    driveWebViewLink: meta.driveWebViewLink,
    driveShared: meta.driveShared,
  }
}

/** Patch Drive fields in meta.json without rewriting the video blob. */
export async function updateDriveMetaInFolder(
  id: string,
  patch: Pick<RecordingMeta, 'driveFileId' | 'driveWebViewLink' | 'driveShared'>,
  root?: FileSystemDirectoryHandle,
): Promise<void> {
  if (!isSafeRecordingId(id)) throw new Error('Invalid recording id')
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  const recordings = await permitted.getDirectoryHandle(RECORDINGS_DIR, { create: true })
  const dir = await recordings.getDirectoryHandle(id)
  const meta = await readJsonFile<DiskMeta>(dir, 'meta.json')
  if (!meta?.id) throw new Error('Recording not found')

  const next: DiskMeta = { ...meta }
  if (patch.driveFileId !== undefined) next.driveFileId = patch.driveFileId
  if (patch.driveWebViewLink !== undefined) next.driveWebViewLink = patch.driveWebViewLink
  if (patch.driveShared !== undefined) next.driveShared = patch.driveShared

  await writeTextFile(dir, 'meta.json', JSON.stringify(next, null, 2) + '\n')
}

export async function listFolderRecordings(
  root?: FileSystemDirectoryHandle,
): Promise<RecordingMeta[]> {
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  const recordings = await permitted.getDirectoryHandle(RECORDINGS_DIR, { create: true })
  const items: RecordingMeta[] = []

  for await (const [name, handle] of recordings.entries()) {
    if (handle.kind !== 'directory') continue
    if (!isSafeRecordingId(name)) continue
    const rec = await readRecordingFromDir(handle as FileSystemDirectoryHandle, name)
    if (!rec) continue
    const { blob: _blob, ...meta } = rec
    items.push(meta)
  }

  return items.sort((a, b) => b.createdAt - a.createdAt)
}

export async function readRecording(
  id: string,
  root?: FileSystemDirectoryHandle,
): Promise<RecordingRecord | undefined> {
  if (!isSafeRecordingId(id)) return undefined
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  try {
    const recordings = await permitted.getDirectoryHandle(RECORDINGS_DIR)
    const dir = await recordings.getDirectoryHandle(id)
    return readRecordingFromDir(dir, id)
  } catch {
    return undefined
  }
}

export async function deleteFromFolder(
  id: string,
  root?: FileSystemDirectoryHandle,
): Promise<void> {
  if (!isSafeRecordingId(id)) throw new Error('Invalid recording id')
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  const recordings = await permitted.getDirectoryHandle(RECORDINGS_DIR, { create: true })
  await removeIfExists(recordings, id)
}

export async function renameInFolder(
  id: string,
  title: string,
  root?: FileSystemDirectoryHandle,
): Promise<void> {
  if (!isSafeRecordingId(id)) throw new Error('Invalid recording id')
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  const rec = await readRecording(id, permitted)
  if (!rec) throw new Error('Recording not found')
  const nextTitle = title.trim() || rec.title
  await writeRecordingToFolder({ ...rec, title: nextTitle }, permitted)
}

export async function updateBlobInFolder(
  id: string,
  blob: Blob,
  durationMs: number,
  thumbnail: Blob | undefined,
  root?: FileSystemDirectoryHandle,
): Promise<RecordingRecord> {
  if (!isSafeRecordingId(id)) throw new Error('Invalid recording id')
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  const existing = await readRecording(id, permitted)
  if (!existing) throw new Error('Recording not found')

  const updated: RecordingRecord = {
    ...existing,
    blob,
    durationMs,
    sizeBytes: blob.size,
    mimeType: blob.type || existing.mimeType,
    thumbnail: thumbnail ?? existing.thumbnail,
  }
  await writeRecordingToFolder(updated, permitted)
  return updated
}

export async function updateTranscriptInFolder(
  id: string,
  transcript: TranscriptData | undefined,
  root?: FileSystemDirectoryHandle,
): Promise<void> {
  if (!isSafeRecordingId(id)) throw new Error('Invalid recording id')
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (!permitted) throw new Error('Library folder permission not granted')

  const existing = await readRecording(id, permitted)
  if (!existing) throw new Error('Recording not found')
  await writeRecordingToFolder({ ...existing, transcript }, permitted)
}
