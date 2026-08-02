import { DEFAULT_API_SETTINGS, type ApiSettings } from './types'

const KEY = 'apiSettings'

/**
 * Load API keys from chrome.storage.local.
 * Keys stay on this device — they are never written to sync storage or logged.
 * Legacy Deepgram / AssemblyAI fields in storage are ignored.
 */
export async function loadApiSettings(): Promise<ApiSettings> {
  const result = await chrome.storage.local.get(KEY)
  const raw = result[KEY] as Partial<ApiSettings> | undefined
  return {
    openaiApiKey: typeof raw?.openaiApiKey === 'string' ? raw.openaiApiKey : DEFAULT_API_SETTINGS.openaiApiKey,
  }
}

export async function saveApiSettings(patch: Partial<ApiSettings>): Promise<ApiSettings> {
  const current = await loadApiSettings()
  const next: ApiSettings = {
    ...current,
    ...sanitizePatch(patch),
  }
  await chrome.storage.local.set({ [KEY]: next })
  return next
}

function sanitizePatch(patch: Partial<ApiSettings>): Partial<ApiSettings> {
  const out: Partial<ApiSettings> = {}
  if (patch.openaiApiKey !== undefined) {
    out.openaiApiKey = patch.openaiApiKey.trim()
  }
  return out
}

export function hasOpenAiKey(settings: ApiSettings): boolean {
  return settings.openaiApiKey.length > 0
}

/** Mask a key for UI display (never log the full value). */
export function maskApiKey(key: string): string {
  const t = key.trim()
  if (!t) return ''
  if (t.length <= 8) return '••••••••'
  return `${t.slice(0, 3)}…${t.slice(-4)}`
}
