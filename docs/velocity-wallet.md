# Velocity wallet: top-ups, charges, the monthly invoice

Analytics → **Velocity wallet** (admins only) reconciles Velocity's prepaid wallet. Nothing here posts to Tally.

## How Velocity bills

You top the wallet up (UPI, usually ₹10,000), every charge is taken from it **as it happens, GST included**, and after month end Velocity sends **one tax invoice** for the month (White Wizard Technologies, GSTIN 29…, to Rethought; IGST 18% because the supplier is in Karnataka). So:

- a **top-up is an advance** (an asset, never an expense);
- the **monthly invoice is the expense**: Shipping Expenses (freight and COD charge, RTO, weight differences, plus the "VAS" line of WhatsApp delivery-failure messages at ₹0.50 each) and the input GST, against the Velocity account. No bank entry: the wallet already paid it.

Proposed Tally treatment (the accountant confirms the ledger names and whether the September invoice, dated 1 Oct for September charges, is booked on its date or was provided for in September):

| Event | Entry |
|---|---|
| Top-up | Payment: Dr Velocity (advance), Cr Bank |
| Monthly invoice | Purchase: Dr Shipping Expenses (before GST), Dr GST input, Cr Velocity |
| COD collected by Velocity and paid into the bank | Separate ledger (COD receivable), never netted against the wallet |

The Velocity account then equals the wallet balance (Dr = prepaid).

## What is uploaded

| File | Read by | Checked before anything is stored |
|---|---|---|
| Dashboard **Ledger Report** CSV (Transaction Type, Amount, Balance, Tracking Number, Notes, Created At) | `parseWalletLedger` in `_shared/velocity-ledger.ts` | the balance column follows from the amounts (the closing balance minus the opening equals the sum of every line; lines in the same second are matched by value because their order is not reliable); no line twice; every row readable; every note a known kind (unknown notes are a warning, stored as `other`) |
| Monthly **tax invoice** PDF | `parseVelocityInvoice` (text via `unpdf`) | lines + GST = the grand total; GST is the stated rate of the lines |

