# Accounting ledger design (October 2026 onwards)

Why this exists: Shopify's sales and tax reports don't agree with Brune's GST books on orders that
are returned, and nothing ties a sale to its payment, its return and the store credit that replaced
it. Unicommerce issues the GST invoices and return invoices but holds no payment information. This
design makes the ERP the place where every order is reconciled, and produces a file Tally can import.

## Ground rules

1. **October cutoff.** `app_settings.accounting_start_date = 2026-10-01`. September and earlier are
   closed in Tally. Nothing here changes how an order from before the cutoff looks; events dated on
   or after it are in scope, including October receipts for September sales.
2. **One source per document.** Sale invoice and return invoice (credit note): Unicommerce
   (INS… / ISR…). Payments, refunds, store credit: Shopify. Money reaching the bank: GoKwik settlement
   reports, Velocity COD remittances (UTR), the bank statement.
3. **One customer control account per order that must net to zero.** If it doesn't, something is
   missing: a payment, a credit note, a fee that was never taxed. The non-zero orders are the
   month-end exception list.
4. **Shopify's COD refund lines are not money.** A refund "to Cash On Delivery" is a record; no cash
   moves. The amount owed to the customer is the **store credit actually issued**, read from the
   customer's store credit account.
5. **Dates are real event dates in IST** (delivery date, UTR date, credit-note date, credit date),
   not the timestamp of whichever job recorded them.
6. **Fix the cause, then reconcile.** `cod-paid-on-delivery` and `store-credit-guard` remove two of
   the causes; the ledger catches whatever is left.

## Entries

Sales are inclusive of 5% IGST (garments up to ₹2,500). Control = the order's customer account,
debit-positive.

The worked examples below use plain account names (Sales, Output IGST, Bank, Gateway clearing, Store credit
liability). The ledger itself uses the Tally ledger names: see "Account names, the prepaid payout and Gateway clearing".

### A. Prepaid return (order 37807: ₹1,399 − ₹259.85 prepaid discount, paid ₹1,139.15 by UPI)

| Event | Source | Dr | Cr | Control |
|---|---|---|---|---|
| Sale invoice INS0106 | Unicommerce | Customer 1,139.15 | Sales 1,084.90, IGST 54.25 | +1,139.15 |
| GoKwik settlement (fee 22.78, GST on fee 4.10) | GoKwik report, UTR | Bank 1,112.27, Gateway fees 22.78, Input GST 4.10 | Customer 1,139.15 | −1,139.15 |
| Return invoice ISR0004 (full item) | Unicommerce | Sales returns 1,084.90, IGST 54.25 | Customer 1,139.15 | −1,139.15 |
| Store credit issued | Customer's credit account | Customer 1,040.15 | Store credit liability 1,040.15 | +1,040.15 |
| Return fee retained ₹99 (5%: 94.29 + 4.71 GST) | Return Prime | Customer 99.00 | Return fee income 94.29, IGST 4.71 | +99.00 |
| | | | **Order total** | **0.00** |

### B. COD return (order 37562: goods ₹1,399 + COD fee ₹100, paid in cash ₹1,499)

Store credit = goods − discount − ₹99 return fee = ₹1,300. The ₹100 COD fee is never refunded.

| Event | Source | Dr | Cr | Control |
|---|---|---|---|---|
| Sale invoice (goods 1,332.38 + 66.62 GST; COD fee 95.24 + 4.76 GST) | Unicommerce | Customer 1,499.00 | Sales 1,427.62, IGST 71.38 | +1,499.00 |
| Delivered, cash collected by the courier | Velocity `delivery_date` | COD receivable (Velocity) 1,499.00 | Customer 1,499.00 | −1,499.00 |
| Return invoice (goods only) | Unicommerce | Sales returns 1,332.38, IGST 66.62 | Customer 1,399.00 | −1,399.00 |
| Store credit issued | Customer's credit account | Customer 1,300.00 | Store credit liability 1,300.00 | +1,300.00 |
| Return fee retained ₹99 | Return Prime | Customer 99.00 | Return fee income 94.29, IGST 4.71 | +99.00 |
| COD remittance | Velocity UTR | Bank 1,499.00 | COD receivable (Velocity) 1,499.00 | — |
| | | | **Order total** | **0.00** |

