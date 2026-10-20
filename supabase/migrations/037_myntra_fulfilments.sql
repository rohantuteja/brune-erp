-- 037_myntra_fulfilments.sql
--
-- Myntra orders are invoiced, labelled and dispatched in Unicommerce as soon as Myntra allows
-- (docs/myntra-fulfilment.md). One row per Unicommerce shipping package, so the job never does a step twice
-- and the Analytics → Myntra page can say which labels are still to be printed.
--
--   status       held       Myntra's own "not yet eligible" time has not come (next_try_at)
--                invoiced   invoice and label made, package READY_TO_SHIP, waiting to be dispatched
--                dispatched on a closed manifest, Myntra can send its courier
--                failed     Unicommerce refused; retried with a back-off (next_try_at)
--                attention  failed too many times in a row, or needs a person
--                cancelled  the order was cancelled before it was dispatched
--                working    a run holds it right now (claimed_at); a stale claim may be taken again
--   source       erp        the job made the invoice and label, so the label is on the print list
--                dashboard  a person made it on the Shipments screen; the job only dispatches it
--   label_url    the invoice + label PDF Unicommerce returned; printed_at is when a person printed it
--
-- Written only by the myntra-fulfil function (service role); admins may read.

CREATE TABLE IF NOT EXISTS public.myntra_fulfilments (
  package_code     text          PRIMARY KEY,
  sale_order_code  text          NOT NULL,
  order_created    timestamptz,
  payment          text          CHECK (payment IN ('prepaid', 'cod')),
  provider         text,
  tracking_number  text,
  invoice_code     text,
  invoice_display  text,
  label_url        text,
  manifest_code    text,
  status           text          NOT NULL CHECK (status IN ('held', 'invoiced', 'dispatched', 'failed', 'attention', 'working', 'cancelled')),
  source           text          NOT NULL DEFAULT 'erp' CHECK (source IN ('erp', 'dashboard')),
  attempts         int           NOT NULL DEFAULT 0,
  next_try_at      timestamptz,
  claimed_at       timestamptz,
  detail           text,
  invoiced_at      timestamptz,
  dispatched_at    timestamptz,
  printed_at       timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS myntra_fulfilments_order ON public.myntra_fulfilments (sale_order_code);
CREATE INDEX IF NOT EXISTS myntra_fulfilments_unprinted ON public.myntra_fulfilments (invoiced_at)
  WHERE printed_at IS NULL AND label_url IS NOT NULL;

ALTER TABLE public.myntra_fulfilments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read" ON public.myntra_fulfilments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- Settings. The job starts in dry mode: it reads Unicommerce and writes nothing until
-- myntra_fulfil_mode is "live". myntra_fulfil_limit caps the packages one run touches (set to 1 for the
-- first live run, check that order, then raise it). myntra_fulfil_from is the first order date it may act on.
INSERT INTO public.app_settings (key, value) VALUES
  ('myntra_fulfil_mode',  to_jsonb('dry'::text)),
  ('myntra_fulfil_limit', to_jsonb(1)),
  ('myntra_fulfil_from',  to_jsonb('2026-10-19'::text))
ON CONFLICT (key) DO NOTHING;

-- Schedule: every 5 minutes (same key as the other jobs, migration 006). In dry mode a run only reads.
SELECT cron.schedule('myntra-fulfil', '*/5 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/myntra-fulfil',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 150000
  )
$$);
