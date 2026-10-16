-- 035_tally_ledgers.sql
--
-- The ledgers that already exist in the owner's Tally, so Analytics → Bills never asks him to type a ledger name: it offers the ledgers
-- that are really there, and says when a name would create a new one.
--
--   tally_ledgers  every LEDGER (not group) in the trial balance of 1-Apr-26 to 30-Sep-26 that he exported, with the group directly above
--                  it (under) and its primary group (section). role says what the Bills page offers it for:
--                    party    a supplier / customer ledger (Sundry Creditors, Sundry Debtors): a vendor's own ledger
--                    expense  a Direct Expenses / Indirect Expenses / Purchase Accounts ledger: where an expense vendor's invoices are booked
--                    other    capital, assets, taxes, banks, the state-wise sales ledgers, ...: never offered
--                  status: in_tally is in the trial balance; will_rename and will_create are the changes he and his accountant agreed on
--                  (tally-changes-needed.xlsx, 14 Oct 2026): the ERP already uses the NEW names, Tally gets them before the first import.
--   vendors        expense_ledger now points at a real Tally ledger (it pointed at a bank-matching bucket, a shorter list of the same names).
--                  ledger_new says the vendor's own ledger is not in Tally yet and is to be created by the export.
--
-- Refreshing it later = loading a newer trial balance; the file is the source, nothing here is typed by hand.

CREATE TABLE IF NOT EXISTS public.tally_ledgers (
  name         text PRIMARY KEY,
  under        text NOT NULL,
  section      text NOT NULL,
  role         text NOT NULL CHECK (role IN ('party', 'expense', 'other')),
  status       text NOT NULL DEFAULT 'in_tally' CHECK (status IN ('in_tally', 'will_rename', 'will_create')),
  renamed_from text,
  as_of        date NOT NULL DEFAULT DATE '2026-09-30'
);
ALTER TABLE public.tally_ledgers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.tally_ledgers;
CREATE POLICY "admin read" ON public.tally_ledgers FOR SELECT TO authenticated USING (public.finance_admin());