The ₹100 COD fee needs no entry of its own: it stays in the original sale with its 5% GST
(₹4.76), provided the return invoice covers the goods only. **Shopify instead reverses all the tax
on a returned order**, so on each COD return Shopify under-reports output GST by ₹9.48 (the ₹99 fee
and the ₹100 COD fee are both kept, untaxed): 199 / 1.05 = 189.52 taxable + 9.48 IGST.

### B2. COD order returned to origin, never delivered (order 37707: ₹1,399 goods + ₹100 COD fee)

Nobody paid, so the whole invoice should end at zero, COD fee included. **Unicommerce's return
invoice for a Courier Returned order reverses the goods only** (ISR0001: ₹1,332.38 + ₹66.62 GST =
₹1,399; COD charges ₹0.00; sale invoice INS0006 was ₹1,499 with COD charges ₹95.24), so ₹100
(₹95.24 + ₹4.76 GST) stays as a sale that was never collected: output GST and revenue overstated,
and a ₹100 receivable that never clears. Shopify is right here (the cancelled order shows zero).

| Event | Source | Dr | Cr | Control |
|---|---|---|---|---|
| Sale invoice INS0006 | Unicommerce | Customer 1,499.00 | Sales 1,427.62, IGST 71.38 | +1,499.00 |
| Return invoice ISR0001 (goods only) | Unicommerce | Sales returns 1,332.38, IGST 66.62 | Customer 1,399.00 | −1,399.00 |
| **COD fee credit note** (not issued by Unicommerce) | ERP | Sales returns 95.24, IGST 4.76 | Customer 100.00 | −100.00 |
| | | | **Order total** | **0.00** |

19 COD orders went RTO since 1 Oct (₹1,900 of COD fees: ₹1,809.52 taxable + ₹90.48 GST). Only those
that Unicommerce holds (placed after the 29 Sep load) have this short return invoice.

Compare B: after a customer return the COD fee **was** collected and is kept, so a goods-only
credit note is correct there.

### C. Extra store credit reversed (orders 36791, 37613)

| Event | Source | Dr | Cr |
|---|---|---|---|
| Second credit added by GoKwik for the store-credit part of the refund | Credit account | Customer (store credit given in error) | Store credit liability |
| Taken back by `store-credit-guard` | Credit account debit | Store credit liability | Customer (store credit given in error) |

The reversal is dated when the debit happens, so for 36791 (credited in September, reversed in
October) the correction lands in October.

### D. Velocity wallet

| Event | Source | Dr | Cr |
|---|---|---|---|
| Wallet recharge | Bank statement | Velocity wallet (advance) | Bank |
| Monthly Velocity invoice (freight + COD fees, with GST) | Invoice, checked against the `shipping-charges` API per parcel | Freight, COD fees, Input GST | Velocity wallet |

Velocity does **not** deduct charges from the COD remittance: a remittance is exactly the COD amount.

## The ledger engine and the Tally file

`supabase/functions/_shared/ledger.ts` builds the entries of one order from facts (Shopify,
Unicommerce, Velocity, GoKwik, Return Prime) and is tested on the real orders above
(`ledger.test.ts`). Its rules:

