-- 045_gstr3b_credit_ledger.sql
--
-- The electronic credit ledger is kept by the ERP instead of being typed in each month (Analytics → GSTR-3B, section 4).
--
--   * October 2026 starts from the owner's Tally trial balance (1-Apr-26 to 30-Sep-26): "GST Credit Ledger UP" closed at ₹13,41,161.00.
--     The GST output and input ledgers are nil at that date (the accountant journals them into the credit ledger every month), so
--     September is already set off and this is the credit carried into October. Tally does not split the credit ledger by tax head; it is
--     shown as integrated tax, which pays any head (the owner can correct the split from the portal). "GST Credit Ledger Delhi" (₹53,607) is
--     the other registration's and is not used.
--   * Every later month starts from the closing credit of the previous month's return, once the owner records that return as filed
--     ("I filed this month's return with these figures"): the figures filed are kept, and the closing credit carries forward by itself.
--     Recording it can be undone.
--
--   gstr3b_months gains: source ('tally' | 'manual' | 'carried'), filed_at / filed_by_name / filed (the figures filed), closing_*.
--   gstr3b_mark_filed / gstr3b_unmark_filed are admin only, validated here as well as on the page, and logged in gstr3b_log.

ALTER TABLE public.gstr3b_months
  ADD COLUMN IF NOT EXISTS source         text          NOT NULL DEFAULT 'manual' CHECK (source IN ('tally', 'manual', 'carried')),
  ADD COLUMN IF NOT EXISTS filed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS filed_by_name  text,
  ADD COLUMN IF NOT EXISTS filed          jsonb,
  ADD COLUMN IF NOT EXISTS closing_igst   numeric(14,2) CHECK (closing_igst >= 0),
  ADD COLUMN IF NOT EXISTS closing_cgst   numeric(14,2) CHECK (closing_cgst >= 0),
  ADD COLUMN IF NOT EXISTS closing_sgst   numeric(14,2) CHECK (closing_sgst >= 0);

-- October 2026 opens with what Tally says. Never overwrites a figure someone has already entered.
INSERT INTO public.gstr3b_months (month, opening_igst, opening_cgst, opening_sgst, note, updated_by_name, source)
VALUES ('2026-10', 1341161.00, 0, 0,
  'From your Tally trial balance at 30-Sep-26: GST Credit Ledger UP closing 13,41,161.00 (September is already set off: the GST output ledgers are nil). Tally does not split it by tax head, so it is shown as integrated tax, which pays any head.',
  'Tally trial balance', 'tally')
ON CONFLICT (month) DO NOTHING;

