# Shipments: parcels the business is waiting on

Analytics → Shipments answers two questions about Velocity parcels:

1. **Escalate.** A forward parcel is past its promised delivery date: raise a ticket with Velocity before the customer complains. Prepaid first (the customer has paid and always complains), COD and part-paid parcels still get a view.
2. **Credit note.** Any parcel (forward, RTO or customer return) still not delivered 45 days after dispatch: only then can a credit note be requested from Velocity.

## Velocity's own tracking decides

**Shopify's fulfilment status and Return Prime's shipment status lag the courier.** The first version of this screen trusted them and listed 133 parcels as pending; checking each against Velocity found **29 already resolved** (20 returns cancelled, 4 returns and 1 RTO delivered back, 2 forward parcels delivered) and 3 RTOs that Velocity had marked **lost** (including 36354, which had been flagged only as "never delivered"). So Shopify and Return Prime now only say which parcels *might* be pending, and every one of them is then asked of Velocity (`shipment-watch` step 4):

| Velocity API (`shazam.velocity.in/custom/api/v1`, `private_secrets.velocity_api_token`) | Gives |
|---|---|
| `order-tracking` `{awbs: [...]}` (50 per call) | `tracking_data.shipment_status` (in_transit, ndr_raised, return_cancelled, lost ...), `shipment_track[0].delivered_date`, `estimated_delivery_date` / `original_edd`, and the tracking log `shipment_track_activities` (date, activity) |
| `shipping-charges` `{awbs: [...]}` | the parcel's wallet ledger: `shipment_debit` (freight), `shipment_cod_debit` / `shipment_cod_credit`, `shipment_rto_debit`, NDR service charges, and `shipment_credit` when Velocity refunds or compensates |
| `cod-remittance` | COD delivery and payment (used by the ledger, not here) |

Probed and **not available** (404): credit notes, claims, tickets, wallet balance or transactions, invoices. The ERP therefore cannot read the credit-note *documents* or Velocity's ticket replies; it can only see wallet credits per parcel. Every one of the 20 cancelled returns was credited its freight automatically (credit = debit); the 3 lost RTOs had no credit yet.

What Velocity's answer does to a parcel (`applyVelocity`):

- **Closed on its own**, only with evidence (a delivery date or a tracking log): `delivered` (outcome delivered), `return_delivered` / `rto_delivered` (outcome returned_to_us), any `*cancel*` (outcome cancelled). `closed_on` is the date of the delivery scan or last tracking line.
- **Flagged, never hidden** (`attention`, with a reason):
  - `lost`: Velocity marked it lost / damaged / destroyed. Stays pending: a claim is due.
  - `ndr`: delivery failed, Velocity waits for instructions. `pickup_failed`: a return could not be collected.
  - `unverified`: Velocity cannot confirm. Reasons: no record of the tracking number; did not answer; a terminal status without evidence (33966 says delivered but has no scan or log); the order note says RTO while Velocity says delivered; Return Prime has no pickup number yet (it writes `_`; each such request gets its own `NOAWB-<request>` row and Velocity is not asked).
- A forward parcel Velocity reports as `rto_*` becomes an RTO row even without a note.
- The promise the customer was given is the courier's `original_edd`, else the order note's EDD (ignored if dated before dispatch), else its current estimate. The last tracking line is when the parcel last moved (drives "stuck").
- A parcel Velocity could not be asked about (API down) is flagged `unverified` for that scan, not trusted.

## Marking parcels: resolved, ticket raised

Table `shipment_reviews` (migration 021) holds what a person decided; a scan never overwrites it. Written only through `shipment_review_set(p_awbs[], p_status, p_ticket_type, p_ticket_ref, p_follow_up_on, p_note, p_credit_note_ref, p_credit_note_amount)` and `shipment_review_clear(p_awbs[])` (security definer; allowed for admins and anyone with `can_view_analytics`; max 500 parcels per call). Every change is appended to `shipment_review_log` with who and when.

- **Ticket raised** (type: delivery escalation or credit note request; ticket number; follow-up in N days): the parcel leaves *Escalate* / *Needs attention* (a credit-note ticket also leaves *Credit note due*) and sits under *Ticket raised* until the follow-up date, when it returns marked "Follow up due".
- **Mark resolved** (delivered / back with us / Velocity issued a credit note + its number and amount / cancelled / other): the parcel leaves every open list and appears under *Resolved* with who resolved it and why.
- **Reopen** removes either mark. Parcels Velocity closes on its own also show under *Resolved*, labelled "Confirmed by Velocity".

## Where the data comes from

