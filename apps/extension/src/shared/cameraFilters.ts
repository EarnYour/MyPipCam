/**
 * Camera color filters for the PiP bubble (preview + tab-captured recording).
 * Persisted in chrome.storage.local; also mirrored on PipSettings for load convenience.
 */

import type { CameraFilterId } from './types'

export type { CameraFilterId }

export type CameraFilterDef = {
  id: CameraFilterId
  label: string
  /** CSS filter value for <video>/<canvas> or CanvasRenderingContext2D.filter */
  css: string
  /** Short swatch hint for the popup grid (no live camera). */
  swatch: string
}

export const CAMERA_FILTERS: readonly CameraFilterDef[] = [
  { id: 'none', label: 'None', css: 'none', swatch: 'linear-gradient(145deg,#e8e6e1,#c9c6bf)' },
  { id: 'bw', label: 'B&W', css: 'grayscale(1)', swatch: 'linear-gradient(145deg,#bdbdbd,#4a4a4a)' },
  {
    id: 'sepia',
    label: 'Sepia',
    css: 'sepia(0.9) contrast(1.05)',
    swatch: 'linear-gradient(145deg,#e8d5b0,#8a6a3a)',
  },
  {
    id: 'warm',
    label: 'Warm',
    css: 'sepia(0.28) saturate(1.35) hue-rotate(-12deg) brightness(1.04)',
    swatch: 'linear-gradient(145deg,#ffd4a8,#e07a3a)',
  },
  {
    id: 'cool',
    label: 'Cool',
    css: 'saturate(1.15) hue-rotate(195deg) brightness(1.04)',
    swatch: 'linear-gradient(145deg,#b8d4f0,#3a6ea8)',
  },
  {
    id: 'contrast',
    label: 'Contrast',
    css: 'contrast(1.4) saturate(1.2)',
    swatch: 'linear-gradient(145deg,#fff,#222)',
  },
  {
    id: 'soft',
    label: 'Soft',
    css: 'brightness(1.1) contrast(0.9) saturate(0.88)',
    swatch: 'linear-gradient(145deg,#f5e6dc,#d4b8a8)',
  },
] as const

const FILTER_IDS = new Set<string>(CAMERA_FILTERS.map((f) => f.id))
const FILTER_KEY = 'cameraFilter'

export function isCameraFilterId(value: unknown): value is CameraFilterId {
  return typeof value === 'string' && FILTER_IDS.has(value)
}

export function normalizeCameraFilter(value: unknown): CameraFilterId {
  return isCameraFilterId(value) ? value : 'none'
}

export function cameraFilterCss(id: CameraFilterId | undefined | null): string {
  const normalized = normalizeCameraFilter(id)
  return CAMERA_FILTERS.find((f) => f.id === normalized)?.css ?? 'none'
}

export function cameraFilterLabel(id: CameraFilterId | undefined | null): string {
  const normalized = normalizeCameraFilter(id)
  return CAMERA_FILTERS.find((f) => f.id === normalized)?.label ?? 'None'
}

/** Load filter from chrome.storage.local (source of truth). */
export async function loadCameraFilter(): Promise<CameraFilterId> {
  try {
    const result = await chrome.storage.local.get(FILTER_KEY)
    return normalizeCameraFilter(result[FILTER_KEY])
  } catch {
    return 'none'
  }
}

/** Persist filter to chrome.storage.local. */
export async function saveCameraFilter(id: CameraFilterId): Promise<CameraFilterId> {
  const next = normalizeCameraFilter(id)
  await chrome.storage.local.set({ [FILTER_KEY]: next })
  return next
}