-- A typed opening is a correction: it is marked manual, and refused for a month that is recorded as filed.
CREATE OR REPLACE FUNCTION public.gstr3b_save_opening(p_month text, p_igst numeric, p_cgst numeric, p_sgst numeric, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'the month must look like 2026-10'; END IF;
  IF coalesce(p_igst, -1) < 0 OR coalesce(p_cgst, -1) < 0 OR coalesce(p_sgst, -1) < 0 OR greatest(p_igst, p_cgst, p_sgst) > 1000000000 THEN
    RAISE EXCEPTION 'each balance must be a number from 0 to 100 crore';
  END IF;
  IF EXISTS (SELECT 1 FROM gstr3b_months WHERE month = p_month AND filed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'this month is recorded as filed: undo that first to change its opening credit';
  END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  INSERT INTO gstr3b_months (month, opening_igst, opening_cgst, opening_sgst, note, updated_by_name, updated_at, source)
  VALUES (p_month, round(p_igst, 2), round(p_cgst, 2), round(p_sgst, 2), NULLIF(btrim(coalesce(p_note, '')), ''), v_name, now(), 'manual')
  ON CONFLICT (month) DO UPDATE SET opening_igst = EXCLUDED.opening_igst, opening_cgst = EXCLUDED.opening_cgst, opening_sgst = EXCLUDED.opening_sgst,
    note = EXCLUDED.note, updated_by_name = EXCLUDED.updated_by_name, updated_at = now(), source = 'manual';
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (p_month, 'opening', jsonb_build_object('igst', p_igst, 'cgst', p_cgst, 'sgst', p_sgst, 'note', p_note), v_name);
END $$;

-- The owner records that the month's return was filed with these figures; its closing credit carries into the next month by itself.
CREATE OR REPLACE FUNCTION public.gstr3b_mark_filed(
  p_month text, p_opening_igst numeric, p_opening_cgst numeric, p_opening_sgst numeric,
  p_closing_igst numeric, p_closing_cgst numeric, p_closing_sgst numeric, p_source text, p_filed jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_replaced boolean;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'the month must look like 2026-10'; END IF;
  IF p_source NOT IN ('tally', 'manual', 'carried') THEN RAISE EXCEPTION 'unknown source of the opening credit'; END IF;
  IF p_filed IS NULL OR jsonb_typeof(p_filed) <> 'object' OR length(p_filed::text) > 30000 THEN RAISE EXCEPTION 'the figures filed must be an object'; END IF;
  IF least(coalesce(p_opening_igst, -1), coalesce(p_opening_cgst, -1), coalesce(p_opening_sgst, -1), coalesce(p_closing_igst, -1), coalesce(p_closing_cgst, -1), coalesce(p_closing_sgst, -1)) < 0
     OR greatest(p_opening_igst, p_opening_cgst, p_opening_sgst, p_closing_igst, p_closing_cgst, p_closing_sgst) > 1000000000 THEN
    RAISE EXCEPTION 'each balance must be a number from 0 to 100 crore';
  END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  v_replaced := EXISTS (SELECT 1 FROM gstr3b_months WHERE month = p_month AND filed_at IS NOT NULL);
  INSERT INTO gstr3b_months (month, opening_igst, opening_cgst, opening_sgst, source, updated_by_name, updated_at, filed_at, filed_by_name, filed, closing_igst, closing_cgst, closing_sgst)
  VALUES (p_month, round(p_opening_igst, 2), round(p_opening_cgst, 2), round(p_opening_sgst, 2), p_source, v_name, now(), now(), v_name, p_filed,
          round(p_closing_igst, 2), round(p_closing_cgst, 2), round(p_closing_sgst, 2))
  ON CONFLICT (month) DO UPDATE SET opening_igst = EXCLUDED.opening_igst, opening_cgst = EXCLUDED.opening_cgst, opening_sgst = EXCLUDED.opening_sgst, source = EXCLUDED.source,
    updated_by_name = v_name, updated_at = now(), filed_at = now(), filed_by_name = v_name, filed = EXCLUDED.filed,
    closing_igst = EXCLUDED.closing_igst, closing_cgst = EXCLUDED.closing_cgst, closing_sgst = EXCLUDED.closing_sgst;
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (p_month, CASE WHEN v_replaced THEN 'filed_replaced' ELSE 'filed' END,
    jsonb_build_object('closing', jsonb_build_object('igst', p_closing_igst, 'cgst', p_closing_cgst, 'sgst', p_closing_sgst), 'source', p_source), v_name);
END $$;

-- Taking it back (recorded by mistake). A row that exists only because of the filing (its opening was carried) goes; a Tally or typed opening stays.
CREATE OR REPLACE FUNCTION public.gstr3b_unmark_filed(p_month text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_src text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT source INTO v_src FROM gstr3b_months WHERE month = p_month AND filed_at IS NOT NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  IF v_src = 'carried' THEN DELETE FROM gstr3b_months WHERE month = p_month;
  ELSE UPDATE gstr3b_months SET filed_at = NULL, filed_by_name = NULL, filed = NULL, closing_igst = NULL, closing_cgst = NULL, closing_sgst = NULL, updated_at = now() WHERE month = p_month;
  END IF;
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (p_month, 'unfiled', NULL, v_name);
END $$;

REVOKE ALL ON FUNCTION public.gstr3b_save_opening(text, numeric, numeric, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gstr3b_mark_filed(text, numeric, numeric, numeric, numeric, numeric, numeric, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gstr3b_unmark_filed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gstr3b_save_opening(text, numeric, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gstr3b_mark_filed(text, numeric, numeric, numeric, numeric, numeric, numeric, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gstr3b_unmark_filed(text) TO authenticated;
