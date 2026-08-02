import { cors, getSupabase, json, mapShare, serverError } from '../_lib/supabase.js'
import { rateLimit } from '../_lib/rateLimit.js'

/**
 * GET /api/shares/:id — public share metadata for the watch page
 */
export default async function handler(req, res) {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed' })
    return
  }

  try {
    if (!rateLimit(req, res, 'share-get', 120)) return

    const id = String(req.query?.id || '').trim()
    if (!id || id.length < 8 || id.length > 64) {
      json(res, 400, { error: 'Invalid share id' })
      return
    }

    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('mypipcam_shares')
      .select(
        'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at,expires_at',
      )
      .eq('id', id)
      .maybeSingle()

    if (error) {
      serverError(res, 'share fetch failed', error)
      return
    }
    if (!data) {
      json(res, 404, { error: 'Share not found' })
      return
    }
    if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
      json(res, 404, { error: 'Share link expired' })
      return
    }

    json(res, 200, { share: mapShare(data) })
  } catch (err) {
    if (err.statusCode) {
      json(res, err.statusCode, { error: err.message })
      return
    }
    serverError(res, 'share handler failed', err)
  }
}
