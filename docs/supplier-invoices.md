# Supplier invoices: reading the PDFs for Tally

**Goal.** When the ERP pushes to Tally it must create the supplier's ledger if it is missing and post the purchase voucher (and every advance paid before the invoice came) without anyone typing an invoice. Nothing here posts to Tally yet. The plan was agreed on 15 Oct 2026; it is built in four slices, each reviewed before it goes live.

| Slice | What | State |
|---|---|---|
| 1 | The reader (`_shared/invoice-reader.ts`) and its tests: pure code, no database, no network | built |
| 2 | Tables (`supplier_bills`, lines, layout memory, item map, supplier GSTIN / PAN / state / Tally name), a private storage bucket for the original PDFs, the upload page (Analytics → Supplier bills), supplier creation, auto-accept after the first confirmed bill per supplier | not started |
| 3 | Bank matching: advances waiting for an invoice (flag after 15 days) and unpaid invoices; the payee → supplier link | not started |
| 4 | The "Tally-ready" purchase voucher preview and the item map | not started |

## Decisions (owner, 14-15 Oct 2026)
- PDFs arrive only through the upload page (no mailbox). The original PDF is stored for records.
- **No paid service and no AI call**: the reader is rules plus arithmetic. (The Anthropic API was considered and declined: the owner does not want a usage bill.)
- No manual invoice form. The first invoice from each supplier is confirmed once; later ones are accepted automatically when every check passes, and anything doubtful is held.
- Invoices dated before 1 Oct 2026 are opening bills: used for matching, never exported.
- The ERP inventory module (physical fabric, for production) is NOT matched to invoice lines. The purchase voucher follows the invoice as printed; stock in Tally is for value. Kilos go to `KNITTED FABRIC` (KGS), metres to `Shirting Fabric` (MTR), with the HSN of each invoice line. Whether closing stock is a month-end value entry from the ERP shelf value is the accountant's call.
- Tally names, taken from the accountant's own sample `Purchase UP` voucher and trial balance: voucher type `Purchase UP`, the voucher number and reference are the supplier's invoice number, ledger `Purchase Raw Material`, GST on `IGST Input  UP` (two spaces; `CGST Input UP` + `SGST Input UP` for a supplier in Uttar Pradesh), rounding on `ROUND OFF`, godown `Main Location`, batch `Primary Batch`, supplier ledger under its trade name with GSTIN, state and PAN. Open question for the accountant: does he park purchase GST on `INPUT NOT CLAIMED FOR INV NOT IN 2A` until the invoice shows in GSTR-2B?

## The reader (slice 1)
`readInvoicePdf(items, { companyGstin, today })` takes the text of the PDF with its position (pdf.js through `unpdf`, the library the card-statement reader already uses; **not pypdf, which garbles TallyPrime PDFs**) and returns every invoice in the file.

How it reads, since the layouts differ between billing programs:
- **GSTIN**: a fixed shape with a check digit; the first one that is neither ours nor the transporter's is the supplier's. The state and the PAN come from it.
- **Invoice number and date**: found by their label (`Invoice No`, `Invoice Date`, `Date of Invoice`, `Dated`), the value being the next thing to the right or below.
- **Amounts are solved, not located**: a taxable value, a standard GST rate (0.25, 3, 5, 12, 18, 28 %), a GST amount that is that rate of it (IGST, or two equal halves for CGST + SGST) and a total within a rupee of rounding, wherever they are printed.
- **Line items**: by column. Every header is a column, a number goes to the nearest one, a "Qty Unit" cell is split, and the description is whatever sits between the serial number and the HSN (headers are often centred over a left-aligned description).
- **Supplier name**: the "for <name>" line above the signature.
- **Copies and continuation**: an invoice printed twice in one file (original for the recipient, duplicate for the transporter) is one invoice read once; a page with no supplier or invoice number continues the one before.

Each invoice carries checks: supplier GSTIN check digit, billed to our GSTIN, invoice number, date (not in the future), amounts agree, IGST vs CGST + SGST fits the states, lines add up to the taxable value, quantity × rate = amount for every line. `status` is `ok` when all pass, `review` when something was read but a check failed, `unreadable` when neither a supplier nor an invoice number was found; a PDF with no text at all comes back as `problem: 'no_text'`.

**Known limits.** One GST rate per invoice (an invoice mixing 5 % and 12 % lines comes back for review); a PDF that is only a picture has no text; a layout the reader has not met may be held for review. It was built against six real invoices from five billing programs (all IGST 5 %, none CGST + SGST), so a first supplier in Uttar Pradesh is the one to watch.

**Fixtures.** `_shared/fixtures/invoices/*.json` are those six invoices as pdf.js text items with every name, GSTIN, address, phone number and bank detail replaced; the layout is untouched. Never add a real invoice to the repo: replace the personal details first.
