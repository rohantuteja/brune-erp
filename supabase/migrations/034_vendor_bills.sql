-- 034_vendor_bills.sql
--
-- Analytics → Bills (slice 2 of the supplier-invoice work, docs/supplier-invoices.md): every vendor's invoice PDF is uploaded, read
-- by _shared/invoice-reader.ts, checked, and kept with its original. Nothing here posts to Tally.
--
--   vendors          who sends invoices, and HOW each is booked, set once at its first invoice:
--                      expense   a GST EXPENSES voucher: Dr the expense ledger + input GST, Cr the vendor (Meta, Velocity, GoKwik, Airtel ...)
--                      purchase  a Purchase UP voucher with stock items (fabric)
--                      tie_out   never posted, only compared with something else (no vendor uses it yet)
--                    auto_accept turns on after the owner has confirmed the first bill of that vendor.
--   vendor_invoices  the existing table (Meta and Velocity rows are in it, the bank matching and the Velocity page read it) gains what
--                    a bill needs: the vendor, goods or service, status, the checks, the original file, who confirmed it and what they edited.
--   vendor-bills     a private storage bucket for the original PDFs: nobody reads it from a browser, the Bills function hands out short links.

-- ── Vendors ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vendors (
  id                bigserial   PRIMARY KEY,
  name              text        NOT NULL UNIQUE,                 -- as the ERP shows it ("Meta")
  tally_ledger_name text        NOT NULL,                        -- the vendor's own ledger in Tally: the party, created there if missing
  gstin             text,
  pan               text,
  state_code        text,
  booking           text        NOT NULL DEFAULT 'expense' CHECK (booking IN ('expense', 'purchase', 'tie_out')),
  expense_ledger    text        REFERENCES public.finance_buckets(name),      -- a bucket is a Tally ledger name
  auto_accept       boolean     NOT NULL DEFAULT false,
  active            boolean     NOT NULL DEFAULT true,
  note              text,
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendors_expense_needs_a_ledger CHECK (booking <> 'expense' OR expense_ledger IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS vendors_gstin ON public.vendors (gstin) WHERE gstin IS NOT NULL;
ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.vendors;
CREATE POLICY "admin read" ON public.vendors FOR SELECT TO authenticated USING (public.finance_admin());

-- The vendors whose booking the owner and the accountant have already settled (the accountant's September vouchers; the owner's
-- corrections of 15 Oct 2026: GoKwik's COD and PP COD invoices are payment gateway charges, Goexcelsior is software, not marketing).
INSERT INTO public.vendors (name, tally_ledger_name, gstin, pan, state_code, booking, expense_ledger, note) VALUES
  ('Meta',        'Facebook India Online Services Private Limited', '06AABCF5150G1ZZ', 'AABCF5150G', '06', 'expense', 'Marketing Expenses',                  'Advertising. 2% TDS applies from October (accountant).'),
  ('Velocity',    'Velocity Prepaid Recharge Account',              '29AACCW3721H1ZA', 'AACCW3721H', '29', 'expense', 'Shipping Expenses @ 18%',              'The monthly invoice is the expense; the wallet top-ups were the advance.'),
  ('Easebuzz',    'Easebuzz Private Limited',                       '27AAVCS2699M1Z5', 'AAVCS2699M', '27', 'expense', 'Payment Gateway Expenses',              'Posted like every other vendor invoice; the fee and GST calculated from GoKwik''s settlement report are the tie-out (September: both ₹12,618.85).'),
  ('GoKwik',      'Gokwik Commerce Solutions Private Limited',      '06AAICG6853C1ZN', 'AAICG6853C', '06', 'expense', 'Payment Gateway Expenses',              'Commission on COD and PP COD: payment gateway charges, not marketing. GoKwik may deduct it from the Easebuzz settlement.'),
  ('Goexcelsior', 'Goexcelsior Private Limited',                    NULL,              NULL,         NULL, 'expense', 'Software Expenses @ 18%',              'KwikChat: software, not marketing. Its own ledger is the creditor, Software Expenses @ 18% the expense.'),
  ('Google',      'Google India Pvt Ltd',                           '06AACCG0527D1Z8', 'AACCG0527D', '06', 'expense', 'Software Expenses @ 18%',              'Workspace. The invoice prints our PAN and state code instead of the GSTIN; the GST is claimed from GSTR-2B.'),
  ('Airtel',      'M/s Bharti Airtel Ltd  UP',                      '09AAACB2894G1ZL', 'AAACB2894G', '09', 'expense', 'Telephone and Internet Expenses GST',  'Wi-Fi. A supplier in Uttar Pradesh: CGST + SGST.')
ON CONFLICT (name) DO NOTHING;

-- ── What a bill is ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.vendor_invoices
  ADD COLUMN IF NOT EXISTS vendor_id          bigint      REFERENCES public.vendors(id),
  ADD COLUMN IF NOT EXISTS kind               text        CHECK (kind IN ('goods', 'service')),
  ADD COLUMN IF NOT EXISTS status             text        NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'review', 'void')),
  ADD COLUMN IF NOT EXISTS opening            boolean     NOT NULL DEFAULT false,      -- dated before the books start: matched, never exported
  ADD COLUMN IF NOT EXISTS tax_rate           numeric(5,2),
  ADD COLUMN IF NOT EXISTS round_off          numeric(14,2),
  ADD COLUMN IF NOT EXISTS place_of_supply    text,
  ADD COLUMN IF NOT EXISTS irn                text,
  ADD COLUMN IF NOT EXISTS checks             jsonb,
  ADD COLUMN IF NOT EXISTS reader             text,                                    -- which version of the reader read it
  ADD COLUMN IF NOT EXISTS file_path          text,                                    -- the original, in the vendor-bills bucket
  ADD COLUMN IF NOT EXISTS file_hash          text,
  ADD COLUMN IF NOT EXISTS file_name          text,
  ADD COLUMN IF NOT EXISTS confirmed_by       uuid,
  ADD COLUMN IF NOT EXISTS confirmed_by_name  text,
  ADD COLUMN IF NOT EXISTS confirmed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS edited             jsonb,                                   -- what a person changed: { field: { read, now } }
  ADD COLUMN IF NOT EXISTS accepted_anyway    text,                                    -- why a bill with a failed check was accepted
  ADD COLUMN IF NOT EXISTS void_reason        text,
  ADD COLUMN IF NOT EXISTS voided_at          timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by_name     text;
CREATE INDEX IF NOT EXISTS vendor_invoices_status    ON public.vendor_invoices (status);
CREATE INDEX IF NOT EXISTS vendor_invoices_file_hash ON public.vendor_invoices (file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS vendor_invoices_vendor_id ON public.vendor_invoices (vendor_id);

-- The invoices already stored (four from Meta, one from Velocity) belong to their vendors; they are services, no PDF is attached yet
-- (the Bills page lets the owner attach each one), and the ones dated before the books start are opening bills.
UPDATE public.vendor_invoices i SET vendor_id = v.id, kind = 'service',
  opening = i.invoice_date < coalesce((SELECT (value #>> '{}')::date FROM public.app_settings WHERE key = 'accounting_start_date'), DATE '2026-10-01')
FROM public.vendors v WHERE v.name = i.vendor AND i.vendor_id IS NULL;

-- ── The originals ────────────────────────────────────────────────────────────────────────────
-- Private, PDFs only, 5 MB. No policy is created on storage.objects, so no browser can read or write it: the Bills function (service
-- role) stores the file and hands the admin a link that expires in minutes.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('vendor-bills', 'vendor-bills', false, 5242880, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- ── Our own GSTIN: what an invoice must be billed to ──────────────────────────────────────────
INSERT INTO public.app_settings (key, value) VALUES ('company_gstin', '"09AALCR1014K1ZB"')
ON CONFLICT (key) DO NOTHING;
