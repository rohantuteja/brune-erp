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

**Matching.**
- A bill is matched to a 2B line by supplier GSTIN and invoice number (`normInvoice`: no case, punctuation or leading zeros). A bill
  with no supplier GSTIN (Goexcelsior) is matched by invoice number and tax amount.
- The payment gateway and Myntra are matched **by supplier** (GSTIN), because the ERP holds no invoice numbers for them: the 2B total
  for the supplier against what the ledger booked in the month. Their invoices and the ledger lines fall in different months, so a
  difference is expected and only noted.
- Every 2B line lands in exactly one place (a test proves nothing is lost): matched and claimable; matched but the bill is still in
  review (held); marked "ITC not available" or reverse charge (left out, listed); a supplier credit/debit note (reduces/adds credit);
  gateway or Myntra (supplier level); or an invoice with no bill in the ERP (listed, **not claimed unless the owner ticks the box**).
- When a bill and its 2B line differ, **the smaller figure per tax head is claimed** and the line is flagged.
- A bill dated in the month that is not in 2B is "not claimable this month"; it appears in the month the supplier reports it. A bill
  dated before the books started that turns up in this month's 2B is flagged for a check against double claiming.
- A bill whose tax type does not fit the supplier's state (IGST from a supplier in the buyer's state, or CGST + SGST from another state)
  is flagged: it cannot be claimed as charged.

**Without a 2B** the claim is simply the books, shown in amber as "not checked against GSTR-2B", with a warning.

## Payment, Table 6.1

Order of set-off (sections 49 and 49A, Rule 88A): IGST credit pays IGST first; own-head credit pays CGST and SGST; leftover IGST credit
pays CGST and SGST; CGST / SGST credit pay IGST only once IGST credit is used up, and never each other. The tests prove it conserves
every rupee and pays cash only when no usable credit is left. Rule 86B (more than ₹50 lakh taxable in a month: at least 1% in cash) is
flagged. The credit carried in is **entered by hand** each month from the portal's electronic credit ledger (the ERP cannot see the
portal) and saved in `gstr3b_months`; the closing credit is shown so it can be compared with the portal after filing.

## Storage (migration 044, applied only after the owner approves)

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
- Whether to claim 2B lines that have no bill, and whether to hold back 2B credit with a reversal in 4(B)(2).
- The 2B file layouts (JSON and Excel) were written from the portal's published layout, not from a real file: **try the first real
  file** and, if the preview says it cannot read it, send the file's sheet names and header row.

## October 2026 (indicative, before a 2B is loaded)

Tax on sales ₹32,210.01 (IGST ₹30,156.06, CGST ₹1,027.01, SGST ₹1,026.94) on ₹6,44,217.09 taxable, equal to the GST view's net.
Table 3.2: 26 states, ₹6,03,137 taxable, IGST ₹30,156.06 (equal to 3.1). Books hold ₹1,09,315.39 of credit (14 accepted bills
₹1,07,432.23, gateway ₹635.78, Myntra ₹1,247.38): more than the tax, so no cash is due and about ₹77,105 is left to carry on.
TCS ₹100.80, TDS ₹20.15.
