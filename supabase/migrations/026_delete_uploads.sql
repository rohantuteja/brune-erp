-- 026_delete_uploads.sql
--
-- Take back an upload: a bank or card statement, a Velocity wallet ledger, a Velocity invoice or a GoKwik settlement report,
-- together with the lines it brought in. Every function is a dry run first (it counts what would go, so the screen can tell the
-- person before anything is deleted) and writes the deletion to upload_deletions.
--
-- Overlapping uploads: a line is stored once, by the first upload that had it, so an upload's lines may also be in a later upload.
-- A line another upload of the same account/ledger also covers (that upload's period contains the line's date, and a statement or
-- report holds every line of its period) is not deleted: it moves to that upload. Everything else the upload brought in goes.
--
-- After a delete the edge function re-runs the bank matching, so a payment that was proved only by the deleted upload goes back to
-- "suggested". Lines a person decided are never changed by matching; they go only when their own statement goes.
--
-- Service role only (the finance-import and velocity-import functions call these after checking the caller is an admin); the log
-- is readable by admins like the other finance tables.

CREATE TABLE IF NOT EXISTS public.upload_deletions (
  id               bigserial   PRIMARY KEY,
  deleted_at       timestamptz NOT NULL DEFAULT now(),
  deleted_by       uuid,
  deleted_by_name  text,
  kind             text        NOT NULL CHECK (kind IN ('statement', 'velocity_ledger', 'velocity_invoice', 'gokwik_report')),
  label            text,                                   -- file name, or the invoice number
  uploaded_at      timestamptz,
  uploaded_by_name text,
  summary          jsonb       NOT NULL DEFAULT '{}'       -- what went: period, lines removed, lines moved to another upload, hand-filed lines
);
ALTER TABLE public.upload_deletions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.upload_deletions;
CREATE POLICY "admin read" ON public.upload_deletions FOR SELECT TO authenticated USING (public.finance_admin());

-- ── Which other upload also covers each line of an upload ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_line_keepers(p_statement uuid)
RETURNS TABLE (line_id bigint, keeper uuid)
LANGUAGE sql STABLE AS $$
  SELECT l.id,
    (SELECT o.id FROM finance_statements o
      WHERE o.account_id = s.account_id AND o.id <> s.id AND o.period_from <= l.txn_date AND l.txn_date <= o.period_to
      ORDER BY o.uploaded_at, o.id LIMIT 1)
  FROM finance_statements s JOIN finance_lines l ON l.statement_id = s.id
  WHERE s.id = p_statement
$$;

CREATE OR REPLACE FUNCTION public.velocity_line_keepers(p_import uuid)
RETURNS TABLE (line_id bigint, keeper uuid)
LANGUAGE sql STABLE AS $$
  SELECT l.id,
    (SELECT o.id FROM velocity_ledger_imports o
      WHERE o.id <> i.id AND o.period_from <= l.txn_date AND l.txn_date <= o.period_to
      ORDER BY o.uploaded_at, o.id LIMIT 1)
  FROM velocity_ledger_imports i JOIN velocity_wallet_lines l ON l.import_id = i.id
  WHERE i.id = p_import
$$;

-- ── A bank or card statement ────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finance_delete_statement(p_id uuid, p_dry_run boolean, p_by uuid, p_by_name text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  s finance_statements; acct text; v_total integer; v_kept integer; v_hand integer; v_topups integer; v_by jsonb; v_out jsonb;
BEGIN
  SELECT * INTO s FROM finance_statements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT name INTO acct FROM finance_accounts WHERE id = s.account_id;

  SELECT count(*), count(*) FILTER (WHERE k.keeper IS NOT NULL),
         count(*) FILTER (WHERE k.keeper IS NULL AND l.decided_at IS NOT NULL),
         count(*) FILTER (WHERE k.keeper IS NULL AND l.bucket = 'Velocity wallet recharge' AND l.debit > 0)
    INTO v_total, v_kept, v_hand, v_topups
  FROM finance_lines l JOIN finance_line_keepers(p_id) k ON k.line_id = l.id;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.keeper, 'filename', o.filename, 'lines', x.n) ORDER BY o.uploaded_at), '[]'::jsonb) INTO v_by
  FROM (SELECT keeper, count(*) n FROM finance_line_keepers(p_id) WHERE keeper IS NOT NULL GROUP BY keeper) x
  JOIN finance_statements o ON o.id = x.keeper;

  v_out := jsonb_build_object(
    'dry_run', p_dry_run, 'kind', 'statement', 'id', s.id, 'label', s.filename, 'account', acct, 'period_from', s.period_from, 'period_to', s.period_to,
    'uploaded_at', s.uploaded_at, 'uploaded_by_name', s.uploaded_by_name,
    'lines', v_total, 'removed', v_total - v_kept, 'moved_to_other_upload', v_kept, 'moved_to', v_by,
    'filed_by_hand', v_hand, 'topup_payments', v_topups);
  IF p_dry_run THEN RETURN v_out; END IF;

  UPDATE finance_lines l SET statement_id = k.keeper FROM finance_line_keepers(p_id) k WHERE l.id = k.line_id AND k.keeper IS NOT NULL;
  UPDATE finance_statements o SET new_lines = o.new_lines + m.lines, duplicate_lines = greatest(o.duplicate_lines - m.lines, 0)
    FROM jsonb_to_recordset(v_by) AS m(id uuid, lines integer) WHERE o.id = m.id;
  DELETE FROM finance_lines WHERE statement_id = p_id;
  DELETE FROM finance_statements WHERE id = p_id;
  INSERT INTO upload_deletions (deleted_by, deleted_by_name, kind, label, uploaded_at, uploaded_by_name, summary)
    VALUES (p_by, p_by_name, 'statement', s.filename, s.uploaded_at, s.uploaded_by_name, v_out - 'dry_run' - 'id');
  RETURN v_out;
