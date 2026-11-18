-- 047_gstr2b_book_or_hand_over.sql
--
-- A supplier that has filed an invoice (it is in GSTR-2B) but has not sent it: the credit is claimed from GSTR-2B anyway; this lets the owner say what happens to the BOOKS:
--
--   * gstr2b_book_bill     book it from the GSTR-2B details (supplier, number, date, taxable value, tax) against an expense ledger the owner picks. A bill is created like any
--                          other (source 'gstr2b', accepted, no PDF): it flows into the Tally file, and attaching the real PDF later (Bills page) is the normal "attach" of a bill
--                          that has none. A supplier not in the system is created with its own ledger (the vendor's ledger is added to tally_ledgers as to be created).
--   * gstr2b_mark_handled  "the accountant books this one": no voucher from the ERP, no longer blocks the file. Undone with gstr2b_unmark_handled.
-- Admin only, SECURITY DEFINER, validated here as well as on the page. Nothing is deleted.

CREATE TABLE IF NOT EXISTS public.gstr2b_handled (
  id          bigserial   PRIMARY KEY,
  gstin       text        NOT NULL,
  invoice_key text        NOT NULL,                 -- the invoice number without case, punctuation or leading zeros (as the page matches them)
  invoice_no  text        NOT NULL,
  supplier    text,
  month       text,
  note        text        CHECK (note IS NULL OR length(note) <= 300),
  by_name     text,
  at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gstin, invoice_key)
);
ALTER TABLE public.gstr2b_handled ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.gstr2b_handled;
CREATE POLICY "admin read" ON public.gstr2b_handled FOR SELECT TO authenticated USING (public.finance_admin());

