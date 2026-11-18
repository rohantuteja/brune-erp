-- 041_myntra_open_returns.sql
--
-- The list behind "Pieces with a return open" (Analytics → Myntra → Myntra returns). The returns job (migration 039) already reads
-- every Myntra order that has a return open, every 30 minutes; it now keeps what it sees: one row per return that is open in
-- Unicommerce and not received yet, wherever its parcel is (pickup arranged, RTO on its way back, back with us and about to be
-- received). A row goes when the return is received (by the job or by a person) or the order has no open piece any more.
--
-- opened_at and reason come from Unicommerce's oms/return/get, asked once per return (they never change):
-- opened_at is the day Myntra opened the return (Indian time stored as UTC), reason the customer's reason on a customer return.
--
-- Written only by the myntra-returns function (service role); admins may read.

CREATE TABLE IF NOT EXISTS public.myntra_open_returns (
  return_code        text         PRIMARY KEY,                    -- RPxxxx (customer return) or BRUNxxxxx (RTO)
  order_code         text         NOT NULL,                       -- Unicommerce sale order code (ledger_orders.channel_ref)
  kind               text         NOT NULL CHECK (kind IN ('rto', 'customer')),
  skus               text[]       NOT NULL DEFAULT '{}',
  tracking_status    text,                                        -- Myntra's tracking: CIR_COURIER_ASSIGNED, RTO_INITIATED, *_DELIVERED_TO_SELLER ...
  awb                text,
  courier            text,
  uc_status          text,                                        -- the return's status in Unicommerce
  opened_at          timestamptz,                                 -- when Myntra opened the return
  reason             text,                                        -- the customer's reason (customer returns)
  detail_fetched_at  timestamptz,                                 -- when opened_at / reason were read; null = not yet
  first_seen_at      timestamptz  NOT NULL DEFAULT now(),
  seen_at            timestamptz  NOT NULL DEFAULT now()          -- last run that saw it open
);

CREATE INDEX IF NOT EXISTS myntra_open_returns_order ON public.myntra_open_returns (order_code);

ALTER TABLE public.myntra_open_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin read" ON public.myntra_open_returns FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
