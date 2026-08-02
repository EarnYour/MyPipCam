-- Baseline schema for MyPipCam share links + view tracking.
-- Matches the deployed schema (captured 2026-08-02); idempotent so it can be
-- applied to a database that already has these objects.
--
-- Access model: RLS is ENABLED with NO policies on both tables — anon and
-- authenticated roles can do nothing. All access goes through the Vercel
-- serverless API using the service_role key (which bypasses RLS), plus the
-- SECURITY DEFINER RPC below.

create table if not exists public.mypipcam_shares (
  id text primary key,
  recording_id text not null,
  drive_file_id text,
  drive_web_view_link text,
  owner_hint text,
  created_at timestamptz not null default now(),
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  processing_status text not null default 'unknown'
    constraint mypipcam_shares_processing_status_check
    check (processing_status in ('unknown', 'processing', 'ready')),
  drive_ready_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 days')
);

comment on table public.mypipcam_shares is
  'MyPipCam share links (watch page view tracking)';

-- The API's create-or-return-existing flow relies on this unique index:
-- concurrent POST /api/shares for one recording resolve via 23505.
create unique index if not exists mypipcam_shares_recording_id_uidx
  on public.mypipcam_shares (recording_id);
create index if not exists mypipcam_shares_drive_file_id_idx
  on public.mypipcam_shares (drive_file_id);
create index if not exists mypipcam_shares_expires_at_idx
  on public.mypipcam_shares (expires_at);

create table if not exists public.mypipcam_views (
  id uuid primary key default gen_random_uuid(),
  share_id text not null references public.mypipcam_shares (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  ua_hash text
);

comment on table public.mypipcam_views is
  'MyPipCam per-open view events; ua_hash is coarse and optional';

create index if not exists mypipcam_views_share_id_idx
  on public.mypipcam_views (share_id);
create index if not exists mypipcam_views_viewed_at_idx
  on public.mypipcam_views (viewed_at desc);

alter table public.mypipcam_shares enable row level security;
alter table public.mypipcam_views enable row level security;

create or replace function public.mypipcam_record_view(
  p_share_id text,
  p_ua_hash text default null
)
returns table (
  id text,
  recording_id text,
  drive_file_id text,
  drive_web_view_link text,
  owner_hint text,
  created_at timestamptz,
  view_count integer,
  last_viewed_at timestamptz,
  processing_status text,
  drive_ready_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
  v_expires timestamptz;
begin
  if p_share_id is null or length(trim(p_share_id)) < 8 then
    raise exception 'invalid share id';
  end if;

  select s.expires_at into v_expires
  from public.mypipcam_shares s
  where s.id = p_share_id;

  if not found then
    raise exception 'share not found';
  end if;

  if v_expires is not null and v_expires <= v_now then
    raise exception 'share expired';
  end if;

  insert into public.mypipcam_views (share_id, viewed_at, ua_hash)
  values (p_share_id, v_now, nullif(left(coalesce(p_ua_hash, ''), 64), ''));

  update public.mypipcam_shares s
  set
    view_count = s.view_count + 1,
    last_viewed_at = v_now
  where s.id = p_share_id;

  return query
  select
    s.id,
    s.recording_id,
    s.drive_file_id,
    s.drive_web_view_link,
    s.owner_hint,
    s.created_at,
    s.view_count,
    s.last_viewed_at,
    s.processing_status,
    s.drive_ready_at,
    s.expires_at
  from public.mypipcam_shares s
  where s.id = p_share_id;
end;
$function$;
