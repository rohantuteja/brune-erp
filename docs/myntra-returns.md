# Myntra returns: received in Unicommerce automatically

Function `myntra-returns` (migration 039, rules in `_shared/myntra-returns.ts`, panel in Analytics → Myntra → Myntra returns).
Written 17 Nov 2026 on the owner's instruction: the team is small and cannot check every parcel before restocking it, so whatever
the courier brings back is received in Unicommerce at once; the odd wrong or damaged piece is fixed by hand afterwards.

## The problem

Myntra orders live in Unicommerce (channel `MYNTRAPPMP`). When one comes back, Unicommerce opens a return on it and leaves it open until
someone receives it. Nobody was, so:

- the piece never went back into sellable stock (Unicommerce pushes stock to Shopify and Myntra),
- Unicommerce never issued the return invoice (credit note), so the ledger kept the order `awaiting_return`,
- Pipeline Health's Myntra velocity counted the piece as sold (it subtracts only received returns).

On 17 Nov 2026 there were 119 returned pieces on 117 orders, none received (₹1,52,313 of goods; October 95 pieces ₹1,25,993).

| Unicommerce return | Type | Status | Myntra tracking when it is back |
|---|---|---|---|
| RTO (parcel came back undelivered) | `Courier Returned`, code `BRUNxxxxx` | `RETURN_EXPECTED` | `RTO_DELIVERED_TO_SELLER` |
| Customer return | `Customer Returned`, code `RPxxxx` (a reverse pickup) | `COURIER_ALLOCATED` | `CIR_DELIVERED_TO_SELLER` |

Still on their way (left alone): `CIR_COURIER_ASSIGNED` (pickup arranged), `RTO_INITIATED`, `STATUS_NOT_DEFINED`, and any status nobody has seen.
Of the 119: 73 pickups arranged, 20 customer returns back, 5 RTOs back, 20 RTOs on the way, 1 not defined.

`oms/return/get` (read-only) shows a return's `returnStatus`, `returnDeliveryDate`, per-item `saleOrderItemStatus` (`NOT_RECEIVED` /
`RECEIVED`) and `trackingStatus`. Note: the delivered date of the 25 parcels is one of two batch times (12 and 13 Nov, about 15:00), so it is
when Myntra's status reached Unicommerce, not a per-parcel scan.

## What the job does

Every 30 minutes (17 and 47 past the hour):

1. Takes the Myntra orders with a return open (`myntra_order_lines.return_state = 'expected'`, kept by `myntra-velocity`).
2. Reads each from Unicommerce (`oms/saleorder/get`, through `uc_post`), rotating through them when there are more than fit in 85 s.
3. A return that is open (`RETURN_EXPECTED` / `COURIER_ALLOCATED`), has tracking `*_DELIVERED_TO_SELLER`, matches its kind (RTO ↔ `RTO_*`,
   customer ↔ `CIR_*`), whose items are all `DISPATCHED` / `DELIVERED` and on no other open return, is received:
   `POST /oms/returns/complete { saleOrderCode, saleOrderItems: [{ code, status: GOOD_INVENTORY, shelfCode: DEFAULT, reason }] }`, every item of the
   return in one call (Unicommerce's rule). Unicommerce puts the piece back and issues the return invoice. The ERP never adds stock itself.
4. Reads the order again to prove it (`receivedIn`: the return record received, or every item `RETURNED`), refreshes `myntra_order_lines`, and
   records the credit note number if Unicommerce shows one.

Anything odd is `attention` and is not received (see the tests for each case).

### Exactly once

`myntra_returns` has one row per return the job acted on. The row is inserted (or updated from a known status) as `working` BEFORE the call, so two
runs, or a run and a click, cannot both receive it.

| status | meaning | retried by the job? |
|---|---|---|
| `received` | proved from a fresh read | no |
| `failed` | Unicommerce refused; back-off 30 min, 2 h, 6 h, 24 h | yes, up to 5 times, then `attention` |
| `unverified` | Unicommerce said yes but the order still shows the return open | **never** (a second receive could add the piece twice) |
| `attention` | the rules would not receive it, or 5 failures | no; a person uses Retry or "I handled it" |
| `resolved` | a person handled it in Unicommerce | no |
| `working` | a run holds it; a claim older than 10 min is a dead run | the next read decides: received → closed, still open → tried again |

A `failed` / `working` / `unverified` row whose return Unicommerce now shows received (a call that timed out after Unicommerce took it, or a person
receiving it by hand) is closed on the next read (`closeIfReceived`).

## Customer returns need no putaway call (proven 17 Nov 2026)

`oms/returns/complete` is documented only for "Courier Returned", and Unicommerce's own screens receive a customer return (reverse pickup,
`RPxxxx`) through a putaway, for which no public API is documented. The same call does both, though, tested live on one of each:

| | RTO `BRUN00068` (order 007) | customer return `RP0003` (order 003) |
|---|---|---|
| stock of the SKU | 14 → 15 | 66 → 67 |
| return after the call | `RETURNED`, return invoice `ISR0056`, putaway `PT0058` | `COMPLETE`, return invoice `ISR0057`, putaway `PT0059` |
| the order afterwards | `COMPLETE`, item `DISPATCHED` | **`CANCELLED`**, item `CANCELLED` |

