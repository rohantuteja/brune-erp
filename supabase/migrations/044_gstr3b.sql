-- 044_gstr3b.sql
--
-- Analytics → GSTR-3B (docs/gstr3b-view.md): a working sheet for the monthly return. Two small tables it needs to remember between visits:
--
--   gstr2b_files    the lines of the GSTR-2B the owner loaded for a month (supplier GSTIN, invoice number, date, taxable value, tax by head,
--                   "ITC available", reverse charge). The file is read in the browser; only these lines are kept, never the file itself,
--                   and loading another file for the month replaces the first. Read only by admins.
--   gstr3b_months   the credit the owner carried into a month (IGST, CGST, SGST), from the portal's electronic credit ledger. Entered once
--                   a month by hand: the ERP cannot see the portal.
--   gstr3b_log      who loaded, replaced, removed or entered what, and when.
--
-- Nothing here touches the order ledger, the bills or any other table. Writes go through the three functions below (admin only,
-- SECURITY DEFINER, validated here as well as on the page); no browser can write the tables directly.

CREATE TABLE IF NOT EXISTS public.gstr3b_months (
  month            text          PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  opening_igst     numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_igst >= 0),
  opening_cgst     numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_cgst >= 0),
  opening_sgst     numeric(14,2) NOT NULL DEFAULT 0 CHECK (opening_sgst >= 0),
  note             text,
  updated_by_name  text,
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gstr2b_files (
  month            text          PRIMARY KEY CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  gstin            text,
  period           text,                                   -- the month the file says it is for ('2026-10'); null when an Excel file does not say
  generated_on     date,
  file_name        text,
  source           text          NOT NULL CHECK (source IN ('json', 'excel')),
  docs             jsonb         NOT NULL,                 -- [{ kind, ctin, supplier, no, date, value, taxable, igst, cgst, sgst, cess, itc, reason, rcm, supplierPeriod }]
  warnings         jsonb         NOT NULL DEFAULT '[]',
  doc_count        integer       NOT NULL,
  uploaded_by_name text,
  uploaded_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gstr3b_log (
  id         bigserial   PRIMARY KEY,
  month      text        NOT NULL,
  action     text        NOT NULL,
  detail     jsonb,
  by_name    text,
  at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gstr3b_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gstr2b_files  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gstr3b_log    ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.gstr3b_months;
DROP POLICY IF EXISTS "admin read" ON public.gstr2b_files;
DROP POLICY IF EXISTS "admin read" ON public.gstr3b_log;
CREATE POLICY "admin read" ON public.gstr3b_months FOR SELECT TO authenticated USING (public.finance_admin());
CREATE POLICY "admin read" ON public.gstr2b_files  FOR SELECT TO authenticated USING (public.finance_admin());
CREATE POLICY "admin read" ON public.gstr3b_log    FOR SELECT TO authenticated USING (public.finance_admin());

-- ── The credit carried into a month ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gstr3b_save_opening(p_month text, p_igst numeric, p_cgst numeric, p_sgst numeric, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'the month must look like 2026-10'; END IF;
  IF coalesce(p_igst, -1) < 0 OR coalesce(p_cgst, -1) < 0 OR coalesce(p_sgst, -1) < 0 OR greatest(p_igst, p_cgst, p_sgst) > 1000000000 THEN
    RAISE EXCEPTION 'each balance must be a number from 0 to 100 crore';
  END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  INSERT INTO gstr3b_months (month, opening_igst, opening_cgst, opening_sgst, note, updated_by_name, updated_at)
  VALUES (p_month, round(p_igst, 2), round(p_cgst, 2), round(p_sgst, 2), NULLIF(btrim(coalesce(p_note, '')), ''), v_name, now())
  ON CONFLICT (month) DO UPDATE SET opening_igst = EXCLUDED.opening_igst, opening_cgst = EXCLUDED.opening_cgst, opening_sgst = EXCLUDED.opening_sgst,
    note = EXCLUDED.note, updated_by_name = EXCLUDED.updated_by_name, updated_at = now();
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (p_month, 'opening', jsonb_build_object('igst', p_igst, 'cgst', p_cgst, 'sgst', p_sgst, 'note', p_note), v_name);
END $$;

-- ── The GSTR-2B lines for a month ───────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gstr2b_save(p_month text, p_file_name text, p_source text, p_gstin text, p_period text, p_generated_on date, p_docs jsonb, p_warnings jsonb DEFAULT '[]')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_company text; v_count integer; v_replaced boolean;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'the month must look like 2026-10'; END IF;
  IF p_source NOT IN ('json', 'excel') THEN RAISE EXCEPTION 'unknown file type'; END IF;
  IF p_docs IS NULL OR jsonb_typeof(p_docs) <> 'array' THEN RAISE EXCEPTION 'the lines must be a list'; END IF;
  v_count := jsonb_array_length(p_docs);
  IF v_count > 5000 THEN RAISE EXCEPTION 'more than 5000 lines in one month: check the file'; END IF;
  IF p_period IS NOT NULL AND p_period <> p_month THEN RAISE EXCEPTION 'this file is for %, not %', p_period, p_month; END IF;
  SELECT NULLIF(value #>> '{}', '') INTO v_company FROM app_settings WHERE key = 'company_gstin';
  IF p_gstin IS NOT NULL AND v_company IS NOT NULL AND upper(p_gstin) <> upper(v_company) THEN RAISE EXCEPTION 'this file is for GSTIN %, not %', p_gstin, v_company; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  v_replaced := EXISTS (SELECT 1 FROM gstr2b_files WHERE month = p_month);
  INSERT INTO gstr2b_files (month, gstin, period, generated_on, file_name, source, docs, warnings, doc_count, uploaded_by_name, uploaded_at)
  VALUES (p_month, upper(p_gstin), p_period, p_generated_on, left(p_file_name, 200), p_source, p_docs, coalesce(p_warnings, '[]'), v_count, v_name, now())
  ON CONFLICT (month) DO UPDATE SET gstin = EXCLUDED.gstin, period = EXCLUDED.period, generated_on = EXCLUDED.generated_on, file_name = EXCLUDED.file_name,
    source = EXCLUDED.source, docs = EXCLUDED.docs, warnings = EXCLUDED.warnings, doc_count = EXCLUDED.doc_count, uploaded_by_name = EXCLUDED.uploaded_by_name, uploaded_at = now();
  INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (p_month, CASE WHEN v_replaced THEN 'gstr2b_replaced' ELSE 'gstr2b_loaded' END, jsonb_build_object('file', left(p_file_name, 200), 'lines', v_count), v_name);
  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION public.gstr2b_delete(p_month text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_lines integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  DELETE FROM gstr2b_files WHERE month = p_month RETURNING doc_count INTO v_lines;
  IF FOUND THEN INSERT INTO gstr3b_log (month, action, detail, by_name) VALUES (p_month, 'gstr2b_removed', jsonb_build_object('lines', v_lines), v_name); END IF;
END $$;

REVOKE ALL ON FUNCTION public.gstr3b_save_opening(text, numeric, numeric, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gstr2b_save(text, text, text, text, text, date, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.gstr2b_delete(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gstr3b_save_opening(text, numeric, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gstr2b_save(text, text, text, text, text, date, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.gstr2b_delete(text) TO authenticated;
