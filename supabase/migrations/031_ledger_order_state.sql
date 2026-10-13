-- 031_ledger_order_state.sql
--
-- Every order in the ledger carries the state the goods go to (its place of supply). The Tally file puts it on every voucher
-- of the order, it decides IGST or CGST+SGST, and the B2C GST return is by state.
--
--   ledger_orders.state       the GST portal's name, e.g. Delhi, Uttar Pradesh
--   ledger_orders.state_code  the two-digit GST state code, e.g. 07, 09
--
-- NULL means the state could not be found (Shopify shipping address, then Unicommerce's order address): the order then has the
-- exception `no_state` and is not exported. Where it came from is in facts.state.source.
-- ledger_save_orders is replaced to save them; everything else in it is unchanged. A full sync fills the existing orders in.

ALTER TABLE public.ledger_orders ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE public.ledger_orders ADD COLUMN IF NOT EXISTS state_code text;
CREATE INDEX IF NOT EXISTS ledger_orders_state ON public.ledger_orders (state_code);

CREATE OR REPLACE FUNCTION public.ledger_save_orders(p_orders jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o jsonb;
  n integer := 0;
BEGIN
  FOR o IN SELECT * FROM jsonb_array_elements(p_orders) LOOP
    INSERT INTO ledger_orders AS t (order_name, order_id, channel, channel_ref, status, net, opening, cod_open, gateway_open, sale_date, state, state_code, exception_type,
                                    exceptions, balancing, notes, facts, computed_at)
    VALUES (o->>'order_name', NULLIF(o->>'order_id', '')::bigint, COALESCE(NULLIF(o->>'channel', ''), 'shopify'), NULLIF(o->>'channel_ref', ''),
            o->>'status', (o->>'net')::numeric, (o->>'opening')::numeric,
            COALESCE((o->>'cod_open')::numeric, 0), COALESCE((o->>'gateway_open')::numeric, 0),
            NULLIF(o->>'sale_date', '')::date, NULLIF(o->>'state', ''), NULLIF(o->>'state_code', ''), NULLIF(o->>'exception_type', ''),
            COALESCE(o->'exceptions', '[]'::jsonb), COALESCE(o->'balancing', '[]'::jsonb), COALESCE(o->'notes', '[]'::jsonb),
            o->'facts', now())
    ON CONFLICT (order_name) DO UPDATE SET
      order_id = EXCLUDED.order_id, channel = EXCLUDED.channel, channel_ref = EXCLUDED.channel_ref,
      status = EXCLUDED.status, net = EXCLUDED.net, opening = EXCLUDED.opening,
      cod_open = EXCLUDED.cod_open, gateway_open = EXCLUDED.gateway_open, sale_date = EXCLUDED.sale_date,
      state = EXCLUDED.state, state_code = EXCLUDED.state_code, exception_type = EXCLUDED.exception_type,
      exceptions = EXCLUDED.exceptions, balancing = EXCLUDED.balancing, notes = EXCLUDED.notes, facts = EXCLUDED.facts,
      computed_at = now();

    DELETE FROM ledger_entries WHERE order_name = o->>'order_name';
    INSERT INTO ledger_entries (order_name, seq, entry_date, voucher, account, debit, credit, doc, issued_by, memo, exportable, part, qty)
    SELECT o->>'order_name', (e.i - 1)::integer, (e.v->>'date')::date, e.v->>'voucher', e.v->>'account',
           (e.v->>'debit')::numeric, (e.v->>'credit')::numeric, NULLIF(e.v->>'doc', ''), e.v->>'by', e.v->>'memo',
           COALESCE((e.v->>'exportable')::boolean, false), NULLIF(e.v->>'part', ''), NULLIF(e.v->>'qty', '')::numeric
    FROM jsonb_array_elements(COALESCE(o->'entries', '[]'::jsonb)) WITH ORDINALITY AS e(v, i);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.ledger_save_orders(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_save_orders(jsonb) TO service_role;
