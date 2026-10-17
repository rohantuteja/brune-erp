-- 036_gateway_trueups.sql
--
-- The monthly Easebuzz invoice against the gateway fees the order ledger booked at each GoKwik payout (docs/supplier-invoices.md).
-- The order ledger is NOT changed: it keeps booking the fee and the GST on it at every payout. When the invoice is in, a person confirms
-- the tie-out on the Bills page and the difference, if any, is kept here as ONE monthly adjustment voucher, so that the expense and the
-- input GST end equal to the invoice (and therefore to GSTR-2B). The Tally export reads the confirmed, un-voided rows (not built yet).
--
--   invoice_id      the vendor_invoices row (Easebuzz's bill); one live adjustment per invoice
--   voucher_date    the invoice date: the month the input GST is claimed in
--   invoice/report/booked   the figures the tie-out was made from, kept as they were that day
--   lines           the voucher: [{ account, debit, credit }], empty when the invoice agreed
--   status          agrees (nothing to post) | adjust (a rounding-size difference) | investigate (confirmed with a reason)
--   voided_*        an adjustment confirmed by mistake is voided, never deleted

CREATE TABLE IF NOT EXISTS public.gateway_trueups (
  id                bigserial   PRIMARY KEY,
  invoice_id        bigint      NOT NULL REFERENCES public.vendor_invoices(id),
  period_from       date        NOT NULL,
  period_to         date        NOT NULL,
  voucher_date      date        NOT NULL,
  invoice           jsonb       NOT NULL,
  report            jsonb       NOT NULL,
  booked            jsonb       NOT NULL,
  expense_diff      numeric(14,2) NOT NULL,
  gst_diff          numeric(14,2) NOT NULL,
  gateway_diff      numeric(14,2) NOT NULL,
  lines             jsonb       NOT NULL DEFAULT '[]',
  status            text        NOT NULL CHECK (status IN ('agrees', 'adjust', 'investigate')),
  reason            text,
  confirmed_by      uuid,
  confirmed_by_name text,
  confirmed_at      timestamptz NOT NULL DEFAULT now(),
  voided_at         timestamptz,
  voided_by_name    text,
  void_reason       text
);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_trueups_one_live ON public.gateway_trueups (invoice_id) WHERE voided_at IS NULL;
ALTER TABLE public.gateway_trueups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin read" ON public.gateway_trueups;
CREATE POLICY "admin read" ON public.gateway_trueups FOR SELECT TO authenticated USING (public.finance_admin());
