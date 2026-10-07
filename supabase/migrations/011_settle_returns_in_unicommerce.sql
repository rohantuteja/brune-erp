-- 011_settle_returns_in_unicommerce.sql
--
-- RTOs and Return Prime returns of orders Unicommerce shipped now go back into
-- stock by receiving the "Courier Returned" return Unicommerce opens on the
-- order (after the Shopify cancel or refund), instead of a separate stock add.
-- Unicommerce opens that return 6–30 minutes later, so a line found back at the
-- warehouse before then waits with status 'waiting' (shown as "In progress" on
-- the Returns screen) and is settled by a 15-minute job, which also retries
-- failed lines at most hourly. See supabase/functions/_shared/uc-returns.ts.
--
-- Return Prime lines are settled by the existing returnprime-sweep job
-- (migration 006); this adds the same job for RTO lines.

ALTER TABLE public.shopify_order_restocks DROP CONSTRAINT shopify_order_restocks_status_check;
ALTER TABLE public.shopify_order_restocks ADD CONSTRAINT shopify_order_restocks_status_check
  CHECK (status IN ('claimed', 'waiting', 'restocked', 'skipped', 'failed'));

ALTER TABLE public.returnprime_restocks DROP CONSTRAINT returnprime_restocks_status_check;
ALTER TABLE public.returnprime_restocks ADD CONSTRAINT returnprime_restocks_status_check
  CHECK (status IN ('claimed', 'waiting', 'restocked', 'skipped', 'failed', 'baseline'));

SELECT cron.schedule('shopify-returns-settle', '*/15 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shopify-order-webhook',
    body    := '{"job": "settle"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 120000
  )
$$);
