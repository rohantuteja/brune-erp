-- 014_drop_unicommerce_channel_links.sql
--
-- Undoes migration 013. Unicommerce's own catalog sync links a new Shopify
-- listing to its SKU about 2 minutes after the SKU exists (Colette Brown,
-- 8 Oct 2026) and fills in the listing's product name; linking it through the
-- API as well replaced that listing and blanked the name. shopify-product-webhook
-- no longer links listings, so this ledger isn't used.

DROP TABLE IF EXISTS public.unicommerce_channel_links;
