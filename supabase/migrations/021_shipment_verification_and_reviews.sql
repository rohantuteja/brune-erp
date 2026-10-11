-- 021_shipment_verification_and_reviews.sql
--
-- 1. What Velocity itself says about each parcel. Shopify's fulfilment status and Return Prime's
--    shipment status lag the courier (a first check of 133 "pending" parcels found 29 already
--    resolved: 20 cancelled and 4 delivered returns, 2 delivered forward parcels, 1 delivered RTO,
--    and 3 RTOs Velocity had marked lost), so the shipment-watch function now asks Velocity's
--    order-tracking API about every pending parcel and Velocity's answer decides the state.
--    Velocity's shipping-charges API is a per-parcel wallet ledger; a credit on it (other than the
--    COD reversal) means Velocity has refunded or compensated that parcel.
-- 2. What a person decided: a parcel marked resolved, or a ticket raised with Velocity (delivery
--    escalation or credit-note request, with its reference and a follow-up date). Kept in its own table so
--    a scan never overwrites it. Written only through shipment_review_set / shipment_review_clear
--    (permission-checked, logged), never by direct table writes.

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS velocity_status        text,          -- Velocity's own status, e.g. in_transit, ndr_raised, return_cancelled, lost
  ADD COLUMN IF NOT EXISTS velocity_checked_at    timestamptz,
  ADD COLUMN IF NOT EXISTS velocity_last_activity text,          -- latest tracking line: "Item OFD at BOM_WagleEstate"
  ADD COLUMN IF NOT EXISTS velocity_last_at       timestamptz,
  ADD COLUMN IF NOT EXISTS verified               boolean       NOT NULL DEFAULT false,   -- Velocity confirmed the state this scan
  ADD COLUMN IF NOT EXISTS outcome                text,          -- how a closed parcel ended: delivered, returned_to_us, cancelled
  ADD COLUMN IF NOT EXISTS attention              text,          -- why a person must look: ndr, pickup_failed, lost, unverified
  ADD COLUMN IF NOT EXISTS attention_reason       text,
  ADD COLUMN IF NOT EXISTS freight_debit          numeric(12,2), -- Velocity wallet: freight charged for this parcel (with GST)
  ADD COLUMN IF NOT EXISTS credit_received        numeric(12,2); -- Velocity wallet: credits other than the COD reversal (with GST)

CREATE INDEX IF NOT EXISTS shipments_attention ON public.shipments (attention) WHERE attention IS NOT NULL AND state = 'pending';

