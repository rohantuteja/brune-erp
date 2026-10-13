# Bank & card: statements matched line by line

Analytics → **Bank & card** (admins only) takes the company's bank statement, the founder's credit card statement and GoKwik's settlement report, works out what every line is, and lets a person file the rest under a bucket. It is the input for the accountant's Tally file; nothing here posts to Tally, Shopify or Unicommerce.

## What gets uploaded

| File | Account | Read by | Checked before anything is stored |
|---|---|---|---|
| ICICI "DetailedStatement" `.xlsx` | ICICI current account (bank, company) | `xlsxRows` + `parseBankRows` in `_shared/statements.ts` (a small zip/XML reader: no dependency, runs on Deno and Node) | running balance follows from every amount; transaction ids unique; serial numbers without a gap |
| Kotak credit card statement `.pdf` | Kotak credit card (card, holder = founder) | `unpdf` text (page by page; merged text loses line breaks) + `parseCardText` | purchases, fees, payments and "total amount due" all agree with the statement's own totals |
| GoKwik `rawSettlementReport` `.csv` | none (feeds the matching) | `_shared/gokwik-report.ts` | each payment: amount − fee − GST = what was credited; payment ids unique |

A file that does not add up is refused whole (nothing is stored) and the failed checks are shown. The same file twice is recognised by its hash. An overlapping statement (July–Sep, then July–Oct) adds only the new lines: each line's key is the bank's transaction id (card: a hash of date, description and amount, numbered when repeated). **Only the lines are stored, never the file.** `settlement_v2` carries the same numbers as `rawSettlementReport`; upload only the raw one.

Upload goes through the `finance-import` edge function (admin login or `x-cron-key`), actions `statement`, `gokwik`, `rematch`. Files up to 5 MB.

## How a line is classified (`_shared/bank-match.ts`, first match wins)

1. **Pairs that cancel**: a bank credit saying RETURN/REVERS that repeats an earlier debit of the same amount within 5 days (the ICICI bounce glitch on the ₹1,06,000 payments), or a card credit that repeats a charge. Both lines become `Returned or reversed (no entry)`, status *no entry needed*.
2. **Proof from another system** (status *matched*): an `Easebuzz` credit equal to a GoKwik payout (grouped by settlement UTR, within 3 days); a `White Wizard` (Velocity) credit equal to a COD payout in the ledger (`finance_velocity_payouts()`: `ledger_orders.facts.remitted` grouped by UTR); a `FACEBOOK` debit whose narration ends in the number of a stored Meta invoice and equals its total (or the total less 2% TDS on the pre-GST amount). When nothing proves it the line is only *suggested* (upload the report/invoice that covers it) or *needs review* (amount differs from the invoice).
3. **Your rules** (`finance_rules`, status *matched*): a payee, or text the narration contains, always goes to a bucket. Created by ticking "Remember payee" when filing.
4. **Built-in guesses** (status *suggested*): the note typed on a UPI/IMPS/INF payment (`pcrate` → Labour Charges, `trims` → Fabric and Consumbale, `salary`, `rent`, `transport`, `machine` → Sewing Machine GST, …), known merchants on the card (Google Workspace → Software Expenses @ 18%, Claude/ChatGPT → Software Expenses, GoKwik on the card → Goexcelsior Private Limited (KwikChat), Shopify, Amazon → Subscription Charges, YouTube/Google Play → Suspense …), the card's Fuel category → Car Fuel Expenses, bank and card charges → Bank Charges, cash deposits → CASH AT POS DELHI, RTGS credits → Suspense.
5. Anything else is *needs review*.

Founder's card: a purchase is a company expense owed to the founder; the founder paying his own card bill is `Founder card payment (no company entry)`.

## A person's decision is final

`finance_line_assign(ids, bucket, remember)`, `finance_line_confirm(ids)` and `finance_line_reset(ids)` (security definer, admin only, 1,000 lines per call, every change logged in `finance_line_log` with who and when). A decided line has `decided_at` set and the engine never changes it again: re-matching only touches lines nobody has decided. When a payee is remembered the screen re-runs the matching so the payee's other open lines are filed at once. A payout a person has already filed against a line cannot explain another credit.

## The screen

Upload panel (what, file, upload; failed checks listed), statements already uploaded (with the GoKwik coverage), dates (defaults to the accounting start date, 1 Oct 2026, because earlier books are closed; "All dates" shows the rest) and account, status cards, **Label by payee** (one decision files every line to a payee), **By bucket** totals (click to filter), and the lines (status pills, money in/out, search, sort, paging, CSV, multi-select with File / Confirm suggestions / Reopen). Phone: lines become cards. Filters live in the URL (`bstatus`, `bacct`, `bflow`, `bbucket`, `bq`, `bfrom`, `bto`, `ball`, `bsort`, `bdir`, `bpage`, `bsize`).

## Tables and security (migrations 022, 023, 024)

`finance_accounts`, `finance_statements`, `finance_lines`, `finance_buckets`, `finance_rules`, `finance_line_log`, `gokwik_payments`, `vendor_invoices` (the four Meta invoices, Jun–Sep 2026, are seeded). Row level security: only `finance_admin()` (role `admin`) can read; **nobody writes from a browser**: imports run as the service role and decisions go through the logged functions. `finance_velocity_payouts()` and `finance_apply_matches()` are service-role only.

