import { DRIVE_LIBRARY_FOLDER_NAME } from './driveConfig'

const KEY = 'driveSettings'

export type DriveSettings = {
  /** Drive folder ID for the shared MyPipCam library (synced across Chrome). */
  folderId: string | null
  folderName: string | null
  /** Upload new recordings to Drive after local save when connected. */
  autoUpload: boolean
}

export const DEFAULT_DRIVE_SETTINGS: DriveSettings = {
  folderId: null,
  folderName: null,
  autoUpload: true,
}

/** Folder ID lives in sync so the same Google Chrome profile set shares the library. */
export async function loadDriveSettings(): Promise<DriveSettings> {
  const result = await chrome.storage.sync.get(KEY)
  return { ...DEFAULT_DRIVE_SETTINGS, ...(result[KEY] as Partial<DriveSettings> | undefined) }
}

export async function saveDriveSettings(
  patch: Partial<DriveSettings>,
): Promise<DriveSettings> {
  const current = await loadDriveSettings()
  const next: DriveSettings = {
    ...current,
    ...patch,
    folderName: patch.folderName === undefined ? current.folderName : patch.folderName,
    folderId: patch.folderId === undefined ? current.folderId : patch.folderId,
  }
  await chrome.storage.sync.set({ [KEY]: next })
  return next
}

export async function clearDriveSettings(): Promise<void> {
  await chrome.storage.sync.remove(KEY)
}

export function driveFolderLabel(settings: DriveSettings): string {
  if (!settings.folderId) return 'Not connected'
  return settings.folderName || DRIVE_LIBRARY_FOLDER_NAME
}
