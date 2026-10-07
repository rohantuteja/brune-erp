-- 008_unicommerce_sku_sync.sql
--
-- When a Shopify product goes Active, shopify-product-webhook creates its size
-- SKUs in Unicommerce (create only — existing SKUs are never edited) and then
-- adds any completed batches of that style that were waiting because the
-- product wasn't in Unicommerce yet.
--
-- One row per SKU the function has dealt with. 'created' and
-- 'already_in_unicommerce' rows are skipped on later events; 'failed' rows are
-- retried. needs_review flags SKUs a person should check (price above ₹2,500:
-- the GST tax code may need changing in Unicommerce).

CREATE TABLE IF NOT EXISTS public.unicommerce_sku_sync (
  sku                text        PRIMARY KEY,
  shopify_product_id bigint,
  product_title      text,
  status             text        NOT NULL CHECK (status IN ('created', 'already_in_unicommerce', 'failed')),
  needs_review       boolean     NOT NULL DEFAULT false,
  detail             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Written only by the edge function (service role); signed-in users may read.
ALTER TABLE public.unicommerce_sku_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.unicommerce_sku_sync FOR SELECT TO authenticated USING (true);
