-- 004_shopify_order_restocks.sql
--
-- Stock coming back from Shopify orders goes into Unicommerce (the inventory
-- system of record) via the shopify-order-webhook edge function:
--   • an unshipped order is cancelled        → reason 'cancelled'
--   • an RTO parcel is back (tag rto_delivered) → reason 'rto'
--   • a Return Prime return reaches the warehouse → reason 'return' (follow-up)
--
-- shopify_order_restocks is the exactly-once ledger: one row per order line,
-- claimed by INSERT … ON CONFLICT DO NOTHING before Unicommerce is touched, so
-- duplicate webhooks, retries and overlapping events (e.g. a cancel webhook
-- followed by the RTO tag) can never put the same piece back twice.
--
-- shopify_rto_orders tracks each RTO order (cancel on Shopify, store credit for
-- prepaid orders). Orders already tagged rto_delivered at go-live are inserted
-- as 'baseline' so they are never processed again.

CREATE TABLE IF NOT EXISTS public.shopify_order_restocks (
  order_id     bigint      NOT NULL,
  line_item_id bigint      NOT NULL,
  order_name   text,
  sku          text,
  qty          integer     NOT NULL,
  reason       text        NOT NULL CHECK (reason IN ('cancelled', 'rto', 'return')),
  status       text        NOT NULL CHECK (status IN ('claimed', 'restocked', 'skipped', 'failed')),
  detail       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, line_item_id)
);

CREATE TABLE IF NOT EXISTS public.shopify_rto_orders (
  order_id         bigint      PRIMARY KEY,
  order_name       text,
  status           text        NOT NULL CHECK (status IN ('baseline', 'processing', 'done', 'needs_attention')),
  financial_status text,
  cancel_status    text,       -- cancelled | already_cancelled | failed | disabled
  credit_status    text,       -- issued | not_prepaid | failed | unknown | needs_review | disabled
  credit_amount    numeric,
  detail           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Written only by the edge function (service role); signed-in users may read.
ALTER TABLE public.shopify_order_restocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_rto_orders     ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.shopify_order_restocks FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated read" ON public.shopify_rto_orders     FOR SELECT TO authenticated USING (true);
