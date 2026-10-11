-- 018_ledger_adjustments.sql
--
-- Decisions a person has made about an order that the ledger cannot work out from the other
-- systems. Today there is one kind: a goodwill credit, i.e. the customer was deliberately given
-- more store credit than they paid (a return refund rounded up, or a gesture). The ledger books
-- the extra to the "Goodwill credits" account instead of flagging the order, but only when the
-- amount here equals the difference it found.
--
-- Written by hand (SQL) by whoever approved it; signed-in users can read.

CREATE TABLE IF NOT EXISTS public.ledger_adjustments (
  order_name   text          NOT NULL,                 -- Shopify order number
  kind         text          NOT NULL CHECK (kind IN ('goodwill_credit')),
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  reason       text          NOT NULL,
  approved_by  text          NOT NULL,                 -- who decided, and where
  created_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (order_name, kind)
);

ALTER TABLE public.ledger_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.ledger_adjustments FOR SELECT TO authenticated USING (true);
