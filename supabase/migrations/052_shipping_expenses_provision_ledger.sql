-- 052_shipping_expenses_provision_ledger.sql
--
-- Month-end provisions (18 Nov 2026): Meta and Velocity are provisioned at the month end for the spend whose invoice comes on the 1st of the next month, and the provision is
-- reversed on the 1st, as the accountant does for Meta (Dr `Marketing Expenses Provision` / Cr `Provision for Expenses`, reversed the next day; both are in his Tally).
-- Velocity had no provision ledger of its own: `Shipping Expenses Provision` (Direct Expenses, the same kind as the marketing one) is added as a ledger the file creates.
-- Additive.
INSERT INTO public.tally_ledgers (name, "under", section, role, status, as_of)
SELECT 'Shipping Expenses Provision', 'Direct Expenses', 'Direct Expenses', 'expense', 'will_create', DATE '2026-09-30'
WHERE NOT EXISTS (SELECT 1 FROM public.tally_ledgers WHERE name = 'Shipping Expenses Provision');
