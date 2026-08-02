import {
  cors,
  getSupabase,
  isValidDriveFileId,
  isValidDriveLink,
  json,
  makeShareId,
  mapShare,
  readJson,
  serverError,
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
        .select(
          'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at',
        )
        .in('id', ids)

      if (error) {
        serverError(res, 'batch share lookup failed', error)
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

      if (!recordingId || recordingId.length > 80) {
        json(res, 400, { error: 'recordingId is required' })
        return
      }
      if (driveFileId && !isValidDriveFileId(driveFileId)) {
        json(res, 400, { error: 'driveFileId is not a valid Drive file id' })
        return
      }
      if (driveWebViewLink && !isValidDriveLink(driveWebViewLink)) {
        json(res, 400, {
          error: 'driveWebViewLink must be an https://drive.google.com link',
        })
        return
      }

      const { data: existing, error: findErr } = await supabase
        .from('mypipcam_shares')
        .select(
          'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at',
        )
        .eq('recording_id', recordingId)
        .maybeSingle()

      if (findErr) {
        serverError(res, 'share lookup failed', findErr)
        return
      }

      if (existing) {
        // Refresh Drive fields if the extension re-shares.
        if (
          (driveFileId && driveFileId !== existing.drive_file_id) ||
          (driveWebViewLink && driveWebViewLink !== existing.drive_web_view_link)
        ) {
          const { data: updated, error: updErr } = await supabase
            .from('mypipcam_shares')
            .update({
              drive_file_id: driveFileId ?? existing.drive_file_id,
              drive_web_view_link: driveWebViewLink ?? existing.drive_web_view_link,
            })
            .eq('id', existing.id)
            .select(
              'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at',
            )
            .single()

          if (updErr) {
            serverError(res, 'share update failed', updErr)
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
        })
        .select(
          'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at',
        )
        .single()

      if (insErr) {
        // Race: another create won — return that row.
        if (insErr.code === '23505') {
          const { data: raced } = await supabase
            .from('mypipcam_shares')
            .select(
              'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at',
            )
            .eq('recording_id', recordingId)
            .maybeSingle()
          if (raced) {
            json(res, 200, { share: mapShare(raced), created: false })
            return
          }
        }
        serverError(res, 'share insert failed', insErr)
        return
      }

      json(res, 201, { share: mapShare(created), created: true })
      return
    }

    json(res, 405, { error: 'Method not allowed' })
  } catch (err) {
    if (err.statusCode) {
      json(res, err.statusCode, { error: err.message })
      return
    }
    serverError(res, 'shares handler failed', err)
  }
}
