# Numbers for the documents the ERP issues itself

Unicommerce's invoices and credit notes keep Unicommerce's numbers. The credit notes and invoices the ledger issues itself
(because Unicommerce's are missing or short, or because the ERP keeps a fee from a customer) get the ERP's own series, as the
owner's accountant allowed (A7, B4 and B1 of his answers, 14 Oct 2026):

| Document | Number | Examples of what it is |
|---|---|---|
| Credit note | `ERP/CN/2627/0001`, `0002`, ... | goods returned on an order older than Unicommerce; the ₹100 COD charge on a parcel returned to origin |
| Invoice | `ERP/IN/2627/0001`, `0002`, ... | the ₹99 return fee kept from a customer; a COD charge kept on a return |

16 characters (the GST limit). One gapless series per kind per **financial year** (April to March; `2627` is 2026-27); each
1 April the next year starts again at `0001` (`2728`). Nothing dated before `accounting_start_date` is numbered (it is never
exported). A credit note and an invoice are separate series.

## How it works (migration 042)

- The ledger rewrites every order's entries on each run, so the number is kept in `ledger_documents`, against the document's
  identity: **order, voucher kind and memo**. A trigger on `ledger_entries` (`ledger_number_entry`) looks the identity up each
  time an ERP credit note or invoice entry is written, issues the next number the first time it is seen, and puts the number in
  `ledger_entries.doc`. It is a trigger rather than a change to `ledger_save_orders` because earlier migrations replaced that
  function more than once and a replacement would have dropped the numbering without anyone noticing.
- **The number and the date never change.** If the ledger later computes another date for a numbered document, the registered
  date is kept and the computed one is remembered (`seen_date`).
- The first 92 credit notes and 42 invoices (all October 2026) were numbered when the migration was applied, oldest first, so the
  numbers run in date order.
- `ledger_document_check` (a view) says for every number whether it is `ok`, `gone from the ledger` (the ledger no longer
  produces that document), `value changed` (its debit total moved since it was first written) or `date differs from the ledger`.
  Anything other than `ok` needs a person: a document that was issued does not simply disappear; the correcting document is
  dated in the month it is found (the owner's rule for anything already exported).
- **Never reword the memos** of the ERP's credit notes and invoices in `supabase/functions/_shared/ledger.ts`
  (`return N (kind): credit note for goods`, `... credit note for the COD charge`, `... return fee`, `... retained COD charge`):
  a reworded memo is a new identity and the document would be numbered a second time. `ledger-memos.test.ts` pins them.

## Where the numbers show

Analytics → Ledger (the document column of an order's entries), Analytics → GST (the Number column of the credit note and fee
invoice lists) and the Excel file (Credit notes and Fee invoices sheets).

## Not done

- A credit note and the COD-charge credit note of one parcel returned to origin are two documents with two numbers (25 returns in
  October). They could be one credit note per return; that would change the ledger's vouchers and has not been asked for.
- The Tally export is not built; it will carry these numbers as the voucher numbers.
