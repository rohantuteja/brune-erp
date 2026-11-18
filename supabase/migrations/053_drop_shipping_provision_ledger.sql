-- 053_drop_shipping_provision_ledger.sql
--
-- Velocity is not provisioned (owner, 18 Nov 2026): it keeps being booked on the invoice date, as the accountant's books have always done (no Velocity provision ledger in his Tally,
-- Velocity's September invoice booked on its own date). The ledger `Shipping Expenses Provision` added by migration 052 for it is therefore not created in Tally.
-- Only a ledger still waiting to be created is removed.
DELETE FROM public.tally_ledgers WHERE name = 'Shipping Expenses Provision' AND status = 'will_create';
