# GST view (Analytics → GST)

One month of sales for GSTR-1, by state and rate, worked out from the stored order ledger, with an Excel file of everything on
the page. Built 18 Nov 2026. It only reads `ledger_entries` and `ledger_orders` (nothing is written, no migration, no function):
the arithmetic is in the browser (`src/lib/gstReport.js`, tested), so the figures are exactly the ledger's.

## The rules (the owner's, 14 Oct and 18 Nov 2026)

- **A sale counts in the month the ORDER was placed** (Shopify's order time, Myntra's order time, both IST), whether or not any
  money has arrived. Half of October's sales were still unpaid when this was built and are all in the month's sales. Payment
  only decides whether an order is "open" on the Ledger page; it never moves a sale between months. The daily Myntra payment
  reports cannot change a sale.
- **A return reduces the month its CREDIT NOTE is dated** (Unicommerce's return invoice date, or the ERP's own credit note date
  when Unicommerce's is missing or short), not the month of the sale. A return whose credit note does not exist yet has not
  reduced anything yet.
- **Fees the ERP keeps from a customer** on a return (the ₹99 return fee, a ₹100 COD charge) are invoiced by the ERP (the
  accountant's B1 answer) and are sales in the month of that invoice. They are listed apart ("Fee invoices").
- **An order Unicommerce has not invoiced yet is not a sale.** It has no ledger entries, so it is not in the figures; the page
  lists it under "Placed this month, not invoiced yet" and the first check line warns about it. Before filing a month, that list
  should be empty.
- The four Myntra orders placed on 27 and 30 Sep are booked in **October**, as the owner decided (September's books were closed
  and had no Myntra sales). The page says so under its checks. This is a one-off: nothing similar can happen again.
- **Myntra is both in Table 7 and in Table 14(a) of GSTR-1** (checked 18 Nov 2026 against the GSTN advisory on Notification
  26/2022 and the GST portal's Table 14 help). Myntra is an e-commerce operator that collects TCS under section 52 (every payout
  shows its TCS), and you invoice the customer yourself, so your sales through it are consumer (B2C) sales like Shopify's: they
  go in **Table 7**, state and rate wise, together with Shopify's. In addition, **Table 14(a)** asks for "the ECO-GSTIN wise
  summary of the supplies made through ECO on which ECO is liable to collect tax at source (TCS) and liability on which has
  already been reported in any table 4 to 10", that is a summary under Myntra's GSTIN (Myntra Designs, 29AAECM9636P1ZJ) of sales
  already in Table 7. "No taxable value or tax liabilities will be auto-populated from this table to GSTR-3B": tax is paid on
  the normal tables, and the TCS Myntra deducts is claimed from the cash ledger, not through GSTR-1. Table 14(b) and Table 15
  are for section 9(5) supplies (services such as transport and accommodation, not apparel). So the view's **Both channels**
  figure is Table 7 and its **Myntra** figure is Table 14(a); Myntra must not be left out of Table 7. The portal's Table 14 fields
  are the operator's GSTIN, the net value of supplies and the tax amounts; the advisory spells out "net of credit / debit note"
  only for 14(b), so the 14(a) value is shown net of Myntra's credit notes to agree with Table 7, which the accountant should
  confirm. Amendments go in Table 14A.

## What is on the page

- A month picker (from the accounting start date; the last finished month is the default) and a switch: **Both channels (Table 7)** (the default), **Myntra (Table 14)**, Shopify only.
- Four cards: sales (sales invoices + fee invoices), credit notes, net taxable value, net GST (IGST, CGST, SGST).
- Checks: every document has a state; no order waiting for an invoice; how many credit notes and invoices the ERP issued
  itself (they carry `ERP/CN/2627/NNNN` and `ERP/IN/2627/NNNN` numbers from the ledger, `docs/document-numbers.md`; an unnumbered one is a warning); the
  Myntra orders booked from before the books started; and an error line if the state table ever stops adding up to the documents.
- **By state and rate**: sales, fee invoices, credit notes, net taxable value, net IGST, CGST and SGST, with a total row. A
  state or rate is a row of its own. UP sales carry CGST + SGST, every other state IGST (this follows the invoice).
- Lists (paged): sales invoices, credit notes (with who issued each), ERP fee invoices, orders not invoiced yet.
- **Download Excel**: always the whole month, both channels, whichever switch is selected. Sheets: Summary (with a "Where it goes in GSTR-1" block), B2C all (Table 7), Myntra (Table 14), Shopify by state,
  Sales invoices, Fee invoices (ERP), Credit notes, Not invoiced yet. Real numbers and real dates, a frozen
  header row, one file per month named `GST-sales-YYYY-MM.xlsx`.

## How it is computed

`fetchGstMonth` (`src/lib/gstData.js`) reads the month's entries on the five GST accounts (`GST SALES`, `GST SALES RETURN`,
`IGST OUTPUT UP`, `CGST Output UP`, `SGST Output UP`; vouchers `sale`, `credit_note`, `invoice`) dated in the month, then the
orders they belong to (state, channel, rate, order date) and the orders waiting for an invoice. `buildGstReport` groups the
entries into documents (one invoice, credit note or fee invoice: same order, voucher, date and document number or memo), sums
each document, and groups them by channel, state and rate. A credit note's taxable value is the debit to `GST SALES RETURN`
plus the debit to `GST SALES` (a COD charge); a sale's is the credit to `GST SALES`. The rate is the order's (the ledger
split the tax with it); if an order is missing, the rate the amounts imply is used.

## Not covered (the accountant maps the figures onto the GSTR-1 tables)

- No HSN summary (the ledger holds quantities, not HSN codes), no B2CL / B2B split (every sale is to a consumer), no
  amendments or nil-rated lines.
- One rate per order. All October 2026 orders are 5%; an invoice with items at two rates would be shown at the first item's rate
  (the ledger itself splits tax with one rate per order).
- (Numbers for the ERP's own credit notes and invoices were added the same day: `docs/document-numbers.md`.)
- A net CGST or SGST of a paisa either way can appear on a state (Unicommerce splits an odd paisa of tax between CGST and SGST
  differently on a sale and on its credit note).

## Checked when built (read-only, 18 Nov 2026)

- October 2026 worked out independently in SQL: 544 sales invoices, ₹7,85,966.92 taxable, GST ₹39,297.48 (IGST 37,053.20,
  CGST 1,122.17, SGST 1,122.11); 42 ERP fee invoices ₹3,963.03; 139 credit notes ₹1,45,712.86 (47 from Unicommerce, 92 from
  the ERP). The state-wise rows add up to those totals exactly.
- The real code was run on real ledger rows (seven orders of 15 Oct with credit notes, including an order whose Unicommerce
  credit note and ERP COD note fall on the same day) against an independent per-row total: equal to the paisa, 5 sales, 3 fee
  invoices and 10 credit notes found as expected.
- The Excel file was read back with the ERP's own `.xlsx` reader and structurally validated (zip, XML well-formedness, style
  indices, row and cell order). It was not opened in desktop Excel.
