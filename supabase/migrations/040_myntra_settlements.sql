-- 040_myntra_settlements.sql
--
-- Myntra's payouts. Myntra pays about every other day, one NEFT per payout, net of its fixed fee, commission, TCS and TDS, and takes
-- back what customers returned (plus a return fee) out of the same transfers. The two reports that carry the money (the monthly SETTLED
-- report and the PAYMENT DETAILS report) are read into one line per stream of an order line in a payout; the order ledger books the
-- ones a bank credit proves (supabase/functions/_shared/myntra-settlement.ts, docs/myntra-settlements.md).
--
--   myntra_settlement_lines     what the reports say, GST-inclusive as Myntra writes it (forward: paid to us, reverse: taken back)
--   myntra_reports()            the uploaded reports, for the screen
--   myntra_delete_report()      take a report back (a dry run first, like the other uploads; logged in upload_deletions)
--
-- A line is stored once, by the (UTR, order line, stream, direction) it describes; a later report holding the same line replaces it,
-- so uploading overlapping reports, or the settled and the payment details report of the same days, never doubles anything.

CREATE TABLE IF NOT EXISTS public.myntra_settlement_lines (
  id           bigserial     PRIMARY KEY,
  utr          text          NOT NULL,                 -- e.g. NFT-/XUTR/DEUTH026303A2EWNX; the bank narration repeats its first 16 characters
  settled_on   date,                                   -- the date the report gives (the ledger books the bank's date)
  invoice      text          NOT NULL,                 -- Unicommerce sale invoice number: the order's name in the ledger
  line_id      text          NOT NULL,                 -- Myntra's order line id (one invoice can hold several items)
  order_ref    text,                                   -- Myntra's seller order id (the Unicommerce order code)
  stream       text          NOT NULL CHECK (stream IN ('prepaid', 'postpaid')),
  dir          text          NOT NULL CHECK (dir IN ('forward', 'reverse')),
  product      numeric(14,3) NOT NULL,
  commission   numeric(14,3) NOT NULL DEFAULT 0,       -- GST-inclusive, charged (forward) or given back (reverse)
  fee          numeric(14,3) NOT NULL DEFAULT 0,       -- GST-inclusive: forward = fixed fee, reverse = return fee
  tcs          numeric(14,3) NOT NULL DEFAULT 0,
  tds          numeric(14,3) NOT NULL DEFAULT 0,
  net          numeric(14,3) NOT NULL,                 -- in the transfer: forward +, reverse - (taken back)
  source_file  text,
  source_kind  text          CHECK (source_kind IN ('settled_report', 'payment_details')),
  imported_at  timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (utr, line_id, stream, dir)
);
CREATE INDEX IF NOT EXISTS myntra_settlement_lines_invoice ON public.myntra_settlement_lines (invoice);
CREATE INDEX IF NOT EXISTS myntra_settlement_lines_file ON public.myntra_settlement_lines (source_file);

ALTER TABLE public.myntra_settlement_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.myntra_settlement_lines;
CREATE POLICY "admin read" ON public.myntra_settlement_lines FOR SELECT TO authenticated USING (public.finance_admin());

-- The log of deleted uploads learns the new kind.
ALTER TABLE public.upload_deletions DROP CONSTRAINT IF EXISTS upload_deletions_kind_check;
ALTER TABLE public.upload_deletions ADD CONSTRAINT upload_deletions_kind_check
  CHECK (kind IN ('statement', 'velocity_ledger', 'velocity_invoice', 'gokwik_report', 'myntra_report'));

-- ── The reports on file, for the screen ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.myntra_reports()
RETURNS TABLE (source_file text, source_kind text, lines bigint, payouts bigint, settled_from date, settled_to date, net numeric, imported_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN QUERY
    SELECT m.source_file, min(m.source_kind), count(*), count(DISTINCT m.utr), min(m.settled_on), max(m.settled_on), round(coalesce(sum(m.net), 0), 2), min(m.imported_at)
    FROM myntra_settlement_lines m WHERE m.source_file IS NOT NULL GROUP BY m.source_file ORDER BY min(m.imported_at) DESC;
END $$;
REVOKE ALL ON FUNCTION public.myntra_reports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.myntra_reports() TO authenticated;

-- ── Taking a report back ────────────────────────────────────────────────────────────────────────────────────────────
-- A dry run counts what would go; a real delete removes the lines the file last brought in and writes the log. Lines a later report also
-- holds were taken over by that report when it was uploaded (the file name moves), so they stay with it. The bank credits these payouts
-- proved go back to "suggested" when the edge function re-runs the matching afterwards; a credit filed by hand stays as filed.
CREATE OR REPLACE FUNCTION public.myntra_delete_report(p_source_file text, p_dry_run boolean, p_by uuid, p_by_name text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n integer; v_from date; v_to date; v_net numeric; v_payouts integer; v_reverting integer; v_staying integer; v_imported timestamptz; v_out jsonb;
BEGIN
  SELECT count(*), min(settled_on), max(settled_on), coalesce(sum(net), 0), count(DISTINCT utr), min(imported_at)
    INTO v_n, v_from, v_to, v_net, v_payouts, v_imported
  FROM myntra_settlement_lines WHERE source_file = p_source_file;
  IF v_n = 0 THEN RETURN NULL; END IF;

  SELECT count(*) FILTER (WHERE f.decided_at IS NULL), count(*) FILTER (WHERE f.decided_at IS NOT NULL) INTO v_reverting, v_staying
  FROM finance_lines f
  WHERE f.kind = 'myntra_payout' AND f.match_ref IN (SELECT 'UTR ' || utr FROM myntra_settlement_lines WHERE source_file = p_source_file);

  v_out := jsonb_build_object(
    'dry_run', p_dry_run, 'kind', 'myntra_report', 'label', p_source_file, 'period_from', v_from, 'period_to', v_to, 'uploaded_at', v_imported,
    'lines', v_n, 'removed', v_n, 'payouts', v_payouts, 'to_bank', round(v_net, 2), 'bank_lines_reverting', v_reverting, 'bank_lines_staying', v_staying);
  IF p_dry_run THEN RETURN v_out; END IF;
  DELETE FROM myntra_settlement_lines WHERE source_file = p_source_file;
  INSERT INTO upload_deletions (deleted_by, deleted_by_name, kind, label, uploaded_at, summary)
    VALUES (p_by, p_by_name, 'myntra_report', p_source_file, v_imported, v_out - 'dry_run');
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.myntra_delete_report(text, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.myntra_delete_report(text, boolean, uuid, text) TO service_role;
