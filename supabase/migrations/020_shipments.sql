-- 020_shipments.sql
--
-- Parcels the business is waiting on, one row per tracking number (AWB):
--   forward  a parcel to a customer that is not delivered yet
--   rto      a parcel coming back to origin (Velocity writes "RTO Initiated / In Transit / Delivered on ..."
--            in the Shopify order note and does not always tag the order)
--   return   a customer return on its way to the warehouse (Return Prime's reverse pickup)
--
-- Written only by the shipment-watch function (service role); signed-in users may read.
-- A row is kept after it closes (delivered, back at the warehouse, received) so the page can
-- show what was resolved; only rows that were ever pending are stored.
--
-- The page this feeds answers two questions:
--   escalate  a forward parcel past its promised delivery date (prepaid first)
--   claim     any parcel still not delivered 45 days after dispatch: a credit note can be requested

CREATE TABLE IF NOT EXISTS public.shipments (
  awb             text          PRIMARY KEY,
  kind            text          NOT NULL CHECK (kind IN ('forward', 'rto', 'return')),
  order_name      text          NOT NULL,
  order_id        bigint,
  request_number  text,                                   -- Return Prime request, for returns
  courier         text,
  tracking_url    text,
  payment_type    text          CHECK (payment_type IN ('prepaid', 'cod', 'partial')),
  order_total     numeric(12,2),
  cod_due         numeric(12,2),                          -- cash to collect on delivery
  city            text,
  pincode         text,
  dispatched_on   date          NOT NULL,                 -- IST date it left (a return: the day it was requested)
  edd             date,                                   -- delivery date promised in the order note
  rto_state       text          CHECK (rto_state IN ('initiated', 'in_transit', 'delivered')),
  rto_since       date,
  status          text          NOT NULL,                 -- in_transit, out_for_delivery, attempted, rto_in_transit, return_on_the_way, delivered, ...
  raw_status      text,
  last_event_at   timestamptz,                            -- latest tracking event
  attempts        integer       NOT NULL DEFAULT 0,
  state           text          NOT NULL CHECK (state IN ('pending', 'closed')),
  closed_on       date,
  late_days       integer       NOT NULL DEFAULT 0,       -- days past the promised date (forward parcels)
  pending_days    integer       NOT NULL DEFAULT 0,       -- days since dispatch
  escalation      text          CHECK (escalation IN ('now', 'consider')),
  claim_eligible  boolean       NOT NULL DEFAULT false,
  stuck           boolean       NOT NULL DEFAULT false,   -- no tracking update for several days
  note            text,
  first_seen_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipments_pending ON public.shipments (kind, dispatched_on) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS shipments_escalation ON public.shipments (escalation) WHERE escalation IS NOT NULL AND state = 'pending';
CREATE INDEX IF NOT EXISTS shipments_claim ON public.shipments (dispatched_on) WHERE claim_eligible AND state = 'pending';
CREATE INDEX IF NOT EXISTS shipments_order ON public.shipments (order_name);

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read" ON public.shipments FOR SELECT TO authenticated USING (true);

-- Thresholds (all in days) and the on/off switch for the schedule.
INSERT INTO public.app_settings (key, value) VALUES
  ('shipment_claim_days',            to_jsonb(45)),   -- not delivered after this long: request a credit note
  ('shipment_escalate_prepaid_days', to_jsonb(1)),    -- prepaid: escalate this many days after the promised date
  ('shipment_escalate_cod_days',     to_jsonb(2)),    -- COD / part-paid: consider escalating at this many days late
  ('shipment_default_sla_days',      to_jsonb(7)),    -- no promised date in the note: dispatch + this many days
  ('shipment_stuck_days',            to_jsonb(4)),    -- no tracking update for this long
  ('shipment_lookback_days',         to_jsonb(150)),  -- how far back to look for pending parcels
  ('shipment_watch_mode',            to_jsonb('off'::text))
ON CONFLICT (key) DO NOTHING;

-- Every 30 minutes; does nothing until shipment_watch_mode is "live".
SELECT cron.schedule('shipment-watch', '*/30 * * * *', $$
  SELECT net.http_post(
    url     := 'https://nexhqmdplnxqypjydslg.supabase.co/functions/v1/shipment-watch',
    body    := '{"action":"tick"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (SELECT value FROM public.private_secrets WHERE key = 'erp_stock_cron_key')),
    timeout_milliseconds := 170000
  )
$$);
