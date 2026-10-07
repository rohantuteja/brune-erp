-- 010_rto_sweep_cron.sql
--
-- Daily safety net for RTOs (06:00 IST): shopify-order-webhook's sweep processes
-- any order tagged rto_delivered in the last 3 days that the ERP never heard
-- about (Shopify gave up on the webhook, or deleted the subscription after
-- repeated failures), and flags RTOs stuck half-processed. Same key as the
-- other stock-sync jobs (migration 006).

SELECT cron.schedule('shopify-rto-sweep', '30 0 * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-order-webhook',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 150000
  )
$$);
