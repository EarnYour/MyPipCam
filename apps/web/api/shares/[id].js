import {
  cors,
  DEFAULT_SHARE_TTL_DAYS,
  expiresAtIsoFromDays,
  getSupabase,
  isShareExpired,
  json,
  mapShare,
  mapSharePublic,
  normalizeExpiresInDays,
  normalizeProcessingStatus,
  readJson,
  SHARE_SELECT,
} from '../_lib/supabase.js'

/**
 * GET   /api/shares/:id — public share metadata for the watch page
 * PATCH /api/shares/:id — update Drive processing readiness / renew expiry
 */
export default async function handler(req, res) {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  try {
    const id = String(req.query?.id || '').trim()
    if (!id || id.length < 8 || id.length > 64) {
      json(res, 400, { error: 'Invalid share id' })
      return
    }

    const supabase = getSupabase()

    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('mypipcam_shares')
        .select(SHARE_SELECT)
        .eq('id', id)
        .maybeSingle()

      if (error) {
        json(res, 500, { error: error.message })
        return
      }
      if (!data) {
        json(res, 404, { error: 'Share not found' })
        return
      }

      if (isShareExpired(data)) {
        json(res, 410, {
          error: 'This link has expired',
          expired: true,
          share: mapSharePublic(data),
        })
        return
      }

      json(res, 200, { share: mapSharePublic(data) })
      return
    }

    if (req.method === 'PATCH') {
      const body = await readJson(req)
      const processingStatus = normalizeProcessingStatus(body.processingStatus)
      const driveReadyAt =
        body.driveReadyAt === null
          ? null
          : body.driveReadyAt
            ? String(body.driveReadyAt)
            : undefined
      const renew = Boolean(body.renew)
      const expiresInDays = normalizeExpiresInDays(body.expiresInDays)

      if (
        !processingStatus &&
        driveReadyAt === undefined &&
        !renew &&
        expiresInDays == null
      ) {
        json(res, 400, {
          error: 'Provide processingStatus, driveReadyAt, renew, and/or expiresInDays',
        })
        return
      }

      const patch = {}
      if (processingStatus) patch.processing_status = processingStatus
      if (driveReadyAt !== undefined) patch.drive_ready_at = driveReadyAt
      if (processingStatus === 'ready' && driveReadyAt === undefined) {
        patch.drive_ready_at = new Date().toISOString()
      }
      if (renew || expiresInDays != null) {
        patch.expires_at = expiresAtIsoFromDays(
          expiresInDays ?? DEFAULT_SHARE_TTL_DAYS,
        )
      }

      const { data, error } = await supabase
        .from('mypipcam_shares')
        .update(patch)
        .eq('id', id)
        .select(SHARE_SELECT)
        .maybeSingle()

      if (error) {
        json(res, 500, { error: error.message })
        return
      }
      if (!data) {
        json(res, 404, { error: 'Share not found' })
        return
      }

      json(res, 200, { share: mapShare(data) })
      return
    }

    json(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    json(res, err.statusCode || 500, { error: err.message || 'Server error' })
  }
}
