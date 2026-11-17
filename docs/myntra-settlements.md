# Myntra settlements (payouts in the order ledger)

Myntra collects the customer's money and pays us about every other day: one NEFT per payout, net of its **fixed fee**,
**commission** (accepted as charged), **TCS** and **TDS**, and with what customers **returned** taken back out of the same transfer
(plus a **return fee**). Until a payout is booked, every Myntra sale sits open on `Myntra receivable (order control)`
(`awaiting_settlement`). This feature reads Myntra's settlement reports, proves each payout against the bank statement, and books it
order by order so a paid order nets to zero. Decisions are the owner's (3, 4 and 17 Nov 2026); numbers below are October 2026's.

Code: `supabase/functions/_shared/myntra-settlement.ts` (reading, bank tie, shares; tests beside it), `settlementLines` and the
`settlement` voucher in `_shared/ledger.ts`, the `myntra` action in `finance-import`, the loader in `accounting-ledger`, the screen on
Analytics → Bank & card. Migration `040_myntra_settlements.sql`.

## The two reports (the owner uploads them; nothing can be scheduled)

| | Monthly SETTLED report (`.xlsx`) | PAYMENT DETAILS report (`.csv`) |
|---|---|---|
| Organised by | the month the money was **paid** | the month the order was **placed** (at most 31 days per file) |
| Holds | every payout line of that month, whatever month the order is from (October's tied all 8 bank credits, including three September orders) | only that month's orders, settled and not yet settled; about two days old |
| Available | after month end | on any day |
| Sheets / columns | `forward_settled`, `reverse_settled`; three header rows | one row per order line, forward and reverse side by side |

Both are read into the same **settlement line**: one stream (prepaid or postpaid: online or at the door, each has its own transfer)
of one order line in one payout, forward (paid to us) or reverse (taken back). A line is stored once, by `(utr, line_id, stream, dir)`,
so uploading both reports, or overlapping ones, never doubles anything (checked: all 52 payment-details lines of October carry the same
key and the same amounts as the settled report). A payout split over two files is completed by the second.

A file is **refused whole** unless every line adds up to the paisa:

- forward: `paid = product - commission - fixed fee - TCS - TDS`
- reverse: `taken back = product - commission + return fee - TCS - TDS` (the fixed fee is not given back; commission, TCS and TDS are)

Commission and both fees are GST-inclusive in the reports. A charge the ledger has no account for (tech enablement, pick and pack, royalty,
additional charges ...) refuses the file with its name, instead of being guessed. Nothing Myntra charged is judged or flagged (the owner
accepted the commission and the price changes): the money is booked as it moved. The payment details report has no return-fee column;
it is what is left of the amount taken back.

## When a payout is booked

Only when a **bank credit proves it**: the credit's narration holds the first 16 characters of the UTR (`NEFT-DEUTH026303A2EWN-MYNTRA
DESIGNS...` for `NFT-/XUTR/DEUTH026303A2EWNX`) and its amount is the sum of the payout's lines to the paisa. Money received before
`accounting_start_date` (1 Oct 2026) is never touched. A payout not in the bank statement yet, or whose total differs (the report does
not hold every line of it), books nothing; the upload says which. The bank matching (`bank-match.ts`) files the credit under
`Myntra receivable (order control)` as proved, kind `myntra_payout`.

The 8 payouts of October 2026 (22-30 Oct, ₹12,862.76) all tie to the bank to the paisa.

## What is booked

One `settlement` voucher per order per payout (UTR in `doc`), dated by the **bank** credit, issued by `myntra`. The bank leg is the order's
**share** of the transfer; the shares of a payout add up to the bank credit exactly (the running total is rounded, not each line).

Forward: Dr bank share, `Payment Gateway Expenses` (the fixed fee, ex GST; its amount comes from each order's line, it is not always the
same), `Myntra Commission`, `IGST Input  UP` (GST on the fee and on the commission, claimed), `Tax Collected at source 26-27`,
`Tax Deducted at source 26-27` / Cr `Myntra receivable (order control)` for what Myntra owed for the item.
Reverse: Dr `Myntra receivable` (open again until the credit note), `Myntra Return Fees` and the GST on them / Cr the bank share
(negative), commission and its GST, TCS and TDS (they come back).

An order's forward and reverse lines **in the same payout are netted**, so a returned order shows only what it cost: its money, TCS, TDS
and receivable cancel and are left off. Example, order ...058 (₹1,326, returned) in the 30 Oct payout of ₹1,075.34 with the kept order
...047: ...047 books bank 1,259.42, fixed fee 50.00, IGST 9.00, TCS 6.32, TDS 1.26 against the receivable 1,326.00; ...058 books fixed fee
50.00, return fee 106.00, IGST 28.08 and a bank leg of **-184.08** (its share: ...047's money covered its fees). The two bank legs add to
1,075.34, the bank statement line.

The paisa the three-decimal figures leave over goes in the TCS line: there is no Round off entry. TCS and TDS ledgers are per financial year
(April to March): `Tax Collected at source 26-27`, so 1 Apr 2027 needs `27-28` created in Tally first.

Tally export: not built yet. The owner decided (4 Nov 2026) the file carries **one voucher per payout** (all orders' lines, order numbers
on each line, one bank line equal to the statement), not one per order; the ledger keeps the per-order shares so every order proves itself.

## Order stages

- no payout booked: `awaiting_settlement` (open).
- paid and taken back, credit note not issued yet: `awaiting_return` (open); `complete` once the parcel is received and the credit note exists.
- credit note issued, Myntra paid and has not taken the money back yet: `awaiting_clawback` (open); `complete` when its reverse line arrives in a later payout.
- a settlement line more than 5 paise out in the ledger: `bad_facts` (nothing is booked for it).
- an order Myntra netted before paying (returned within its payment period) has no payout at all and is complete once the credit note exists: no money moved.

Every ledger run re-reads the Myntra orders whose provable payouts changed (and those that hold payouts no longer proved), even
complete ones, so an upload shows in the ledger within a couple of minutes (the screen starts the refresh). Taking a report back
(Delete, with a dry run first, logged in `upload_deletions`) reverses it the same way.

## Checked on October 2026 (read-only, before anything was applied)

Both reports parsed, every line adds up, the two readers agree on all 52 shared lines. Booked against the live October ledger facts of the
35 orders: 21 complete (16 were awaiting settlement), 14 awaiting the returned parcel (pending); all vouchers balance. Totals against Myntra's
own tax invoices: fixed fee ₹1,800.00 (invoice ₹1,800.00), return fees ₹3,108.00 (₹3,108.00), commission ₹2,022.01 (₹2,022.00),
input GST ₹1,247.38 (₹1,247.40); bank ₹12,862.76 (the statement).

## Uploading

Analytics → Bank & card → Upload → *Myntra settlement report*. The result lists every payout with its state (in the bank and booked /
not in the bank statement yet / differs from the bank credit). Weekly is useful (a returned parcel, a stuck order or a wrong charge shows
days earlier); monthly is the minimum: after month end, with the bank statement, upload the monthly settled report.
