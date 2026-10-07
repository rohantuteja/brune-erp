-- 012_shopify_order_edits.sql
--
-- Unicommerce imports a Shopify order once and never sees later edits (a size
-- swapped by email, an item added or removed). When Velocity ships the edited
-- order, Unicommerce dispatches its own stale copy and takes the wrong piece
-- out of stock (#37827: the XS swapped out was dispatched instead of the M that
-- shipped). shopify-order-webhook now corrects Unicommerce's stock for every
-- edited order (orders/edited webhook, the daily sweep, and the 15-min job):
-- it takes out pieces added by the edit and puts back pieces removed.
-- Unicommerce's own order and invoice still show the original items.
--
-- shopify_order_edits: one row per edited order — status (ok / pending:
--   waiting for Unicommerce to cancel its copy / needs_attention), and a lock so
--   only one run corrects an order at a time.
-- shopify_order_edit_lines: per Shopify line, the net number of pieces the ERP
--   has taken out of Unicommerce for it (negative = put back). RTOs and returns
--   read it: a piece the ERP took out for an added line is added back when it
--   comes back.

CREATE TABLE IF NOT EXISTS public.shopify_order_edits (
  order_id      bigint      PRIMARY KEY,
  order_name    text,
  status        text        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'pending', 'needs_attention')),
  detail        text,
  locked_until  timestamptz,
  checked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shopify_order_edit_lines (
  order_id      bigint      NOT NULL REFERENCES public.shopify_order_edits (order_id),
  line_item_id  bigint      NOT NULL,
  sku           text        NOT NULL,
  net_removed   integer     NOT NULL DEFAULT 0,
  detail        text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, line_item_id)
);

-- Written only by the edge function (service role); signed-in users may read.
ALTER TABLE public.shopify_order_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_order_edit_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.shopify_order_edits FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated read" ON public.shopify_order_edit_lines FOR SELECT TO authenticated USING (true);

-- #37827 was corrected by hand on 8 Oct 2026 (Unicommerce: XS +1, M −1).
INSERT INTO public.shopify_order_edits (order_id, order_name, status, detail, checked_at)
VALUES (7366724223235, '37827', 'ok', 'Unicommerce stock corrected by hand on 8 Oct 2026: TULA-BLUE-DRESS-56-XS +1, TULA-BLUE-DRESS-56-M −1', now())
ON CONFLICT (order_id) DO NOTHING;
INSERT INTO public.shopify_order_edit_lines (order_id, line_item_id, sku, net_removed, detail) VALUES
  (7366724223235, 16969161539843, 'TULA-BLUE-DRESS-56-XS', -1, '1 removed after Unicommerce imported the order'),
  (7366724223235, 16970680729859, 'TULA-BLUE-DRESS-56-M',   1, '1 added after Unicommerce imported the order')
ON CONFLICT (order_id, line_item_id) DO NOTHING;
