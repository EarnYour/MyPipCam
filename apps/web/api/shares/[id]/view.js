import { createHash } from 'node:crypto'
import {
  cors,
  getSupabase,
  json,
  mapShare,
  readJson,
  serverError,
} from '../../_lib/supabase.js'
import { rateLimit } from '../../_lib/rateLimit.js'

/**
 * POST /api/shares/:id/view — record a watch-page open (counts as a view)
 */
export default async function handler(req, res) {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  if (req.method !== 'POST') {
    json(res, 405, { error: 'Method not allowed' })
    return
  }

  try {
    if (!rateLimit(req, res, 'share-view', 30)) return

    const id = String(req.query?.id || '').trim()
    if (!id || id.length < 8 || id.length > 64) {
      json(res, 400, { error: 'Invalid share id' })
      return
    }

    // Optional body; UA comes from headers. Never store raw UA — coarse hash only.
    try {
      await readJson(req)
    } catch {
      /* empty body ok */
    }

    const ua = String(req.headers['user-agent'] || '')
    const uaHash = ua
      ? createHash('sha256').update(ua).digest('hex').slice(0, 32)
      : null

    const supabase = getSupabase()
    const { data, error } = await supabase.rpc('mypipcam_record_view', {
      p_share_id: id,
      p_ua_hash: uaHash,
    })

    if (error) {
      const msg = error.message || ''
      const notFound =
        /share not found|invalid share|share expired/i.test(msg) ||
        error.code === 'P0001'
      if (notFound) {
        json(res, 404, {
          error: /expired/i.test(msg) ? 'Share link expired' : 'Share not found',
        })
        return
      }
      serverError(res, 'record view failed', error)
      return
    }

    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      json(res, 404, { error: 'Share not found' })
      return
    }

    json(res, 200, { share: mapShare(row) })
  } catch (err) {
    if (err.statusCode) {
      json(res, err.statusCode, { error: err.message })
      return
    }
    serverError(res, 'view handler failed', err)
  }
}
