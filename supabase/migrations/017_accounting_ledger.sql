-- 017_accounting_ledger.sql
--
-- The stored order ledger (October 2026 onwards — see docs/accounting-ledger.md).
-- The accounting-ledger edge function reads every order from Shopify, Unicommerce,
-- Return Prime and Velocity, builds its double-entry ledger (supabase/functions/
-- _shared/ledger.ts) and saves the result here:
--
--   ledger_orders   one row per Shopify order: its state, what is still open, the
--                   balancing documents the ERP has to issue, and the facts it was
--                   computed from.
--   ledger_entries  the order's double-entry lines. `exportable` marks those dated on
--                   or after accounting_start_date; earlier ones are carried in and
--                   never exported.
--   ledger_runs     one row per sync run: the queue of orders, where it got to.
--
-- The ledger is derived data. Every sync recomputes an order from scratch and
-- replaces its rows, so a fix to the rules is applied by running the sync again.
-- Nothing here is ever sent to Shopify, Unicommerce or Tally.
--
-- Written only by the edge function (service role, through ledger_save_orders);
-- signed-in users may read. Switch the schedule on with app_settings.ledger_sync_mode.

CREATE TABLE IF NOT EXISTS public.ledger_orders (
  order_name      text          PRIMARY KEY,           -- Shopify order number, e.g. 37613
  order_id        bigint        NOT NULL,
  -- complete: nets to zero · open: still travelling (COD in transit, waiting for the
  -- returned parcel) · attention: a person must look · not_a_sale: cancelled before dispatch
  status          text          NOT NULL CHECK (status IN ('complete', 'open', 'attention', 'not_a_sale')),
  net             numeric(12,2) NOT NULL DEFAULT 0,    -- control account balance, whole life; 0 when complete
  opening         numeric(12,2) NOT NULL DEFAULT 0,    -- part of it that was carried in from before the cutoff
  sale_date       date,
  exception_type  text,                                -- first exception: in_transit, awaiting_return, refund_due, store_credit_differs, ...
  exceptions      jsonb         NOT NULL DEFAULT '[]'::jsonb,   -- [{type, amount, reason}]
  balancing       jsonb         NOT NULL DEFAULT '[]'::jsonb,   -- documents the ERP issues: [{type, amount, reason}]
  notes           jsonb         NOT NULL DEFAULT '[]'::jsonb,
  facts           jsonb,
  computed_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_orders_status ON public.ledger_orders (status) WHERE status <> 'complete';
CREATE INDEX IF NOT EXISTS ledger_orders_order_id ON public.ledger_orders (order_id);

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id           bigserial     PRIMARY KEY,
  order_name   text          NOT NULL REFERENCES public.ledger_orders (order_name) ON DELETE CASCADE,
  seq          integer       NOT NULL,
  entry_date   date          NOT NULL,
  voucher      text          NOT NULL,                 -- sale, delivery, payment, credit_note, invoice, store_credit, ...
  account      text          NOT NULL,
  debit        numeric(12,2) NOT NULL DEFAULT 0,
  credit       numeric(12,2) NOT NULL DEFAULT 0,
  doc          text,                                   -- the source document number, when there is one
  issued_by    text          NOT NULL,                 -- unicommerce, erp, shopify, return_prime, courier, gateway
  memo         text,
  exportable   boolean       NOT NULL,
  UNIQUE (order_name, seq)
);

CREATE INDEX IF NOT EXISTS ledger_entries_export ON public.ledger_entries (entry_date) WHERE exportable;

CREATE TABLE IF NOT EXISTS public.ledger_runs (
  id           bigserial     PRIMARY KEY,
  kind         text          NOT NULL CHECK (kind IN ('incremental', 'full', 'manual')),
  status       text          NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  queue        jsonb         NOT NULL DEFAULT '[]'::jsonb,    -- Shopify order ids to process
  pos          integer       NOT NULL DEFAULT 0,              -- how many of them are done
  total        integer       NOT NULL DEFAULT 0,
  summary      jsonb,
  error        text,
  started_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS ledger_runs_latest ON public.ledger_runs (started_at DESC);

ALTER TABLE public.ledger_orders  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.ledger_orders  FOR SELECT TO authenticated USING (true);
ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.ledger_entries FOR SELECT TO authenticated USING (true);
ALTER TABLE public.ledger_runs    ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.ledger_runs    FOR SELECT TO authenticated USING (true);

-- Replace a batch of orders and their entries in one transaction, so a reader never
-- sees an order without its lines. Each element of p_orders:
--   { order_name, order_id, status, net, opening, sale_date, exception_type,
--     exceptions, balancing, notes, facts, entries: [{date, voucher, account, debit,
--     credit, doc, by, memo, exportable}] }
CREATE OR REPLACE FUNCTION public.ledger_save_orders(p_orders jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o jsonb;
  n integer := 0;
BEGIN
  FOR o IN SELECT * FROM jsonb_array_elements(p_orders) LOOP
    INSERT INTO ledger_orders AS t (order_name, order_id, status, net, opening, sale_date, exception_type,
                                    exceptions, balancing, notes, facts, computed_at)
    VALUES (o->>'order_name', (o->>'order_id')::bigint, o->>'status', (o->>'net')::numeric, (o->>'opening')::numeric,
            NULLIF(o->>'sale_date', '')::date, NULLIF(o->>'exception_type', ''),
            COALESCE(o->'exceptions', '[]'::jsonb), COALESCE(o->'balancing', '[]'::jsonb), COALESCE(o->'notes', '[]'::jsonb),
            o->'facts', now())
    ON CONFLICT (order_name) DO UPDATE SET
      order_id = EXCLUDED.order_id, status = EXCLUDED.status, net = EXCLUDED.net, opening = EXCLUDED.opening,
      sale_date = EXCLUDED.sale_date, exception_type = EXCLUDED.exception_type, exceptions = EXCLUDED.exceptions,
      balancing = EXCLUDED.balancing, notes = EXCLUDED.notes, facts = EXCLUDED.facts, computed_at = now();

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

-- Settings. The schedule is installed switched off ("off"); the sync only runs on its
-- own when this is "live". The `sync` action can always be run by hand.
INSERT INTO public.app_settings (key, value) VALUES
  ('ledger_sync_mode', to_jsonb('off'::text))
ON CONFLICT (key) DO NOTHING;

-- Every 10 minutes: continue a run that is part-way through, or start the next one
-- (a run of recently changed and still-open orders every hour, a full one each night).
SELECT cron.schedule('accounting-ledger-sync', '*/10 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/accounting-ledger',
    body    := '{"action":"tick"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 170000
  )
$$);
