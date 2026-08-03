/**
 * Virtual organization folders for the Library.
 *
 * Folders are metadata only — recordings stay under `recordings/<uuid>/`.
 * On disk: `folders.json` at the library root + `folderId` in each `meta.json`.
 * Browser-only (no FS grant): `chrome.storage.local` key `libraryFolders`.
 */

import { isSafeRecordingId } from './security'
import type { LibraryFolder } from './types'
import {
  ensureLibraryPermission,
  FOLDERS_FILE,
  readFoldersFile,
  writeFoldersFile,
} from './libraryFs'

export const STORAGE_LIBRARY_FOLDERS = 'libraryFolders'
export const FOLDERS_FILE_VERSION = 1 as const

export type LibraryFoldersPayload = {
  version: typeof FOLDERS_FILE_VERSION
  folders: LibraryFolder[]
}

export type LibraryBrowseFilter = 'all' | 'unfiled' | string

const FOLDER_NAME_MAX = 80

export function normalizeFolderName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, FOLDER_NAME_MAX)
}

export function isSafeFolderId(id: unknown): id is string {
  return isSafeRecordingId(id)
}

function sortFolders(folders: LibraryFolder[]): LibraryFolder[] {
  return [...folders].sort((a, b) => {
    const ao = a.sortOrder ?? a.createdAt
    const bo = b.sortOrder ?? b.createdAt
    if (ao !== bo) return ao - bo
    return a.name.localeCompare(b.name)
  })
}

function emptyPayload(): LibraryFoldersPayload {
  return { version: FOLDERS_FILE_VERSION, folders: [] }
}

function sanitizePayload(raw: unknown): LibraryFoldersPayload {
  if (!raw || typeof raw !== 'object') return emptyPayload()
  const obj = raw as { version?: unknown; folders?: unknown }
  const foldersRaw = Array.isArray(obj.folders) ? obj.folders : []
  const folders: LibraryFolder[] = []
  const seen = new Set<string>()
  for (const entry of foldersRaw) {
    if (!entry || typeof entry !== 'object') continue
    const f = entry as Partial<LibraryFolder>
    if (!isSafeFolderId(f.id)) continue
    if (seen.has(f.id)) continue
    const name = typeof f.name === 'string' ? normalizeFolderName(f.name) : ''
    if (!name) continue
    const createdAt =
      typeof f.createdAt === 'number' && Number.isFinite(f.createdAt)
        ? f.createdAt
        : Date.now()
    const sortOrder =
      typeof f.sortOrder === 'number' && Number.isFinite(f.sortOrder)
        ? f.sortOrder
        : undefined
    seen.add(f.id)
    folders.push({
      id: f.id,
      name,
      createdAt,
      ...(sortOrder !== undefined ? { sortOrder } : {}),
    })
  }
  return { version: FOLDERS_FILE_VERSION, folders: sortFolders(folders) }
}

async function loadFoldersFromStorage(): Promise<LibraryFoldersPayload> {
  const result = await chrome.storage.local.get(STORAGE_LIBRARY_FOLDERS)
  return sanitizePayload(result[STORAGE_LIBRARY_FOLDERS])
}

async function saveFoldersToStorage(payload: LibraryFoldersPayload): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_LIBRARY_FOLDERS]: {
      version: FOLDERS_FILE_VERSION,
      folders: sortFolders(payload.folders),
    },
  })
}

/** Prefer on-disk folders.json when the library root is granted; else chrome.storage. */
export async function listLibraryFolders(
  root?: FileSystemDirectoryHandle | null,
): Promise<LibraryFolder[]> {
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (permitted) {
    try {
      const disk = await readFoldersFile(permitted)
      if (disk) return sanitizePayload(disk).folders
    } catch {
      /* fall through */
    }
  }
  return (await loadFoldersFromStorage()).folders
}

async function persistFolders(
  folders: LibraryFolder[],
  root?: FileSystemDirectoryHandle | null,
): Promise<LibraryFolder[]> {
  const payload: LibraryFoldersPayload = {
    version: FOLDERS_FILE_VERSION,
    folders: sortFolders(folders),
  }
  const permitted =
    root ?? (await ensureLibraryPermission(undefined, { request: false }))
  if (permitted) {
    await writeFoldersFile(permitted, payload)
  }
  // Keep chrome.storage in sync so IDB-only sessions and SW paths stay consistent.
  await saveFoldersToStorage(payload)
  return payload.folders
}

export async function createLibraryFolder(
  name: string,
  root?: FileSystemDirectoryHandle | null,
): Promise<LibraryFolder> {
  const normalized = normalizeFolderName(name)
  if (!normalized) throw new Error('Folder name is required.')
  const current = await listLibraryFolders(root)
  if (current.some((f) => f.name.toLowerCase() === normalized.toLowerCase())) {
    throw new Error('A folder with that name already exists.')
  }
  const folder: LibraryFolder = {
    id: crypto.randomUUID(),
    name: normalized,
    createdAt: Date.now(),
    sortOrder: current.length,
  }
  await persistFolders([...current, folder], root)
  return folder
}

export async function renameLibraryFolder(
  id: string,
  name: string,
  root?: FileSystemDirectoryHandle | null,
): Promise<LibraryFolder> {
  if (!isSafeFolderId(id)) throw new Error('Invalid folder id')
  const normalized = normalizeFolderName(name)
  if (!normalized) throw new Error('Folder name is required.')
  const current = await listLibraryFolders(root)
  const existing = current.find((f) => f.id === id)
  if (!existing) throw new Error('Folder not found')
  if (
    current.some(
      (f) => f.id !== id && f.name.toLowerCase() === normalized.toLowerCase(),
    )
  ) {
    throw new Error('A folder with that name already exists.')
  }
  const next = current.map((f) =>
    f.id === id ? { ...f, name: normalized } : f,
  )
  await persistFolders(next, root)
  return { ...existing, name: normalized }
}

/**
 * Delete a folder definition. Recordings that pointed at it become Unfiled
 * (caller should clear `folderId` on items — see `deleteLibraryFolderAndUnfile`).
 */
export async function deleteLibraryFolder(
  id: string,
  root?: FileSystemDirectoryHandle | null,
): Promise<void> {
  if (!isSafeFolderId(id)) throw new Error('Invalid folder id')
  const current = await listLibraryFolders(root)
  if (!current.some((f) => f.id === id)) return
  await persistFolders(
    current.filter((f) => f.id !== id),
    root,
  )
}

/** Copy chrome.storage folders onto a newly granted disk root if missing. */
export async function seedFoldersFileFromStorage(
  root: FileSystemDirectoryHandle,
): Promise<void> {
  const existing = await readFoldersFile(root)
  if (existing?.folders?.length) return
  const fromStorage = await loadFoldersFromStorage()
  if (fromStorage.folders.length === 0) {
    await writeFoldersFile(root, emptyPayload())
    return
  }
  await writeFoldersFile(root, fromStorage)
}

export function folderMatchesFilter(
  folderId: string | null | undefined,
  filter: LibraryBrowseFilter,
): boolean {
  if (filter === 'all') return true
  if (filter === 'unfiled') return !folderId
  return folderId === filter
}

export { FOLDERS_FILE }
