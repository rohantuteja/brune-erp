-- 024_finance_bucket_rename.sql
-- "Returned payment (no entry)" also holds reversed card charges, so it is called "Returned or reversed (no entry)".
INSERT INTO public.finance_buckets (name, kind, needs_bill, note, sort)
VALUES ('Returned or reversed (no entry)', 'ignore', false, 'A payment the bank returned, or a card charge reversed: nets to zero', 270)
ON CONFLICT (name) DO NOTHING;
UPDATE public.finance_lines SET bucket = 'Returned or reversed (no entry)' WHERE bucket = 'Returned payment (no entry)';
UPDATE public.finance_rules SET bucket = 'Returned or reversed (no entry)' WHERE bucket = 'Returned payment (no entry)';
DELETE FROM public.finance_buckets WHERE name = 'Returned payment (no entry)';
