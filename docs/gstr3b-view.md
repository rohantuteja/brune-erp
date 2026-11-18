# GSTR-3B working sheet (Analytics → GSTR-3B, admin only)

One month's GSTR-3B worked out from what the ERP already knows, to check before filing on the GST portal. **It files nothing and
changes nothing in the ledger.** Built 18 Nov 2026. The arithmetic is in the browser and tested (`src/lib/gstr3b.js`,
`gstr2b.js`, `gstr3bWorkbook.js`); the page is `src/pages/Gstr3bSection.jsx`; the data loader is `src/lib/gstr3bData.js`.

## What it shows

1. **Outward supplies, Tables 3.1 and 3.2.** The month's net sales from the GST view (`buildGstReport`, so the same order-date and
   credit-note rules, see `docs/gst-view.md`): taxable value and IGST / CGST / SGST for 3.1(a); inter-state sales by place of supply
   for 3.2 (home-state sales are CGST + SGST and are not in 3.2). **Since July 2025 the portal fills these two tables from GSTR-1 and
   they cannot be edited**, so this part is a cross-check of what the portal will show once GSTR-1 is filed. 3.1(b) to (e) (zero rated,
   nil rated, reverse charge, non-GST) are not worked out: the ERP has none.
2. **Input tax credit, Table 4(A)(5).** What the books hold against GSTR-2B (below).
3. **TCS and TDS deducted by Myntra**, from the settlements the ledger has booked (`Tax Collected at source` / `Tax Deducted at
   source` accounts): to compare with the TCS credit in the portal's electronic cash ledger. The screen does not count TCS as a
   payment of tax: how it reaches the return is for the accountant (not confirmed from official sources). TDS is income tax.
4. **Payment, Table 6.1.** Tax on sales less credit, by head, with the credit carried in (entered by hand) and what is left to carry on.

## Input credit: the books against GSTR-2B

**Books side** (nothing is posted to the ledger by Bills; these are read separately and never added twice):
- accepted supplier bills (`vendor_invoices`, status accepted, not void, not "opening", **dated in the month**), by head: `IGST` bills
  are IGST; `CGST+SGST` bills split in half. Vendors booked as `tie_out` (Easebuzz) are left out: the ledger books their GST at each payout.
- the GST on the payment gateway's fees (`IGST Input  UP` lines of `payout` vouchers) and on Myntra's fees (`settlement` vouchers), plus
  the confirmed, un-voided gateway true-ups (`gateway_trueups.gst_diff`, dated by `voucher_date`).

**GSTR-2B side.** Only credit that is in GSTR-2B can be claimed. The owner downloads the file from the portal (Returns Dashboard →
GSTR-2B → Download, JSON or Excel) and loads it on the screen. It is read in the browser (`src/lib/gstr2b.js`, `xlsxRead.js`); a
preview shows what was found and checks it (the month and GSTIN must be right, the file's own summary of available credit must
agree with the lines read, sections the screen does not read are named). **Nothing is kept until Save**, and only the lines are kept
(`gstr2b_files`), never the file. Another file for the month replaces the first.

**GSTR-2B is the source of truth (the owner's rule, 18 Nov 2026).** The credit claimed is everything GSTR-2B lists as available (not
"ITC not available", not reverse charge; supplier credit notes taken off), **whether or not the ERP has the bill**: a supplier can have
filed and still be late sending the invoice. The bills only explain the credit, and produce the list of bills still to upload.

**Matching (to explain the credit, never to limit it).**
- A bill is matched to a 2B line by supplier GSTIN and invoice number (`normInvoice`: no case, punctuation or leading zeros). A bill
  with no supplier GSTIN (Goexcelsior) is matched by invoice number and tax amount.
- The payment gateway and Myntra are matched **by supplier** (GSTIN), because the ERP holds no invoice numbers for them: the 2B total
  for the supplier against what the ledger booked in the month. Their invoices and the ledger lines fall in different months, so a
  difference is expected and only noted. Easebuzz's invoice is still on the upload list until it is uploaded as a tie-out bill.
- Every 2B line lands in exactly one place (a test proves nothing is lost): with a bill in the ERP (matched, differs, or the bill is still
  in review); gateway or Myntra (supplier level); supplier credit/debit note; no bill yet (**the "Bills to upload" list**); or left out
  (marked "ITC not available", or reverse charge, both listed).
- When a bill and its 2B line differ, **the 2B figure is claimed** and the bill is flagged (check the bill, or ask the supplier).
- **Bills to upload:** each invoice in 2B with no bill in the ERP, by supplier, with GSTIN, number, date, taxable value, tax, invoice
  value and whether the supplier is already a vendor (by GSTIN, or by name when the vendor has no GSTIN) or will be created on the
  first bill. It has its own Excel download and a sheet in the main workbook.
- A bill dated in the month that is not in 2B is not claimed this month (the supplier has not filed it); it appears in the month the
  supplier files it. A bill dated before the books started that turns up in this month's 2B is flagged for a check against double claiming.