1. **Every order nets to zero** on the control account, whatever the other systems do.
2. **Compare, then balance.** For every return the engine compares what Unicommerce's return
   invoice covers with what the order requires, and issues the difference itself as an `erp`
   voucher: a credit note for missing goods (orders from before 29 Sep have no Unicommerce invoice),
   a credit note for the COD charge on a return to origin, a bill for the retained COD charge if
   Unicommerce starts reversing it on customer returns, and an invoice for the ₹99 return fee.
   Whatever Unicommerce changes, the result still balances. The ledger reads the actual amounts of
   every sale and return invoice with Unicommerce's Get Invoice Details API
   (`POST /services/rest/v1/invoice/details/get` with the shipping package code and `return: true`
   for the return invoice): total, tax and `cashOnDeliveryCharges`, per invoice and per item.
   Verified on 37707 (INS0006 ₹1,499 incl. COD charge ₹95.24, tax ₹71.38; ISR0001 ₹1,399, COD charge
   ₹0.00, tax ₹66.62) and 37807 (ISR0004 equals its sale invoice). From it, `uc.codFee` is the COD
   charge times (1 + rate) and `uc.goods` is the total less that. The `Return Invoices` export report
   is NOT usable for this: its tax columns are zero, it lists packages by the date they were added
   (so earlier packages' returns are missing) and it has no COD column.
3. **Entitlement check.** On a customer return the credit or refund must equal goods returned less
   the return fee. Anything else, such as a double store credit, is an exception.
4. **Cutoff.** Entries dated before `accounting_start_date` are computed (so the order can be shown
   to balance) but never exported; the carried-in balance is reported as `opening`.

**Tally import file rules** (to build on this engine):

- It contains only entries dated on or after the cutoff, grouped into vouchers that each balance.
- An order that does not balance, or has an exception, is **left out and listed** as an exception:
  Tally never receives an unbalanced order.
- Sale and return vouchers come from the ledger, not from Unicommerce's Tally integration. The ERP
  issues the balancing credit notes and invoices (with their own number series) and files them with the
  rest, so the file is complete by itself.
- Receipts (GoKwik settlement by UTR, Velocity COD remittance by UTR) post against the clearing
  accounts, so a month-end report shows what has been delivered or settled but not yet received.

## Workflows built (this branch)

| Workflow | What it does | Function |
|---|---|---|
| Mark COD paid on delivery | Marks COD / PPCOD orders paid when Velocity shows a delivery date, so a later return lands on a paid order | `cod-paid-on-delivery` |
| Double-credit guard | Takes back the store credit Return Prime and GoKwik issued twice | `store-credit-guard` |

Both start in dry mode and write what they would do to `cod_deliveries` / `store_credit_reversals`.

| Facts gatherer + ledger run | Reads each order from Shopify, Unicommerce, Return Prime and Velocity, maps it to facts (`_shared/order-facts.ts`), builds the ledger (`_shared/ledger.ts`) and reports which orders balance and which need a balancing document or a person. Writes nothing. | `accounting-ledger` |

`accounting-ledger` actions (admin JWT or `x-cron-key`): `order` (`{order:"37613"}`: facts, notes, entries) and
`report` (`{from, limit, after, only_issues}`, paged by Shopify order update time; `next` is the cursor).
How the facts are read:

- **Sale:** Unicommerce's sale invoice when one exists (amounts, COD charge, tax type, number); orders from before
  29 Sep, or whose Unicommerce copy was cancelled, use Shopify's amounts (note: GST rate assumed 5%).
- **Which day the sale is booked on: the Shopify order date (IST), for every order** (decided 13 Oct 2026). September was
  filed from Shopify's sales report, which counts an order on the day it was placed, and the books must follow the same
  rule as the returns filed from them. Unicommerce creates its invoice when the parcel is packed, which can be the next
  day or month (orders 37712 and 37716-37729 were placed on 30 Sep and invoiced on 1 Oct: booked on the invoice date they
  would have been counted in both September's return and October's). The Unicommerce invoice keeps its number, amounts
  and GST; its own date is stored as `facts.invoiceDate`, a note says so when it falls in a later month, and the
  "invoiced N days ago" wording for COD parcels in transit still counts from it. Returns keep using the date of
  Unicommerce's return invoice (the credit note). A sale dated before `accounting_start_date` is September's: it is not
  exported, and what the order does afterwards (delivery, remittance, credit note) is October's, like order 37711.
  Strictly, GST ties the supply of goods to the invoice / dispatch date; the order date is the rule the owner's
  accountant already files on, and it only moves a sale between months at month ends.
- **Settlement:** prepaid payments from Shopify transactions, store credit spent at checkout, and for COD the courier
  collection on the delivery date (`cod_deliveries`, else Velocity, else the Shopify payment date).
- **Customer return** (one per Return Prime request that refunded something): goods returned from Shopify's refund
  line items, return fee from Return Prime, store credit actually issued from the customer's store-credit account
  within minutes of Return Prime's refund. A debit counts as a reversal only if its id is in
  `store_credit_reversals` (a customer spending the credit looks the same). The credit note is due when the
  parcel is back (Unicommerce's return invoice, else Return Prime's receipt); before that the return is `pending`
  and shows as `awaiting_return` with how long the customer has been refunded.
- **RTO:** orders tagged `rto_delivered`; the whole sale comes back, dated by the courier's order note
  ("RTO Delivered on 2026-10-03 16:04:38") when there is no Unicommerce return invoice. The customer is owed
  everything they paid (prepaid money, a part-payment such as the ₹199 PPCOD advance, and store credit spent);
  the ERP's own RTO process refunds all of it to store credit. For parcels returned before that process existed
  there is no Shopify refund, so the ledger looks for a credit a person gave by hand on the customer's store credit
  account after the parcel came back: the credit closest to what the customer paid, within ₹250, is booked as the
  refund. A difference of under ₹1 goes to the `Round off` account (a person rounds the credit); a bigger
  difference is `store_credit_differs`; no credit at all is `refund_due`. Checked on 11 Oct: 37370 (₹1,260 credited
  for ₹1,259.10 paid), 37535 (₹1,300 for ₹1,300) balance; 37586 (₹1,599 for ₹1,499) shows a ₹100 difference;
  37560 (nothing credited for ₹1,629.10) was `refund_due` until the ERP's RTO flow was run on it (below). Limit: if one customer has several returned orders
  of similar value, one credit can be matched to more than one of them.
- **Not a sale:** cancelled before dispatch with no money moved (skipped and counted as `not_a_sale`).
- `report` with `budget_s` (up to 100) keeps paging inside one call and reads Return Prime once; 352 orders take about 100 s.

**Order states.** Every order ends in one of these (`OrderLedger.status`):

| Status | Meaning | Blocks the Tally export? |
|---|---|---|
| `complete` | nets to zero | no |
| `open` (`in_transit`) | COD parcel shipped, not delivered yet; the amount is the receivable due on delivery. Reason says how many days; over 15 days is flagged for a courier check | no |
| `open` (`awaiting_return`) | the customer is refunded, the parcel isn't back yet, so no credit note is due | no |
| `attention` (`refund_due`) | parcel returned to origin and sale reversed, but the customer's payment was never refunded or credited | yes |
| `attention` (`store_credit_differs`) | store credit issued ≠ goods returned less the fee: a double credit | yes |
| `attention` (`unexplained_residual`, `bad_facts`) | a payment, return or credit is missing / the facts are inconsistent | yes |

Orders cancelled before dispatch are `not a sale` and skipped.

**Full run, 11 Oct 2026** (all 352 orders updated since 1 Oct, one call of 101 s, function v4):

| | Orders |
|---|---|
| Complete | 279 |
| Not a sale | 7 |
| Open, COD in transit | 50 (₹82,517.20 due on delivery; 3 are over 15 days old: 37294 and 37378 are tagged `rto_initiated`, 37358 has no tag) |
| Open, waiting for the returned parcel | 12 (₹15,489.45; the oldest refunded 9 days ago, 37528) |
| Attention, refund due | 4: 37370 ₹1,259.10, 37535 ₹1,300, 37560 ₹1,629.10, 37586 ₹1,499 (₹5,687.20) |
| Double store credit / unexplained | 0 |

The four `refund_due` orders were returned to origin before the ERP handled RTOs (tag `rto_delivered`, so the stock
sync treats them as baseline), are still `PAID` on Shopify and have no refund or store credit.

Balancing documents the ERP has to issue for these orders: goods credit notes 40 orders ₹58,290.60 (no Unicommerce
return invoice, or a short one), COD-charge credit notes 23 orders ₹2,300 (COD returns to origin), ₹99 return-fee
invoices 16 orders ₹1,584.

## The stored ledger (migration 017)

`accounting-ledger` saves what it computes so the books can be read, filtered and exported without recomputing:

| Table | One row per | Holds |
|---|---|---|
| `ledger_orders` | Shopify order | status (`complete`, `open`, `attention`, `not_a_sale`), open amount (`net`), the amount carried in from before the start date (`opening`), the first exception, the balancing documents the ERP issues, notes, and the facts the order was computed from |
| `ledger_entries` | double-entry line | date, voucher, account, debit, credit, source document, who issued it (`unicommerce`, `erp`, `shopify`, `return_prime`, `courier`, `gateway`), memo, and `exportable` (dated on or after `accounting_start_date`) |
| `ledger_runs` | sync run | the queue of order ids, how far it got, orders missing from Shopify, a summary of statuses, and any error |

The ledger is derived data: every sync recomputes an order from scratch and replaces its rows in one transaction
(`ledger_save_orders`), so a fix to the rules is applied by syncing again. Nothing in these tables is sent to
Shopify, Unicommerce or Tally. Signed-in users can read them; only the function writes.

**Sync.** `sync` starts a run (or continues the running one) and saves orders for up to `budget_s` seconds.
A full run queues every order updated since the start date; an incremental run queues those updated since the
last run (two days back) plus every order that is `open` or `attention`, because those change without Shopify
noticing: a parcel arrives, a courier delivers, Unicommerce issues an invoice. `tick` is what the schedule calls
(pg_cron `accounting-ledger-sync`, every 10 minutes): it does nothing unless `app_settings.ledger_sync_mode` is
`live`; then it continues a part-done run, or starts a full run each night (23 h) or an incremental one each hour
(55 min). A run that stops mid-way continues where it was; one that errors is marked `failed` and the next tick
starts a new one.

**First sync, 11 Oct 2026:** 352 orders and 2,164 lines in 92 s, none missing. Checks on the stored data: total
debits equal total credits (₹10,73,329.05 each); every order's lines balance; all 279 complete orders net to zero;
each order's stored `net` equals the sum of its control-account lines; 1,397 lines are exportable and 767 are
carried in. The status counts match the read-only report (279 / 7 / 50 / 12 / 4).

**Screen.** Analytics → Ledger (`/analytics/ledger`, `src/pages/LedgerSection.jsx`): status cards, the Needs
attention list, the documents the ERP issues (by type, with order numbers), and a filterable order table
(`?lstatus=`, `?lq=`) whose rows open to the order's double-entry lines.

**Why four RTO orders were stuck (found 11 Oct).** The ERP's RTO flow ran on 37370, 37535, 37560 and 37586 on
7 Oct: the pieces went back into Unicommerce stock, but the Shopify cancel failed ("Cannot cancel an order that has
outstanding fulfillments") and no credit was issued. They stayed `needs_attention` on `shopify_rto_orders`.
The webhook now cancels the shipment before the order (v15), but a failed row is not retried by itself. The
`cancel` admin action retries one, and needs an admin login, so `rto-cancel` (same code, in
`_shared/rto-cancel.ts`, also accepting the cron key) can do it from the database. It refuses when the customer's
store credit account already holds a credit close to what the order still holds, so it can never credit twice.
Run on 37560 on 11 Oct: shipment cancelled, order cancelled, ₹1,629.10 (₹199 PPCOD advance + ₹1,430.10 store
credit spent) refunded to store credit, cancellation email sent, row `done`. 37370, 37535 and 37586 were credited
by hand on 9 Oct and the guard refuses them; their rows stay `needs_attention` and the orders stay uncancelled on
Shopify (still `PAID` and fulfilled there).

**Approved decisions** (`ledger_adjustments`, migration 018). A person's decision the other systems cannot show.
One kind so far, `goodwill_credit`: the customer was deliberately given more store credit than they paid. When the
amount equals the difference the ledger found, it books it to `Goodwill credits` (debit) instead of flagging the
order. It never covers a shortfall and never a different amount. 37586: ₹1,599 credited for ₹1,499 paid, the extra
₹100 approved by the owner in chat on 11 Oct 2026. The GST treatment of a goodwill credit is for the CA.

## Velocity: delivery, remittance and the money still with the courier

The ledger follows each COD parcel to the bank. Velocity's `cod-remittance` API gives, per AWB, the delivery date, the
COD amount and, once the money has been paid, the remittance date and UTR (`utr_no` set means paid; `remittance_date`
alone is only a schedule). For every COD order that is not yet recorded as remitted the ledger asks Velocity (100 parcels a
call, 5 calls a minute, so calls are spaced 13 s apart across the whole function); an order whose UTR is already on
`cod_deliveries` is not asked again.

| Event | Entry | Date |
|---|---|---|
| Delivered | Dr COD receivable (Velocity), Cr Customer (order control) | Velocity's delivery date |
| Remitted | Dr Bank, Cr COD receivable (Velocity), document = the UTR | Velocity's remittance date |

- `ledger_orders.cod_open` is the balance of COD receivable (Velocity): collected by the courier, not yet in the bank.
  It is separate from `net`, which is the customer side: a delivered COD order nets to zero for the customer while
  Velocity still owes the money.
- **Overdue.** Delivered more than 10 days ago with no UTR: `remittance_overdue` (needs attention: chase Velocity).
  A delivery date that is only a guess is never called overdue.
- **Different amount.** Velocity paid something other than the COD collected: `remittance_differs`.
- Money received in October for September sales is October's: the delivery is dated September (carried in) and the
  remittance October (exported).
- Velocity does not deduct its charges from a remittance (they come from the wallet or the monthly invoice), so the
  remittance equals the COD amount exactly.
- **If Velocity cannot be reached** (HTTP 503 on 13 Oct 2026, after a full sync had rewritten 56 orders without their
  remittances because a failed call was silently skipped), the order is **held back**: it is not saved, so the last good
  rows stay, and the run records the order names in `ledger_runs.summary.held`. A parcel Velocity answers for but does
  not know is not a failure. After an outage run a full sync once Velocity answers.

**First reading, 11 Oct 2026** (81 delivered COD orders in the ledger): 57 remitted, none with a different amount; the
other 24 (delivered 6 to 11 Oct, ₹37,201.90) are still with Velocity and none is overdue. Remittances found:

| Remitted on | Parcels | Amount | Delivered |
|---|---|---|---|
| 5 Oct (Mon) | 36 | ₹53,978.60 | 25 Sep to 1 Oct |
| 9 Oct (Fri) | 19 | ₹31,541.00 | 2 to 5 Oct |
| 25 and 28 Sep | 1 each | ₹1,539.10 and ₹1,749.00 | September (before the start date) |

Each remittance is one UTR for the whole batch, so the bank statement should show one credit of ₹53,978.60 on 5 Oct
and one of ₹31,541.00 on 9 Oct. To check against it.

**Coverage check** (`velocity_gap`). The ledger holds orders Shopify has updated since the start date. A September COD
order that Velocity paid in October but never marked paid on Shopify (it skips COD orders that used store credit)
would be missing. Checked every COD order created since 10 Sep that Shopify has not touched since 1 Oct (73 orders,
₹1,05,380.10): all were paid out in September, none in October, none delivered and unpaid, none undelivered. So every
October remittance is in the ledger. Widened back to 1 Aug (442 orders, ₹6,26,839): 441 paid out before October, and one
COD parcel never delivered, order 36354 (₹1,539.10, created 10 Aug, fulfilled, no RTO tag): chase Velocity.

## RTOs in progress (Velocity's order note)

Velocity does not always tag an RTO order; it writes `RTO Initiated / In Transit / Delivered on <ts>` in the Shopify
order note. The facts builder reads that note (`parseNote`, shared with the shipments screen, `docs/shipments.md`).
A COD order that was never delivered and is coming back is the open stage `rto_on_the_way` ("returning to origin; the
sale is reversed when the parcel is back"), not `in_transit`; the credit notes follow once `RTO Delivered` appears.
After the resync of 11 Oct 2026: 15 orders `rto_on_the_way` (₹24,956.20 owed on the sale side), 35 `in_transit` (it
was 50), debits equal credits at ₹11,68,025.75. A prepaid RTO nets to zero while it travels and stays `complete` until
the return documents are due; the Shipments screen lists it.

## Account names, the prepaid payout and Gateway clearing (migration 028, `accounting-ledger` v15)

**The account names are the Tally ledger names** (the owner's `tally-names-proposed.xlsx`, 13 Oct 2026), so the Tally
file needs no mapping: `ICICI Bank`, `GST SALES` (goods, COD charge and return fee are the `part` of the entry, not
separate accounts), `GST SALES RETURN`, `IGST OUTPUT UP` / `CGST Output UP` / `SGST Output UP`, `STORE CREDIT BY SHOPIFY`,
`Easebuzz Private Limited` (GoKwik's settlement bank; Razorpay is `Razorpay Payment Private Limited`),
`Payment Gateway Expenses`, `IGST Input  UP` (two spaces, as in Tally), `ROUND OFF`. The three control accounts
(`Customer (order control)`, `Myntra receivable (order control)`, `COD receivable (Velocity)`, plus `Goodwill credits`)
are the ERP's own and are not posted to Tally as ledgers of their own. Each sale and credit-note line carries the
**piece count** (`qty`) so the file can name the stock item; `part` says which line of the sale it is.

**The prepaid payout.** A prepaid order is paid into the gateway, and GoKwik later pays the bank the amount less its fee
and GST, one UTR for the batch. The sale side was always booked (Dr gateway account on payment); the missing half is
now booked from GoKwik's `rawSettlementReport` (table `gokwik_payments`, one row per Shopify payment, uploaded on
Analytics → Bank & card):

| Event | Entry | Date |
|---|---|---|
| Customer pays | Dr Easebuzz Private Limited, Cr Customer (order control) | Shopify payment date |
| GoKwik pays out | Dr ICICI Bank (amount − fee − GST), Dr Payment Gateway Expenses (fee), Dr IGST Input (GST on the fee), Cr Easebuzz Private Limited (amount); document = UTR | settlement date = the bank credit date (38 of 38 UTRs) |

Fee + GST by settlement month equals Easebuzz's monthly invoice to the paisa. The gateway account is outside the
customer control, so an order still nets to zero for the customer; what is open is `ledger_orders.gateway_open`.

- `awaiting_payout` (open, normal): paid, and GoKwik's report does not list it yet, or the payment is newer than the
  last report. 44 of the 210 prepaid orders on 14 Oct 2026, ₹60,386.10.
- `payout_missing` (needs a person): paid at least 5 days before the last day the uploaded reports cover and still not
  listed. Payments dated before the first report are not flagged.
- `payout_differs` (needs a person): GoKwik paid out a different amount than it took for the order.
- Razorpay-paid orders (none seen so far) stay `awaiting_payout` until a Razorpay import exists.

**Check (14 Oct 2026, full sync against a before-snapshot):** 165 payout vouchers (₹2,08,471.70 gross, ₹4,299.57 fee,
₹774.33 GST, ₹2,03,397.80 to the bank), 44 awaiting, none missing or different; every other total equal to before
under the renames; Myntra unchanged.

## Myntra orders (migration 027)

Myntra orders (Unicommerce channel `MYNTRAPPMP`) live only in Unicommerce, so the ledger reads them from there and keeps
them next to the Shopify orders (`ledger_orders.channel` = `shopify` | `myntra`; Analytics → Ledger has a channel filter).

- **Source of truth:** the Unicommerce sale invoice (number `I0927RE…`, amounts, tax) and, when a parcel comes back, the
  return invoice. Same rule as Shopify: Unicommerce's documents are the documents, the ERP only adds what is missing.
- **Name:** the order is named by its Unicommerce **invoice number**. Unicommerce's own order code (a UUID, which is
  Myntra's `seller_order_id`) is kept in `channel_ref` and used to read the order again. Myntra's Release ID is not in
  Unicommerce, so the settlement step will bridge it through Myntra's order-flow report (`sale_order_code` = settlement
  `Release_Id`, `packed_id` = `Packet_Id`).
- **Enters the ledger when Unicommerce has invoiced it.** An order with no invoice yet is not stored; a cancelled one is
  `not_a_sale`. The two Myntra test orders of 22 Sep (#1 and #2) are not in Unicommerce and so never appear.
- **Booked on Myntra's order time (IST),** like a Shopify order is booked on its order date, but **never before the
  books started** (`accounting_start_date`): September's books had no Myntra sales, so the four orders placed in
  September (₹6,530 incl. ₹310.94 GST) are booked on 1 Oct. Returns are dated by the return invoice.
- **Myntra is a marketplace, not our customer.** We invoice the **end customer** (B2C) through Unicommerce, and Myntra
  collects the price from the customer. Myntra invoices us only its own fees (commission, fixed fee, return fees) and
  deducts TCS and TDS from what it pays us; so there is no GSTIN on a Myntra sale, and Myntra is flagged as the
  e-commerce operator in the Tally file. `Myntra receivable (order control)` is therefore a **clearing account for the
  money Myntra collected for us and has not paid yet**, not a debtor.
  Sale: Dr Myntra receivable / Cr GST SALES + IGST OUTPUT UP (or CGST + SGST for an in-state order); a return invoice
  reverses it. The "GT charge" Myntra collects from the customer is Myntra's, not ours, and is on no invoice.
- **Stages:** a sold order with no settlement matched is `awaiting_settlement` (open, normal); a customer return the
  warehouse has not received is `awaiting_return`; a courier return (RTO) not yet received is pending the same way.
  When the return invoice exists the credit note is Unicommerce's; any shortfall is balanced by the ERP like Shopify.
- **Not done yet (the second step):** matching Myntra's settlement (payout) to the orders. A payout is what Myntra
  collected (the invoice value) less commission, the ₹59 fixed fee, TCS 0.5% and TDS 0.1% (and, on a return, the return-fee tier ₹106/127/182 + 18%
  GST; commission, TCS and TDS come back, the fixed fee does not). Until then every sale stays open, and the receivable
  control account is the list of what Myntra still owes. First payout is expected 19-25 Oct 2026; the settlement step
  is built once it arrives, from Myntra's order-flow and settlement reports for the same dates.
- **Worth claiming back from Myntra:** 23 of the first orders were charged commission although the brand agreement is
  0% (₹3,605.53 incl. GST, from the settlement report; the label in the report cannot say it should be 0%). Not
  automated; it shows up when settlements are matched.

## Still to build

1. **Control-ledger report**: done (stored ledger and Analytics → Ledger above). Still to do: orders delivered with
   no remittance after 10 days (needs the Velocity remittance matching).
2. **GoKwik settlement import**: done (Analytics → Bank & card; payouts are ledger entries, see "the prepaid payout").
3. **Velocity charges**: per-parcel freight and COD fee from the `shipping-charges` API against the
   monthly invoice. (Remittances are done: see Velocity above.)
4. **Tally import file** from all of the above (sales and return vouchers from Unicommerce, so the
   Unicommerce–Tally integration isn't needed).

## Open decisions and checks

- **Return fee ₹99:** the plan above books it at 5% as a separate supply. The alternative is a
  partial credit note; the net tax is identical, only the documents differ. Owner's CA to confirm
  (and how earlier returns are corrected, if at all — they are before the cutoff).
- **COD fee on RTO return invoices:** confirmed short by ₹100 (order 37707, case B2). Two ways to
  close it: ask Unicommerce whether the Courier Returned return invoice can include COD charges
  (they issue the invoice), and until then the ERP issues a COD-fee credit note per COD RTO. The
  CA decides the document form (credit note under section 34 vs cancelling the invoice).
- **COD fee on customer-return invoices:** still to check on the first one (order 37856, once its
  parcel is received). Goods-only is right there, because the fee was collected and is kept.
- **Asking Unicommerce to include the COD charge on every return invoice (RTO and customer returns)
  is acceptable, if the ERP then bills the retained charges.** Unicommerce can't tell the two cases
  apart, so a blanket setting reverses the whole sale, COD fee included. For a customer return the
  ERP then issues one invoice for the retained ₹199 (₹99 return fee + ₹100 COD fee: 189.52 taxable
  + 9.48 IGST). Net GST is the same as case B (output 71.38 − 71.38 + 9.48), and RTOs need nothing
  more. Control check, customer return: +1,499 sale −1,499 delivered −1,499 credit note +1,300 store
  credit +199 retained-charges invoice = 0. CA to confirm.
- **Velocity's own mark-paid at remittance** is to be switched off by the owner once
  `cod_paid_mode` is "live". Until then both can run: Shopify refuses to mark a paid order paid.
- **Paid COD + store credit orders that are returned:** no example yet; the guard covers them either way.
- **Return Prime exchanges** haven't been looked at.
