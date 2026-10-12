-- 022_bank_and_card_reconciliation.sql
--
-- The bank statement and the credit card statement, line by line, each line matched to what it is:
--   a GoKwik or Velocity payout (proved by the settlement or the ledger), a Meta invoice payment (proved by the
--   invoice), a payment the bank returned, or an expense / income bucket (a guess to confirm, or the owner's rule).
-- Statements are uploaded through the finance-import function, which reads the file, checks that it adds up and
-- stores only the lines (never the file). Nothing here posts to Tally yet.
--
-- Everything is admin-only: these are salaries, founders' payments and bank balances. Browsers can read (admins) but
-- never write: imports run as the service role, and a person's decision goes through the logged functions below.

CREATE OR REPLACE FUNCTION public.finance_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
$$;

-- Where a line can be filed. Names from the owner's Tally profit and loss come first (spelling included).
CREATE TABLE IF NOT EXISTS public.finance_buckets (
  name       text    PRIMARY KEY,
  kind       text    NOT NULL CHECK (kind IN ('expense', 'asset', 'liability', 'income', 'transfer', 'ignore', 'review')),
  needs_bill boolean NOT NULL DEFAULT false,         -- the GST input credit needs the vendor's invoice
  note       text    NOT NULL DEFAULT '',
  sort       integer NOT NULL DEFAULT 0
);
INSERT INTO public.finance_buckets (name, kind, needs_bill, note, sort) VALUES
  ('Marketing Expenses', 'expense', true, 'Advertising other than the Meta invoices', 10),
  ('Employee Benefit Expenses', 'expense', false, 'Salaries, including the founders', 20),
  ('Labour Charges', 'expense', false, 'Karigar piece-rate, cutting and marker work', 30),
  ('Rent Expenses', 'expense', false, '', 40),
  ('Rent Sector 63 Noida', 'expense', false, '', 50),
  ('Software Expenses', 'expense', true, 'Subscriptions and software: needs the vendor GST invoice', 60),
  ('PAYMENT GATEWAY CHARGES', 'expense', true, 'GoKwik and gateway fees', 70),
  ('Shipping Expenses', 'expense', true, '', 80),
  ('Fabric and Consumbale', 'expense', false, 'Trims, zippers and consumables (spelling as in Tally)', 90),
  ('Packaging Expenses', 'expense', false, '', 100),
  ('Travelling Expenses', 'expense', false, 'Includes fuel', 110),
  ('Repair & Maintenance', 'expense', false, '', 120),
  ('MAINTENANCE-DIR RESIDENCE', 'expense', false, '', 130),
  ('FREIGHT INWARD NON GST', 'expense', false, 'Transport and porter charges', 140),
  ('Cleaning Expenses Factory', 'expense', false, '', 150),
  ('Electricity Expenses', 'expense', false, '', 160),
  ('Telephone & Internet Expenses', 'expense', true, '', 170),
  ('Bank Charges GST', 'expense', false, 'Bank and card charges with their GST', 180),
  ('FINANCE COST', 'expense', false, 'Interest', 190),
  ('Miscellaneous Expenses', 'expense', false, '', 200),
  ('Purchase Accounts', 'expense', true, 'Fabric purchases: needs the supplier bill', 210),
  ('GoKwik payout', 'transfer', false, 'Clears what GoKwik owes for prepaid orders', 220),
  ('Velocity COD remittance', 'transfer', false, 'Clears the COD cash Velocity collected', 230),
  ('Velocity wallet recharge', 'asset', false, 'Advance with Velocity, used up by freight charges', 240),
  ('Meta ads (invoice payment)', 'liability', false, 'Pays a Meta tax invoice booked as marketing expense and input GST', 250),
  ('Customer receipts (other gateway)', 'transfer', false, 'For example Razorpay', 260),
  ('Returned payment (no entry)', 'ignore', false, 'Paid, then returned by the bank: nets to zero', 270),
  ('Founder card payment (no company entry)', 'ignore', false, 'The founder paying his own card bill', 280),
  ('To confirm: personal or business', 'review', false, '', 290),
  ('To confirm: capital or loan', 'review', false, 'Money in from an owner, investor or lender', 300),
  ('To confirm: cash deposit', 'review', false, '', 310),
  ('To confirm: machinery (asset)', 'review', true, 'A machine is a fixed asset, not an expense', 320),
  ('To confirm: employee advance', 'review', false, '', 330),
  ('To confirm: other', 'review', false, '', 340)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.finance_accounts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL UNIQUE,
  kind       text        NOT NULL CHECK (kind IN ('bank', 'card')),
  holder     text        NOT NULL DEFAULT 'company' CHECK (holder IN ('company', 'founder')),   -- a founder's card: its purchases are company expenses owed to him
  bank       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.finance_accounts (name, kind, holder, bank) VALUES
  ('ICICI current account', 'bank', 'company', 'ICICI'),
  ('Kotak credit card (founder)', 'card', 'founder', 'Kotak')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.finance_statements (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid          NOT NULL REFERENCES public.finance_accounts(id),
  filename         text,
  file_hash        text          NOT NULL,
  period_from      date,
  period_to        date,
  opening          numeric(14,2),                       -- bank: balance before the first line
  closing          numeric(14,2),                       -- bank: balance after the last line; card: total amount due
  line_count       integer       NOT NULL DEFAULT 0,
  new_lines        integer       NOT NULL DEFAULT 0,
  duplicate_lines  integer       NOT NULL DEFAULT 0,
  checks           jsonb         NOT NULL DEFAULT '[]',  -- [{id, ok, detail}] what was verified about the file
  uploaded_by      uuid,
  uploaded_by_name text,
  uploaded_at      timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (account_id, file_hash)
);

CREATE TABLE IF NOT EXISTS public.finance_lines (
  id               bigserial     PRIMARY KEY,
  account_id       uuid          NOT NULL REFERENCES public.finance_accounts(id),
  statement_id     uuid          REFERENCES public.finance_statements(id),
  line_key         text          NOT NULL,              -- the bank's transaction id, or a hash of the card line
  txn_date         date          NOT NULL,
  value_date       date,
  ref              text,
  remarks          text          NOT NULL,
  debit            numeric(14,2) NOT NULL DEFAULT 0,
  credit           numeric(14,2) NOT NULL DEFAULT 0,
  balance          numeric(14,2),
  fx               text,
  category         text,
  section          text,
  -- what the engine (or a person) says it is
  status           text          NOT NULL DEFAULT 'needs_review' CHECK (status IN ('matched', 'suggested', 'needs_review', 'ignored')),
  kind             text,
  bucket           text          REFERENCES public.finance_buckets(name),
  match_ref        text,                                 -- UTR, invoice number, or the other line of a returned pair
  reason           text,
  needs_bill       boolean       NOT NULL DEFAULT false,
  payee            text,
  rule_id          bigint,
  decided_by       uuid,                                 -- set when a person decided: the engine never touches the line again
  decided_by_name  text,
  decided_at       timestamptz,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (account_id, line_key)
);
CREATE INDEX IF NOT EXISTS finance_lines_date   ON public.finance_lines (txn_date);
CREATE INDEX IF NOT EXISTS finance_lines_status ON public.finance_lines (status) WHERE decided_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_lines_bucket ON public.finance_lines (bucket);
CREATE INDEX IF NOT EXISTS finance_lines_payee  ON public.finance_lines (payee);

-- "This payee always goes to that bucket": learned from a confirmation.
CREATE TABLE IF NOT EXISTS public.finance_rules (
  id              bigserial   PRIMARY KEY,
  match_type      text        NOT NULL CHECK (match_type IN ('payee', 'contains')),
  pattern         text        NOT NULL,
  bucket          text        NOT NULL REFERENCES public.finance_buckets(name),
  created_by_name text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_type, pattern)
);