CREATE OR REPLACE FUNCTION public.gstr2b_invoice_key(p_no text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(upper(regexp_replace(coalesce(p_no, ''), '[^A-Za-z0-9]', '', 'g')), '^0+(?=.)', '')
$$;

CREATE OR REPLACE FUNCTION public.gstr2b_mark_handled(p_gstin text, p_no text, p_supplier text, p_month text, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_gstin IS NULL OR upper(p_gstin) !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$' THEN RAISE EXCEPTION 'the supplier GSTIN is not valid'; END IF;
  IF coalesce(btrim(p_no), '') = '' THEN RAISE EXCEPTION 'the invoice number is missing'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  INSERT INTO gstr2b_handled (gstin, invoice_key, invoice_no, supplier, month, note, by_name)
  VALUES (upper(p_gstin), gstr2b_invoice_key(p_no), btrim(p_no), left(p_supplier, 200), p_month, NULLIF(btrim(coalesce(p_note, '')), ''), v_name)
  ON CONFLICT (gstin, invoice_key) DO UPDATE SET note = EXCLUDED.note, by_name = EXCLUDED.by_name, at = now();
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (coalesce(p_month, ''), 'handled_by_accountant', jsonb_build_object('gstin', upper(p_gstin), 'invoice', btrim(p_no)), v_name);
END $$;

CREATE OR REPLACE FUNCTION public.gstr2b_unmark_handled(p_gstin text, p_no text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  DELETE FROM gstr2b_handled WHERE gstin = upper(p_gstin) AND invoice_key = gstr2b_invoice_key(p_no);
  IF FOUND THEN INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES ('', 'handled_by_accountant_undone', jsonb_build_object('gstin', upper(p_gstin), 'invoice', p_no), v_name); END IF;
END $$;

CREATE OR REPLACE FUNCTION public.gstr2b_book_bill(
  p_gstin text, p_supplier text, p_no text, p_date date, p_taxable numeric, p_igst numeric, p_cgst numeric, p_sgst numeric,
  p_expense_ledger text, p_supplier_ledger text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text; v_gstin text := upper(p_gstin); v_company text; v_start date; v_vendor vendors%ROWTYPE; v_ledger text; v_new boolean := false; v_tax numeric; v_id bigint; v_booking text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF v_gstin IS NULL OR v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$' THEN RAISE EXCEPTION 'the supplier GSTIN is not valid'; END IF;
  IF coalesce(btrim(p_no), '') = '' OR p_date IS NULL THEN RAISE EXCEPTION 'the invoice number and date are needed'; END IF;
  IF coalesce(p_taxable, -1) < 0 OR coalesce(p_igst, -1) < 0 OR coalesce(p_cgst, -1) < 0 OR coalesce(p_sgst, -1) < 0 OR greatest(p_taxable, p_igst, p_cgst, p_sgst) > 1000000000 THEN RAISE EXCEPTION 'the amounts must be numbers from 0 to 100 crore'; END IF;
  IF NOT EXISTS (SELECT 1 FROM tally_ledgers WHERE name = p_expense_ledger) THEN RAISE EXCEPTION 'pick the ledger from the list of Tally ledgers'; END IF;
  v_tax := round(p_igst + p_cgst + p_sgst, 2);
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  SELECT NULLIF(value #>> '{}', '') INTO v_company FROM app_settings WHERE key = 'company_gstin';
  SELECT coalesce(NULLIF(value #>> '{}', '')::date, DATE '2026-10-01') INTO v_start FROM app_settings WHERE key = 'accounting_start_date';
  v_start := coalesce(v_start, DATE '2026-10-01');

  SELECT * INTO v_vendor FROM vendors WHERE gstin = v_gstin;
  IF NOT FOUND THEN
    -- the supplier's own ledger: one the owner's Tally already has (same name, any case), else a new one for the file to create
    v_ledger := coalesce(NULLIF(btrim(p_supplier_ledger), ''), (SELECT name FROM tally_ledgers WHERE lower(name) = lower(btrim(p_supplier)) LIMIT 1), initcap(lower(btrim(p_supplier))));
    IF NOT EXISTS (SELECT 1 FROM tally_ledgers WHERE name = v_ledger) THEN
      v_new := true;
      INSERT INTO tally_ledgers (name, "under", section, role, status, as_of) VALUES (v_ledger, 'Sundry Creditors', 'Current Liabilities', 'party', 'will_create', v_start);
    END IF;
    v_booking := CASE WHEN p_expense_ledger ILIKE 'purchase%' THEN 'purchase' ELSE 'expense' END;
    INSERT INTO vendors (name, tally_ledger_name, gstin, pan, state_code, booking, expense_ledger, auto_accept, ledger_new, note, created_by_name)
    VALUES (initcap(lower(btrim(p_supplier))), v_ledger, v_gstin, substr(v_gstin, 3, 10), substr(v_gstin, 1, 2), v_booking, CASE WHEN v_booking = 'expense' THEN p_expense_ledger END, false, v_new,
            'Created from a GSTR-2B line with no invoice copy.', v_name)
    RETURNING * INTO v_vendor;
  END IF;
  IF v_vendor.booking = 'tie_out' THEN RAISE EXCEPTION 'this supplier is only compared with the ledger (tie-out): upload its invoice instead'; END IF;

  IF EXISTS (SELECT 1 FROM vendor_invoices WHERE vendor = v_vendor.name AND gstr2b_invoice_key(invoice_no) = gstr2b_invoice_key(p_no)) THEN RAISE EXCEPTION 'this invoice is already in the system'; END IF;
  INSERT INTO vendor_invoices (vendor, invoice_no, invoice_date, subtotal, tax, total, tax_type, supplier_gstin, bill_to_gstin, source, vendor_id, kind, status, opening, tax_rate, place_of_supply,
                               checks, confirmed_by, confirmed_by_name, confirmed_at, accepted_anyway)
  VALUES (v_vendor.name, btrim(p_no), p_date, round(p_taxable, 2), v_tax, round(p_taxable + v_tax, 2), CASE WHEN p_igst > 0 THEN 'IGST' ELSE 'CGST+SGST' END, v_gstin, v_company, 'gstr2b', v_vendor.id, 'service', 'accepted',
          p_date < v_start, CASE WHEN p_taxable > 0 THEN round(v_tax / p_taxable * 100, 2) END, 'Uttar Pradesh',
          jsonb_build_array(jsonb_build_object('id', 'from_2b', 'ok', true, 'detail', 'Booked from the GSTR-2B details: no invoice copy yet.')), auth.uid(), v_name, now(), 'Booked from GSTR-2B (no invoice copy yet)')
  RETURNING id INTO v_id;
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (to_char(p_date, 'YYYY-MM'), 'booked_from_2b', jsonb_build_object('gstin', v_gstin, 'invoice', btrim(p_no), 'ledger', p_expense_ledger, 'vendor_id', v_vendor.id, 'bill_id', v_id), v_name);
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION public.gstr2b_mark_handled(text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gstr2b_unmark_handled(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gstr2b_book_bill(text, text, text, date, numeric, numeric, numeric, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gstr2b_mark_handled(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gstr2b_unmark_handled(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gstr2b_book_bill(text, text, text, date, numeric, numeric, numeric, numeric, text, text) TO authenticated;
