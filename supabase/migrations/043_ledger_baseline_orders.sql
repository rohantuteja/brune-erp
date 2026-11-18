-- 043_ledger_baseline_orders.sql
--
-- The books start on accounting_start_date (1 Oct 2026): orders from before it are the baseline and are never touched.
-- The ledger reads every Shopify order that was UPDATED since that date, because an older order that is returned or paid after it
-- is in scope (its credit note or receipt is dated after the start). But on 18 Nov 2026 about 190 orders from Oct 2023 to Mar
-- 2024 were updated on Shopify overnight, the full ledger refresh picked them up, and they showed as "needs attention" (an
-- unpaid sale with no payments on record: the money came years ago). They have nothing dated after the start and are not part of
-- these books.
--
-- Rule: an order sold more than 60 days before the start, with no ledger entry dated on or after the start, is dropped from the
-- ledger. (The 60 days keep the September orders that were still in transit or open on 30 Sep: they carry the opening balance.)
-- It is done by a deferred trigger on ledger_orders, which fires at the end of the transaction that saved the order, so it holds
-- whichever function saves the ledger (ledger_save_orders has been replaced by migrations before) and the entries go with the
-- order (ON DELETE CASCADE). The next refresh that reads such an order saves it and the trigger drops it again.

CREATE OR REPLACE FUNCTION public.ledger_drop_baseline() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_start date;
BEGIN
  IF NEW.sale_date IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(NULLIF(value #>> '{}', '')::date, date '2026-10-01') INTO v_start FROM app_settings WHERE key = 'accounting_start_date';
  v_start := COALESCE(v_start, date '2026-10-01');
  IF NEW.sale_date < v_start - 60
     AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.order_name = NEW.order_name AND e.entry_date >= v_start)
     AND NOT EXISTS (SELECT 1 FROM ledger_documents d WHERE d.order_name = NEW.order_name) THEN
    DELETE FROM ledger_orders WHERE order_name = NEW.order_name;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.ledger_drop_baseline() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ledger_drop_baseline ON public.ledger_orders;
CREATE CONSTRAINT TRIGGER ledger_drop_baseline AFTER INSERT OR UPDATE ON public.ledger_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.ledger_drop_baseline();

-- The ones already saved.
DELETE FROM public.ledger_orders o
WHERE o.sale_date < COALESCE((SELECT NULLIF(value #>> '{}', '')::date FROM public.app_settings WHERE key = 'accounting_start_date'), date '2026-10-01') - 60
  AND NOT EXISTS (SELECT 1 FROM public.ledger_entries e WHERE e.order_name = o.order_name
                  AND e.entry_date >= COALESCE((SELECT NULLIF(value #>> '{}', '')::date FROM public.app_settings WHERE key = 'accounting_start_date'), date '2026-10-01'))
  AND NOT EXISTS (SELECT 1 FROM public.ledger_documents d WHERE d.order_name = o.order_name);
