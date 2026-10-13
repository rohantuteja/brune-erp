-- 032_ledger_waiting_invoice.sql
--
-- An order is a sale only once Unicommerce has issued its invoice. Until then it sits in the ledger as 'waiting_invoice':
-- stored (so the Ledger page can list it, from Shopify and from Myntra alike) but with NO entries, nothing booked and
-- nothing exported. When the invoice exists the order is saved again as a normal sale, booked on the order date.
--
--   ledger_orders.status      gains 'waiting_invoice'
--   ledger_orders.facts       for such an order carries { waiting: { amount, paid, mode, shipped, ... } }
--   exception_type            'invoice_overdue' when it has waited too long, or was dispatched without an invoice
--   app_settings.uc_orders_from          orders placed from this instant on are in Unicommerce and wait for its invoice;
--                                        older orders are not (they keep Shopify's amounts). It is the instant of the opening
--                                        stock load (Shopify snapshot, 29 Sep 2026 17:07:59 UTC).
--   app_settings.invoice_wait_alert_days days an order may wait for its invoice before it is flagged (3)
--
-- A Myntra order has no invoice number yet, so a waiting one is named by its Unicommerce order code; when it is invoiced it
-- is saved under the invoice number and the function deletes the waiting row (only rows with this status).
-- ledger_save_orders needs no change: it stores whatever status it is given.

ALTER TABLE public.ledger_orders DROP CONSTRAINT IF EXISTS ledger_orders_status_check;
ALTER TABLE public.ledger_orders ADD CONSTRAINT ledger_orders_status_check
  CHECK (status IN ('complete', 'open', 'attention', 'not_a_sale', 'waiting_invoice'));

INSERT INTO public.app_settings (key, value) VALUES
  ('uc_orders_from', to_jsonb('2026-09-29T17:07:59Z'::text)),
  ('invoice_wait_alert_days', to_jsonb(3))
ON CONFLICT (key) DO NOTHING;
