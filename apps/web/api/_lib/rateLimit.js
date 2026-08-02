/**
 * Fixed-window in-memory rate limiter.
 *
 * Scope caveat: serverless instances don't share memory, so this caps burst
 * abuse per instance rather than enforcing a global limit. A distributed
 * attacker needs platform-level controls (Vercel WAF / firewall rules) on
 * top of this — but for a public, unauthenticated API this stops the cheap
 * single-source spam loop, which is the realistic abuse case.
 */

const WINDOW_MS = 60_000
const MAX_TRACKED_KEYS = 10_000

const buckets = new Map()

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '')
  const first = fwd.split(',')[0].trim()
  if (first) return first
  return req.socket?.remoteAddress || 'unknown'
}

function prune(now) {
  if (buckets.size < MAX_TRACKED_KEYS) return
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key)
  }
  // Pathological case: everything is live. Drop oldest windows to stay bounded.
  if (buckets.size >= MAX_TRACKED_KEYS) {
    const excess = buckets.size - MAX_TRACKED_KEYS + 1
    let dropped = 0
    for (const key of buckets.keys()) {
      buckets.delete(key)
      if (++dropped >= excess) break
    }
  }
}

/**
 * Returns true if the request may proceed. Otherwise sends a 429 response
 * (with Retry-After) and returns false — the caller must stop handling.
 *
 * @param {string} bucket per-endpoint name so limits don't bleed across routes
 * @param {number} limit max requests per client IP per minute
 */
export function rateLimit(req, res, bucket, limit) {
  const now = Date.now()
  const key = `${bucket}:${clientIp(req)}`
  let entry = buckets.get(key)
  if (!entry || entry.resetAt <= now) {
    prune(now)
    entry = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, entry)
  }
  entry.count += 1
  if (entry.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    res.statusCode = 429
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Retry-After', String(retryAfterSec))
    res.end(JSON.stringify({ error: 'Too many requests' }))
    return false
  }
  return true
}
