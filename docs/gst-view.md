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
- Myntra is a marketplace: its supplies are reported under the e-commerce operator (Myntra Designs, GSTIN
  29AAECM9636P1ZJ) and are kept apart from Shopify's by a switch above the table.

## What is on the page

- A month picker (from the accounting start date; the last finished month is the default), a Shopify / Myntra / Both switch.
- Four cards: sales (sales invoices + fee invoices), credit notes, net taxable value, net GST (IGST, CGST, SGST).
- Checks: every document has a state; no order waiting for an invoice; how many credit notes and invoices the ERP issued
  itself (they get `ERP/CN/2627/NNNN` and `ERP/IN/2627/NNNN` numbers when exported to Tally, which is not built yet); the
  Myntra orders booked from before the books started; and an error line if the state table ever stops adding up to the documents.
- **By state and rate**: sales, fee invoices, credit notes, net taxable value, net IGST, CGST and SGST, with a total row. A
  state or rate is a row of its own. UP sales carry CGST + SGST, every other state IGST (this follows the invoice).
- Lists (paged): sales invoices, credit notes (with who issued each), ERP fee invoices, orders not invoiced yet.
- **Download Excel**: always the whole month, both channels, whichever switch is selected. Sheets: Summary, Shopify by state,
  Myntra by state, Sales invoices, Fee invoices (ERP), Credit notes, Not invoiced yet. Real numbers and real dates, a frozen
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
- ERP-issued credit notes and invoices carry no number until the Tally export assigns them.
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
