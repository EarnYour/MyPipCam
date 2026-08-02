import {
  cors,
  DEFAULT_SHARE_TTL_DAYS,
  expiresAtIsoFromDays,
  getSupabase,
  isShareExpired,
  json,
  makeShareId,
  mapShare,
  normalizeExpiresInDays,
  normalizeProcessingStatus,
  readJson,
  SHARE_SELECT,
} from '../_lib/supabase.js'

/**
 * GET  /api/shares?ids=a,b,c  — batch stats for Library
 * POST /api/shares            — create or return existing share for a recording
 */
export default async function handler(req, res) {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  try {
    const supabase = getSupabase()

    if (req.method === 'GET') {
      const idsParam = String(req.query?.ids || '')
      const ids = idsParam
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length >= 8 && s.length <= 64)
        .slice(0, 100)

      if (ids.length === 0) {
        json(res, 400, { error: 'Pass ?ids=shareId1,shareId2' })
        return
      }

      const { data, error } = await supabase
        .from('mypipcam_shares')
        .select(SHARE_SELECT)
        .in('id', ids)

      if (error) {
        json(res, 500, { error: error.message })
        return
      }

      json(res, 200, { shares: (data || []).map(mapShare) })
      return
    }

    if (req.method === 'POST') {
      const body = await readJson(req)
      const recordingId = String(body.recordingId || '').trim()
      const driveFileId = body.driveFileId ? String(body.driveFileId).trim() : null
      const driveWebViewLink = body.driveWebViewLink
        ? String(body.driveWebViewLink).trim()
        : null
      const ownerHint = body.ownerHint
        ? String(body.ownerHint).trim().slice(0, 80)
        : null
      const processingStatus = normalizeProcessingStatus(body.processingStatus)
      const driveReadyAt =
        body.driveReadyAt === null
          ? null
          : body.driveReadyAt
            ? String(body.driveReadyAt)
            : undefined
      const expiresInDays =
        normalizeExpiresInDays(body.expiresInDays) ?? DEFAULT_SHARE_TTL_DAYS
      const renew = Boolean(body.renew)

      if (!recordingId || recordingId.length > 80) {
        json(res, 400, { error: 'recordingId is required' })
        return
      }

      const { data: existing, error: findErr } = await supabase
        .from('mypipcam_shares')
        .select(SHARE_SELECT)
        .eq('recording_id', recordingId)
        .maybeSingle()

      if (findErr) {
        json(res, 500, { error: findErr.message })
        return
      }

      if (existing) {
        const patch = {}
        if (driveFileId && driveFileId !== existing.drive_file_id) {
          patch.drive_file_id = driveFileId
        }
        if (driveWebViewLink && driveWebViewLink !== existing.drive_web_view_link) {
          patch.drive_web_view_link = driveWebViewLink
        }
        if (processingStatus && processingStatus !== existing.processing_status) {
          patch.processing_status = processingStatus
        }
        if (driveReadyAt !== undefined && driveReadyAt !== existing.drive_ready_at) {
          patch.drive_ready_at = driveReadyAt
        }
        // Renew only when asked, or automatically if the link already expired.
        if (renew || isShareExpired(existing)) {
          patch.expires_at = expiresAtIsoFromDays(expiresInDays)
        }

        if (Object.keys(patch).length > 0) {
          const { data: updated, error: updErr } = await supabase
            .from('mypipcam_shares')
            .update(patch)
            .eq('id', existing.id)
            .select(SHARE_SELECT)
            .single()

          if (updErr) {
            json(res, 500, { error: updErr.message })
            return
          }
          json(res, 200, { share: mapShare(updated), created: false })
          return
        }

        json(res, 200, { share: mapShare(existing), created: false })
        return
      }

      const id = makeShareId()
      const { data: created, error: insErr } = await supabase
        .from('mypipcam_shares')
        .insert({
          id,
          recording_id: recordingId,
          drive_file_id: driveFileId,
          drive_web_view_link: driveWebViewLink,
          owner_hint: ownerHint,
          processing_status: processingStatus || 'processing',
          drive_ready_at: driveReadyAt === undefined ? null : driveReadyAt,
          expires_at: expiresAtIsoFromDays(expiresInDays),
        })
        .select(SHARE_SELECT)
        .single()

      if (insErr) {
        // Race: another create won — return that row.
        if (insErr.code === '23505') {
          const { data: raced } = await supabase
            .from('mypipcam_shares')
            .select(SHARE_SELECT)
            .eq('recording_id', recordingId)
            .maybeSingle()
          if (raced) {
            json(res, 200, { share: mapShare(raced), created: false })
            return
          }
        }
        json(res, 500, { error: insErr.message })
        return
      }

      json(res, 201, { share: mapShare(created), created: true })
      return
    }

    json(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    json(res, err.statusCode || 500, { error: err.message || 'Server error' })
  }
}
