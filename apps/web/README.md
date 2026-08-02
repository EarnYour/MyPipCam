# MyPipCam web (`mypipcam.earnyour.com`)

Static marketing site plus serverless share APIs and Loom-style watch pages.

## Share links

| URL | Purpose |
| --- | --- |
| `https://mypipcam.earnyour.com/w/{shareId}` | Public watch page (counts as a view on load) |
| `POST /api/shares` | Extension creates/registers a share after Drive anyone-with-link |
| `GET /api/shares?ids=…` | Batch view stats for Library |
| `GET /api/shares/:id` | Share metadata for the watch page |
| `POST /api/shares/:id/view` | Record a view (coarse UA hash only) |

Drive native analytics are unavailable to third-party apps — the custom watch page is required for view counts.

## Environment

Copy `.env.example` and set in Vercel (Production + Preview):

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Tables (Supabase): `mypipcam_shares`, `mypipcam_views` + RPC `mypipcam_record_view`.

## Deploy

```bash
cd apps/web
npm install
vercel --prod
```
