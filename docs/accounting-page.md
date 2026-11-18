# Accounting (main menu, admin only): month checklist and the Tally file

Built 18 Nov 2026 at the owner's request. A page of its own in the main menu (not an Analytics tab): pick a month, see every step still to
do before that month's Tally file can be generated, then generate the file. Nothing is sent to Tally: the accountant imports a JSON file.

## The checklist (`src/lib/accountingChecklist.js`, `accountingData.js`)
Worked out live from what the ERP holds. Each step is done, to do, or information; a to-do step marked **blocks the file** keeps the
Generate button disabled.

| Section | Step | Blocks the file? |
|---|---|---|
| Uploads | the month has ended | yes |
| | ICICI statement runs to the month end (its end date is its LAST TRANSACTION: up to 3 days short is a note that does not block, for a holiday with no transaction; more than 3 blocks) | yes |
| | Kotak card statement covers the cycle ending on the 20th | yes |
| | every Easebuzz credit of the month in the bank is matched to a GoKwik payout line (the bank decides, not the date of the last transaction: payments made in the last days of the month are paid out, and listed in the report, next month; a first version compared the last transaction date and wrongly blocked October on 18 Nov) | yes |
| | Velocity wallet ledger runs to the month end (same 3-day tolerance, same reason) | yes |
| | Myntra settlement reports (how far loaded) | information |
| | GSTR-2B loaded for the month | no |
| Bills | no bill waiting for review | yes |
| | every invoice in GSTR-2B has its bill (only once a 2B is loaded) | yes |
| | the regular supplier invoices (Meta, Velocity, GoKwik dated the 1st of the next month; Easebuzz the last day) | no |
| Clear up | every bank and card line of the month has a bucket | yes |
| | no order needs attention | yes |
| | no order placed in the month is waiting for a Unicommerce invoice (sales are booked on the order date) | yes |
| | no order held back by an outage; the ledger refreshed in the last 36 hours (stale = asked, not blocking) | held: yes |
| | open items (awaiting payout / settlement / return, RTO on the way): they close by themselves | information |
| Tally | every ledger the file uses (order-ledger accounts, bank buckets, the ledgers of the month's bill vendors) is in Tally (`tally_ledgers.status = in_tally`); the others are listed with "to be created / renamed / not in the list" | yes |

**No GST step (owner's correction, 18 Nov 2026).** The checklist has no "file GSTR-3B" or "record it" step and no GST section: GSTR-1 and GSTR-3B are
filed from Tally once the month's data has been imported, so they cannot be a condition for making the file. Only the GSTR-2B matters here (Uploads:
loaded for the month; Bills: every invoice in it has its bill, is booked from it, or is one the accountant books), because it decides which supplier bills
exist to be booked. The GSTR-3B screen under Analytics stays as a working sheet; its "I filed" button only carries the closing credit into the next month.

**A supplier's own ledger that Tally lacks (migration 048, 18 Nov 2026).** A vendor saved with "it is not in my Tally yet" (`vendors.ledger_new`) is a
ledger the file creates. Such ledgers were not in `tally_ledgers`, so the checklist reported them as "not in the list of Tally ledgers" and blocked the
file (VIPUL ENTERPRISES, Mittal Hosiery Private Limited (Delhi), PicknPack Solutions India Pvt Ltd, 18 Nov). Migration 048 adds them to `tally_ledgers` as
`will_create` under Sundry Creditors and a trigger on `vendors` does the same for every vendor saved later, so the file's ledgers section and the
"imported" marking both cover them. What still blocks is only a ledger waiting to be renamed by hand in Tally, or a name that is in no list at all.

## The Tally file (`tallyVouchers.js`, `tallyJson.js`)
First version, as the owner asked: a file, not a sync. The order ledger's entries are grouped into vouchers exactly as the ledger holds
them (the owner's rule: reproduce the ledger event by event, nothing lumped into monthly journals):

- **Sales** (type `Sales`): each Unicommerce sale invoice and each ERP fee invoice (₹99 return fee, retained COD charge): Dr Customer (or
  Myntra receivable) / Cr GST SALES + output tax. Party, place of supply (the order's state in Tally's spelling, "Jammu & Kashmir"),
  Unregistered/Consumer, an *accounting invoice* (no stock items). A New Ref bill named by the invoice number.
- **Credit Note**: Unicommerce's and the ERP's own: clears the customer's bill (Agst Ref) of the sale invoice.
- **Receipt**: one per UTR (gateway payouts, COD remittances, Myntra settlements), dated by the bank, the UTR as the bank instrument number,
  a bill per order on the receivable (Easebuzz, COD receivable (Velocity), Myntra receivable).
- **Journal**: the per-order clearing of the customer's bill: gateway payment, COD delivery, store credit used and issued, goodwill, round off.
  Numbered `GW/<order>/<ddmm>` (gateway), `COD/`, `SC/`, `SCU/`, ...; a second one on the same day gets `-2`.

Format: JSON in the shape of TallyPrime's own Day Book export of the same vouchers (the accountant's `DayBook.json`): `tallymessage` of vouchers,
a debit has `isdeemedpositive: true` and a negative amount, a credit a positive one, dates `YYYYMMDD`, a stable GUID per voucher (a second import
is recognised, not duplicated). **Only the keys an import needs are written; the import itself has not been tested on a real Tally.** Hence the
**small test file** (3 vouchers of each type): import it into a COPY company first; whatever Tally says goes into `tallyJson.js` (one place).

Built-in checks shown after generating: every voucher sums to zero in the file; every ledger's debit and credit total in the file equals the
order ledger's own; no voucher was left out (an order with no state, or a set of entries that does not balance, is left out and named).

## The ledgers file (`tallyLedgers.js`, migration 046)
Tally imports ledgers from a file of the same kind as the vouchers, and reads an import file's messages in order, so the ledgers the file needs that are
not in Tally yet are created by **the same file: they come first, then the vouchers** (the owner's idea, 18 Nov 2026; `withLedgers`). A separate ledgers
file stays available as a fallback if Tally refuses a combined file (untested). Built from tally_ledgers (the ledger list): built from `tally_ledgers` (status `will_create`, each under its group; the customer control ledgers
bill by bill and Unregistered/Consumer), nothing typed. Seven today: Customer (order control), Myntra receivable (order control), Goodwill credits, Myntra
Return Fees, Myntra Commission (added to the list by migration 046), Tax Deducted at source 26-27, Tax Collected at source 26-27. **Renames (3) are not in
the file**: the accountant does them by hand (Alter Ledger), because an import cannot be trusted to rename rather than make a second ledger next to a year
of vouchers. The ledgers the file creates do not block the checklist (information only); the 3 renames and any name not in the list do. After the first real import
the owner presses "The accountant imported this file into Tally" (and "I renamed them" for the renames): `tally_ledgers_mark`, admin only, logged in
`tally_ledger_log`; the ledgers are then in_tally and later months do not create them again. The master shape (`metadata.type` Ledger, `parent`, `isbillwiseon`) is Tally's own pattern but, like the
vouchers, **has not been imported on a real Tally**: try it on a copy company.

## Not in the first version (listed on the page)
Purchase vouchers from the bills (type `Purchase`: the owner's `Purchase UP` and `GST EXPENSES` are voucher *names*, not types; the gateway true-up), payment and receipt vouchers for the other
bank lines (salaries, rent, suppliers, Suspense), the card journal (`Rohan (Director Personal Credit Card)`), stock items on sales and the monthly stock
journal, the Meta and Velocity month-end provisions, an export log that stops an already-exported voucher from changing (rule: an entry exported to
Tally is never changed; a correction is a new document dated when it is found). Decisions still open are in the memory notes `tally-accountant-answers`
and `tally-ledgers-to-create`.

## Voucher types (the owner, 18 Nov 2026)
`SALES UP`, `Purchase UP` and `GST EXPENSES` are voucher **names** in his Tally, not types. The file uses the standard types: **Sales, Credit Note, Receipt, Payment,
Purchase, Journal** (and Stock Journal). Stock: sales stay accounting invoices (no stock items); closing stock stays a journal, as the accountant does it today
(a stock journal turning fabric into dresses and work in progress, and his own entry for the wholesale stock). The ERP will generate that monthly Stock Journal from
the cutting and production data (next slice).

## How each "covers the month" step decides (checked 18 Nov 2026)
Each date a step reads has a different meaning: a **bank statement** and a **Velocity ledger** end at their last transaction; a **card statement** ends at its billing date
(the period in the PDF header, exact); **GoKwik's report** is judged by the bank (every Easebuzz credit of the month matched to a payout), never by the last transaction
date, because payments made on the last days of a month are paid out in the next month and appear in the next month's report.