-- The trial balance of 30 Sep 2026 (198 ledgers).
INSERT INTO public.tally_ledgers (name, under, section, role) VALUES
  ('Share Capital Adrija Halder', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Ananta Bizcon LLP', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Dipakkumar G Mehta & Bhanu Dipak Meht', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('SHARE CAPITAL FIRST FOUNDER INVESTMENT TRUST', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Kabir Kulkarni', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Ketan Kishor Rathi', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Rohan Tuteja', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Shavdia Ventures1 LLP', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Upside Down', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Urja PUli Sheroff', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Viswanath Ramachandran', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Share Capital Yash Bipin Kotak', 'Issued and Subscribed Capital', 'Capital Account', 'other'),
  ('Reserve and Surplus', 'Capital Account', 'Capital Account', 'other'),
  ('SHARE PREMIUM ACCOUNT', 'Capital Account', 'Capital Account', 'other'),
  ('Sharbari Purkayastha (CN)', 'Unsecured Loans From Directors', 'Loans (Liability)', 'other'),
  ('CGST Input UP', 'GST', 'Current Liabilities', 'other'),
  ('CGST OUTPUT DELHI', 'GST', 'Current Liabilities', 'other'),
  ('CGST Output UP', 'GST', 'Current Liabilities', 'other'),
  ('IGST Input  UP', 'GST', 'Current Liabilities', 'other'),
  ('IGST OUTPUT DELHI', 'GST', 'Current Liabilities', 'other'),
  ('IGST OUTPUT UP', 'GST', 'Current Liabilities', 'other'),
  ('IGST RCM', 'GST', 'Current Liabilities', 'other'),
  ('SGST Input UP', 'GST', 'Current Liabilities', 'other'),
  ('SGST OUTPUT DELHI', 'GST', 'Current Liabilities', 'other'),
  ('SGST Output UP', 'GST', 'Current Liabilities', 'other'),
  ('Audit Fee Payable', 'Provisions', 'Current Liabilities', 'other'),
  ('Rent Payable', 'Provisions', 'Current Liabilities', 'other'),
  ('Salary Payable', 'Provisions', 'Current Liabilities', 'other'),
  ('Rohan (Director Personal Credit Card)', 'Credit Card for Payment', 'Current Liabilities', 'other'),
  ('Rohan HDFC Add on CC', 'Credit Card for Payment', 'Current Liabilities', 'other'),
  ('Aggarwal Traders', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Bathla Teletech Private Limited', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Bitpro Technocraft Llp', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Chandra Fashion', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Chandrakanta Exports', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Commodum Groceries Private Limited', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Facebook India Online Services Private Limited', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Flipkart India Pvt Ltd', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Flipkart Internet Private Limited Banglore', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Gautam Roadways', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Gokwik Commerce Solutions Private Limited', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Khushi  Fabrics', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('K J M & ASSOCIATES', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Meera Handicrafts', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Meesha Fabrics Private Limited', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('M/s Bharti Airtel Ltd  UP', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('M/s Nityam Garments Machine', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Poonam Jain', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Prayosha Food Services Private Limited', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Shopify Commerce Signapore Pte. Ltd.', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Shree Vinayak Fab', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('STORE CREDIT BY SHOPIFY', 'Sundry Creditors', 'Current Liabilities', 'other'),
  ('The Fabria', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Vishal Sewtech', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Vool Fashion', 'Sundry Creditors', 'Current Liabilities', 'party'),
  ('Director Salary Payable- Rohan Tuteja', 'Sundry Creditors', 'Current Liabilities', 'other'),
  ('Directory Salary Payable- Adrija Halder', 'Sundry Creditors', 'Current Liabilities', 'other'),
  ('Provision for Expenses', 'Current Liabilities', 'Current Liabilities', 'other'),
  ('CP Plus Wired 8 Channel HD DVR', 'Electricity Fitting', 'Fixed Assets', 'other'),
  ('Water Coler', 'Electricity Fitting', 'Fixed Assets', 'other'),
  ('APPLE I PAD', 'SHOP EXPENSES F&F', 'Fixed Assets', 'other'),
  ('DUMP FIN', 'SHOP EXPENSES F&F', 'Fixed Assets', 'other'),
  ('HANGERS', 'SHOP EXPENSES F&F', 'Fixed Assets', 'other'),
  ('STEAMER', 'SHOP EXPENSES F&F', 'Fixed Assets', 'other'),
  ('BARCODE PRINTER', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('BARCODE SCANNER', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Boiler for Steam Press', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('CLOTH RACK METAL', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Cutting Table', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('CUTTING TOOLS', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Depreciation on Fixed Assets', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('DESERT AIR COOLER', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('DIGITAL LIGHTS FOR SHOOTING', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Furniture & Fixture  GST', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('INVERTER WITH BATTERY', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('I-Phone', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('I-Phone 14', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Laptop', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('MICROVAVE FOR OFFICE', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('MOBILE PURCHASE', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Printer', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('SEWING MACHINE', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Sewing Machine GST', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('SINGER SEWING MACHINE', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Software (Androip & Apple App)', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('Sticker Machine', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('TABLE FAN BAJAJ', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('WIREMESH CAGE CONTAINER', 'Fixed Assets', 'Fixed Assets', 'other'),
  ('FDR (022510011444)', 'Investments', 'Investments', 'other'),
  ('Opening Stock', 'Current Assets', 'Current Assets', 'other'),
  ('Security Deposit LAV KUSH Sec 63 Noida', 'Deposits (Asset)', 'Current Assets', 'other'),
  ('SECURITY DEPOSIT-SARITADAS DIR RESIDENCE', 'Deposits (Asset)', 'Current Assets', 'other'),
  ('BIGFOOT RETAIL SOLUTIONS PVT LTD', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Easebuzz Private Limited', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Goexcelsior Private Limited', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Google India Pvt Ltd', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Mittal Textile', 'Sundry Debtors', 'Current Assets', 'party'),
  ('online sale (Andaman And Nicobar Islands)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Andhra Pradesh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Arunachal Pradesh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Assam)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Bihar)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Chandigarh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Chhattisgarh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Dadra And Nagar Haveli)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('Online Sale (Delhi)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('Online Sale (Goa)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Gujarat)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Haryana)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Himachal Pradesh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Jammu And Kashmir)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Jharkhand)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Karnataka)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Kerala)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Madhya Pradesh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Maharashtra)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Manipur)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale  (Meghalaya)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Mizoram)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Nagaland)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Odisha)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Puducherry)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Punjab)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Rajasthan)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Sikkim)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Tamil Nadu)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Telangana)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Tripura)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Uttarakhand)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (Uttar Pradesh)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('online sale (West Bengal)', 'Sundry Debtors', 'Current Assets', 'other'),
  ('Outstanding COD Sales White Wizzard', 'Sundry Debtors', 'Current Assets', 'other'),
  ('Razorpay Payment Private Limited', 'Sundry Debtors', 'Current Assets', 'party'),
  ('RETHOUGHT TECHNOLOGIES PVT LTD', 'Sundry Debtors', 'Current Assets', 'other'),
  ('RETHOUGHT TECHNOLOGIES PVT LTD GHAZIABAD', 'Sundry Debtors', 'Current Assets', 'other'),
  ('Shipfast-Prepaid Recharge Account', 'Sundry Debtors', 'Current Assets', 'party'),
  ('SMARTSHIFT LOGISTICS SOLUTIONS PVT LTD', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Unicommerce Esolutions Limited', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Wakum India', 'Sundry Debtors', 'Current Assets', 'party'),
  ('White Wizard Technologies Private Limited', 'Sundry Debtors', 'Current Assets', 'party'),
  ('Cash', 'Cash-in-Hand', 'Current Assets', 'other'),
  ('CASH AT POS DELHI', 'Cash-in-Hand', 'Current Assets', 'other'),
  ('ICICI Bank', 'Bank Accounts', 'Current Assets', 'other'),
  ('Gst Cash Ledger', 'Gst Portal Balance', 'Current Assets', 'other'),
  ('GST Credit Ledger Delhi', 'Gst Portal Balance', 'Current Assets', 'other'),
  ('GST Credit Ledger UP', 'Gst Portal Balance', 'Current Assets', 'other'),
  ('INPUT NOT CLAIMED FOR INV NOT IN 2A', 'Current Assets', 'Current Assets', 'other'),
  ('Tax Deducted at Source 25-26', 'Current Assets', 'Current Assets', 'other'),
  ('Suspense', 'Suspense A/c', 'Suspense A/c', 'other'),
  ('Fixed Asset Sales', 'Sales Accounts', 'Sales Accounts', 'other'),
  ('GST SALES', 'Sales Accounts', 'Sales Accounts', 'other'),
  ('GST SALES RETURN', 'Sales Accounts', 'Sales Accounts', 'other'),
  ('Shipping Charges 5%', 'Sales Accounts', 'Sales Accounts', 'other'),
  ('PURCHASE FIXED ASSETS', 'Purchase Accounts', 'Purchase Accounts', 'expense'),
  ('Purchase Raw Material', 'Purchase Accounts', 'Purchase Accounts', 'expense'),
  ('PURCHASES INTERSTATE', 'Purchase Accounts', 'Purchase Accounts', 'expense'),
  ('Domain Expenses Non GST', 'Marketing Expenses', 'Direct Expenses', 'expense'),
  ('Marketing Expenses', 'Marketing Expenses', 'Direct Expenses', 'expense'),
  ('Shipping Expenses @ 18%', 'Shipping Expenses', 'Direct Expenses', 'expense'),
  ('Fabric and Consumbale', 'Direct Expenses', 'Direct Expenses', 'expense'),
  ('Marketing Expenses Provision', 'Direct Expenses', 'Direct Expenses', 'expense'),
  ('Packaging Expenses', 'Direct Expenses', 'Direct Expenses', 'expense'),
  ('DISCOUNT RECEIVED', 'Indirect Incomes', 'Indirect Incomes', 'other'),
  ('Interest on FDRs', 'Indirect Incomes', 'Indirect Incomes', 'other'),
  ('MISC INCOME', 'Indirect Incomes', 'Indirect Incomes', 'other'),
  ('Director Salary', 'Employee Benifit Expenses', 'Indirect Expenses', 'expense'),
  ('Salary Expenses', 'Employee Benifit Expenses', 'Indirect Expenses', 'expense'),
  ('Staff Welfare Expenses', 'Employee Benifit Expenses', 'Indirect Expenses', 'expense'),
  ('Bank Charges', 'FINANCE COST', 'Indirect Expenses', 'expense'),
  ('Payment Gateway Charges Non Gst', 'PAYMENT GATEWAY CHARGES', 'Indirect Expenses', 'expense'),
  ('Payment Gateway Expenses', 'PAYMENT GATEWAY CHARGES', 'Indirect Expenses', 'expense'),
  ('Rent - Director Resident', 'Rent Expenses', 'Indirect Expenses', 'expense'),
  ('Apps Charges', 'Software Expenses', 'Indirect Expenses', 'expense'),
  ('Software Expenses', 'Software Expenses', 'Indirect Expenses', 'expense'),
  ('Software Expenses @ 18%', 'Software Expenses', 'Indirect Expenses', 'expense'),
  ('Subscription Charges', 'Software Expenses', 'Indirect Expenses', 'expense'),
  ('Transaction Fees', 'Software Expenses', 'Indirect Expenses', 'expense'),
  ('Car Fuel Expenses', 'Travelling Expenses', 'Indirect Expenses', 'expense'),
  ('Travelling Expenses', 'Travelling Expenses', 'Indirect Expenses', 'expense'),
  ('Bank Charges GST', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('CAR SERVICE EXPENSES', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Cleaning Expenses Factory', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Electricity Expenses', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('FREIGHT GST', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('FREIGHT INWARD NON GST', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('FREIGHT RCM 5%', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('INTERNET EXPENSES Non Gst', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Labour Charges', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('MAINTENANCE-DIR RESIDENCE', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('MARKETING/STATIONERY/MISCNON GST', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Miscelleneous Expenses', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('RENT GHAZIABAD', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Rent Sector 63 Noida', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Repair & Maintenance', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('ROUND OFF', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Short and Excess', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Telephone and Internet Expenses GST', 'Indirect Expenses', 'Indirect Expenses', 'expense'),
  ('Telephone & Internet Expenses', 'Indirect Expenses', 'Indirect Expenses', 'expense')
ON CONFLICT (name) DO UPDATE SET under = EXCLUDED.under, section = EXCLUDED.section, role = EXCLUDED.role;

-- Renames agreed with the accountant: the ERP uses the new names. The old name leaves the list (it will not exist in Tally any more).
DELETE FROM public.tally_ledgers WHERE name IN ('Shipfast-Prepaid Recharge Account', 'Outstanding COD Sales White Wizzard', 'Directory Salary Payable- Adrija Halder');
INSERT INTO public.tally_ledgers (name, under, section, role, status, renamed_from) VALUES
  ('Velocity Prepaid Recharge Account',      'Sundry Debtors',  'Current Assets',      'party', 'will_rename', 'Shipfast-Prepaid Recharge Account'),
  ('COD receivable (Velocity)',              'Sundry Debtors',  'Current Assets',      'other', 'will_rename', 'Outstanding COD Sales White Wizzard'),
  ('Director Salary Payable- Adrija Halder', 'Sundry Creditors', 'Current Liabilities', 'other', 'will_rename', 'Directory Salary Payable- Adrija Halder')
ON CONFLICT (name) DO NOTHING;

-- Ledgers still to be created in Tally (the same file).
INSERT INTO public.tally_ledgers (name, under, section, role, status) VALUES
  ('Customer (order control)',          'Sundry Debtors',    'Current Assets',    'other',   'will_create'),
  ('Myntra receivable (order control)', 'Sundry Debtors',    'Current Assets',    'other',   'will_create'),
  ('Goodwill credits',                  'Indirect Expenses', 'Indirect Expenses', 'expense', 'will_create'),
  ('Myntra Return Fees',                'Indirect Expenses', 'Indirect Expenses', 'expense', 'will_create'),
  ('Tax Deducted at source 26-27',      'Current Assets',    'Current Assets',    'other',   'will_create'),
  ('Tax Collected at source 26-27',     'Current Assets',    'Current Assets',    'other',   'will_create')
ON CONFLICT (name) DO NOTHING;

-- ── Vendors ──────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS ledger_new boolean NOT NULL DEFAULT false;

-- expense_ledger: from "a bank-matching bucket" to "a ledger in Tally" (every value in use is one: checked below by the new constraint).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.vendors'::regclass AND contype = 'f' AND confrelid = 'public.finance_buckets'::regclass LOOP
    EXECUTE format('ALTER TABLE public.vendors DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.vendors DROP CONSTRAINT IF EXISTS vendors_expense_ledger_tally;
ALTER TABLE public.vendors ADD CONSTRAINT vendors_expense_ledger_tally FOREIGN KEY (expense_ledger) REFERENCES public.tally_ledgers(name);

-- A vendor whose own ledger is not in Tally (set up before this list existed) is one the export is to create.
UPDATE public.vendors SET ledger_new = true
WHERE ledger_new = false AND tally_ledger_name NOT IN (SELECT name FROM public.tally_ledgers);
