-- 050_supplier_links.sql
--
-- Payment vouchers for the Tally file (18 Nov 2026). A bank payment to a supplier has to be posted to THAT supplier's ledger, against the bill it pays (or as an advance),
-- not to an expense: the expense is already booked by the supplier's bill (Dr expense / Cr supplier), so posting it again would count it twice.
--
--   * finance_lines.vendor_id        the supplier a payment went to, when a person (or a remembered payee) said so. Most lines need nothing: the ERP finds the supplier by
--                                     the bill's exact amount, or by the payee's name; only the lines it cannot place are asked about (Accounting page).
--   * finance_payee_vendors          a payee remembered as a supplier (the UPI handle or name on the bank line), so later payments to it are linked without asking.
--   * finance_line_link_vendor()     admin only, logged in finance_line_log (action 'vendor_linked'); optionally remembers the payee. finance_line_unlink_vendor() undoes it.
--   * vendors.tds_rate / tds_ledger  tax deducted at source by us on a supplier's invoice (Meta, 2% from October 2026); tds_to_confirm says the owner still has to
--                                     give the rate and the Tally ledger: the Accounting page lists such a supplier as "to do" until it is set. Meta is flagged now.
-- Additive. Nothing is changed or deleted.

ALTER TABLE public.finance_lines ADD COLUMN IF NOT EXISTS vendor_id bigint REFERENCES public.vendors(id);

CREATE TABLE IF NOT EXISTS public.finance_payee_vendors (
  payee     text        PRIMARY KEY,
  vendor_id bigint      NOT NULL REFERENCES public.vendors(id),
  by_name   text,
  at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.finance_payee_vendors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.finance_payee_vendors;
CREATE POLICY "admin read" ON public.finance_payee_vendors FOR SELECT TO authenticated USING (public.finance_admin());

ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS tds_rate numeric CHECK (tds_rate IS NULL OR (tds_rate >= 0 AND tds_rate <= 40));
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS tds_ledger text;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS tds_to_confirm boolean NOT NULL DEFAULT false;
UPDATE public.vendors SET tds_to_confirm = true WHERE name = 'Meta' AND tds_rate IS NULL;

CREATE OR REPLACE FUNCTION public.finance_line_link_vendor(p_ids bigint[], p_vendor_id bigint, p_remember boolean DEFAULT true)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_vendor text; v_count integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT name INTO v_vendor FROM vendors WHERE id = p_vendor_id;
  IF v_vendor IS NULL THEN RAISE EXCEPTION 'unknown supplier'; END IF;
  IF coalesce(array_length(p_ids, 1), 0) = 0 OR array_length(p_ids, 1) > 200 THEN RAISE EXCEPTION 'between 1 and 200 lines'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();

  IF p_remember THEN
    INSERT INTO finance_payee_vendors (payee, vendor_id, by_name)
    SELECT DISTINCT payee, p_vendor_id, v_name FROM finance_lines WHERE id = ANY (p_ids) AND payee IS NOT NULL AND payee <> '' AND payee !~ '^x+$'
    ON CONFLICT (payee) DO UPDATE SET vendor_id = EXCLUDED.vendor_id, by_name = EXCLUDED.by_name, at = now();
  END IF;

  WITH up AS (UPDATE finance_lines SET vendor_id = p_vendor_id, updated_at = now() WHERE id = ANY (p_ids) RETURNING id, bucket),
  lg AS (INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name) SELECT id, 'vendor_linked', bucket, v_vendor, v_name FROM up RETURNING 1)
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.finance_line_unlink_vendor(p_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_count integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF coalesce(array_length(p_ids, 1), 0) = 0 OR array_length(p_ids, 1) > 200 THEN RAISE EXCEPTION 'between 1 and 200 lines'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  WITH up AS (UPDATE finance_lines SET vendor_id = NULL, updated_at = now() WHERE id = ANY (p_ids) AND vendor_id IS NOT NULL RETURNING id, bucket),
  lg AS (INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name) SELECT id, 'vendor_unlinked', bucket, NULL, v_name FROM up RETURNING 1)
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.finance_line_link_vendor(bigint[], bigint, boolean), public.finance_line_unlink_vendor(bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_line_link_vendor(bigint[], bigint, boolean), public.finance_line_unlink_vendor(bigint[]) TO authenticated;
