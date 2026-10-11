-- 019_ledger_cod_open.sql
--
-- COD money the courier has collected and not yet paid into the bank, per order
-- (the balance of "COD receivable (Velocity)"). It is separate from `net`, which is the
-- customer side of the order: a delivered COD order nets to zero for the customer while
-- Velocity still owes the money until its remittance (UTR) arrives.
--
-- ledger_save_orders is replaced to save it; everything else in it is unchanged.

ALTER TABLE public.ledger_orders ADD COLUMN IF NOT EXISTS cod_open numeric(12,2) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ledger_orders_cod_open ON public.ledger_orders (cod_open) WHERE cod_open <> 0;

CREATE OR REPLACE FUNCTION public.ledger_save_orders(p_orders jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o jsonb;
  n integer := 0;
BEGIN
  FOR o IN SELECT * FROM jsonb_array_elements(p_orders) LOOP
    INSERT INTO ledger_orders AS t (order_name, order_id, status, net, opening, cod_open, sale_date, exception_type,
                                    exceptions, balancing, notes, facts, computed_at)
    VALUES (o->>'order_name', (o->>'order_id')::bigint, o->>'status', (o->>'net')::numeric, (o->>'opening')::numeric,
            COALESCE((o->>'cod_open')::numeric, 0),
            NULLIF(o->>'sale_date', '')::date, NULLIF(o->>'exception_type', ''),
            COALESCE(o->'exceptions', '[]'::jsonb), COALESCE(o->'balancing', '[]'::jsonb), COALESCE(o->'notes', '[]'::jsonb),
            o->'facts', now())
    ON CONFLICT (order_name) DO UPDATE SET
      order_id = EXCLUDED.order_id, status = EXCLUDED.status, net = EXCLUDED.net, opening = EXCLUDED.opening,
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
