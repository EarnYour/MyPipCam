# Supabase schema (share links + view tracking)

The share API in `apps/web/api/` talks to two tables and one RPC. They live in
`migrations/`, applied in filename order:

| File | What it does |
| --- | --- |
| `20260802000000_mypipcam_share_schema.sql` | Baseline: `mypipcam_shares`, `mypipcam_views`, indexes, RLS, `mypipcam_record_view()` |
| `20260802000001_mypipcam_view_dedupe.sql` | Repeat views from the same client within 60s stop double-counting |

The baseline file is idempotent (`create table if not exists`, `create or
replace function`), so it is safe to run against the existing project — it was
captured from the deployed schema rather than written from scratch.

## Access model

RLS is **enabled with no policies** on both tables, so `anon` and
`authenticated` can read and write nothing directly. All access goes through:

- the serverless handlers in `apps/web/api/`, using `SUPABASE_SERVICE_ROLE_KEY`
  (bypasses RLS — never expose this key to the browser), and
- `mypipcam_record_view()`, a `SECURITY DEFINER` function that validates the
  share id, rejects expired shares, dedupes rapid repeats, and increments the
  counter in one round trip.

## Applying

With the Supabase CLI linked to the project:

```sh
supabase db push
```

Or paste a file into the SQL editor. Applying the same migration twice is a
no-op.

## Notes

- `mypipcam_shares.recording_id` has a unique index. `POST /api/shares` relies
  on it: concurrent creates for one recording resolve by catching `23505` and
  returning the row that won.
- `expires_at` defaults to 30 days out. `GET /api/shares/:id` returns 404 past
  that, and the RPC refuses to record further views.
- Nothing prunes expired rows yet. If the tables grow, add a scheduled job that
  deletes `mypipcam_shares` past `expires_at` (views cascade).
