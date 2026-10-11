# Shipments: parcels the business is waiting on

Analytics → Shipments answers two questions about Velocity parcels:

1. **Escalate.** A forward parcel is past its promised delivery date: raise a ticket with Velocity before the customer complains. Prepaid first (the customer has paid and always complains), COD and part-paid parcels still get a view.
2. **Credit note.** Any parcel (forward, RTO or customer return) still not delivered 45 days after dispatch: only then can a credit note be requested from Velocity.

## Where the data comes from

| Shipment | Source | What it gives |
|---|---|---|
| Forward | Shopify fulfilment (Velocity writes its tracking there) | `displayStatus` (IN_TRANSIT, OUT_FOR_DELIVERY, ATTEMPTED_DELIVERY, DELIVERED ...), `deliveredAt`, latest events, AWB, courier |
| Forward | Shopify order note | `EDD: 2026-10-12 09:00:00 +0530`, the date Velocity promised |
| RTO | Shopify order note | `RTO Initiated on <ts>`, `RTO In Transit on <ts>`, `RTO Delivered on <ts>` (IST). The latest state wins. |
| Customer return | Return Prime request | reverse-pickup AWB, `shipment_status`, `tracking_updated_at` |

**Velocity does not reliably tag RTO orders.** Thirteen in-progress RTOs had no `rto_initiated` tag at the first scan; the note is the source of truth. A tag is still honoured when it is the only sign. (No `RTO Delivered` note was ever found without the `rto_delivered` tag, so the existing RTO flow in `shopify-order-webhook` is not affected.)

Parcels whose fulfilment is only `FULFILLED` / `MARKED_AS_FULFILLED` were typed in by hand for a courier Shopify cannot follow (old DTDC orders): nothing can be said about them, so they are closed as `untracked` and counted in the scan summary (`untracked_not_followed`). A cancelled or voided fulfilment is `cancelled`.

## Rules (`supabase/functions/_shared/shipments.ts`, tested in `shipments.test.ts`)

All thresholds are `app_settings` rows (days), editable without a deploy:

| Key | Default | Meaning |
|---|---|---|
| `shipment_claim_days` | 45 | pending this long since dispatch → credit note can be requested |
| `shipment_escalate_prepaid_days` | 1 | prepaid: escalate NOW when this many days past the promised date |
| `shipment_escalate_cod_days` | 2 | COD / part-paid: CONSIDER escalating at this many days late |
| `shipment_default_sla_days` | 7 | no EDD in the note → promised date = dispatch + this |
| `shipment_stuck_days` | 4 | no tracking event for this long = stuck (prepaid and stuck is escalated even before its date) |
| `shipment_lookback_days` | 150 | how far back the scan looks for pending parcels |
| `shipment_watch_mode` | `off` → `live` | gates the schedule |

- **A re-fulfilled order keeps the first booking's note.** Order 37800's first AWB (xpressbees) was cancelled on 5 Oct and a new one (shadowfax) booked on 9 Oct, but the note still said `EDD: 2026-10-08`. A promise dated before the parcel left is ignored (stored as not given) and the dispatch + `shipment_default_sla_days` fallback applies.
- Days pending run from dispatch (the fulfilment date). A forward parcel and its RTO share one AWB, so the clock does not restart when the RTO begins. For a customer return the clock starts when the request was made. **Assumption to confirm with Velocity:** they may count the 45 days differently (e.g. from the pickup scan).
- Payment type: `prepaid`, `cod`, or `partial` (an advance or store credit plus COD). For COD and part-paid parcels the screen shows how much cash is to be collected.
- Return Prime's flags (`approved`, `archived`, `rejected`, `received`) are objects, `{ status: boolean, ... }`. `archived` does NOT mean closed (it is set once the refund is paid while the parcel may still be travelling); a return is finished when received, rejected, or its shipment status says so.

## The function and the table

`shipment-watch` (cron key or admin JWT) with actions `scan` (`{dry?}`), `tick` (what the schedule calls; does nothing unless the mode is `live`) and `status`. A scan reads Shopify in pages of 25 orders (`created_at` within the lookback, fulfilled or partial, not delivered), re-reads any previously pending order that no longer matches the search (so it can be closed), reads every Return Prime request, and upserts `public.shipments` (migration 020; one row per AWB; rows are kept after they close). The result summary, including anomaly counts (RTO note without tag, tag without note), is stored in `app_settings.shipment_watch_last_run`. Cron `shipment-watch` runs every 30 minutes.

The screen reads `shipments` directly (RLS: signed-in users read). Views `?sview=` `escalate | claim | rto | return | all`, payment filter `?spay=`, search `?sq=`. "Copy AWBs" and "Copy for a ticket" (tab-separated: order, AWB, courier, city, dispatched, promised, status) put the list on the clipboard for a Velocity ticket.

## First reading, 11 Oct 2026

133 pending parcels: 63 forward, 20 RTO, 50 customer returns. Escalate now: 10 prepaid forward parcels, all truly past their promised date (two are months old: 33966 at 135 days and 35868 at 75 days, both still showing "out for delivery"). Consider: 5 COD / part-paid. Credit note eligible (45+ days): 25 (2 forward, 4 RTO, 19 returns). Three old orders are untracked.

## The ledger and RTOs in progress

`order-facts.ts` reads the same note: a note that says `RTO Initiated` or `RTO In Transit` (or the tag) with a sale still owed and no delivery gives the ledger a new open stage, `rto_on_the_way` ("returning to origin; the sale is reversed when the parcel is back"), instead of showing the order as a COD parcel in transit. An `RTO Delivered` note counts as returned to origin even without the tag. After the 11 Oct 2026 resync: 15 orders `rto_on_the_way` (₹24,956.20), 35 `in_transit` (was 50), debits equal credits.
