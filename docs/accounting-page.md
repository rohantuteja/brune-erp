# Accounting (main menu, admin only): month checklist and the Tally file

Built 18 Nov 2026 at the owner's request. A page of its own in the main menu (not an Analytics tab): pick a month, see every step still to
do before that month's Tally file can be generated, then generate the file. Nothing is sent to Tally: the accountant imports a JSON file.

## The checklist (`src/lib/accountingChecklist.js`, `accountingData.js`)
Worked out live from what the ERP holds. Each step is done, to do, or information; a to-do step marked **blocks the file** keeps the
Generate button disabled.

| Section | Step | Blocks the file? |
|---|---|---|
| Uploads | the month has ended | yes |
| | ICICI statement runs to the month end | yes |
| | Kotak card statement covers the cycle ending on the 20th | yes |
| | every Easebuzz credit of the month in the bank is matched to a GoKwik payout line (the bank decides, not the date of the last transaction: payments made in the last days of the month are paid out, and listed in the report, next month; a first version compared the last transaction date and wrongly blocked October on 18 Nov) | yes |
| | Velocity wallet ledger runs to the month end | yes |
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
| GST | GSTR-3B recorded as filed | no |
| Tally | every ledger the file uses (order-ledger accounts, bank buckets, the ledgers of the month's bill vendors) is in Tally (`tally_ledgers.status = in_tally`); the others are listed with "to be created / renamed / not in the list" | yes |

## The Tally file (`tallyVouchers.js`, `tallyJson.js`)
First version, as the owner asked: a file, not a sync. The order ledger's entries are grouped into vouchers exactly as the ledger holds
them (the owner's rule: reproduce the ledger event by event, nothing lumped into monthly journals):

- **Sales** (`SALES UP`): each Unicommerce sale invoice and each ERP fee invoice (₹99 return fee, retained COD charge): Dr Customer (or
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
Purchase vouchers from the bills (`Purchase UP`, expense bills as `GST EXPENSES`, the gateway true-up), payment and receipt vouchers for the other
bank lines (salaries, rent, suppliers, Suspense), the card journal (`Rohan (Director Personal Credit Card)`), stock items on sales and the monthly stock
journal, the Meta and Velocity month-end provisions, an export log that stops an already-exported voucher from changing (rule: an entry exported to
Tally is never changed; a correction is a new document dated when it is found). Decisions still open are in the memory notes `tally-accountant-answers`
and `tally-ledgers-to-create`.
