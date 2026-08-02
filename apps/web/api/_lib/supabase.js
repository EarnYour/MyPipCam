import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

/**
 * Server-side Supabase client (anon key + RLS).
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY
 */
export function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_ANON_KEY
  if (!url || !key) {
    const err = new Error(
      'Missing SUPABASE_URL or SUPABASE_ANON_KEY. Set them in Vercel project env.',
    )
    err.statusCode = 503
    throw err
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
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
    watchUrl: `https://mypipcam.earnyour.com/w/${row.id}`,
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