Unicommerce does the putaway itself in both cases. So the job needs no second step for customer returns.

Two consequences found by that test, both fixed in the ledger (`accounting-ledger` v21):

1. **Unicommerce cancels the whole order once a customer return is received.** The ledger treated a cancelled Myntra order as "never a sale"
   (no entries at all), which would have erased a sale that was invoiced, dispatched and delivered, together with its credit note. A cancelled order
   with a return that has a return invoice is now a sale with a credit note (`returnedAfterSale` in `_shared/order-facts.ts`); a cancelled order
   without one is still "never a sale".
2. **A customer return's credit note is not on the shipping package.** `invoice/details/get` with the package code answers `INVOICE_NOT_GENERATED`
   for it; the return invoice is read by `reversePickupCode` (RP0003 → ISR0057, ₹1,226, IGST ₹58.38). An RTO's stays on the package
   (`returnInvoiceRequest`). Before the fix the ledger could never have read a customer return's credit note.

The velocity job treats the received piece as cancelled (the item is `CANCELLED`), which takes it out of the sales count: the same net result as
"ordered minus returns received".

## Money and the ledger

- The credit note is Unicommerce's return invoice, dated the day it is received. The ledger reads it at its next run (every open Myntra order is
  re-read each hour): sale Dr Myntra receivable, credit note Cr Myntra receivable, the order nets to zero.
- This closes the goods and GST side only. Myntra's money side on returns (its reverse settlement, the ₹59 fixed fee and the return fee it keeps,
  TCS / TDS coming back) comes with the Myntra settlement import, which is not built (`docs/accounting-ledger.md`, "Myntra orders").
- A return received now is a November credit note for an October sale. The parcels came back in November (12-13 Nov), so that is also when they
  physically arrived.

## The list of returns still on their way

The four boxes on the panel are buttons: Received by the job (the table of what was received), Needs a person, Failed, will retry (the
returns the job could not finish, with Retry and "I handled it in Unicommerce"), and Pieces with a return open (every return still on its
way). The view is kept in the URL (`rview`, `rfilter`), so a link opens the same list. Until a view is chosen, what needs a person opens
first, then what failed, then what was received.

The open list comes from `myntra_open_returns` (migration 041), which every sweep keeps up to date: one row per return open in Unicommerce
and not received (tracking, courier and AWB, pieces), written for every Myntra order the run read. A row goes when the return is received
(by the job or by a person) or the order has no open piece any more. The list is oldest first, with the filters Customer pickups, RTOs and
14+ days, and each order is named by its ledger invoice number with what the ledger still shows as owed on it.

Unicommerce's order does not say when a return was opened, so `oms/return/get` is asked once per return (a customer return by its
`reversePickupCode`, an RTO by its `shipmentCode`, which is its own code): `channelReturnCreatedDate` is the day Myntra opened it (Indian
time, e.g. `2026-10-23 17:54:18`, checked against the delivery challan's epoch) and the customer's reason is on each item
(`marketplaceReturnReason`). At most 40 of these are asked per run, so the first runs fill the whole list in; after that only a new return costs
a call. "Out for" counts days since Myntra opened the return: amber from 14 days, red from 30.

The list never stops the job: if its table cannot be read or written the returns that are back are still received, and the run's answer has
a `list_error`. The count on the box comes from Unicommerce's pieces (`myntra_order_lines`); the list counts returns, so the two can differ
by a run until the list catches up (the panel says so).

## Wrong or damaged pieces

Handled by hand, as the owner decided. Analytics → Myntra → Myntra returns lists what was received with SKU and parcel number. To fix one: in
Unicommerce remove the stock of the SKU that should not be there and add the right one (Inventory adjustment). Myntra's own claim windows for a wrong or
damaged return are separate and are the owner's to watch.

## Rollout (nothing below is applied until the owner approves each step)

1. Apply migration 039 (table, two settings in dry mode, the schedule). Deploy `myntra-returns` (new name, so nothing live calls it).
2. Dry check (panel button, or `sweep` with `dry: true`): it must list the same 25 returns as the rules test did (20 customer, 5 RTO).
3. Receive ONE RTO with `receive` and check it in Unicommerce and on the Myntra page (stock +1 for that SKU, return invoice, order nets to zero in
   the ledger after the next run). Then ONE customer return the same way. (Both done 17 Nov 2026, see above.)
4. Switch to live with a small `myntra_returns_limit`, watch a run, raise the limit.
5. The list (v2): apply migration 041, deploy `myntra-returns` v2, then merge the frontend. The next scheduled run (17 or 47 past the hour)
   starts filling the list, 40 returns' dates per run, so it is complete after about three runs. The panel's "Check now (dry)" does not write the
   list (a dry check changes nothing). Until the list has rows the panel says it fills in at the next run.
Each Unicommerce call goes through `uc_post`; the live check of a run is the function's own JSON answer (`received`, `failed`, `unverified`).

## Not covered

- Returns still on their way: 47 customer-return pickups were arranged 14+ days ago (16 over 30 days) and 6 RTOs are 14+ days into their journey. The job
  waits for Myntra's tracking; someone has to chase Myntra on the old ones (Myntra may already have reverse-settled them).
- A parcel marked delivered by Myntra that is not physically here would be restocked on paper. A stock audit (`stock-audit`) shows such a gap.
