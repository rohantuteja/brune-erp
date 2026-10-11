-- 016_cod_paid_on_delivery_and_credit_guard.sql
--
-- Two accounting workflows (October 2026 onwards only — see CLAUDE.md,
-- "Accounting cutoff"):
--
-- 1. cod_deliveries — COD / PPCOD orders are marked paid on Shopify when Velocity
--    says the parcel was delivered (the customer has paid the courier; the cash
--    reaches the bank later in a COD remittance). One row per order, so the ERP
--    can reconcile each month: delivered → marked paid → remitted (UTR).
--    Function: cod-paid-on-delivery.
--
-- 2. store_credit_reversals — Return Prime credits store credit by hand on every
--    COD return and also refunds the store-credit part of the order through the
--    "Shopify Store Credits" payment method, which GoKwik turns into a second
--    real credit. The guard takes the extra credit back. One row per return.
--    Function: store-credit-guard.
--
-- Both start in dry mode: the functions only write rows saying what they WOULD do
-- until app_settings.cod_paid_mode / credit_guard_mode are set to "live".

CREATE TABLE IF NOT EXISTS public.cod_deliveries (
  order_id         bigint        PRIMARY KEY,
  order_name       text          NOT NULL,
  awb              text,
  -- would_mark: dry run · marking: claimed · marked: Shopify now shows it paid ·
  -- attention: a person must look (amounts differ, several parcels) ·
  -- failed: Shopify refused · baseline: delivered before the accounting start
  -- date, left to Velocity's own mark-paid at remittance, never touched
  status           text          NOT NULL CHECK (status IN ('would_mark', 'marking', 'marked', 'attention', 'failed', 'baseline')),
  delivered_on     date,
  cod_amount       numeric(12,2),
  outstanding      numeric(12,2),
  marked_at        timestamptz,
  remittance_date  date,
  utr              text,
  detail           text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cod_deliveries_open_remittance ON public.cod_deliveries (delivered_on) WHERE status = 'marked' AND utr IS NULL;

CREATE TABLE IF NOT EXISTS public.store_credit_reversals (
  id                    bigserial     PRIMARY KEY,
  order_id              bigint        NOT NULL,
  order_name            text          NOT NULL,
  request_number        text          NOT NULL,   -- Return Prime request, e.g. RET715
  customer_id           text,
  rp_refunded           numeric(12,2),            -- what Return Prime says it refunded
  store_credit_refund   numeric(12,2),            -- refund Shopify sent to the store-credit payment method
  credited_total        numeric(12,2),            -- store credit actually added around the refund
  excess                numeric(12,2),
  -- would_reverse: dry run · reversing: claimed · reversed: taken back ·
  -- flagged: needs a person (credit already spent, amounts don't line up)
  status                text          NOT NULL CHECK (status IN ('would_reverse', 'reversing', 'reversed', 'flagged')),
  detail                text,
  debit_transaction_id  text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (order_id, request_number)
);

-- Written only by the edge functions (service role); signed-in users may read.
ALTER TABLE public.cod_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.cod_deliveries FOR SELECT TO authenticated USING (true);
ALTER TABLE public.store_credit_reversals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.store_credit_reversals FOR SELECT TO authenticated USING (true);

-- Settings. Both workflows start in dry mode; the accounting start date is the
-- first day the ERP may touch: nothing delivered or refunded before it changes.
INSERT INTO public.app_settings (key, value) VALUES
  ('accounting_start_date', to_jsonb('2026-10-01'::text)),
  ('cod_paid_mode',         to_jsonb('dry'::text)),
  ('credit_guard_mode',     to_jsonb('dry'::text))
ON CONFLICT (key) DO NOTHING;

-- Schedules (same key as the stock-sync jobs, migration 006). Velocity limits
-- its API to 5 calls a minute, so the delivery job runs every 15 minutes; the
-- guard runs every 2 minutes so an extra credit is taken back before a
-- customer could spend it.
SELECT cron.schedule('cod-paid-on-delivery', '*/15 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/cod-paid-on-delivery',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 150000
  )
$$);

SELECT cron.schedule('store-credit-guard', '*/2 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/store-credit-guard',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 60000
  )
$$);
