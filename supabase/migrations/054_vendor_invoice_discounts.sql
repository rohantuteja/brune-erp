-- 054_vendor_invoice_discounts.sql
--
-- A supplier who accepted a little less than its invoice (19 Nov 2026: Shree Vinayak quoted ₹89,019, was paid that in two parts, then invoiced ₹89,061) is settled by
-- a DISCOUNT: the invoice is booked in full, as the supplier issued it (the input GST is the one on the invoice), and one small journal closes what is left of the bill:
--   Dr the supplier (against the invoice) / Cr DISCOUNT RECEIVED.
-- One row per invoice. The Accounting page reads it; nothing else changes. Additive.

CREATE TABLE IF NOT EXISTS public.vendor_invoice_discounts (
  invoice_id bigint      PRIMARY KEY REFERENCES public.vendor_invoices(id),
  amount     numeric     NOT NULL CHECK (amount > 0),
  ledger     text        NOT NULL DEFAULT 'DISCOUNT RECEIVED',
  reason     text,
  by_name    text,
  at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.vendor_invoice_discounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.vendor_invoice_discounts;
CREATE POLICY "admin read" ON public.vendor_invoice_discounts FOR SELECT TO authenticated USING (public.finance_admin());

CREATE OR REPLACE FUNCTION public.vendor_invoice_discount_set(p_invoice_id bigint, p_amount numeric, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total numeric; v_name text;
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT total INTO v_total FROM vendor_invoices WHERE id = p_invoice_id;
  IF v_total IS NULL THEN RAISE EXCEPTION 'unknown invoice'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount >= v_total THEN RAISE EXCEPTION 'a discount must be more than nil and less than the invoice'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  INSERT INTO vendor_invoice_discounts (invoice_id, amount, reason, by_name) VALUES (p_invoice_id, round(p_amount, 2), p_reason, v_name)
  ON CONFLICT (invoice_id) DO UPDATE SET amount = EXCLUDED.amount, reason = EXCLUDED.reason, by_name = EXCLUDED.by_name, at = now();
END $$;

CREATE OR REPLACE FUNCTION public.vendor_invoice_discount_clear(p_invoice_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.finance_admin() THEN RAISE EXCEPTION 'not allowed'; END IF;
  DELETE FROM vendor_invoice_discounts WHERE invoice_id = p_invoice_id;
END $$;

REVOKE ALL ON FUNCTION public.vendor_invoice_discount_set(bigint, numeric, text), public.vendor_invoice_discount_clear(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_invoice_discount_set(bigint, numeric, text), public.vendor_invoice_discount_clear(bigint) TO authenticated;