END $$;

-- ── A Velocity wallet ledger ────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.velocity_delete_import(p_id uuid, p_dry_run boolean, p_by uuid, p_by_name text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  i velocity_ledger_imports; v_total integer; v_kept integer; v_topups integer; v_topup_amount numeric; v_reverting integer; v_staying integer; v_by jsonb; v_out jsonb;
BEGIN
  SELECT * INTO i FROM velocity_ledger_imports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*), count(*) FILTER (WHERE k.keeper IS NOT NULL),
         count(*) FILTER (WHERE k.keeper IS NULL AND l.kind = 'recharge'), coalesce(sum(l.amount) FILTER (WHERE k.keeper IS NULL AND l.kind = 'recharge'), 0)
    INTO v_total, v_kept, v_topups, v_topup_amount
  FROM velocity_wallet_lines l JOIN velocity_line_keepers(p_id) k ON k.line_id = l.id;

  -- Bank payments that a removed top-up proves: the automatic ones fall back to "suggested"; ones a person confirmed stay as filed.
  SELECT count(*) FILTER (WHERE f.decided_at IS NULL), count(*) FILTER (WHERE f.decided_at IS NOT NULL) INTO v_reverting, v_staying
  FROM finance_lines f
  WHERE f.kind = 'velocity_recharge' AND f.match_ref IN (
    SELECT 'Wallet recharge ' || to_char(l.txn_at, 'YYYY-MM-DD HH24:MI:SS')
    FROM velocity_wallet_lines l JOIN velocity_line_keepers(p_id) k ON k.line_id = l.id WHERE k.keeper IS NULL AND l.kind = 'recharge');

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.keeper, 'filename', o.filename, 'lines', x.n) ORDER BY o.uploaded_at), '[]'::jsonb) INTO v_by
  FROM (SELECT keeper, count(*) n FROM velocity_line_keepers(p_id) WHERE keeper IS NOT NULL GROUP BY keeper) x
  JOIN velocity_ledger_imports o ON o.id = x.keeper;

  v_out := jsonb_build_object(
    'dry_run', p_dry_run, 'kind', 'velocity_ledger', 'id', i.id, 'label', i.filename, 'period_from', i.period_from, 'period_to', i.period_to,
    'uploaded_at', i.uploaded_at, 'uploaded_by_name', i.uploaded_by_name,
    'lines', v_total, 'removed', v_total - v_kept, 'moved_to_other_upload', v_kept, 'moved_to', v_by,
    'topups', v_topups, 'topup_amount', v_topup_amount, 'bank_lines_reverting', v_reverting, 'bank_lines_staying', v_staying);
  IF p_dry_run THEN RETURN v_out; END IF;

  UPDATE velocity_wallet_lines l SET import_id = k.keeper FROM velocity_line_keepers(p_id) k WHERE l.id = k.line_id AND k.keeper IS NOT NULL;
  UPDATE velocity_ledger_imports o SET new_lines = o.new_lines + m.lines, duplicate_lines = greatest(o.duplicate_lines - m.lines, 0)
    FROM jsonb_to_recordset(v_by) AS m(id uuid, lines integer) WHERE o.id = m.id;
  DELETE FROM velocity_wallet_lines WHERE import_id = p_id;
  DELETE FROM velocity_ledger_imports WHERE id = p_id;
  INSERT INTO upload_deletions (deleted_by, deleted_by_name, kind, label, uploaded_at, uploaded_by_name, summary)
    VALUES (p_by, p_by_name, 'velocity_ledger', i.filename, i.uploaded_at, i.uploaded_by_name, v_out - 'dry_run' - 'id');
  RETURN v_out;
