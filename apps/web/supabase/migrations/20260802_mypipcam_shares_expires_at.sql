-- Share link expiration (default 30 days from creation)
-- Applied to EarnYour Marketing Supabase project (mypipcam_shares).

ALTER TABLE public.mypipcam_shares
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE public.mypipcam_shares
SET expires_at = created_at + interval '30 days'
WHERE expires_at IS NULL;

ALTER TABLE public.mypipcam_shares
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS mypipcam_shares_expires_at_idx
  ON public.mypipcam_shares (expires_at);

COMMENT ON COLUMN public.mypipcam_shares.expires_at IS
  'When the public watch link stops working; default 30 days from create/renew.';

DROP FUNCTION IF EXISTS public.mypipcam_record_view(text, text);

CREATE FUNCTION public.mypipcam_record_view(
  p_share_id text,
  p_ua_hash text DEFAULT NULL::text
)
RETURNS TABLE(
  id text,
  recording_id text,
  drive_file_id text,
  drive_web_view_link text,
  owner_hint text,
  created_at timestamp with time zone,
  view_count integer,
  last_viewed_at timestamp with time zone,
  processing_status text,
  drive_ready_at timestamp with time zone,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_expires timestamptz;
BEGIN
  IF p_share_id IS NULL OR length(trim(p_share_id)) < 8 THEN
    RAISE EXCEPTION 'invalid share id';
  END IF;

  SELECT s.expires_at INTO v_expires
  FROM public.mypipcam_shares s
  WHERE s.id = p_share_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'share not found';
  END IF;

  IF v_expires IS NOT NULL AND v_expires <= v_now THEN
    RAISE EXCEPTION 'share expired';
  END IF;

  INSERT INTO public.mypipcam_views (share_id, viewed_at, ua_hash)
  VALUES (p_share_id, v_now, NULLIF(left(coalesce(p_ua_hash, ''), 64), ''));

  UPDATE public.mypipcam_shares s
  SET
    view_count = s.view_count + 1,
    last_viewed_at = v_now
  WHERE s.id = p_share_id;

  RETURN QUERY
  SELECT
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
  FROM public.mypipcam_shares s
  WHERE s.id = p_share_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.mypipcam_record_view(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mypipcam_record_view(text, text) TO service_role;
