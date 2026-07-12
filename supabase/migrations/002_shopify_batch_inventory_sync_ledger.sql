-- 002_shopify_batch_inventory_sync_ledger.sql
--
-- Exactly-once guard for Shopify inventory adjustments.
--
-- Background: batch completion pushes each issued size's quantity to Shopify via
-- the shopify-adjust-inventory edge function. A duplicate completion (double
-- click, second tab, refetch race, retry, concurrent call) previously re-applied
-- the full quantity, over-counting Shopify stock (e.g. one XL:13 batch pushed
-- +13 three times → +39).
--
-- This ledger makes each (batch_id, size) adjustable AT MOST ONCE. The edge
-- function claims a transition atomically before calling Shopify; any duplicate
-- or concurrent call gets FALSE and skips the API entirely.

CREATE TABLE IF NOT EXISTS public.shopify_batch_inventory_sync (
  batch_id   bigint  NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  size       text    NOT NULL,
  qty        integer NOT NULL,
  applied    boolean NOT NULL DEFAULT false,   -- true = +qty currently pushed to Shopify
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, size)
);

-- Only the service role (edge function) may touch this table; no Data API access.
ALTER TABLE public.shopify_batch_inventory_sync ENABLE ROW LEVEL SECURITY;

-- Atomically claim a state transition. Returns TRUE only if THIS call flipped the
-- state and must therefore call the Shopify API. Concurrency-safe: the conditional
-- upsert/update takes a row lock, so duplicate or simultaneous calls get FALSE.
CREATE OR REPLACE FUNCTION public.claim_batch_size_sync(
  p_batch_id bigint, p_size text, p_qty integer, p_direction text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE v_rows integer;
BEGIN
  IF p_direction = 'complete' THEN
    INSERT INTO public.shopify_batch_inventory_sync (batch_id, size, qty, applied)
    VALUES (p_batch_id, p_size, p_qty, true)
    ON CONFLICT (batch_id, size)
    DO UPDATE SET applied = true, qty = EXCLUDED.qty, updated_at = now()
      WHERE public.shopify_batch_inventory_sync.applied = false;
  ELSE
    UPDATE public.shopify_batch_inventory_sync
      SET applied = false, updated_at = now()
      WHERE batch_id = p_batch_id AND size = p_size AND applied = true;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Undo a claim when the Shopify call afterwards fails, so a later retry re-attempts.
CREATE OR REPLACE FUNCTION public.release_batch_size_sync(
  p_batch_id bigint, p_size text, p_direction text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_direction = 'complete' THEN
    UPDATE public.shopify_batch_inventory_sync
      SET applied = false, updated_at = now()
      WHERE batch_id = p_batch_id AND size = p_size;
  ELSE
    UPDATE public.shopify_batch_inventory_sync
      SET applied = true, updated_at = now()
      WHERE batch_id = p_batch_id AND size = p_size;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_batch_size_sync(bigint, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_batch_size_sync(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_batch_size_sync(bigint, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_batch_size_sync(bigint, text, text) TO service_role;

-- Backfill: mark every currently-synced (batch, size) as applied so future
-- retries/re-syncs never re-add already-pushed quantities.
INSERT INTO public.shopify_batch_inventory_sync (batch_id, size, qty, applied)
SELECT pb.id,
       s.size,
       COALESCE((pb.issued_sizes ->> s.size)::int, 0),
       true
FROM public.production_batches pb
CROSS JOIN LATERAL jsonb_array_elements_text(pb.shopify_adjustment -> 'adjusted') AS s(size)
WHERE pb.status = 'completed'
  AND pb.shopify_adjustment ->> 'direction' = 'complete'
  AND jsonb_typeof(pb.shopify_adjustment -> 'adjusted') = 'array'
ON CONFLICT (batch_id, size) DO NOTHING;
