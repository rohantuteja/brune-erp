-- 013_unicommerce_channel_links.sql
--
-- Unicommerce only pushes stock to a Shopify listing it has linked to one of
-- its SKUs ("channel item type"). It keys a Shopify listing as
-- '<product id>-<variant id>', so the same SKU can have several listings:
-- Brune keeps Unlisted copies of some products at a lower price (e.g. Tula,
-- Selene), and every copy shows the SKU's full stock. A new product's
-- listings weren't linked by themselves (Colette Brown, 8 Oct 2026), so
-- shopify-product-webhook now links every listing of a live (Active or
-- Unlisted) product once its SKU is in Unicommerce, including a new copy of
-- an existing product.
--
-- One row per Shopify listing:
--   linked   — linked by the ERP
--   baseline — already linked by Unicommerce when this started; never touched,
--              so settings made in Unicommerce stay
--   failed   — retried on the product's next update

CREATE TABLE IF NOT EXISTS public.unicommerce_channel_links (
  channel_product_id text        PRIMARY KEY,
  sku                text        NOT NULL,
  shopify_product_id bigint      NOT NULL,
  product_title      text,
  status             text        NOT NULL CHECK (status IN ('linked', 'baseline', 'failed')),
  detail             text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Written only by the edge function (service role); signed-in users may read.
ALTER TABLE public.unicommerce_channel_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.unicommerce_channel_links FOR SELECT TO authenticated USING (true);

-- Colette Brown's listings were linked by hand on 8 Oct 2026.
INSERT INTO public.unicommerce_channel_links (channel_product_id, sku, shopify_product_id, product_title, status, detail) VALUES
  ('9696486326531-49746645025027', 'COLETTE-BROWN-SHIRT-66-XS', 9696486326531, 'Colette Shirt With Wrap Detail In Brown', 'linked', 'linked by hand on 8 Oct 2026'),
  ('9696486326531-49746645057795', 'COLETTE-BROWN-SHIRT-66-S',  9696486326531, 'Colette Shirt With Wrap Detail In Brown', 'linked', 'linked by hand on 8 Oct 2026'),
  ('9696486326531-49746645090563', 'COLETTE-BROWN-SHIRT-66-M',  9696486326531, 'Colette Shirt With Wrap Detail In Brown', 'linked', 'linked by hand on 8 Oct 2026'),
  ('9696486326531-49746645123331', 'COLETTE-BROWN-SHIRT-66-L',  9696486326531, 'Colette Shirt With Wrap Detail In Brown', 'linked', 'linked by hand on 8 Oct 2026'),
  ('9696486326531-49746645156099', 'COLETTE-BROWN-SHIRT-66-XL', 9696486326531, 'Colette Shirt With Wrap Detail In Brown', 'linked', 'linked by hand on 8 Oct 2026')
ON CONFLICT (channel_product_id) DO NOTHING;