**A bucket is a Tally ledger** (migration 029, 14 Oct 2026): its name is the ledger's name, from the owner's `tally-names-proposed.xlsx`, spelling included (`Fabric and Consumbale`, `Miscelleneous Expenses`, `Shopify Commerce Signapore Pte. Ltd.`). The Tally file therefore needs no mapping, and the three ledgers the order ledger also posts to are the same strings on both sides (`Easebuzz Private Limited` = GoKwik payouts, `COD receivable (Velocity)` = Velocity remittances, `Razorpay Payment Private Limited`; `bank-match.test.ts` checks them against `ledger.ts`). The list is `BUCKETS` in `supabase/functions/_shared/bank-match.ts` and is mirrored by the migration (a test compares the two). Not ledgers: `Returned or reversed (no entry)`, `Founder card payment (no company entry)`, and `Purchase Accounts` (a Tally group, kept as the bucket for fabric and supplier-bill payments: a payment of ₹5,000 and over settles the supplier's invoice, so the Tally file posts it to that supplier's own ledger, linked per payee; that link is still to be built). `Myntra receivable (order control)` is a bucket too, for Myntra's payouts.

What changed from the first list: salary, rent, software, telephone and travelling split into several ledgers (Salary Payable, Director Salary Payable- Rohan Tuteja / Adrija Halder, Staff Welfare Expenses; Rent Payable, Rent - Director Resident; Software Expenses @ 18% / Software Expenses / Subscription Charges / Apps Charges; Telephone and Internet Expenses GST / Telephone & Internet Expenses; Travelling Expenses / Car Fuel Expenses / CAR SERVICE EXPENSES), `GoKwik payout` → `Easebuzz Private Limited`, `Velocity COD remittance` → `COD receivable (Velocity)`, `Velocity wallet recharge` → `Velocity Prepaid Recharge Account`, `Meta ads (invoice payment)` → `Facebook India Online Services Private Limited`, the `To confirm: …` family → `Suspense` (cash deposit → `CASH AT POS DELHI`, machinery → `Sewing Machine GST`). `Purchase Accounts` and `FINANCE COST` (interest and other finance costs) were kept under their old names after the owner asked on 14 Oct 2026 (migration 030, which also added `Myntra receivable (order control)`).

**Moving the data (migration 029, run 14 Oct 2026 on 160 lines and 17 rules):** a line or rule on a bucket that became one ledger moved to it; one that became several moved to the closest (Salary Payable, Rent Payable, Software Expenses @ 18%, Telephone and Internet Expenses GST), except a decided salary payment of exactly ₹50,000 naming a director, which went to that director's ledger. 19 decided lines moved and each is logged in `finance_line_log` as `renamed`; no decision was undone (`decided_by`, `decided_at`, status unchanged). A re-match then recomputed the undecided lines with the new rules (6 changed: ChatGPT/Claude, KwikChat, Shopify, Amazon, fuel). Decided lines the owner may want to check: the split buckets' lines default to the first ledger, so a payment that belongs to `Rent - Director Resident`, `Staff Welfare Expenses`, `Software Expenses` (no GST bill) or `Telephone & Internet Expenses` (no GST) has to be refiled by hand.

## Taking an upload back (migration 026)

Each upload on the Bank & card and Velocity wallet pages has a **Delete** button (an "Uploaded files" list on the Velocity page; "Statements uploaded" on the Bank page, which also lists the GoKwik reports). It asks the server for a **dry run** first and shows what would happen; only "Delete this upload" deletes. Nothing is deleted unless the request says `dry_run: false` exactly.

- **What goes:** the upload's record and the lines it brought in. A line is stored once, by the first upload that had it, so a line another upload of the **same account / ledger** also covers (that upload's period contains the line's date; a statement or report holds every line of its period) is **moved to that upload, not deleted**. That upload's new/duplicate counts are corrected.
- **What falls back:** the bank matching is re-run straight after, so a payment only the deleted upload proved goes back to "suggested" (bank payments proved by deleted Velocity top-ups or GoKwik payouts; Velocity top-ups lose their bank payment when the bank statement goes).
- **A person's decision:** lines a person filed go only when their own statement goes (the confirmation counts them: "N were filed by you"); a confirmed match to a deleted proof stays as filed.
- **GoKwik:** payments carry the file that last held them (`source_file`), so deleting a report removes the payments still attributed to it; a payment also in a later report goes with whichever file last carried it (upload that report again to bring it back).
- **Log:** every delete is written to `upload_deletions` (who, when, what, counts), shown as "Recently deleted" under the list. Admin read only. A Meta (or other vendor) invoice cannot be deleted from here: `velocity_delete_invoice` only touches `vendor = 'Velocity'`.
- **Functions:** `finance-import` (`delete_statement`, `delete_gokwik`) and `velocity-import` (`delete_ledger`, `delete_invoice`); SQL `finance_delete_statement`, `velocity_delete_import`, `velocity_delete_invoice`, `gokwik_delete_report` (service role only; atomic), `gokwik_reports()` (admin, for the list).

## Not built yet

- The Tally import file from this data and the ledger (needs the accountant's chart of accounts, voucher types and numbering).
- Myntra settlements (no settlement has landed yet).
- Reading vendor invoices automatically (Gmail read access is a later session); GoKwik/Easebuzz fee invoices for the GST input credit.
- Questions for the accountant (RTGS ₹7.82L and the cash deposits, the founder's ledger, GoKwik receivable at 30 Sep, TDS on Meta, closing stock) are collected only when the owner asks for the list.
