-- 029_finance_buckets_tally_names.sql
-- The bank & card buckets become the owner's Tally ledger names (his tally-names-proposed.xlsx, 14 Oct 2026), so the
-- Tally file needs no mapping and the bank side and the order ledger use the same names (Easebuzz Private Limited,
-- COD receivable (Velocity), Payment Gateway Expenses ...). The list below is the one in
-- supabase/functions/_shared/bank-match.ts (BUCKETS); bank-match.test.ts checks they are the same.
--
-- Lines and rules already filed move to the new name:
--   * one old bucket, one new ledger: the new name (GoKwik payout -> Easebuzz Private Limited, ...);
--   * one old bucket that became several ledgers (salary, rent, software, telephone): the ledger it was most like
--     (Salary Payable, Rent Payable, Software Expenses @ 18%, Telephone and Internet Expenses GST), except that a
--     decided EXACTLY-50,000 salary payment naming a director goes to that director's ledger;
--   * the four "To confirm" buckets about unknown money all become Suspense (the accountant's own practice).
-- A decision a person made stays a decision (decided_by and decided_at are untouched); each moved decided line is
-- logged as 'renamed'. Lines nobody decided keep their guess until the next re-match recomputes it with the new names.
-- Safe to run twice: the move only runs while the old 'Employee Benefit Expenses' bucket still exists.

CREATE TEMP TABLE new_buckets (name text PRIMARY KEY, kind text NOT NULL, needs_bill boolean NOT NULL, note text NOT NULL, sort integer NOT NULL) ON COMMIT DROP;
INSERT INTO new_buckets (name, kind, needs_bill, note, sort) VALUES
  ('Marketing Expenses', 'expense', true, 'Advertising other than Meta', 10),
  ('Salary Payable', 'liability', false, 'Staff salary: the expense is your month-end journal, each payment settles it', 20),
  ('Director Salary Payable- Rohan Tuteja', 'liability', false, '₹50,000 a month', 30),
  ('Director Salary Payable- Adrija Halder', 'liability', false, '₹50,000 a month', 40),
  ('Staff Welfare Expenses', 'expense', false, '', 50),
  ('Labour Charges', 'expense', false, 'Karigar piece-rate, cutting, marker', 60),
  ('Rent Payable', 'liability', false, 'Rent to the Sector 63 landlord: the expense is your month-end journal to Rent Sector 63 Noida', 70),
  ('Rent - Director Resident', 'expense', false, '', 80),
  ('Software Expenses @ 18%', 'expense', true, 'Software with a GST invoice', 90),
  ('Software Expenses', 'expense', false, 'No GST invoice, or foreign (ChatGPT, Claude)', 100),
  ('Subscription Charges', 'expense', false, '', 110),
  ('Apps Charges', 'expense', false, '', 120),
  ('Payment Gateway Expenses', 'expense', true, 'Only fees paid outside a GoKwik payout; payout fees come from the order ledger', 130),
  ('Shipping Expenses @ 18%', 'expense', true, '', 140),
  ('Fabric and Consumbale', 'expense', false, 'Petty fabric, trims, zippers under ₹5,000', 150),
  ('Packaging Expenses', 'expense', false, '', 160),
  ('Travelling Expenses', 'expense', false, '', 170),
  ('Car Fuel Expenses', 'expense', false, 'Fuel', 180),
  ('CAR SERVICE EXPENSES', 'expense', false, '', 190),
  ('Repair & Maintenance', 'expense', false, '', 200),
  ('MAINTENANCE-DIR RESIDENCE', 'expense', false, '', 210),
  ('FREIGHT INWARD NON GST', 'expense', false, 'Transport and porter', 220),
  ('Cleaning Expenses Factory', 'expense', false, '', 230),
  ('Electricity Expenses', 'expense', false, '', 240),
  ('Telephone and Internet Expenses GST', 'expense', true, 'With a GST bill', 250),
  ('Telephone & Internet Expenses', 'expense', false, 'Without GST', 260),
  ('Bank Charges', 'expense', false, 'Bank and card charges, GST included', 270),
  ('Miscelleneous Expenses', 'expense', false, 'Spelled as in Tally today', 280),
  ('The supplier''s own ledger (one per payee)', 'liability', true, 'Payments of ₹5,000 and over: you book the supplier invoice, the payment settles it. Each payee is linked to a ledger once.', 290),
  ('Easebuzz Private Limited', 'transfer', false, 'GoKwik payout: the receipt comes from the order ledger, one per payout; the bank line only proves it', 300),
  ('COD receivable (Velocity)', 'transfer', false, 'Velocity COD remittance: the receipt comes from the order ledger, one per payout; the bank line only proves it', 310),
  ('Razorpay Payment Private Limited', 'transfer', false, 'Customer receipts through another gateway: the receipt comes from the order ledger', 320),
  ('Velocity Prepaid Recharge Account', 'asset', false, 'Wallet top-up: an advance, used up by freight charges', 330),
  ('Facebook India Online Services Private Limited', 'liability', false, 'Settles the Meta invoice by its number', 340),
  ('Shopify Commerce Signapore Pte. Ltd.', 'liability', false, 'Shopify subscription', 350),
  ('Goexcelsior Private Limited', 'liability', true, 'KwikChat; also the card item that reads GoKwik', 360),
  ('Returned or reversed (no entry)', 'ignore', false, 'A payment the bank returned, or a card charge reversed: nets to zero', 370),
  ('Founder card payment (no company entry)', 'ignore', false, 'The founder paying his own card bill', 380),
  ('CASH AT POS DELHI', 'transfer', false, 'Cash deposited (your wholesale vertical): Dr ICICI Bank / Cr this ledger', 390),
  ('Sewing Machine GST', 'asset', true, 'A machine is a fixed asset. Other machines need their own ledger: tell me which', 400),
  ('Suspense', 'review', false, 'Parked until a person decides (Unsecured Loans From Directors when it is a director)', 410);

INSERT INTO public.finance_buckets (name, kind, needs_bill, note, sort)
SELECT name, kind, needs_bill, note, sort FROM new_buckets
ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, needs_bill = EXCLUDED.needs_bill, note = EXCLUDED.note, sort = EXCLUDED.sort;

DO $move$
BEGIN
  IF EXISTS (SELECT 1 FROM public.finance_buckets WHERE name = 'Employee Benefit Expenses') THEN
    CREATE TEMP TABLE bucket_map (old text PRIMARY KEY, new text NOT NULL) ON COMMIT DROP;
    INSERT INTO bucket_map (old, new) VALUES
      ('Employee Benefit Expenses', 'Salary Payable'),
      ('Rent Expenses', 'Rent Payable'),
      ('Rent Sector 63 Noida', 'Rent Payable'),
      ('Software Expenses', 'Software Expenses @ 18%'),
      ('PAYMENT GATEWAY CHARGES', 'Payment Gateway Expenses'),
      ('Shipping Expenses', 'Shipping Expenses @ 18%'),
      ('Telephone & Internet Expenses', 'Telephone and Internet Expenses GST'),
      ('Bank Charges GST', 'Bank Charges'),
      ('Miscellaneous Expenses', 'Miscelleneous Expenses'),
      ('Purchase Accounts', 'The supplier''s own ledger (one per payee)'),
      ('GoKwik payout', 'Easebuzz Private Limited'),
      ('Velocity COD remittance', 'COD receivable (Velocity)'),
      ('Customer receipts (other gateway)', 'Razorpay Payment Private Limited'),
      ('Velocity wallet recharge', 'Velocity Prepaid Recharge Account'),
      ('Meta ads (invoice payment)', 'Facebook India Online Services Private Limited'),
      ('FINANCE COST', 'Suspense'),
      ('To confirm: personal or business', 'Suspense'),
      ('To confirm: capital or loan', 'Suspense'),
      ('To confirm: employee advance', 'Suspense'),
      ('To confirm: other', 'Suspense'),
      ('To confirm: cash deposit', 'CASH AT POS DELHI'),
      ('To confirm: machinery (asset)', 'Sewing Machine GST');

    -- Where every line goes (decided director salaries first by name; everything else by the map).
    CREATE TEMP TABLE bucket_move ON COMMIT DROP AS
    SELECT l.id, l.bucket AS old,
           CASE WHEN l.decided_at IS NOT NULL AND l.bucket = 'Employee Benefit Expenses' AND l.debit = 50000 AND l.remarks ILIKE '%rohan%' THEN 'Director Salary Payable- Rohan Tuteja'
                WHEN l.decided_at IS NOT NULL AND l.bucket = 'Employee Benefit Expenses' AND l.debit = 50000 AND l.remarks ILIKE '%adrija%' THEN 'Director Salary Payable- Adrija Halder'
                ELSE m.new END AS new,
           l.decided_at IS NOT NULL AS decided
    FROM public.finance_lines l JOIN bucket_map m ON m.old = l.bucket;

    INSERT INTO public.finance_line_log (line_id, action, bucket_from, bucket_to, by_name)
    SELECT id, 'renamed', old, new, 'Tally ledger names' FROM bucket_move WHERE decided AND new <> old;

    UPDATE public.finance_lines l SET bucket = mv.new, updated_at = now()
    FROM bucket_move mv WHERE l.id = mv.id AND mv.new <> mv.old;

    UPDATE public.finance_rules r SET bucket = m.new FROM bucket_map m WHERE r.bucket = m.old AND m.new <> m.old;
  END IF;
END $move$;

-- Whether a line needs the supplier's bill follows from its (new) bucket.
UPDATE public.finance_lines l SET needs_bill = b.needs_bill
FROM public.finance_buckets b WHERE b.name = l.bucket AND l.needs_bill IS DISTINCT FROM b.needs_bill;

DELETE FROM public.finance_buckets WHERE name NOT IN (SELECT name FROM new_buckets);

-- Deleting a statement counts the top-ups filed by hand under the wallet bucket: it has a new name.
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
         count(*) FILTER (WHERE k.keeper IS NULL AND l.bucket = 'Velocity Prepaid Recharge Account' AND l.debit > 0)
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
