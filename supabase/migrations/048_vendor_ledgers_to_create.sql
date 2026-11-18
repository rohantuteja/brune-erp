-- 048_vendor_ledgers_to_create.sql
--
-- A supplier whose own ledger is not in Tally yet (vendors.ledger_new = true) is a ledger the Tally file has to create, but only ledgers listed in
-- tally_ledgers were ever created by the file, so three suppliers (VIPUL ENTERPRISES, Mittal Hosiery Private Limited (Delhi), PicknPack Solutions India
-- Pvt Ltd) were reported by the Accounting checklist as "not in the list of Tally ledgers" and blocked the file, although the file was meant to create them.
--
--   * Every such vendor ledger is added to tally_ledgers as a ledger to create (under Sundry Creditors), once.
--   * A trigger on vendors does the same for a vendor saved from now on (the Bills page, GSTR-2B booking), so the two lists cannot drift apart again.
-- Nothing is renamed or removed. A ledger already in the list is left exactly as it is.

CREATE OR REPLACE FUNCTION public.vendor_ledger_to_create()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.ledger_new IS TRUE AND coalesce(btrim(NEW.tally_ledger_name), '') <> ''
     AND NOT EXISTS (SELECT 1 FROM tally_ledgers WHERE name = NEW.tally_ledger_name) THEN
    INSERT INTO tally_ledgers (name, "under", section, role, status, as_of)
    VALUES (NEW.tally_ledger_name, 'Sundry Creditors', 'Current Liabilities', 'party', 'will_create',
            coalesce((SELECT NULLIF(value #>> '{}', '')::date FROM app_settings WHERE key = 'accounting_start_date'), DATE '2026-10-01'));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.vendor_ledger_to_create() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vendors_ledger_to_create ON public.vendors;
CREATE TRIGGER vendors_ledger_to_create AFTER INSERT OR UPDATE OF tally_ledger_name, ledger_new ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.vendor_ledger_to_create();

INSERT INTO public.tally_ledgers (name, "under", section, role, status, as_of)
SELECT DISTINCT v.tally_ledger_name, 'Sundry Creditors', 'Current Liabilities', 'party', 'will_create',
       coalesce((SELECT NULLIF(value #>> '{}', '')::date FROM public.app_settings WHERE key = 'accounting_start_date'), DATE '2026-10-01')
FROM public.vendors v
WHERE v.ledger_new IS TRUE AND coalesce(btrim(v.tally_ledger_name), '') <> ''
  AND NOT EXISTS (SELECT 1 FROM public.tally_ledgers t WHERE t.name = v.tally_ledger_name);