`Created At` is in the invoice's timezone (IST): September's 293 delivery-failure messages come to ₹172.87 with GST, exactly the invoice's ₹146.50 VAS line plus 18%. A report that does not add up is refused whole. Re-uploading overlapping reports adds only new lines (a line's key is its time, type, amount, tracking number, note and the balance after it). Reports are also checked against their neighbours: each must open where the previous one closed, or the screen says a report is missing. (An overlapping report must start on a date boundary, as the dashboard's date filter produces; one that starts mid-day shows a false "report missing" warning.) Whether a line is already stored is asked by date range, a page at a time: asking by key put hundreds of long keys in the web address, which the database refuses ("Bad Request") on a real month of about 2,000 lines.

Upload goes through the `velocity-import` edge function (admin login or `x-cron-key`, which the scheduled report inbox will use later): actions `ledger`, `invoice`, `reconcile`. After a ledger import the bank matching is re-run, because a wallet top-up **proves** the bank payment that funded it.

## The reconciliation

1. **Top-ups against the bank.** Each wallet top-up is matched to a bank debit of the same amount, within a day, to a Velocity handle (`shipfast.cf@…`, `cf.shipfast@…`, a masked `…t.cf@axisban`, a masked `…fast@cashfre`: four Cashfree handles seen; the bank masks parts of a handle, so a new one can appear), **or to a bank line a person filed under the `Velocity wallet recharge` bucket by hand** (shown as "matched by you"; that is how an unrecognised handle is fixed without a code change). `finance-import` v4 marks a recognised bank line *matched*, bucket `Velocity wallet recharge`, and keeps a hand-filed line's top-up reserved so no other bank line is matched to it. A top-up with no bank payment was paid from another account, probably personally: it is a company expense owed to whoever paid.
2. **A month's charges against its invoice** (before GST). The VAS line must match to the paisa. Velocity's freight line is not "everything debited": it takes back some credits and not others, so the screen shows every way of counting the credits and names the closest. For September 2026 the closest is *all charges, less shipping-charge reversals and lost-shipment credits*, ₹87.93 (0.18%) below the invoice; COD-charge reversals (₹3,437.25 with GST in September) are credited to the wallet but do not appear to be taken off the invoice. That rule is inferred from one month: a second invoice would confirm it, and it is worth asking Velocity.
3. **Balances.** The wallet balance carries month to month from the first stored report (August 2026 closed at ₹1,003.75, September at ₹6,047.73, October to the 12th at ₹9,758.25 on the real files).

## Velocity's API (what it can and cannot give)

Documentation: `https://www.velocity.in/shipping-faq/api/` (newer than the PDF V1). The **Finance APIs** page has `shipping-charges` (ledger events per tracking number, with `amount_without_gst` and `amount_with_gst`; 100 tracking numbers a call; 5 requests a minute shared with `cod-remittance`) and `cod-remittance`. `/custom/api/v1/shipments` lists shipments by date (about 660 KB a page of 100: use a long timeout, one page at a time). There is **no wallet-level endpoint** (top-ups, balance, statement); about 65 guessed export paths all return 404. The dashboard's Ledger Report is the only source of top-ups and balances, which is why the scheduled email report is the plan for automating it.

## Tables and security (migration 025)

`velocity_ledger_imports`, `velocity_wallet_lines`; `vendor_invoices` gains `period_from`, `period_to`, `lines`. Same security as the other finance tables: admins read, nobody writes from a browser; `velocity_summary()` is service-role only.

## Taking an upload back (migration 026)

Each ledger report and invoice on the Velocity wallet page has a **Delete** button (an "Uploaded files" list on the Velocity page; "Statements uploaded" on the Bank page, which also lists the GoKwik reports). It asks the server for a **dry run** first and shows what would happen; only "Delete this upload" deletes. Nothing is deleted unless the request says `dry_run: false` exactly.

- **What goes:** the upload's record and the lines it brought in. A line is stored once, by the first upload that had it, so a line another upload of the **same account / ledger** also covers (that upload's period contains the line's date; a statement or report holds every line of its period) is **moved to that upload, not deleted**. That upload's new/duplicate counts are corrected.
- **What falls back:** the bank matching is re-run straight after, so a payment only the deleted upload proved goes back to "suggested" (bank payments proved by deleted Velocity top-ups or GoKwik payouts; Velocity top-ups lose their bank payment when the bank statement goes).
- **A person's decision:** lines a person filed go only when their own statement goes (the confirmation counts them: "N were filed by you"); a confirmed match to a deleted proof stays as filed.
- **GoKwik:** payments carry the file that last held them (`source_file`), so deleting a report removes the payments still attributed to it; a payment also in a later report goes with whichever file last carried it (upload that report again to bring it back).
- **Log:** every delete is written to `upload_deletions` (who, when, what, counts), shown as "Recently deleted" under the list. Admin read only. A Meta (or other vendor) invoice cannot be deleted from here: `velocity_delete_invoice` only touches `vendor = 'Velocity'`.
- **Functions:** `finance-import` (`delete_statement`, `delete_gokwik`) and `velocity-import` (`delete_ledger`, `delete_invoice`); SQL `finance_delete_statement`, `velocity_delete_import`, `velocity_delete_invoice`, `gokwik_delete_report` (service role only; atomic), `gokwik_reports()` (admin, for the list).

## Not built yet

- The scheduled email report and the endpoint that receives it (next, after the manual upload is confirmed right).
- The Tally vouchers from this data (waits for the accountant's ledger names).
- Proof of each month's charges from `shipping-charges` per parcel (it has no dates, so it can only be indicative; the dated Ledger Report is exact).
- Velocity credit notes, if Velocity ever issues them as documents (today the wallet shows "financial note" credits).
