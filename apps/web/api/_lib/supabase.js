import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * Server-side Supabase client.
 * Prefer SUPABASE_SERVICE_ROLE_KEY (bypasses RLS; never ship to the browser).
 * Falls back to SUPABASE_ANON_KEY only if service role is unset (dev).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required in production)
 */
export function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) {
    const err = new Error('Share service is not configured')
    err.statusCode = 503
    throw err
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.VERCEL) {
    console.warn(
      '[mypipcam] SUPABASE_SERVICE_ROLE_KEY unset on Vercel — using anon key; configure service_role for locked-down RLS.',
    )
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export function json(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Log the real error server-side, return a generic message to the client.
 * Internal Supabase/driver messages must never reach callers.
 */
export function serverError(res, context, error) {
  console.error(`[mypipcam] ${context}:`, error?.message || error)
  json(res, 500, { error: 'Server error' })
}

const ALLOWED_ORIGINS = new Set([
  'https://mypipcam.earnyour.com',
  'https://mypipcam.vercel.app',
])

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true
  // Extension pages use chrome-extension:// origins.
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}

export function cors(req, res) {
  const origin = req.headers.origin || ''
  res.setHeader(
    'Access-Control-Allow-Origin',
    origin && isAllowedOrigin(origin) ? origin : 'https://mypipcam.earnyour.com',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
}

/** Google Drive file IDs are URL-safe tokens. */
export function isValidDriveFileId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{10,120}$/.test(id)
}

/** Only real Google Drive/Docs links may be stored — the watch page renders this. */
export function isValidDriveLink(link) {
  if (typeof link !== 'string' || link.length > 500) return false
  try {
    const { protocol, hostname } = new URL(link)
    return (
      protocol === 'https:' &&
      (hostname === 'drive.google.com' || hostname === 'docs.google.com')
    )
  } catch {
    return false
  }
}

export function mapShare(row) {
  if (!row) return null
  // owner_hint is intentionally omitted: it is caller-supplied free text and
  // must not be disclosed to anyone who merely knows a share id.
  return {
    id: row.id,
    recordingId: row.recording_id,
    driveFileId: row.drive_file_id ?? undefined,
    driveWebViewLink: row.drive_web_view_link ?? undefined,
    createdAt: row.created_at,
    viewCount: row.view_count ?? 0,
    lastViewedAt: row.last_viewed_at ?? null,
    watchUrl: `https://mypipcam.earnyour.com/w/${row.id}`,
  }
}

/** URL-safe share id, 16 chars / 96 bits (no modulo bias). */
export function makeShareId() {
  return randomBytes(12).toString('base64url')
}

const MAX_BODY_BYTES = 64 * 1024

export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body too large')
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const err = new Error('Invalid JSON body')
    err.statusCode = 400
    throw err
  }
}
