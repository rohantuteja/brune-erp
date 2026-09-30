-- 006_stock_sync_cron.sql
--
-- Safety nets for the Unicommerce stock sync, every 15 minutes:
--   • returnprime-sweep       — returns back at the warehouse whose Return Prime
--                               webhook never arrived (Return Prime recommends its
--                               API as a backup to webhooks).
--   • shopify-cancel-recheck  — cancellations skipped because the order hadn't
--                               reached Unicommerce yet; if Unicommerce imported it
--                               afterwards, the held piece is put back.
--
-- The jobs authenticate with a random key kept in private_secrets and read at
-- run time, so the key never appears in the job definitions.

INSERT INTO public.private_secrets (key, value, updated_at)
VALUES ('erp_stock_cron_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), now())
ON CONFLICT (key) DO NOTHING;

SELECT cron.schedule('returnprime-sweep', '*/15 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/returnprime-webhook',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 120000
  )
$$);

SELECT cron.schedule('shopify-cancel-recheck', '*/15 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-order-webhook',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 60000
  )
$$);