| Shipment | Source | What it gives |
|---|---|---|
| Forward | Shopify fulfilment (Velocity writes its tracking there) | `displayStatus` (IN_TRANSIT, OUT_FOR_DELIVERY, ATTEMPTED_DELIVERY, DELIVERED ...), `deliveredAt`, latest events, AWB, courier |
| Forward | Shopify order note | `EDD: 2026-10-12 09:00:00 +0530`, the date Velocity promised |
| RTO | Shopify order note | `RTO Initiated on <ts>`, `RTO In Transit on <ts>`, `RTO Delivered on <ts>` (IST). The latest state wins. |
| Customer return | Return Prime request | reverse-pickup AWB, `shipment_status`, `tracking_updated_at` |

**Velocity does not reliably tag RTO orders.** Thirteen in-progress RTOs had no `rto_initiated` tag at the first scan; the note is the source of truth. A tag is still honoured when it is the only sign. (No `RTO Delivered` note was ever found without the `rto_delivered` tag, so the existing RTO flow in `shopify-order-webhook` is not affected.)

Parcels whose fulfilment is only `FULFILLED` / `MARKED_AS_FULFILLED` were typed in by hand for a courier Shopify cannot follow (old DTDC orders): nothing can be said about them, so they are closed as `untracked` and counted in the scan summary (`untracked_not_followed`). A cancelled or voided fulfilment is `cancelled`.

**Parcels dispatched from Unicommerce (shipment-watch v6, 14 Oct 2026).** Fulfilling an order in Unicommerce books the AWB with Velocity (same 14-digit series, Velocity's tracking answers for it) but Unicommerce names the carrier **SHIPFAST** on the Shopify fulfilment ("UNIWARE marked 1 item as fulfilled", tracking link `shipfast.in/track/…`), a name Shopify cannot follow: the fulfilment stays plain `FULFILLED` with no courier events and never turns `DELIVERED`. Those parcels used to be read as hand-typed old AWBs and dropped (order 37929 was missing from this tab). A fulfilment whose carrier starts with `shipfast` or `velocity` is now kept **pending** (`label_created` until Velocity answers) so Velocity's own tracking decides, like any other parcel; a SHIPFAST AWB Velocity does not know is flagged `unverified`, never hidden. Because Shopify never says delivered for them, every scan would list them again, so once Velocity has closed one it **stays closed** (`staysClosed`) and is not asked again. Other carrier names (DTDC and the like) are still `untracked`. Not yet seen: an RTO of a Unicommerce-shipped parcel, which depends on Velocity writing its note or tag on the Shopify order for parcels Unicommerce booked.

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

The screen reads `shipments` and `shipment_reviews` directly (RLS: signed-in users read). Everything is in the URL: `?sview=` `escalate | attention | claim | ticket | resolved | all`, `stype` (forward / rto / return), `spay`, `scourier`, `sstat`, `stk` (ticket state), `sq` (search), `sfrom` / `sto` (dispatch date range), `sage` (pending for N+ days), `ssort` / `sdir`, `spage` / `ssize`. Dates and type scope the whole page (cards and tab counts follow them); the rest filter the table. Rows expand for the detail and the mark buttons; tick rows to act on a selection. "Copy AWBs", "Copy for a ticket" (tab-separated) and CSV act on the selection, else on everything the filters show, across all pages. On a phone the table becomes cards. Shared building blocks (date range, paging, collapsible panels, sortable headers, chips, CSV) are in `src/components/AnalyticsKit.jsx` with tested logic in `src/lib/analyticsKit.js`; the Ledger screen uses the same.

## First reading, 11 Oct 2026

Before Velocity was asked: 133 pending (63 forward, 20 RTO, 50 returns), 10 to escalate now, 25 credit-note eligible. After: **107 pending, 26 closed by Velocity** (24 returns, 1 forward, 1 RTO). Flagged: 3 lost (33740, 34691, 36354), 6 delivery failed, 9 pickup failed, 2 that cannot be confirmed (33966, and return 36075 with no pickup number). Escalate now 3, consider 3, credit-note eligible 9. Three old orders are untracked. All 5 parcels Velocity shows delivered back to us arrived before the 29 Sep opening-stock load, so no restock is missing.

## The ledger and RTOs in progress

`order-facts.ts` reads the same note: a note that says `RTO Initiated` or `RTO In Transit` (or the tag) with a sale still owed and no delivery gives the ledger a new open stage, `rto_on_the_way` ("returning to origin; the sale is reversed when the parcel is back"), instead of showing the order as a COD parcel in transit. An `RTO Delivered` note counts as returned to origin even without the tag. After the 11 Oct 2026 resync: 15 orders `rto_on_the_way` (₹24,956.20), 35 `in_transit` (was 50), debits equal credits.
