# MyPipCam web (`mypipcam.earnyour.com`)

Static marketing site plus serverless share APIs and Loom-style watch pages.

**Primary CTA:** [Chrome Web Store — Add to Chrome](https://chromewebstore.google.com/detail/mypipcam/meiehjfjcaahfjcdneoegjkmajbfghmm). Secondary: GitHub (source / macOS).

**Tip jar:** [donate.stripe.com/…](https://donate.stripe.com/7sY9AVb6S9uadWwek4cAo09) (pay-what-you-want; hero CTA + `#support` section on the funnel + `?thanks=1` after payment).

## Share links

| URL | Purpose |
| --- | --- |
| `https://mypipcam.earnyour.com/w/{shareId}` | Public watch page (counts as a view on load) |
| `https://mypipcam.earnyour.com/open-library?ext=…&id=…` | macOS → extension Library bridge (`externally_connectable`). `ext=` = store `meiehjfjcaahfjcdneoegjkmajbfghmm` or unpacked `akpchobfndfddajiihkkdpnihihdicjc` |
| `POST /api/shares` | Extension creates/registers a share after Drive anyone-with-link |
| `GET /api/shares?ids=…` | Batch view stats for Library |
| `GET /api/shares/:id` | Share metadata for the watch page (`410` when expired) |
| `PATCH /api/shares/:id` | Update Drive processing readiness and/or renew expiry |
| `POST /api/shares/:id/view` | Record a view (coarse UA hash only; rejected when expired) |

Share links expire by default **30 days** after create/renew (`expires_at` on `mypipcam_shares`). Optional TTL on create/renew: `7` / `30` / `90` days via `expiresInDays`. Expired watch pages show “This link has expired” (no video embed) and do not count views.

Drive native analytics are unavailable to third-party apps — the custom watch page is required for view counts.

## Environment

Copy `.env.example` and set in Vercel (Production **and** Preview):

- `SUPABASE_URL` — `https://YOUR_PROJECT_REF.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; required after RLS lockdown (anon can no longer write `mypipcam_*` tables)

Optional local fallback only: `SUPABASE_ANON_KEY` (not enough for share create/view under locked RLS).

Tables (Supabase): `mypipcam_shares`, `mypipcam_views` + RPC `mypipcam_record_view` (service_role).

`mypipcam_shares` also stores binary Drive playback readiness (`processing_status`: `unknown` | `processing` | `ready`, plus optional `drive_ready_at`). Drive’s API does not expose a processing percent — the extension polls `files.get` for `videoMediaMetadata` / thumbnail proxies and PATCHes the share when ready.

## Deploy

Vercel project root directory is `apps/web` (link from the monorepo root or this folder):

```bash
cd apps/web
npm install
vercel --prod
```

Never commit real Supabase keys. Prefer `vercel env add SUPABASE_SERVICE_ROLE_KEY` for Production and Preview.