END $$;

-- ── A Velocity tax invoice ──────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.velocity_delete_invoice(p_invoice_no text, p_dry_run boolean, p_by uuid, p_by_name text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v vendor_invoices; v_out jsonb;
BEGIN
  SELECT * INTO v FROM vendor_invoices WHERE vendor = 'Velocity' AND invoice_no = p_invoice_no FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_out := jsonb_build_object(
    'dry_run', p_dry_run, 'kind', 'velocity_invoice', 'label', v.invoice_no, 'invoice_date', v.invoice_date, 'period_from', v.period_from, 'period_to', v.period_to,
    'subtotal', v.subtotal, 'tax', v.tax, 'total', v.total, 'uploaded_at', v.imported_at);
  IF p_dry_run THEN RETURN v_out; END IF;
  DELETE FROM vendor_invoices WHERE id = v.id;
  INSERT INTO upload_deletions (deleted_by, deleted_by_name, kind, label, uploaded_at, summary)
    VALUES (p_by, p_by_name, 'velocity_invoice', v.invoice_no, v.imported_at, v_out - 'dry_run');
  RETURN v_out;
END $$;

-- ── A GoKwik settlement report ──────────────────────────────────────────────────────────────────────────────────────
-- Payments are stored one by one with the file that last carried them, so a report's payments are the ones whose source_file is it.
CREATE OR REPLACE FUNCTION public.gokwik_delete_report(p_source_file text, p_dry_run boolean, p_by uuid, p_by_name text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n integer; v_from date; v_to date; v_amount numeric; v_payouts integer; v_reverting integer; v_staying integer; v_imported timestamptz; v_out jsonb;
BEGIN
  SELECT count(*), min(settlement_date), max(settlement_date), coalesce(sum(credit), 0), count(DISTINCT utr), min(imported_at)
    INTO v_n, v_from, v_to, v_amount, v_payouts, v_imported
  FROM gokwik_payments WHERE source_file = p_source_file;
  IF v_n = 0 THEN RETURN NULL; END IF;

  SELECT count(*) FILTER (WHERE f.decided_at IS NULL), count(*) FILTER (WHERE f.decided_at IS NOT NULL) INTO v_reverting, v_staying
  FROM finance_lines f
  WHERE f.kind = 'gokwik_payout' AND f.match_ref IN (SELECT 'UTR ' || utr FROM gokwik_payments WHERE source_file = p_source_file AND utr IS NOT NULL);

  v_out := jsonb_build_object(
    'dry_run', p_dry_run, 'kind', 'gokwik_report', 'label', p_source_file, 'period_from', v_from, 'period_to', v_to, 'uploaded_at', v_imported,
    'lines', v_n, 'removed', v_n, 'payouts', v_payouts, 'to_bank', v_amount, 'bank_lines_reverting', v_reverting, 'bank_lines_staying', v_staying);
  IF p_dry_run THEN RETURN v_out; END IF;
  DELETE FROM gokwik_payments WHERE source_file = p_source_file;
  INSERT INTO upload_deletions (deleted_by, deleted_by_name, kind, label, uploaded_at, summary)
    VALUES (p_by, p_by_name, 'gokwik_report', p_source_file, v_imported, v_out - 'dry_run');
  RETURN v_out;
END $$;

-- The GoKwik reports on file, for the screen (payments carry the file that last held them; there is no separate upload record).
CREATE OR REPLACE FUNCTION public.gokwik_reports()
RETURNS TABLE (source_file text, payments bigint, settled_from date, settled_to date, to_bank numeric, imported_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  RETURN QUERY
    SELECT g.source_file, count(*), min(g.settlement_date), max(g.settlement_date), round(coalesce(sum(g.credit), 0), 2), min(g.imported_at)
    FROM gokwik_payments g WHERE g.source_file IS NOT NULL GROUP BY g.source_file ORDER BY min(g.imported_at) DESC;
END $$;

REVOKE ALL ON FUNCTION public.finance_line_keepers(uuid), public.velocity_line_keepers(uuid),
  public.finance_delete_statement(uuid, boolean, uuid, text), public.velocity_delete_import(uuid, boolean, uuid, text),
  public.velocity_delete_invoice(text, boolean, uuid, text), public.gokwik_delete_report(text, boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_line_keepers(uuid), public.velocity_line_keepers(uuid),
  public.finance_delete_statement(uuid, boolean, uuid, text), public.velocity_delete_import(uuid, boolean, uuid, text),
  public.velocity_delete_invoice(text, boolean, uuid, text), public.gokwik_delete_report(text, boolean, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.gokwik_reports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gokwik_reports() TO authenticated;
