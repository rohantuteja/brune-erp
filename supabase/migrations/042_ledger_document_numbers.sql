-- 042_ledger_document_numbers.sql
--
-- Numbers for the credit notes and invoices the ERP issues itself (Unicommerce's documents keep their own numbers).
--   credit notes   ERP/CN/2627/0001, 0002, ...      invoices   ERP/IN/2627/0001, 0002, ...
-- 16 characters (the GST limit), one gapless series per kind per financial year (April to March; 2627 = 2026-27), restarting at
-- 0001 each 1 April. The owner's accountant allowed the ERP its own number series (14 Oct 2026).
--
-- The ledger rewrites every order's entries on each run, so a number cannot live on the entry: it lives here, against the
-- document's identity (order, voucher kind, memo), and a trigger puts it back on the entry every time the entry is written.
-- A trigger on ledger_entries (not a wrapper around ledger_save_orders) because migrations have replaced that function more
-- than once, and a replacement would have dropped the numbering silently.
--
--   * A document is numbered the first time the ledger writes it, in date order for the ones that exist now.
--   * Its number and its date never change afterwards: if the ledger later computes another date, the registered date is kept
--     and the date it computed is remembered in seen_date, so a person can look (ledger_document_check).
--   * Documents dated before accounting_start_date are never numbered (they are never exported).
--   * The memo is part of the identity: never reword the memos of the ERP's credit notes and invoices in
--     supabase/functions/_shared/ledger.ts (a test pins them).

CREATE OR REPLACE FUNCTION public.ledger_fy(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lpad((s % 100)::text, 2, '0') || lpad(((s + 1) % 100)::text, 2, '0')
  FROM (SELECT (CASE WHEN extract(month FROM d) >= 4 THEN extract(year FROM d) ELSE extract(year FROM d) - 1 END)::int AS s) x
$$;

CREATE TABLE IF NOT EXISTS public.ledger_documents (
  id          bigserial     PRIMARY KEY,
  series      text          NOT NULL CHECK (series IN ('CN', 'IN')),
  fy          text          NOT NULL,                               -- '2627'
  seq         integer       NOT NULL CHECK (seq > 0),
  number      text          NOT NULL UNIQUE,                        -- ERP/CN/2627/0001
  order_name  text          NOT NULL,                               -- no foreign key: the registry must outlive any rewrite of the order
  voucher     text          NOT NULL CHECK (voucher IN ('credit_note', 'invoice')),
  memo        text          NOT NULL,
  doc_date    date          NOT NULL,                               -- the date it was numbered with; never moves
  amount      numeric(14,2) NOT NULL DEFAULT 0,                     -- value including GST when it was first written (0 = not set yet)
  issued_at   timestamptz   NOT NULL DEFAULT now(),
  seen_date   date,                                                 -- the date the ledger last computed for it
  seen_at     timestamptz,
  UNIQUE (series, fy, seq),
  UNIQUE (order_name, voucher, memo),
  CHECK (length(number) <= 16)
);

ALTER TABLE public.ledger_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated read" ON public.ledger_documents;
CREATE POLICY "authenticated read" ON public.ledger_documents FOR SELECT TO authenticated USING (true);

-- ── Number the documents that exist now, oldest first ───────────────────────────────────────────────────────────────
-- (the value of a balanced voucher is the sum of its debits)
WITH cut AS (SELECT COALESCE((SELECT NULLIF(value #>> '{}', '')::date FROM public.app_settings WHERE key = 'accounting_start_date'), date '2026-10-01') AS d),
docs AS (
  SELECT e.order_name, e.voucher, e.memo, min(e.entry_date) AS doc_date, round(sum(e.debit), 2) AS amount,
         CASE e.voucher WHEN 'credit_note' THEN 'CN' ELSE 'IN' END AS series
  FROM public.ledger_entries e, cut
  WHERE e.issued_by = 'erp' AND e.voucher IN ('credit_note', 'invoice') AND e.memo IS NOT NULL AND e.entry_date >= cut.d
  GROUP BY e.order_name, e.voucher, e.memo),
numbered AS (
  SELECT docs.*, public.ledger_fy(doc_date) AS fy,
         row_number() OVER (PARTITION BY series, public.ledger_fy(doc_date) ORDER BY doc_date, order_name, memo) AS seq
  FROM docs)
INSERT INTO public.ledger_documents (series, fy, seq, number, order_name, voucher, memo, doc_date, amount, seen_date, seen_at)
SELECT series, fy, seq, 'ERP/' || series || '/' || fy || '/' || lpad(seq::text, 4, '0'), order_name, voucher, memo, doc_date, amount, doc_date, now()
FROM numbered
ON CONFLICT DO NOTHING;

UPDATE public.ledger_entries e SET doc = g.number
FROM public.ledger_documents g
WHERE e.issued_by = 'erp' AND e.voucher = g.voucher AND e.order_name = g.order_name AND e.memo = g.memo AND e.doc IS NULL;

-- ── From now on: the trigger numbers every ERP credit note and invoice as the ledger writes it ──────────────────────
CREATE OR REPLACE FUNCTION public.ledger_number_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  reg     ledger_documents%ROWTYPE;
  v_start date;
  v_ser   text;
  v_fy    text;
  v_seq   integer;
BEGIN
  IF NEW.issued_by IS DISTINCT FROM 'erp' OR NEW.voucher NOT IN ('credit_note', 'invoice') OR NEW.memo IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO reg FROM ledger_documents WHERE order_name = NEW.order_name AND voucher = NEW.voucher AND memo = NEW.memo;
  IF NOT FOUND THEN
    SELECT COALESCE(NULLIF(value #>> '{}', '')::date, date '2026-10-01') INTO v_start FROM app_settings WHERE key = 'accounting_start_date';
    IF NEW.entry_date < COALESCE(v_start, date '2026-10-01') THEN RETURN NEW; END IF;          -- before the books started: never numbered
    PERFORM pg_advisory_xact_lock(hashtext('ledger_documents'));
    SELECT * INTO reg FROM ledger_documents WHERE order_name = NEW.order_name AND voucher = NEW.voucher AND memo = NEW.memo;   -- numbered while we waited?
    IF NOT FOUND THEN
      v_ser := CASE NEW.voucher WHEN 'credit_note' THEN 'CN' ELSE 'IN' END;
      v_fy := ledger_fy(NEW.entry_date);
      SELECT COALESCE(max(seq), 0) + 1 INTO v_seq FROM ledger_documents WHERE series = v_ser AND fy = v_fy;
      INSERT INTO ledger_documents (series, fy, seq, number, order_name, voucher, memo, doc_date, seen_date, seen_at)
      VALUES (v_ser, v_fy, v_seq, 'ERP/' || v_ser || '/' || v_fy || '/' || lpad(v_seq::text, 4, '0'), NEW.order_name, NEW.voucher, NEW.memo, NEW.entry_date, NEW.entry_date, now())
      RETURNING * INTO reg;
    END IF;
  END IF;

  IF reg.seen_date IS DISTINCT FROM NEW.entry_date THEN UPDATE ledger_documents SET seen_date = NEW.entry_date, seen_at = now() WHERE id = reg.id; END IF;

  NEW.doc := reg.number;
  NEW.entry_date := reg.doc_date;                                                              -- a numbered document keeps its date
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ledger_number_entry() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS ledger_number_entry ON public.ledger_entries;
CREATE TRIGGER ledger_number_entry BEFORE INSERT ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.ledger_number_entry();

-- A document's value (the sum of its debits) is written once, when the statement that first wrote its rows has finished: an
-- amount of 0 means "not set yet", so a later rewrite of the same rows never adds to it.
CREATE OR REPLACE FUNCTION public.ledger_number_amounts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE ledger_documents g SET amount = s.v
  FROM (SELECT doc, round(sum(debit), 2) AS v FROM new_rows WHERE doc LIKE 'ERP/%' GROUP BY doc) s
  WHERE g.number = s.doc AND g.amount = 0;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.ledger_number_amounts() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ledger_number_amounts ON public.ledger_entries;
CREATE TRIGGER ledger_number_amounts AFTER INSERT ON public.ledger_entries REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_number_amounts();

-- ── For a person to look at: is every number still on a document, with the date and value it was issued with? ────────
CREATE OR REPLACE VIEW public.ledger_document_check AS
SELECT g.number, g.order_name, g.voucher, g.memo, g.doc_date, g.seen_date, g.amount AS amount_issued,
       coalesce(l.value, 0) AS amount_now, coalesce(l.lines, 0) AS lines_now,
       CASE WHEN coalesce(l.lines, 0) = 0 THEN 'gone from the ledger'
            WHEN abs(coalesce(l.value, 0) - g.amount) > 0.01 THEN 'value changed'
            WHEN g.seen_date IS DISTINCT FROM g.doc_date THEN 'date differs from the ledger'
            ELSE 'ok' END AS status
FROM public.ledger_documents g
LEFT JOIN (SELECT doc, round(sum(debit), 2) AS value, count(*) AS lines FROM public.ledger_entries WHERE doc IS NOT NULL GROUP BY doc) l ON l.doc = g.number;
GRANT SELECT ON public.ledger_document_check TO authenticated;
