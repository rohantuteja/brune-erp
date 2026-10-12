-- 025_velocity_wallet.sql
--
-- Velocity's prepaid wallet: the dashboard's Ledger Report (every top-up, charge and reversal, with the balance after it)
-- and the monthly tax invoice. Top-ups are advances, the invoice is the expense (see docs/velocity-wallet.md).
-- Files are read by the velocity-import function, which checks they add up and stores only the lines. Nothing here posts to Tally.
--
-- Same security as the other finance tables: admins read, nobody writes from a browser.

CREATE TABLE IF NOT EXISTS public.velocity_ledger_imports (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  filename         text,
  file_hash        text          NOT NULL UNIQUE,
  period_from      date,
  period_to        date,
  opening          numeric(12,2),                       -- wallet balance before the first line
  closing          numeric(12,2),                       -- wallet balance after the last line
  line_count       integer       NOT NULL DEFAULT 0,
  new_lines        integer       NOT NULL DEFAULT 0,
  duplicate_lines  integer       NOT NULL DEFAULT 0,
  checks           jsonb         NOT NULL DEFAULT '[]',  -- [{id, ok, detail}] what was verified about the file
  uploaded_by      uuid,
  uploaded_by_name text,
  uploaded_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.velocity_wallet_lines (
  id          bigserial     PRIMARY KEY,
  import_id   uuid          REFERENCES public.velocity_ledger_imports(id),
  line_key    text          NOT NULL UNIQUE,            -- time, type, amount, parcel, note and the balance after it
  txn_at      timestamp     NOT NULL,                   -- IST wall-clock time, as in the report
  txn_date    date          NOT NULL,
  direction   text          NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      numeric(12,2) NOT NULL,                   -- GST-inclusive
  balance     numeric(12,2) NOT NULL,                   -- wallet balance after this line
  awb         text,
  notes       text          NOT NULL,
  kind        text          NOT NULL,                   -- shipping | cod_charge | rto | ndr_automation | weight_discrepancy | cod_reversal | shipping_reversal | financial_note | recharge | other
  ex_gst      numeric(12,2),                            -- before GST, for charges and reversals
  created_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS velocity_wallet_lines_date ON public.velocity_wallet_lines (txn_date);
CREATE INDEX IF NOT EXISTS velocity_wallet_lines_kind ON public.velocity_wallet_lines (kind);
CREATE INDEX IF NOT EXISTS velocity_wallet_lines_awb  ON public.velocity_wallet_lines (awb) WHERE awb IS NOT NULL;

-- Supplier tax invoices carry their period and lines (Velocity's monthly invoice: VAS and freight).
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS period_from date;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS period_to   date;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS lines       jsonb NOT NULL DEFAULT '[]';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['velocity_ledger_imports', 'velocity_wallet_lines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "admin read" ON public.%I', t);
    EXECUTE format('CREATE POLICY "admin read" ON public.%I FOR SELECT TO authenticated USING (public.finance_admin())', t);
  END LOOP;
END $$;

-- A month's lines by kind and direction (or any date range), for the reconciliation. Service role only.
CREATE OR REPLACE FUNCTION public.velocity_summary(p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (month text, kind text, direction text, n bigint, amount numeric, ex_gst numeric)
LANGUAGE sql STABLE AS $$
  SELECT to_char(txn_date, 'YYYY-MM'), kind, direction, count(*), round(sum(amount), 2), round(coalesce(sum(ex_gst), 0), 2)
  FROM velocity_wallet_lines
  WHERE (p_from IS NULL OR txn_date >= p_from) AND (p_to IS NULL OR txn_date <= p_to)
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
$$;

REVOKE ALL ON FUNCTION public.velocity_summary(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.velocity_summary(date, date) TO service_role;
