-- 009_unicommerce_via_db.sql
--
-- Unicommerce only accepts its REST API (/services/*) from whitelisted IP
-- addresses (since 2 Oct 2026). Edge functions have no fixed outbound address;
-- this database does. It reaches Unicommerce over IPv6 from its own address,
-- which Unicommerce whitelisted on 7 Oct 2026. So the edge functions send their
-- Unicommerce API calls through uc_post(), which makes the request from here
-- with the http extension.
--
-- The host and facility are fixed below, and the token is read from
-- unicommerce_token, so a caller can only reach Uniware's REST API. Only the
-- service role may call it. Token renewal (/oauth/token isn't IP-restricted)
-- stays in the edge functions (_shared/unicommerce.ts).
--
-- The database's IPv6 address changes when the project is paused and resumed
-- or Postgres is upgraded; Unicommerce then has to whitelist the new one:
--   select content from extensions.http_get('https://api64.ipify.org');

CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.uc_post(p_path text, p_body jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token text;
  v_res   extensions.http_response;
BEGIN
  IF p_path !~ '^/services/rest/v1/[A-Za-z0-9/_-]+$' THEN
    RAISE EXCEPTION 'uc_post: path not allowed: %', p_path;
  END IF;

  SELECT access_token INTO v_token FROM public.unicommerce_token;
  IF v_token IS NULL THEN
    RAISE EXCEPTION 'uc_post: no Unicommerce token cached';
  END IF;

  -- Inside PostgREST's 8 s statement timeout, so a hung call fails cleanly.
  PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '7000');
  v_res := extensions.http((
    'POST',
    'https://brune.unicommerce.com' || p_path,
    ARRAY[
      extensions.http_header('Authorization', 'bearer ' || v_token),
      extensions.http_header('Facility', 'brune')
    ],
    'application/json',
    p_body::text
  )::extensions.http_request);

  RETURN jsonb_build_object('status', v_res.status, 'content', v_res.content);
END;
$$;

REVOKE ALL ON FUNCTION public.uc_post(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.uc_post(text, jsonb) TO service_role;
