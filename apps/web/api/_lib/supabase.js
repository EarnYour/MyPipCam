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
    const err = new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in Vercel project env (never commit service_role).',
    )
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

export function cors(req, res) {
  const origin = req.headers.origin || '*'
  // Extension pages use chrome-extension:// origins; allow those + product site.
  const allowed =
    origin === '*' ||
    origin.startsWith('chrome-extension://') ||
    origin.endsWith('mypipcam.earnyour.com') ||
    origin.endsWith('mypipcam.vercel.app') ||
    origin.includes('localhost') ||
    origin.includes('127.0.0.1')

  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : 'https://mypipcam.earnyour.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
}

/** Columns selected for share API responses. */
export const SHARE_SELECT =
  'id,recording_id,drive_file_id,drive_web_view_link,owner_hint,created_at,view_count,last_viewed_at,processing_status,drive_ready_at,expires_at'

/** Default public watch-link lifetime. */
export const DEFAULT_SHARE_TTL_DAYS = 30

const ALLOWED_SHARE_TTL_DAYS = new Set([7, 30, 90])

const PROCESSING_STATUSES = new Set(['unknown', 'processing', 'ready'])

export function normalizeProcessingStatus(value) {
  const s = String(value || '').trim().toLowerCase()
  return PROCESSING_STATUSES.has(s) ? s : null
}

/** Accept 7 / 30 / 90; otherwise null (caller picks default). */
export function normalizeExpiresInDays(value) {
  const n = Number(value)
  return ALLOWED_SHARE_TTL_DAYS.has(n) ? n : null
}

export function expiresAtIsoFromDays(days = DEFAULT_SHARE_TTL_DAYS) {
  const d = ALLOWED_SHARE_TTL_DAYS.has(days) ? days : DEFAULT_SHARE_TTL_DAYS
  return new Date(Date.now() + d * 86_400_000).toISOString()
}

export function isShareExpired(row) {
  if (!row?.expires_at) return false
  const t = Date.parse(row.expires_at)
  return Number.isFinite(t) && t <= Date.now()
}

export function mapShare(row) {
  if (!row) return null
  return {
    id: row.id,
    recordingId: row.recording_id,
    driveFileId: row.drive_file_id ?? undefined,
    driveWebViewLink: row.drive_web_view_link ?? undefined,
    ownerHint: row.owner_hint ?? undefined,
    createdAt: row.created_at,
    viewCount: row.view_count ?? 0,
    lastViewedAt: row.last_viewed_at ?? null,
    processingStatus: row.processing_status || 'unknown',
    driveReadyAt: row.drive_ready_at ?? null,
    expiresAt: row.expires_at ?? null,
    expired: isShareExpired(row),
    watchUrl: `https://mypipcam.earnyour.com/w/${row.id}`,
  }
}

/** Public watch-page payload — strip Drive ids when the link is expired. */
export function mapSharePublic(row) {
  const share = mapShare(row)
  if (!share || !share.expired) return share
  return {
    ...share,
    driveFileId: undefined,
    driveWebViewLink: undefined,
  }
}

/** URL-safe share id (~16 chars). */
export function makeShareId() {
  const bytes = randomBytes(12)
  let out = ''
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

export async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  return JSON.parse(raw)
}
