import { createHash } from 'node:crypto'
import {
  cors,
  getSupabase,
  isShareExpired,
  json,
  mapShare,
  readJson,
  serverError,
  SHARE_SELECT,
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

    const supabase = getSupabase()

    // Fast path: reject expired before inserting a view row.
    const { data: existing, error: findErr } = await supabase
      .from('mypipcam_shares')
      .select(SHARE_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (findErr) {
      serverError(res, 'share lookup failed', findErr)
      return
    }
    if (!existing) {
      json(res, 404, { error: 'Share not found' })
      return
    }
    if (isShareExpired(existing)) {
      json(res, 410, {
        error: 'This link has expired',
        expired: true,
        share: mapShare(existing),
      })
      return
    }

    const ua = String(req.headers['user-agent'] || '')
    const uaHash = ua
      ? createHash('sha256').update(ua).digest('hex').slice(0, 32)
      : null

    const { data, error } = await supabase.rpc('mypipcam_record_view', {
      p_share_id: id,
      p_ua_hash: uaHash,
    })

    if (error) {
      // The RPC raises for expired / missing / malformed ids. Anything else is
      // a real fault and must not leak its message to the caller.
      const msg = error.message || ''
      const expired = /share expired/i.test(msg)
      const notFound =
        /share not found|invalid share/i.test(msg) || error.code === 'P0001'
      if (expired) {
        json(res, 410, { error: 'This link has expired', expired: true })
        return
      }
      if (notFound) {
        json(res, 404, { error: 'Share not found' })
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
