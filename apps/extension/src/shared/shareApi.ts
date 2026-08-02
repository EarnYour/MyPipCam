import { SHARE_API_BASE, watchUrlForShareId } from './shareConfig'

export type ShareStats = {
  id: string
  recordingId: string
  driveFileId?: string
  driveWebViewLink?: string
  createdAt?: string
  viewCount: number
  lastViewedAt: string | null
  watchUrl: string
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

/** Register (or reuse) a MyPipCam share for a Drive-backed recording. */
export async function createOrGetShare(input: {
  recordingId: string
  driveFileId: string
  driveWebViewLink?: string
  ownerHint?: string
}): Promise<ShareStats> {
  const res = await fetch(`${SHARE_API_BASE}/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recordingId: input.recordingId,
      driveFileId: input.driveFileId,
      driveWebViewLink: input.driveWebViewLink,
      ownerHint: input.ownerHint,
    }),
  })
  const data = await parseJson<CreateShareResponse>(res)
  const share = data.share
  return {
    ...share,
    watchUrl: share.watchUrl || watchUrlForShareId(share.id),
    viewCount: share.viewCount ?? 0,
    lastViewedAt: share.lastViewedAt ?? null,
  }
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
    out[share.id] = {
      ...share,
      watchUrl: share.watchUrl || watchUrlForShareId(share.id),
      viewCount: share.viewCount ?? 0,
      lastViewedAt: share.lastViewedAt ?? null,
    }
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
