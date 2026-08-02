import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { RecordingMeta, RecordingRecord } from './types'
import { defaultTitle } from './types'

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
    mimeType: input.mimeType ?? input.blob.type || 'video/webm',
    sizeBytes: input.blob.size,
    thumbnail: input.thumbnail,
    blob: input.blob,
  }
  const db = await getDb()
  await db.put('recordings', record)
  return record
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const db = await getDb()
  const all = await db.getAllFromIndex('recordings', 'by-created')
  return all
    .map(({ blob: _blob, ...meta }) => meta)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function getRecording(id: string): Promise<RecordingRecord | undefined> {
  const db = await getDb()
  return db.get('recordings', id)
}

export async function renameRecording(id: string, title: string): Promise<void> {
  const db = await getDb()
  const rec = await db.get('recordings', id)
  if (!rec) throw new Error('Recording not found')
  await db.put('recordings', { ...rec, title: title.trim() || rec.title })
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('recordings', id)
}

export async function updateRecordingBlob(
  id: string,
  blob: Blob,
  durationMs: number,
  thumbnail?: Blob,
  overwrite = true,
): Promise<RecordingRecord> {
  const db = await getDb()
  const existing = await db.get('recordings', id)
  if (!existing) throw new Error('Recording not found')

  if (overwrite) {
    const updated: RecordingRecord = {
      ...existing,
      blob,
      durationMs,
      sizeBytes: blob.size,
      mimeType: blob.type || existing.mimeType,
      thumbnail: thumbnail ?? existing.thumbnail,
    }
    await db.put('recordings', updated)
    return updated
  }

  return saveRecording({
    blob,
    durationMs,
    thumbnail,
    title: `${existing.title} (edited)`,
    mimeType: blob.type || existing.mimeType,
  })
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
