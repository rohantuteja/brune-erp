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

- **Sale:** Unicommerce's sale invoice when one exists (amounts, COD charge, tax type, date, number); orders from before
  29 Sep, or whose Unicommerce copy was cancelled, use Shopify's amounts (note: GST rate assumed 5%).
- **Settlement:** prepaid payments from Shopify transactions, store credit spent at checkout, and for COD the courier
  collection on the delivery date (`cod_deliveries`, else Velocity, else the Shopify payment date).
- **Customer return** (one per Return Prime request that refunded something): goods returned from Shopify's refund
  line items, return fee from Return Prime, store credit actually issued from the customer's store-credit account
  within minutes of Return Prime's refund. A debit counts as a reversal only if its id is in
  `store_credit_reversals` (a customer spending the credit looks the same). The credit note is due when the
  parcel is back (Unicommerce's return invoice, else Return Prime's receipt); before that the return is `pending`
  and shows as `awaiting_return` with how long the customer has been refunded.
- **RTO:** orders tagged `rto_delivered`; the whole sale comes back.
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

## Still to build

1. **Control-ledger report**: done (stored ledger and Analytics → Ledger above). Still to do: orders delivered with
   no remittance after 10 days (needs the Velocity remittance matching).
2. **GoKwik settlement import** (upload screen; the `settlement_v2` and `rawSettlementReport`
   downloads carry the same payments, the raw one adds `Remark`, `PG Transaction Type`, `Origin`).
   Match on `Platform Order Id` (the Shopify order number); post per UTR.
3. **Velocity charges**: per-parcel freight and COD fee from the `shipping-charges` API against the
   monthly invoice.
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
