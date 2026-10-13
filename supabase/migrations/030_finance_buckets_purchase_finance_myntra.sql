-- 030_finance_buckets_purchase_finance_myntra.sql
-- Three changes to the bank & card buckets the owner asked for on 14 Oct 2026, after 029:
--   1. "The supplier's own ledger (one per payee)" is "Purchase Accounts" again (kind expense, needs the supplier bill);
--      the lines and rules filed under it move back, and each moved decided line is logged as 'renamed'.
--   2. "FINANCE COST" is back (interest and other finance costs will come under it).
--   3. "Myntra receivable (order control)" is a bucket, so Myntra's payouts can be filed under the ledger the order
--      ledger posts Myntra sales to.
-- The list below is BUCKETS in supabase/functions/_shared/bank-match.ts (bank-match.test.ts checks they are the same).
-- Safe to run twice: the move only runs while the old supplier bucket still exists.

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
  ('FINANCE COST', 'expense', false, 'Interest and other finance costs', 280),
  ('Miscelleneous Expenses', 'expense', false, 'Spelled as in Tally today', 290),
  ('Purchase Accounts', 'expense', true, 'Fabric purchases and supplier bills of ₹5,000 and over: needs the supplier bill, and this payment settles it', 300),
  ('Easebuzz Private Limited', 'transfer', false, 'GoKwik payout: the receipt comes from the order ledger, one per payout; the bank line only proves it', 310),
  ('COD receivable (Velocity)', 'transfer', false, 'Velocity COD remittance: the receipt comes from the order ledger, one per payout; the bank line only proves it', 320),
  ('Razorpay Payment Private Limited', 'transfer', false, 'Customer receipts through another gateway: the receipt comes from the order ledger', 330),
  ('Myntra receivable (order control)', 'transfer', false, 'Myntra''s payouts: the money Myntra collected for us, paid net of its fees, TCS and TDS; the receipt comes from the order ledger', 340),
  ('Velocity Prepaid Recharge Account', 'asset', false, 'Wallet top-up: an advance, used up by freight charges', 350),
  ('Facebook India Online Services Private Limited', 'liability', false, 'Settles the Meta invoice by its number', 360),
  ('Shopify Commerce Signapore Pte. Ltd.', 'liability', false, 'Shopify subscription', 370),
  ('Goexcelsior Private Limited', 'liability', true, 'KwikChat; also the card item that reads GoKwik', 380),
  ('Returned or reversed (no entry)', 'ignore', false, 'A payment the bank returned, or a card charge reversed: nets to zero', 390),
  ('Founder card payment (no company entry)', 'ignore', false, 'The founder paying his own card bill', 400),
  ('CASH AT POS DELHI', 'transfer', false, 'Cash deposited (your wholesale vertical): Dr ICICI Bank / Cr this ledger', 410),
  ('Sewing Machine GST', 'asset', true, 'A machine is a fixed asset. Other machines need their own ledger: tell me which', 420),
  ('Suspense', 'review', false, 'Parked until a person decides (Unsecured Loans From Directors when it is a director)', 430);

INSERT INTO public.finance_buckets (name, kind, needs_bill, note, sort)
SELECT name, kind, needs_bill, note, sort FROM new_buckets
ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, needs_bill = EXCLUDED.needs_bill, note = EXCLUDED.note, sort = EXCLUDED.sort;

DO $move$
BEGIN
  IF EXISTS (SELECT 1 FROM public.finance_buckets WHERE name = 'The supplier''s own ledger (one per payee)') THEN
    INSERT INTO public.finance_line_log (line_id, action, bucket_from, bucket_to, by_name)
    SELECT id, 'renamed', bucket, 'Purchase Accounts', 'Tally ledger names'
    FROM public.finance_lines WHERE bucket = 'The supplier''s own ledger (one per payee)' AND decided_at IS NOT NULL;

    UPDATE public.finance_lines SET bucket = 'Purchase Accounts', updated_at = now() WHERE bucket = 'The supplier''s own ledger (one per payee)';
    UPDATE public.finance_rules SET bucket = 'Purchase Accounts' WHERE bucket = 'The supplier''s own ledger (one per payee)';
  END IF;
END $move$;

-- Whether a line needs the supplier's bill follows from its bucket.
UPDATE public.finance_lines l SET needs_bill = b.needs_bill
FROM public.finance_buckets b WHERE b.name = l.bucket AND l.needs_bill IS DISTINCT FROM b.needs_bill;

DELETE FROM public.finance_buckets WHERE name NOT IN (SELECT name FROM new_buckets);
