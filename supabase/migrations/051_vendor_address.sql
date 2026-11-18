-- 051_vendor_address.sql
--
-- A supplier's ledger is created in Tally with its details, not a bare name (owner, 18 Nov 2026). The GSTIN, PAN and state were already on the supplier; the address and
-- pincode were not, and Tally keeps them on the party (the accountant's Day Book shows them on every supplier voucher). Read from the suppliers' own invoices:
-- VIPUL ENTERPRISES (invoice 2026-27/1695) and PicknPack Solutions (ECOM/26-27/24115). Mittal Hosiery and Nykaa have no invoice copy to read it from yet: left empty.
-- Additive; only fills a supplier whose address is empty.
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS pincode text;
UPDATE public.vendors SET address = E'X/4070, Gali No. -17\nShanti Mohalla, Gandhi Nagar\nDelhi', pincode = '110031' WHERE name = 'VIPUL ENTERPRISES' AND address IS NULL;
UPDATE public.vendors SET address = E'168, Lok Vihar\nPitampura\nNew Delhi', pincode = '110034' WHERE name = 'PicknPack Solutions India Pvt Ltd' AND address IS NULL;
