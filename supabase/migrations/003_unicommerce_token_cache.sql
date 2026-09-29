-- 003_unicommerce_token_cache.sql
--
-- Unicommerce (Uniware) is now Brune's inventory system of record: the ERP
-- pushes stock changes to Unicommerce, and Unicommerce pushes stock on to
-- Shopify and Myntra.
--
-- Edge functions log in to Unicommerce with OAuth2. Access tokens last ~12 h
-- and can be renewed with the refresh token for ~30 days, after which a
-- password login is needed again. This single-row table caches the current
-- token so functions don't log in on every call. Only the service role (edge
-- functions) may touch it.

CREATE TABLE IF NOT EXISTS public.unicommerce_token (
  id            boolean     PRIMARY KEY DEFAULT true CHECK (id),  -- single row
  access_token  text        NOT NULL,
  refresh_token text,
  expires_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.unicommerce_token ENABLE ROW LEVEL SECURITY;

-- The batch sync ledger keeps its name but now tracks whichever system holds
-- stock. Rows applied before the switch were pushed to Shopify, and those
-- pieces were carried into Unicommerce by the opening stock load, so a later
-- revert correctly removes them from Unicommerce.
COMMENT ON TABLE public.shopify_batch_inventory_sync IS
  'Exactly-once ledger of batch stock pushes per (batch, size). applied = the qty is counted in the inventory system of record (Shopify before the Unicommerce switch, Unicommerce after).';
