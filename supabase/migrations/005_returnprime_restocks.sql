-- 005_returnprime_restocks.sql
--
-- Return Prime returns go back into Unicommerce stock when the return parcel
-- is back at the warehouse (courier status "Returned to warehouse"), via the
-- returnprime-webhook edge function.
--
-- Exactly-once ledger: one row per returned item (Return Prime request +
-- Shopify order line), claimed with INSERT … ON CONFLICT DO NOTHING before
-- Unicommerce is touched. Returns already back at the warehouse when the
-- integration went live are recorded as 'baseline' and never processed.

CREATE TABLE IF NOT EXISTS public.returnprime_restocks (
  request_id     text        NOT NULL,
  line_item_id   bigint      NOT NULL,
  request_number text,
  order_id       bigint,
  order_name     text,
  sku            text,
  qty            integer     NOT NULL,
  status         text        NOT NULL CHECK (status IN ('claimed', 'restocked', 'skipped', 'failed', 'baseline')),
  detail         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, line_item_id)
);

-- Written only by the edge function (service role); signed-in users may read.
ALTER TABLE public.returnprime_restocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.returnprime_restocks FOR SELECT TO authenticated USING (true);
