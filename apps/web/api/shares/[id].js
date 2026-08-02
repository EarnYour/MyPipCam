import { cors, getSupabase, json, mapShare } from '../_lib/supabase.js'

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
    const id = String(req.query?.id || '').trim()
    if (!id || id.length < 8 || id.length > 64) {
      json(res, 400, { error: 'Invalid share id' })
      return
    }

    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('mypipcam_shares')
      .select(
        'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at',
      )
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

    json(res, 200, { share: mapShare(data) })
  } catch (err) {
    json(res, err.statusCode || 500, { error: err.message || 'Server error' })
  }
}
