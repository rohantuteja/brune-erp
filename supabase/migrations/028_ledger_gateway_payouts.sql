-- 028_ledger_gateway_payouts.sql
--
-- The order ledger now books the gateway's payout (GoKwik's settlement report): the money reaching the bank, the gateway's fee
-- and the GST on it. And the sale / credit-note lines say which part of the sale they are and how many pieces, because several
-- accounts now post to one Tally ledger (GST SALES) and Tally's stock lines need the quantity.
--
--   ledger_entries.part  goods | cod_charge | return_fee, on the GST SALES / GST SALES RETURN lines
--   ledger_entries.qty   pieces, on a goods line
--   ledger_orders.gateway_open  prepaid money the gateway holds and has not paid out yet
--
-- ledger_save_orders is replaced to save them; everything else in it is unchanged.

ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS part text;
ALTER TABLE public.ledger_entries ADD COLUMN IF NOT EXISTS qty numeric;
ALTER TABLE public.ledger_orders ADD COLUMN IF NOT EXISTS gateway_open numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.ledger_save_orders(p_orders jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o jsonb;
  n integer := 0;
BEGIN
  FOR o IN SELECT * FROM jsonb_array_elements(p_orders) LOOP
    INSERT INTO ledger_orders AS t (order_name, order_id, channel, channel_ref, status, net, opening, cod_open, gateway_open, sale_date, exception_type,
                                    exceptions, balancing, notes, facts, computed_at)
    VALUES (o->>'order_name', NULLIF(o->>'order_id', '')::bigint, COALESCE(NULLIF(o->>'channel', ''), 'shopify'), NULLIF(o->>'channel_ref', ''),
            o->>'status', (o->>'net')::numeric, (o->>'opening')::numeric,
            COALESCE((o->>'cod_open')::numeric, 0), COALESCE((o->>'gateway_open')::numeric, 0),
            NULLIF(o->>'sale_date', '')::date, NULLIF(o->>'exception_type', ''),
            COALESCE(o->'exceptions', '[]'::jsonb), COALESCE(o->'balancing', '[]'::jsonb), COALESCE(o->'notes', '[]'::jsonb),
            o->'facts', now())
    ON CONFLICT (order_name) DO UPDATE SET
      order_id = EXCLUDED.order_id, channel = EXCLUDED.channel, channel_ref = EXCLUDED.channel_ref,
      status = EXCLUDED.status, net = EXCLUDED.net, opening = EXCLUDED.opening,
      cod_open = EXCLUDED.cod_open, gateway_open = EXCLUDED.gateway_open, sale_date = EXCLUDED.sale_date, exception_type = EXCLUDED.exception_type,
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
