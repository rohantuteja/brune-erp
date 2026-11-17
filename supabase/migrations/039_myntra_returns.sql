-- 039_myntra_returns.sql
--
-- Myntra returns are received in Unicommerce by the ERP (docs/myntra-returns.md). Unicommerce holds a return on every Myntra
-- order that comes back (RTO: "Courier Returned", customer return: "Customer Returned") and nobody was receiving them, so
-- the piece never went back into stock and no return invoice (credit note) was issued. Once Myntra's tracking says the
-- parcel has been delivered back to us, the myntra-returns function receives it in Unicommerce as good stock.
--
-- One row per return the job has acted on, so it never receives the same return twice:
--   working     a run has claimed it and is calling Unicommerce right now (claimed_at)
--   received    Unicommerce took it and the order now shows it received (return_invoice = the credit note, when issued)
--   failed      Unicommerce refused; tried again after a back-off (next_try_at), up to 5 attempts
--   unverified  Unicommerce answered "done" but the order still shows the return open: a person checks (never retried)
--   attention   the job does not act on it (something about the return or its items is odd) or failed 5 times
--   resolved    a person dealt with it in Unicommerce and closed it here
--
-- Written only by the myntra-returns function (service role); admins may read.

CREATE TABLE IF NOT EXISTS public.myntra_returns (
  return_code      text         PRIMARY KEY,                      -- Unicommerce's return code: RPxxxx (customer) or BRUNxxxxx (RTO)
  order_code       text         NOT NULL,                         -- Unicommerce sale order code (Myntra's seller_order_id)
  kind             text         NOT NULL CHECK (kind IN ('rto', 'customer')),
  status           text         NOT NULL CHECK (status IN ('working', 'received', 'failed', 'unverified', 'attention', 'resolved')),
  item_codes       text[]       NOT NULL DEFAULT '{}',
  skus             text[]       NOT NULL DEFAULT '{}',
  awb              text,
  courier          text,
  tracking_status  text,                                          -- Myntra's tracking when the job saw it: *_DELIVERED_TO_SELLER
  attempts         int          NOT NULL DEFAULT 0,
  next_try_at      timestamptz,
  claimed_at       timestamptz,
  detail           text,
  return_invoice   text,
  received_at      timestamptz,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS myntra_returns_status ON public.myntra_returns (status);
CREATE INDEX IF NOT EXISTS myntra_returns_order  ON public.myntra_returns (order_code);

ALTER TABLE public.myntra_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read" ON public.myntra_returns FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- Settings. The job starts in dry mode: it reads Unicommerce and writes nothing until myntra_returns_mode is "live".
-- myntra_returns_limit caps the returns one run receives (set it to 1 for the first live run, check that order, then raise it).
INSERT INTO public.app_settings (key, value) VALUES
  ('myntra_returns_mode',  to_jsonb('dry'::text)),
  ('myntra_returns_limit', to_jsonb(1))
ON CONFLICT (key) DO NOTHING;

-- Schedule: 17 and 47 minutes past every hour (the velocity job runs at 7 and 37), same key as the other jobs (migration 006).
-- In dry mode a run only reads.
SELECT cron.schedule('myntra-returns', '17,47 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/myntra-returns',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 150000
  )
$$);