- A bill whose tax type does not fit the supplier's state (IGST from a supplier in the buyer's state, or CGST + SGST from another state)
  is flagged as a data check on the bill.

**Without a 2B** the claim is simply the books, shown in amber as "not checked against GSTR-2B", with a warning.

## Supplier filing (Analytics → Supplier filing, admin only)

The owner's request (18 Nov 2026): a bill the ERP holds but the supplier has not filed cannot be claimed (it is not in GSTR-2B), yet it has to
be tracked: does it turn up next month, or must the supplier be reminded? `src/lib/gstr2bFollowup.js` (tested), page
`src/pages/SupplierFilingSection.jsx`. Every bill dated from the start of the books (not void, not "opening") is checked against **every
GSTR-2B that has been loaded** (`gstr2b_files`), matched by supplier GSTIN and invoice number (or number and tax amount when the bill has
no GSTIN). Status of a bill:

| status | meaning |
|---|---|
| In GSTR-2B | found in a loaded 2B; the month is shown (a later month than the bill's own counts as "turned up later") |
| In 2B, ITC not available | found, but marked "ITC not available" or reverse charge: look at it on the portal |
| Supplier has not filed it | the 2B for the bill's month (or a later one) is loaded and the bill is not in it |
| Load the 2B to check | the 2B for the bill's month should exist by now (made on the 14th of the next month) but has not been loaded |
| Not due yet | that 2B is not made yet: the supplier has until the 11th (13th for a quarterly filer) to file |

For a missing bill the page says whether the supplier filed other invoices of theirs in those months (so this one was left out) or has
nothing in the 2B at all, the age in days, and the last day to claim (30 November after the financial year of the invoice, section 16(4);
**confirm with the accountant**). Waiting bills are grouped by supplier with **Copy message** (a ready reminder for WhatsApp or email, naming
the invoices, the 2B months and our GSTIN; the ERP sends nothing), **I reminded them** (records who reminded about which bills and when) and
a **Note**. Records are kept in `gstr2b_followups` through `gstr2b_followup_add` (admin only, never edited or deleted). Nothing is claimed
or posted from this page: it only follows up. It only knows about the months whose 2B has been loaded, so each month's 2B has to be loaded
on the GSTR-3B tab for a bill to be found.

## An invoice the supplier filed but never sent (migration 047)
The credit is claimed from GSTR-2B either way; this is about the **books**. Each line of "Bills to upload" has three ways out (the owner, 18 Nov 2026):
1. **Upload** the invoice on the Bills page (normal; it then matches).
2. **Book from GSTR-2B**: pick an expense ledger (the Tally ledgers with role expense) and the ERP creates the bill from the 2B details (supplier, number, date, taxable
   value, IGST or CGST + SGST): `source = gstr2b`, accepted, no PDF (`gstr2b_book_bill`). It flows into the Tally file like any bill; a supplier not in the system is created
   with its own ledger (an existing Tally ledger of the same name is reused; otherwise a new creditor ledger is added to `tally_ledgers` as to be created by the file). Bills
   with no PDF are listed ("Booked from GSTR-2B, no invoice copy yet") and on the Accounting checklist as information, never a blocker; attaching the PDF on the Bills page
   (the normal "attach" of a bill with no file) takes it off the list. A tie-out supplier (Easebuzz) is refused: its invoice is uploaded.
3. **The accountant books this one** (wholesale stock, for example): no voucher from the ERP, no longer blocks the file, undoable (`gstr2b_mark_handled`, table `gstr2b_handled`
   keyed by supplier GSTIN + invoice number without case, punctuation or leading zeros).
Neither 2 nor 3 changes the credit. Whether an e-invoice shown in GSTR-2B is enough for the claim without the PDF is the accountant's to confirm; the PDF is kept as proof.

## Payment, Table 6.1

Order of set-off (sections 49 and 49A, Rule 88A): IGST credit pays IGST first; own-head credit pays CGST and SGST; leftover IGST credit
pays CGST and SGST; CGST / SGST credit pay IGST only once IGST credit is used up, and never each other. The tests prove it conserves
every rupee and pays cash only when no usable credit is left. Rule 86B (more than ₹50 lakh taxable in a month: at least 1% in cash) is
flagged.

**The electronic credit ledger is kept by the ERP (migration 045); nothing is typed.** Section 4 shows it: opening + claimed (all of GSTR-2B) - used to pay
tax on sales = closing. **October 2026 opens with the owner's Tally trial balance** (1-Apr-26 to 30-Sep-26): "GST Credit Ledger UP" closing
**₹13,41,161.00** (opening ₹7,24,983 + ₹9,24,929 added - ₹3,08,751 used). The GST output and input ledgers are nil at that date because the
accountant journals them into the credit ledger every month, so September is already set off. Tally does not split the credit ledger by
tax head, so it is shown as integrated tax (which pays any head; with credit of this size no cash is due either way). "GST Credit Ledger
Delhi" (₹53,607) belongs to the other registration and is not used; "Gst Portal Balance" ₹13,94,768 is the two together. **Every later month
opens with the closing credit of the previous month's return**, once the owner presses "I filed this month's return with these figures" after
filing on the portal: the figures filed (tax on sales, credit claimed, cash, closing) are kept in `gstr3b_months.filed`, the closing carries
forward by itself, and the page reports anything that has changed since (a late credit note, a bill accepted later) without moving the
carried credit. Recording can be undone. If the previous month is not recorded as filed, nothing is carried and the page says so. A typed
opening still exists, hidden behind "The portal shows a different balance? Correct the opening", as a correction (marked manual, refused for a
month recorded as filed). Logic: `src/lib/gstr3bCredit.js` (tested).

## Storage (migrations 044 and 045, applied 18 Nov 2026)

`gstr2b_files` (the lines of a month's 2B), `gstr3b_months` (credit carried in), `gstr3b_log` (who loaded, replaced, removed or entered
what). Readable by admins only (`finance_admin()`); written only through `gstr2b_save`, `gstr2b_delete`, `gstr3b_save_opening`
(SECURITY DEFINER, admin only, validated again in SQL: the file's month and GSTIN must match, at most 5000 lines, balances 0 to 100
crore). Tested in a rolled-back transaction, including a non-admin being refused and RLS hiding the rows. **Without the migration
the page still works**: it just cannot remember anything (the file and the opening credit are used for that visit only, and the page says so).

## What it does not cover

Table 4(A)(1) to (4) (imports, reverse charge, ISD), 4(B) reversals other than "claim less", Table 5 and 5.1 (exempt supplies, interest,
late fee), amendments (B2BA, CDNRA), ITC the portal marks ineligible beyond what 2B says, the carried-forward credit's own history.
Anything in the 2B file it does not read is named in the preview.

## Open points for the accountant

- How the TCS credit appears in Table 6.1 / the cash ledger (sources silent).
- Whether any 2B credit should be held back with a reversal in 4(B)(2) (for example Nykaa Fashion's ₹4,500 if the owner finds it is not his purchase).
- **The Excel reader was checked against the owner's real October 2026 GSTR-2B** (18 Nov 2026): 23 invoices from 16 suppliers, and the
  total equals the file's own "ITC Available" summary to the paisa (IGST 1,90,300.58, CGST 80.91, SGST 80.91). That file has no Rate column,
  dd/mm/yyyy dates, "GSTR-1/1A/IFF/GSTR-5 Period" headers, a "B2B-DNR" sheet for debit notes and about twenty other sheets (amendments,
  ISD, ECO, imports, ITC reversal, IMS rejections), all empty that month. The reader now reads B2B, B2B-CDNR and B2B-DNR, cross-checks the
  summary sheet (Part A less Part B) like the JSON path does, and names any other sheet that has lines in it. The JSON layout is still
  from the published description only. Tests use synthetic fixtures with the real layout; **never commit the real file**.

## October 2026 with the real 2B (18 Nov 2026)

13 of the 14 bills dated in October match 2B (the amounts agree within paise). Claimed (all of 2B, the source of truth): ₹1,90,300.58
IGST + ₹80.91 CGST + ₹80.91 SGST, of which ₹81,065.53 IGST is for seven invoices the ERP has no bill for (they go on the upload list): Aggarwal Traders 1068, 1069,
1070 (₹73,267.03, taxable ₹14,65,340.50, all dated 25 Oct), Nykaa Fashion MH2601194236 (₹4,500), Unicommerce UC2627/GGNA/910 (₹2,340),
Goexcelsior HR/26-27/0026152 (₹900), Google 5732193357 (₹58.50). One bill is not in 2B: Shree Vinayak SVF/26-27/265 (₹517.50: the supplier
has not reported it). Myntra's 2B (₹1,247.40) agrees with the ledger (₹1,247.38). Easebuzz's invoice N2627/000100369 has ₹1,235.65 of GST
against ₹635.78 booked, because GoKwik's settlement report is loaded only to 11 Oct. Output tax ₹32,210.01 is covered by credit: cash ₹0, about ₹1,58,252 of credit left to carry on (carried-in credit not entered).

## October 2026 before a 2B was loaded (indicative)

Tax on sales ₹32,210.01 (IGST ₹30,156.06, CGST ₹1,027.01, SGST ₹1,026.94) on ₹6,44,217.09 taxable, equal to the GST view's net.
Table 3.2: 26 states, ₹6,03,137 taxable, IGST ₹30,156.06 (equal to 3.1). Books hold ₹1,09,315.39 of credit (14 accepted bills
₹1,07,432.23, gateway ₹635.78, Myntra ₹1,247.38): more than the tax, so no cash is due and about ₹77,105 is left to carry on.
TCS ₹100.80, TDS ₹20.15.
