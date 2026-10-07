-- 015_unicommerce_backorders.sql
--
-- Sold at zero. Products set to keep selling at 0 on Shopify take orders
-- Unicommerce has no stock for. Unicommerce keeps such an item waiting
-- (UNFULFILLABLE) instead of going negative, but when Velocity ships it,
-- Unicommerce marks it dispatched without taking anything out, so the next
-- batch was added in full (Kira Blue L, Oct 2026: 6 too many). The ERP now
-- follows those items and takes the owed pieces out once the SKU has stock
-- again (supabase/functions/_shared/backorders.ts).
--
-- One row per Unicommerce order item:
--   waiting — no stock for it yet
--   covered — Unicommerce gave it stock (nothing more to do)
--   owed    — dispatched while still waiting: the piece left uncounted
--   settled — taken out of Unicommerce (settled_by: the batch, the 15-min job
--             or the stock audit)
--   closed  — cancelled while waiting
-- Rows found by the stock audit have item_code 'audit:<Shopify line id>:<n>'.

CREATE TABLE IF NOT EXISTS public.unicommerce_backorders (
  sale_order_code text        NOT NULL,
  item_code       text        NOT NULL,
  order_name      text,
  channel         text,
  sku             text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('waiting', 'covered', 'owed', 'settled', 'closed')),
  uc_status       text,
  detail          text,
  settled_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_order_code, item_code)
);

CREATE INDEX IF NOT EXISTS unicommerce_backorders_open ON public.unicommerce_backorders (sku) WHERE status IN ('waiting', 'owed');

-- Written only by the edge functions (service role); signed-in users may read.
ALTER TABLE public.unicommerce_backorders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.unicommerce_backorders FOR SELECT TO authenticated USING (true);
