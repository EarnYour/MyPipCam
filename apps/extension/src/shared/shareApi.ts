import { SHARE_API_BASE, watchUrlForShareId } from './shareConfig'

export type ShareProcessingStatus = 'unknown' | 'processing' | 'ready'

/** Allowed share link lifetimes (days). Default is 30. */
export type ShareTtlDays = 7 | 30 | 90

export const DEFAULT_SHARE_TTL_DAYS: ShareTtlDays = 30

export type ShareStats = {
  id: string
  recordingId: string
  driveFileId?: string
  driveWebViewLink?: string
  createdAt?: string
  viewCount: number
  lastViewedAt: string | null
  watchUrl: string
  processingStatus?: ShareProcessingStatus
  driveReadyAt?: string | null
  expiresAt?: string | null
  expired?: boolean
}

type CreateShareResponse = {
  share: ShareStats
  created: boolean
}

type BatchSharesResponse = {
  shares: ShareStats[]
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw new Error(
      (data && typeof data === 'object' && 'error' in data && data.error) ||
        `Share API error (${res.status})`,
    )
  }
  return data
}

function normalizeShare(share: ShareStats): ShareStats {
  const expiresAt = share.expiresAt ?? null
  const expired =
    share.expired ??
    (expiresAt ? Date.parse(expiresAt) <= Date.now() : false)
  return {
    ...share,
    watchUrl: share.watchUrl || watchUrlForShareId(share.id),
    viewCount: share.viewCount ?? 0,
    lastViewedAt: share.lastViewedAt ?? null,
    processingStatus: share.processingStatus ?? 'unknown',
    driveReadyAt: share.driveReadyAt ?? null,
    expiresAt,
    expired,
  }
}

/** Register (or reuse) a MyPipCam share for a Drive-backed recording. */
export async function createOrGetShare(input: {
  recordingId: string
  driveFileId: string
  driveWebViewLink?: string
  ownerHint?: string
  processingStatus?: ShareProcessingStatus
  driveReadyAt?: string | null
  /** Extend expires_at from now (also used to pick TTL on create). */
  renew?: boolean
  expiresInDays?: ShareTtlDays
}): Promise<ShareStats> {
  const body: Record<string, unknown> = {
    recordingId: input.recordingId,
    driveFileId: input.driveFileId,
    driveWebViewLink: input.driveWebViewLink,
    ownerHint: input.ownerHint,
    processingStatus: input.processingStatus,
    driveReadyAt: input.driveReadyAt,
  }
  if (input.renew) body.renew = true
  if (input.expiresInDays != null) body.expiresInDays = input.expiresInDays

  const res = await fetch(`${SHARE_API_BASE}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await parseJson<CreateShareResponse>(res)
  return normalizeShare(data.share)
}

/** Update Drive playback readiness on an existing share (watch page polls this). */
export async function updateShareProcessing(input: {
  shareId: string
  processingStatus: ShareProcessingStatus
  driveReadyAt?: string | null
}): Promise<ShareStats> {
  const res = await fetch(
    `${SHARE_API_BASE}/shares/${encodeURIComponent(input.shareId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        processingStatus: input.processingStatus,
        driveReadyAt: input.driveReadyAt,
      }),
    },
  )
  const data = await parseJson<{ share: ShareStats }>(res)
  return normalizeShare(data.share)
}

/** Extend a share link’s expires_at (default +30 days from now). */
export async function renewShare(input: {
  shareId: string
  expiresInDays?: ShareTtlDays
}): Promise<ShareStats> {
  const res = await fetch(
    `${SHARE_API_BASE}/shares/${encodeURIComponent(input.shareId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        renew: true,
        expiresInDays: input.expiresInDays ?? DEFAULT_SHARE_TTL_DAYS,
      }),
    },
  )
  const data = await parseJson<{ share: ShareStats }>(res)
  return normalizeShare(data.share)
}

/** Fetch view stats for share ids (Library refresh). */
export async function fetchShareStats(
  shareIds: string[],
): Promise<Record<string, ShareStats>> {
  const ids = [...new Set(shareIds.filter((id) => id && id.length >= 8))].slice(0, 100)
  if (ids.length === 0) return {}

  const res = await fetch(
    `${SHARE_API_BASE}/shares?ids=${encodeURIComponent(ids.join(','))}`,
  )
  const data = await parseJson<BatchSharesResponse>(res)
  const out: Record<string, ShareStats> = {}
  for (const share of data.shares || []) {
    out[share.id] = normalizeShare(share)
  }
  return out
}

export function formatLastViewed(iso: string | null | undefined): string {
  if (!iso) return 'Not viewed yet'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'Not viewed yet'
  const diff = Date.now() - t
  if (diff < 60_000) return 'Viewed just now'
  if (diff < 3_600_000) {
    const m = Math.round(diff / 60_000)
    return `Last viewed ${m}m ago`
  }
  if (diff < 86_400_000) {
    const h = Math.round(diff / 3_600_000)
    return `Last viewed ${h}h ago`
  }
  return `Last viewed ${new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`
}

export function formatViewBadge(viewCount: number | undefined): string {
  const n = viewCount ?? 0
  if (n <= 0) return '👁 Not viewed yet'
  const views = n === 1 ? '1 view' : `${n} views`
  return `👁 ${views}`
}

/** “Expires Aug 31” / “Expired” for Library share UI. */
export function formatShareExpiry(iso: string | null | undefined): string {
  if (!iso) return 'Expires in 30 days'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'Expires in 30 days'
  if (t <= Date.now()) return 'Expired'
  return `Expires ${new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })}`
}

export function isShareExpired(iso: string | null | undefined): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t <= Date.now()
}
