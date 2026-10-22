# Myntra fulfilment: invoice, label and dispatch as soon as Myntra allows

Myntra scores a seller on how fast an order is marked dispatched in Unicommerce, so the ERP does what a person does on the Shipments screen, every 5 minutes:

1. **Invoice and label.** `createInvoiceAndAllocateShippingProvider { shippingPackageCode }` on every Myntra package that is `CREATED`. The package becomes `READY_TO_SHIP`, Myntra is told the item is ready to dispatch, and the answer carries the invoice number, courier, tracking number and the label PDF link (`shippingLabelLink`, the invoice and the label together).
2. **Dispatch.** `shippingManifest/createclose` for every `READY_TO_SHIP` package (invoiced just now, or by a person on the dashboard): one manifest per courier, prepaid and COD together. The package becomes `DISPATCHED` and the order `COMPLETE`.
3. **Labels.** The invoiced labels are listed on Analytics → Myntra until a person marks them printed. "Get one PDF" merges every unprinted label into one file, by default only the courier labels: Unicommerce's file is the invoice (an A4 page) then the label (a 4x6 inch page), and the invoice pages are left out unless the box is unticked.

Function `myntra-fulfil`, rules in `supabase/functions/_shared/myntra-fulfil.ts` (tested), page `src/pages/MyntraSection.jsx`, table `myntra_fulfilments` (migration 037). Every Unicommerce call goes through `public.uc_post`.

## What was verified on live orders (20–21 Oct 2026)

- **Holiday orders.** Myntra decides when an order may be processed (its "upcoming" filter, then "pending"). The invoice step on an upcoming order is refused: `SCRIPT_EXECUTION_FAILED "MYNTRAPPMP unable to mark items ReadyToDispatch : This order is not yet eligible for processing by seller, please try after Tue Oct 20 14:00:00 IST 2026"`. Nothing is created. The job reads the time from the message, marks the package `held` until then and tries again. No holiday calendar is needed.
- **Invoice and label.** BRUN00458 (COD): invoice `I0927RE000000109`, courier `flipkartlogistics` (given by Myntra), tracking `MYSC…`, label link, package `READY_TO_SHIP`, order still `PROCESSING`.
- **Dispatch.** BRUN00461 and BRUN00462 (prepaid) through `createclose`: manifests SM0030 and SM0031, "All packages successfully dispatched", package `DISPATCHED`, order `COMPLETE`. The "restrict manual manifest" setting does not block the API. SM0030 was sent with `shippingMethodCode` and shows that method on the manifest (Quick Dispatch leaves it "Any"), so the job omits it; SM0031 shows "Any".
- **What the dashboard's Quick Dispatch really is.** `POST /data/oms/quickDispatch/create` (an internal website endpoint, not the public API) makes a *Dispatch Group* (QDB…) and a closed manifest. Pack groups (Quick Pack on Print Invoice / Labels) are the same kind of dashboard layer. **The public API has no pack group or dispatch group.** Orders handled by the job therefore sit in no pack group and no dispatch group; the manifests are under Fulfillment → Manifests. That is why the ERP page keeps the "printed or not" record.
- The manifest's Shipping Provider column shows `flipkartlogistics` where Quick Dispatch shows `flipkartlogistics (CHANNEL)`. Cosmetic as far as seen; what Myntra's portal shows for these orders was to be checked by the owner.

## Rules

- Only packages of orders `PROCESSING` in Unicommerce, created on or after `app_settings.myntra_fulfil_from` (2026-10-19), looked back 14 days.
- `CREATED` → invoice; `READY_TO_SHIP` → dispatch; every other package state is left alone. A package dispatched by a person on the dashboard is only recorded (`dispatched outside the ERP`).
- **Held** (Myntra not ready): retried at the time Myntra named. **Failed**: retried after 15, 30, 45 … minutes (max 2 h); after 6 failures in a row the package is `attention` and waits for a person (button "Retry now" on the page). A failed dispatch keeps the invoice and retries only the dispatch.
- Exactly once: one row per package; a run claims the row before it calls Unicommerce (a claim older than 10 minutes is taken as a crashed run). A package that is `READY_TO_SHIP` again after a "dispatched" row is dispatched again.
- Labels: only packages the job invoiced (`source = erp`) are on the print list; ones a person invoiced on the dashboard (`source = dashboard`) were printed there. A label that cannot be fetched stays unprinted.

