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
4. **Built-in guesses** (status *suggested*): the note typed on a UPI/IMPS/INF payment (`pcrate` → Labour Charges, `trims` → Fabric and Consumbale, `salary`, `rent`, `transport`, `machine` → *To confirm: machinery*, …), known merchants on the card (Google Workspace, Claude/ChatGPT, GoKwik, Shopify …), the card's Fuel category → Travelling Expenses, bank and card charges → Bank Charges GST, cash deposits and RTGS credits → *To confirm*.
5. Anything else is *needs review*.

Founder's card: a purchase is a company expense owed to the founder; the founder paying his own card bill is `Founder card payment (no company entry)`.

## A person's decision is final

`finance_line_assign(ids, bucket, remember)`, `finance_line_confirm(ids)` and `finance_line_reset(ids)` (security definer, admin only, 1,000 lines per call, every change logged in `finance_line_log` with who and when). A decided line has `decided_at` set and the engine never changes it again: re-matching only touches lines nobody has decided. When a payee is remembered the screen re-runs the matching so the payee's other open lines are filed at once. A payout a person has already filed against a line cannot explain another credit.

## The screen

Upload panel (what, file, upload; failed checks listed), statements already uploaded (with the GoKwik coverage), dates (defaults to the accounting start date, 1 Oct 2026, because earlier books are closed; "All dates" shows the rest) and account, status cards, **Label by payee** (one decision files every line to a payee), **By bucket** totals (click to filter), and the lines (status pills, money in/out, search, sort, paging, CSV, multi-select with File / Confirm suggestions / Reopen). Phone: lines become cards. Filters live in the URL (`bstatus`, `bacct`, `bflow`, `bbucket`, `bq`, `bfrom`, `bto`, `ball`, `bsort`, `bdir`, `bpage`, `bsize`).

## Tables and security (migrations 022, 023, 024)

`finance_accounts`, `finance_statements`, `finance_lines`, `finance_buckets`, `finance_rules`, `finance_line_log`, `gokwik_payments`, `vendor_invoices` (the four Meta invoices, Jun–Sep 2026, are seeded). Row level security: only `finance_admin()` (role `admin`) can read; **nobody writes from a browser**: imports run as the service role and decisions go through the logged functions. `finance_velocity_payouts()` and `finance_apply_matches()` are service-role only.

Bucket names come from the owner's Tally profit and loss (spelling included: `Fabric and Consumbale`, `PAYMENT GATEWAY CHARGES`), plus bookkeeping buckets the accountant maps to a ledger (`GoKwik payout`, `Velocity COD remittance`, `Meta ads (invoice payment)`, the `To confirm: …` family). The Tally ledger each bucket maps to is **not** decided: that waits for the accountant.

## Not built yet

- The Tally import file from this data and the ledger (needs the accountant's chart of accounts, voucher types and numbering).
- Myntra settlements (no settlement has landed yet).
- Reading vendor invoices automatically (Gmail read access is a later session); GoKwik/Easebuzz fee invoices for the GST input credit.
- Questions for the accountant (RTGS ₹7.82L and the cash deposits, the founder's ledger, GoKwik receivable at 30 Sep, TDS on Meta, closing stock) are collected only when the owner asks for the list.
