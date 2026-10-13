-- 027_myntra_ledger.sql
--
-- Myntra orders in the order ledger (docs/accounting-ledger.md). A Myntra order lives only in Unicommerce (channel
-- MYNTRAPPMP): it has no Shopify id, its name is its Unicommerce invoice number (for example I0927RE000000042), and
-- Myntra, not the end customer, owes the money.
--
--   channel      shopify (every existing row) or myntra
--   channel_ref  Myntra: the Unicommerce order code (a UUID), used to read the order again; null for Shopify
--   order_id     the Shopify order id: now optional, because a Myntra order has none
--
-- ledger_save_orders is replaced to save the two new fields; everything else in it is unchanged.

ALTER TABLE public.ledger_orders ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'shopify';
ALTER TABLE public.ledger_orders DROP CONSTRAINT IF EXISTS ledger_orders_channel_check;
ALTER TABLE public.ledger_orders ADD CONSTRAINT ledger_orders_channel_check CHECK (channel IN ('shopify', 'myntra'));
ALTER TABLE public.ledger_orders ADD COLUMN IF NOT EXISTS channel_ref text;
ALTER TABLE public.ledger_orders ALTER COLUMN order_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS ledger_orders_channel ON public.ledger_orders (channel);
CREATE INDEX IF NOT EXISTS ledger_orders_channel_ref ON public.ledger_orders (channel_ref) WHERE channel_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION public.ledger_save_orders(p_orders jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o jsonb;
  n integer := 0;
BEGIN
  FOR o IN SELECT * FROM jsonb_array_elements(p_orders) LOOP
    INSERT INTO ledger_orders AS t (order_name, order_id, channel, channel_ref, status, net, opening, cod_open, sale_date, exception_type,
                                    exceptions, balancing, notes, facts, computed_at)
    VALUES (o->>'order_name', NULLIF(o->>'order_id', '')::bigint, COALESCE(NULLIF(o->>'channel', ''), 'shopify'), NULLIF(o->>'channel_ref', ''),
            o->>'status', (o->>'net')::numeric, (o->>'opening')::numeric,
            COALESCE((o->>'cod_open')::numeric, 0),
            NULLIF(o->>'sale_date', '')::date, NULLIF(o->>'exception_type', ''),
            COALESCE(o->'exceptions', '[]'::jsonb), COALESCE(o->'balancing', '[]'::jsonb), COALESCE(o->'notes', '[]'::jsonb),
            o->'facts', now())
    ON CONFLICT (order_name) DO UPDATE SET
      order_id = EXCLUDED.order_id, channel = EXCLUDED.channel, channel_ref = EXCLUDED.channel_ref,
      status = EXCLUDED.status, net = EXCLUDED.net, opening = EXCLUDED.opening,
      cod_open = EXCLUDED.cod_open, sale_date = EXCLUDED.sale_date, exception_type = EXCLUDED.exception_type,
      exceptions = EXCLUDED.exceptions, balancing = EXCLUDED.balancing, notes = EXCLUDED.notes, facts = EXCLUDED.facts,
      computed_at = now();

    DELETE FROM ledger_entries WHERE order_name = o->>'order_name';
    INSERT INTO ledger_entries (order_name, seq, entry_date, voucher, account, debit, credit, doc, issued_by, memo, exportable)
    SELECT o->>'order_name', (e.i - 1)::integer, (e.v->>'date')::date, e.v->>'voucher', e.v->>'account',
           (e.v->>'debit')::numeric, (e.v->>'credit')::numeric, NULLIF(e.v->>'doc', ''), e.v->>'by', e.v->>'memo',
           COALESCE((e.v->>'exportable')::boolean, false)
    FROM jsonb_array_elements(COALESCE(o->'entries', '[]'::jsonb)) WITH ORDINALITY AS e(v, i);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.ledger_save_orders(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_save_orders(jsonb) TO service_role;

-- Where Myntra orders start in Unicommerce (it went live on 27 Sep 2026).
INSERT INTO public.app_settings (key, value) VALUES ('myntra_ledger_from', to_jsonb('2026-09-20'::text))
ON CONFLICT (key) DO NOTHING;