## Switching it on

Dry mode is the default (`app_settings.myntra_fulfil_mode = "dry"`): the job reads Unicommerce and reports what it would do (the page's "Check now (dry)" and the last-run line). **Switch to live** on the page sets `myntra_fulfil_mode = "live"` and `myntra_fulfil_limit` (packages per run, default 1): go live with 1, check that order in Unicommerce and in Myntra's portal, then raise the limit.

## Edge cases (simulated: `node --test supabase/functions/myntra-fulfil/sweep.test.mjs`)

The real job code runs against a fake database and a fake Unicommerce (`sim.mjs`) that answer as the live account did. 24 scenarios, all passing:

- **An order arrives while a run is in progress** (during the invoice step, or during dispatch): not lost, picked up by the next run (5 minutes). The run only works on the orders it found at its start.
- **Two runs at the same moment** (cron plus a manual sweep): every package is invoiced once and dispatched once; no package on two manifests. A package belongs to one run: the first to insert its row (or take a claim older than 10 minutes) wins.
- **The invoice call times out** (the database gives a call 7 seconds; Unicommerce still does it): the package is looked at before it is called a failure, and dispatched in the same run. **The dispatch call times out** but Unicommerce dispatched: recorded as dispatched with its manifest.
- **A person acts at the same time** (invoices on the dashboard, or dispatches by hand): the job only dispatches what is READY_TO_SHIP and reads the label link off the package; a row whose order is already COMPLETE is closed ("dispatched outside the ERP").
- **Myntra holds an order** (holiday): waits for the time Myntra names at no cost, then goes at once. A customer cancelling meanwhile ends the row as `cancelled`.
- **A run is cut off** (the edge function limit is 150 s): looking up orders stops at 40 s, invoicing at 80 s, and everything invoiced is dispatched before the run ends; the rest waits for the next run. A crashed run's claim is taken over after 10 minutes, or closed if the package was dispatched meanwhile.
- **Limits**: the per-run limit takes the oldest order first and nothing is dropped across runs. A big batch is dispatched in manifests of at most 10 packages (one createclose call must fit in 7 seconds).
- **Failures**: one order that cannot be invoiced does not block the others; it backs off 15, 30, 45 ... minutes and after 6 failures needs a person. Unicommerce down: the run fails cleanly and writes nothing; the next run works.
- **Search window**: 5 days back (a wider search risks the 7-second limit), never before `myntra_fulfil_from`.

Not simulated (needs real Myntra orders): what Myntra's portal shows for a dispatched order, and Myntra holding an order longer than 5 days.

## Pick list

Analytics → Myntra → **Get the pick list** makes a PDF for the same packages as the labels still to print (unprinted, invoiced or dispatched): `S.No. | SKU | Item Name | Brand | Qty | Image | Picked` (a box to tick), one row per SKU with the units to take off the shelf, then "By parcel (same order as the labels)" so each parcel can be packed against its label. It is built by the function (`picklist` action, `_shared/picklist.ts`) from the items of each package's order in Unicommerce, with a small product picture per SKU, and changes nothing in Unicommerce. Unicommerce's own pick list (`picker/picklist/manual/create`) is not used: it needs a package that has not been dispatched, and the job dispatches within minutes of invoicing. A cancelled item is left off.

## Not covered

- Packing: a label exists before the parcel is packed, and dispatch is marked before the courier collects. Someone must pack from the printed labels.
- Pick lists (`/oms/picker/picklist/manual/create`) and pack groups: not created.
- Myntra returns and RTO stay native in Unicommerce.