CREATE TABLE IF NOT EXISTS public.shipment_reviews (
  awb               text          PRIMARY KEY,
  status            text          NOT NULL CHECK (status IN ('resolved', 'ticket')),
  ticket_type       text          CHECK (ticket_type IN ('delivery', 'credit_note')),
  ticket_ref        text,
  follow_up_on      date,
  credit_note_ref   text,                                  -- the credit note Velocity issued, when resolved by one
  credit_note_amount numeric(12,2),
  note              text,
  reviewed_by       uuid,
  reviewed_by_name  text,
  reviewed_at       timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.shipment_review_log (
  id               bigserial     PRIMARY KEY,
  awb              text          NOT NULL,
  action           text          NOT NULL,                  -- resolved | ticket | reopened
  ticket_type      text,
  ticket_ref       text,
  follow_up_on     date,
  credit_note_ref  text,
  credit_note_amount numeric(12,2),
  note             text,
  by_name          text,
  at               timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shipment_review_log_awb ON public.shipment_review_log (awb, at DESC);

ALTER TABLE public.shipment_reviews    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_review_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.shipment_reviews    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated read" ON public.shipment_review_log FOR SELECT TO authenticated USING (true);

-- Who may mark parcels: admins, and anyone who can see Analytics.
CREATE OR REPLACE FUNCTION public.can_review_shipments() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
    OR EXISTS (SELECT 1 FROM user_permissions WHERE user_id = auth.uid() AND can_view_analytics)
  )
$$;

-- Mark one or many parcels (a ticket for 11 late parcels is one call).
CREATE OR REPLACE FUNCTION public.shipment_review_set(
  p_awbs text[], p_status text, p_ticket_type text DEFAULT NULL, p_ticket_ref text DEFAULT NULL,
  p_follow_up_on date DEFAULT NULL, p_note text DEFAULT NULL,
  p_credit_note_ref text DEFAULT NULL, p_credit_note_amount numeric DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_count integer;
BEGIN
  IF NOT public.can_review_shipments() THEN RAISE EXCEPTION 'not allowed'; END IF;
  IF p_status NOT IN ('resolved', 'ticket') THEN RAISE EXCEPTION 'status must be resolved or ticket'; END IF;
  IF p_status = 'ticket' AND p_ticket_type IS NULL THEN RAISE EXCEPTION 'a ticket needs its type'; END IF;
  IF coalesce(array_length(p_awbs, 1), 0) = 0 OR array_length(p_awbs, 1) > 500 THEN RAISE EXCEPTION 'between 1 and 500 parcels'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();

  WITH ok AS (SELECT awb FROM shipments WHERE awb = ANY (p_awbs)),
  up AS (
    INSERT INTO shipment_reviews (awb, status, ticket_type, ticket_ref, follow_up_on, credit_note_ref, credit_note_amount, note, reviewed_by, reviewed_by_name, reviewed_at)
    SELECT awb, p_status, p_ticket_type, NULLIF(trim(p_ticket_ref), ''), p_follow_up_on, NULLIF(trim(p_credit_note_ref), ''), p_credit_note_amount, NULLIF(trim(p_note), ''), auth.uid(), v_name, now() FROM ok
    ON CONFLICT (awb) DO UPDATE SET status = EXCLUDED.status, ticket_type = EXCLUDED.ticket_type, ticket_ref = EXCLUDED.ticket_ref,
      follow_up_on = EXCLUDED.follow_up_on, credit_note_ref = EXCLUDED.credit_note_ref, credit_note_amount = EXCLUDED.credit_note_amount,
      note = EXCLUDED.note, reviewed_by = EXCLUDED.reviewed_by, reviewed_by_name = EXCLUDED.reviewed_by_name, reviewed_at = EXCLUDED.reviewed_at
    RETURNING awb
  ), lg AS (
    INSERT INTO shipment_review_log (awb, action, ticket_type, ticket_ref, follow_up_on, credit_note_ref, credit_note_amount, note, by_name)
    SELECT awb, p_status, p_ticket_type, NULLIF(trim(p_ticket_ref), ''), p_follow_up_on, NULLIF(trim(p_credit_note_ref), ''), p_credit_note_amount, NULLIF(trim(p_note), ''), v_name FROM up
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $$;

-- Take a mark off again ("reopen").
CREATE OR REPLACE FUNCTION public.shipment_review_clear(p_awbs text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_name text; v_count integer;
BEGIN
  IF NOT public.can_review_shipments() THEN RAISE EXCEPTION 'not allowed'; END IF;
  SELECT coalesce(NULLIF(username, ''), name, 'user') INTO v_name FROM user_profiles WHERE id = auth.uid();
  WITH del AS (DELETE FROM shipment_reviews WHERE awb = ANY (p_awbs) RETURNING awb),
  lg AS (INSERT INTO shipment_review_log (awb, action, by_name) SELECT awb, 'reopened', v_name FROM del RETURNING 1)
  SELECT count(*) INTO v_count FROM del;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.can_review_shipments(), public.shipment_review_set(text[], text, text, text, date, text, text, numeric), public.shipment_review_clear(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_review_shipments(), public.shipment_review_set(text[], text, text, text, date, text, text, numeric), public.shipment_review_clear(text[]) TO authenticated;
