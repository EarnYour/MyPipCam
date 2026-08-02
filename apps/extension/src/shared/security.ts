/**
 * Small security helpers for message validation, IDs, and CSS color values.
 */

/** UUID v4 (and crypto.randomUUID) shape — used as on-disk recording folder names. */
const RECORDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Reject path separators / traversal in folder segment names. */
const UNSAFE_ID_CHARS = /[/\\]|\.\./

export function isSafeRecordingId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const t = id.trim()
  if (!t || t.length > 64) return false
  if (UNSAFE_ID_CHARS.test(t)) return false
  return RECORDING_ID_RE.test(t)
}

/**
 * Allow only simple CSS color tokens for borderColor style assignment.
 * Blocks url(), expression(), and other CSS injection vectors.
 */
export function sanitizeCssColor(raw: unknown, fallback = '#ffffff'): string {
  if (typeof raw !== 'string') return fallback
  const v = raw.trim().toLowerCase()
  if (!v || v.length > 64) return fallback
  if (v === 'transparent') return 'transparent'
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v
  if (/^rgba?\(\s*[\d.]+\s*(,\s*[\d.]+\s*){2,3}(,?\s*[\d.%]+\s*)?\)$/i.test(v)) return v
  if (/^[a-z]{3,20}$/i.test(v)) return v
  return fallback
}

/** True when the message is from this extension (not an external app). */
export function isTrustedExtensionSender(
  sender: chrome.runtime.MessageSender | undefined,
): boolean {
  if (!sender) return false
  // Chrome always sets sender.id for extension messages; reject mismatches.
  if (sender.id != null && sender.id !== chrome.runtime.id) return false
  return true
}

/** Content scripts always have a tab; prefer this for tab-only control surfaces. */
export function isContentScriptSender(
  sender: chrome.runtime.MessageSender | undefined,
): boolean {
  return Boolean(isTrustedExtensionSender(sender) && sender?.tab?.id != null)
}

export function createPipChannelToken(): string {
  return crypto.randomUUID()
}

export function isPipChannelToken(token: unknown): token is string {
  return typeof token === 'string' && RECORDING_ID_RE.test(token.trim())
}
