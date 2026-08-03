-- Dedupe rapid repeat views: a refresh (or a spam loop) from the same client
-- must not inflate view_count on every request. A view from the same ua_hash
-- on the same share within 60s counts once. Views without a ua_hash are not
-- deduped (distinct UA-less clients would collide).

create index if not exists mypipcam_views_share_ua_viewed_idx
  on public.mypipcam_views (share_id, ua_hash, viewed_at desc);

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
  v_hash text;
  v_duplicate boolean := false;
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

  v_hash := nullif(left(coalesce(p_ua_hash, ''), 64), '');

  if v_hash is not null then
    select exists (
      select 1
      from public.mypipcam_views v
      where v.share_id = p_share_id
        and v.ua_hash = v_hash
        and v.viewed_at > v_now - interval '60 seconds'
    ) into v_duplicate;
  end if;

  if not v_duplicate then
    insert into public.mypipcam_views (share_id, viewed_at, ua_hash)
    values (p_share_id, v_now, v_hash);

    update public.mypipcam_shares s
    set
      view_count = s.view_count + 1,
      last_viewed_at = v_now
    where s.id = p_share_id;
  end if;

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