CREATE TABLE IF NOT EXISTS public.finance_line_log (
  id          bigserial   PRIMARY KEY,
  line_id     bigint      NOT NULL,
  action      text        NOT NULL,                      -- assigned | confirmed | reset
  bucket_from text,
  bucket_to   text,
  by_name     text,
  at          timestamptz NOT NULL DEFAULT now()
);

-- GoKwik's settlement report (rawSettlementReport), one row per payment.
CREATE TABLE IF NOT EXISTS public.gokwik_payments (
  payment_id      text          PRIMARY KEY,
  order_name      text,
  txn_date        date,
  settlement_date date,
  utr             text,
  amount          numeric(12,2) NOT NULL,
  fee             numeric(12,2) NOT NULL DEFAULT 0,
  tax             numeric(12,2) NOT NULL DEFAULT 0,       -- GST on the fee
  credit          numeric(12,2) NOT NULL,                 -- what reached the bank for this payment
  method          text,
  remark          text,
  pg_transaction_type text,
  source_file     text,
  imported_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gokwik_payments_utr ON public.gokwik_payments (utr);

-- Tax invoices from suppliers (Meta first): a bank payment is proved by the invoice number in its narration.
CREATE TABLE IF NOT EXISTS public.vendor_invoices (
  id            bigserial     PRIMARY KEY,
  vendor        text          NOT NULL,
  invoice_no    text          NOT NULL,
  invoice_date  date,
  period        text,
  subtotal      numeric(14,2) NOT NULL,                   -- before GST
  tax           numeric(14,2) NOT NULL DEFAULT 0,
  total         numeric(14,2) NOT NULL,
  tax_type      text          NOT NULL DEFAULT 'IGST',
  supplier_gstin text,
  bill_to_gstin  text,
  source        text          NOT NULL DEFAULT 'manual',
  imported_at   timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (vendor, invoice_no)
);
INSERT INTO public.vendor_invoices (vendor, invoice_no, invoice_date, period, subtotal, tax, total, supplier_gstin, bill_to_gstin, source) VALUES
  ('Meta', '2380865306', '2026-07-01', 'Jun-26',  504969.60,  90894.52,  595864.12, '06AABCF5150G1ZZ', '09AALCR1014K1ZB', 'tax invoice PDF'),
  ('Meta', '2380898574', '2026-08-01', 'Jul-26',  836222.32, 150520.01,  986742.33, '06AABCF5150G1ZZ', '09AALCR1014K1ZB', 'tax invoice PDF'),
  ('Meta', '2380919690', '2026-09-01', 'Aug-26',  679432.69, 122297.89,  801730.58, '06AABCF5150G1ZZ', '09AALCR1014K1ZB', 'tax invoice PDF'),
  ('Meta', '2380933755', '2026-10-01', 'Sep-26',  504308.30,  90775.49,  595083.79, '06AABCF5150G1ZZ', '09AALCR1014K1ZB', 'tax invoice PDF')
ON CONFLICT (vendor, invoice_no) DO NOTHING;

-- Row level security: admins read; nobody writes from a browser.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_buckets', 'finance_accounts', 'finance_statements', 'finance_lines', 'finance_rules', 'finance_line_log', 'gokwik_payments', 'vendor_invoices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "admin read" ON public.%I FOR SELECT TO authenticated USING (public.finance_admin())', t);
  END LOOP;
END $$;

-- A person files lines under a bucket. Optionally remembers it: every payee on those lines then goes there from now on.
CREATE OR REPLACE FUNCTION public.finance_line_assign(p_ids bigint[], p_bucket text, p_remember boolean DEFAULT false)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_kind text; v_count integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT kind INTO v_kind FROM finance_buckets WHERE name = p_bucket;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'unknown bucket'; END IF;
  IF coalesce(array_length(p_ids, 1), 0) = 0 OR array_length(p_ids, 1) > 1000 THEN RAISE EXCEPTION 'between 1 and 1000 lines'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();

  IF p_remember THEN
    INSERT INTO finance_rules (match_type, pattern, bucket, created_by_name)
    SELECT DISTINCT 'payee', payee, p_bucket, v_name FROM finance_lines WHERE id = ANY (p_ids) AND payee IS NOT NULL AND payee <> ''
    ON CONFLICT (match_type, pattern) DO UPDATE SET bucket = EXCLUDED.bucket, created_by_name = EXCLUDED.created_by_name, created_at = now();
  END IF;

  WITH before AS (SELECT id, bucket FROM finance_lines WHERE id = ANY (p_ids)),
  up AS (
    UPDATE finance_lines l SET bucket = p_bucket, status = CASE WHEN v_kind = 'ignore' THEN 'ignored' ELSE 'matched' END, kind = 'manual',
      reason = 'Filed by ' || v_name || CASE WHEN p_remember THEN ' (remembered for this payee)' ELSE '' END,
      needs_bill = (SELECT needs_bill FROM finance_buckets WHERE name = p_bucket), decided_by = auth.uid(), decided_by_name = v_name, decided_at = now(), updated_at = now()
    WHERE l.id = ANY (p_ids) RETURNING l.id
  ), lg AS (
    INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name) SELECT up.id, 'assigned', b.bucket, p_bucket, v_name FROM up JOIN before b ON b.id = up.id RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

-- Accept the guess on these lines as it stands (each keeps its own suggested bucket).
CREATE OR REPLACE FUNCTION public.finance_line_confirm(p_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_count integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF coalesce(array_length(p_ids, 1), 0) = 0 OR array_length(p_ids, 1) > 1000 THEN RAISE EXCEPTION 'between 1 and 1000 lines'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  WITH up AS (
    UPDATE finance_lines SET status = 'matched', decided_by = auth.uid(), decided_by_name = v_name, decided_at = now(), updated_at = now(),
      reason = coalesce(reason, '') || ' (confirmed by ' || v_name || ')'
    WHERE id = ANY (p_ids) AND bucket IS NOT NULL AND decided_at IS NULL RETURNING id, bucket
  ), lg AS (
    INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name) SELECT id, 'confirmed', bucket, bucket, v_name FROM up RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

-- Undo a decision: the line goes back to the engine (the next re-match suggests a bucket again).
CREATE OR REPLACE FUNCTION public.finance_line_reset(p_ids bigint[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_count integer;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  WITH before AS (SELECT id, bucket FROM finance_lines WHERE id = ANY (p_ids) AND decided_at IS NOT NULL),
  up AS (
    UPDATE finance_lines l SET status = 'needs_review', kind = NULL, bucket = NULL, reason = 'Reopened by ' || v_name, needs_bill = false, match_ref = NULL,
      decided_by = NULL, decided_by_name = NULL, decided_at = NULL, updated_at = now()
    WHERE l.id IN (SELECT id FROM before) RETURNING l.id
  ), lg AS (
    INSERT INTO finance_line_log (line_id, action, bucket_from, bucket_to, by_name) SELECT up.id, 'reset', b.bucket, NULL, v_name FROM up JOIN before b ON b.id = up.id RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.finance_admin(), public.finance_line_assign(bigint[], text, boolean), public.finance_line_confirm(bigint[]), public.finance_line_reset(bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_admin(), public.finance_line_assign(bigint[], text, boolean), public.finance_line_confirm(bigint[]), public.finance_line_reset(bigint[]) TO authenticated;
