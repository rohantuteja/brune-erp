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
   Whatever Unicommerce changes, the result still balances. The Unicommerce API exposes no invoice
   amounts, so the ledger relies on the order's own facts and keeps Unicommerce's invoice numbers
   only as references.
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

## Still to build

1. **Control-ledger report** (Analytics): every order since 1 Oct with its entries above, the orders
   that don't net to zero, orders delivered with no remittance after 10 days, returns without a
   credit note, store credit without a return. Read-only first.
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
