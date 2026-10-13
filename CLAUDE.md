# Brune ERP — Project Briefing for Claude Code

## What This Project Is

Brune ERP is an internal garment manufacturing ERP system built for Brune, a garment manufacturing business producing under 5,000 pieces/month fully in-house. It is a custom internal tool, not a commercial product.

**Owner:** Rohan (founder)  
**Deployed at:** https://brune-erp.vercel.app  
**Repo:** brune-erp  

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 6 |
| Backend/DB | Supabase (PostgreSQL, Auth, Edge Functions, Realtime) |
| Hosting | Vercel |
| Styling | Tailwind CSS |
| Language | JavaScript (JSX) |
| Icons | lucide-react |
| Routing | react-router-dom v7 |
| Testing | Playwright |
| PWA | vite-plugin-pwa (standalone, auto-update) |

> ⚠️ Note: Vite was chosen over Next.js. This means no server-side rendering and no native API routes. Shopify webhooks cannot be received directly — they go through Supabase Edge Functions instead.

---

## Modules Built

| Module | Status | Notes |
|---|---|---|
| Dashboard | ✅ Done | Overview metrics + pipeline health (stale-while-revalidate RPC cache) |
| Inventory | ✅ Done | Fabric rolls & thans tracking with URL-backed filters |
| Cuttings | ✅ Done | Fabric cutting runs with per-entry fabric usage |
| Production | ✅ Done | Batch production tracking (issue/complete with Shopify sync) |
| Payments | ✅ Done | Karigar (worker) payments with piece-rate breakdown |
| Costing | ✅ Done | Per-piece cost calculation with fabric + fixed + custom lines |
| Analytics | ✅ Done | Tabs: Inventory Value, Shopify Stock Value, WIP Value, Shipments, Ledger, Bank & card and Velocity wallet (admin only), Production. The Pending COD, Returns, Stock Health, Costing, Pipeline and Fabric Usage tabs were removed from the UI on 12 Oct 2026 at the owner's request (see below); nothing behind them changed |
| Master Data | ✅ Done | Reference data (karigars, fabric types, suppliers, style codes) |
| Auth / RBAC | ✅ Done | Supabase Auth + role-based permissions (admin/production_incharge/floor_supervisor/manager) |
| Shopify Inventory | ✅ Done | Read Shopify stock (Unicommerce now pushes stock to Shopify) |
| Unicommerce stock sync | ✅ Live | Batch completion, RTO and Return Prime returns → Unicommerce (see Stock sync below) |
| Monthly Snapshots | ✅ Done | 4 snapshot types: Inventory, WIP, Shopify Stock, COD Pending — each with its own Edge Function and table. The month-end jobs still run for all four; the COD Pending snapshots (`cod_pending_snapshots`) no longer have a screen |
| User Management | ✅ Done | Admin UI to create/edit users and assign granular permissions |
| Bank & card | ✅ Built (Phase 1) | Admin-only Analytics tab: upload bank statement (xlsx), founder's card statement (PDF) and GoKwik settlement report (CSV); every line matched or filed under a bucket (see `docs/bank-reconciliation.md`) |
| Velocity wallet | ✅ Built | Admin-only Analytics tab: upload Velocity's wallet Ledger Report (CSV) and monthly tax invoice (PDF); top-ups matched to the bank, charges checked against the invoice (see `docs/velocity-wallet.md`) |

---

## Folder Structure

```
src/
  App.jsx                      # Root: auth gate → LoginPage or FabricCuttingModule
  main.jsx                     # React entry, wraps with AuthProvider + PermissionsProvider
  index.css                    # Tailwind base
  FabricCuttingModule.jsx      # Main app shell — navigation + all module views
  contexts/
    AuthContext.jsx             # Supabase session state (session, user, loading, signOut)
    PermissionsContext.jsx      # Role presets + granular can() checker
  hooks/
    useAppData.js               # Single hook: all Supabase CRUD + realtime sync
  lib/
    supabase.js                 # Supabase client (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY)
    constants.js                # STANDARD_SIZES, localToday(), orderSizes(), isRunActive()
  pages/
    LoginPage.jsx               # Username → email RPC → Supabase signInWithPassword
    ShopifyInventoryPage.jsx    # Shopify product stock view with URL-backed filters
    UserManagementPage.jsx      # Admin: create users, assign roles & permissions

supabase/
  migrations/
    001_initial_schema.sql      # All core tables (see Database Schema below)
  functions/
    admin-user-ops/             # Create/update/delete Supabase auth users (admin only)
    _shared/unicommerce.ts      # Unicommerce REST client (OAuth token cache, stock adjust, catalog lookup); calls go out via the DB (uc_post)
    _shared/batch-sync.ts       # Batch → Unicommerce ADD/REMOVE with the exactly-once ledger
    _shared/uc-returns.ts       # RTO / customer-return pieces → receive Unicommerce's own return (or add directly)
    _shared/order-edits.ts      # Per-line Unicommerce stock correction for edited Shopify orders
    _shared/backorders.ts       # Sold at zero: follow orders Unicommerce took with no stock; take out owed pieces
    unicommerce-adjust-inventory/ # Add/remove Unicommerce stock when a batch is completed/reverted
    shopify-adjust-inventory/   # Legacy: adjusted Shopify stock directly (replaced by unicommerce-adjust-inventory)
    shopify-inventory-webhook/  # Receive Shopify inventory_level/update webhooks
    shopify-return-webhook/     # Log Return Prime refunds for the Returns screen (no stock change)
    shopify-order-webhook/      # RTO Shopify orders → Unicommerce stock, cancel on Shopify, store credit
    returnprime-webhook/        # Return Prime returns back at warehouse → Unicommerce stock
    shopify-product-webhook/    # Product goes live → create its SKUs in Unicommerce (GST 5, or 18 above ₹2,500), add waiting batches
    stock-audit/                # Admin: replay each SKU from a known starting stock to find pieces sold at zero
    cod-paid-on-delivery/       # Mark COD / PPCOD orders paid on Shopify when Velocity says delivered; follow each to its COD remittance (UTR)
    store-credit-guard/         # Take back the second store credit Return Prime + GoKwik put on COD returns that used store credit
    _shared/cod-paid.ts         # Rules for when an order may be marked paid (tested: node --test)
    _shared/credit-guard.ts     # Rules for spotting and sizing a double store credit (tested: node --test)
    _shared/shopify-admin.ts    # Shopify Admin GraphQL, settings and admin-auth helpers for the two functions above
    shopify-sync/               # Full sync of Shopify product inventory into Supabase
    take-cod-snapshot/          # Daily COD analytics snapshot
    finance-import/             # Admin: read bank / card / GoKwik files, check they add up, store the lines, match them (statement, gokwik, rematch, delete_statement, delete_gokwik)
    velocity-import/            # Admin: read Velocity's wallet ledger (CSV) and tax invoice (PDF), check them, reconcile top-ups, charges and balances (ledger, invoice, reconcile, delete_ledger, delete_invoice)

tests/                          # Playwright e2e tests (URL routing, inventory filters)
```

---

## Database Schema

### Core tables

```sql
-- Suppliers
suppliers (id, name, contact_person, phone, email, address, created_at)

-- Fabric types + per-supplier pricing
fabric_types (id, name, composition, gsm, format CHECK('roll','than'), created_at)
fabric_type_supplier_rates (id, fabric_type_id→fabric_types, supplier_id→suppliers,
  cost_per_kg, chadti, cost_per_m)   -- rolls: cost_per_kg + chadti; thans: cost_per_m

-- Style codes (garment models)
style_codes (id, code UNIQUE, discontinued BOOL, created_at)

-- Fabric inventory
inventory (id, inventory_number UNIQUE, format CHECK('roll','than'),
  fabric_type_id→fabric_types, color, supplier_id→suppliers, width_cm, rate,
  initial_weight_kg, current_weight_kg,   -- roll fields
  initial_length_m,  current_length_m,    -- than fields
  received_date, status CHECK('available','finished'), notes, created_at)

-- Cutting runs (one logical run = one style_code batch)
runs (id, style_code, first_cut_date, last_append_date, created_at)
run_pieces (id, run_id→runs, size, quantity)        -- aggregate totals per size
run_entries (id, run_id→runs, date, notes, created_at)
run_entry_usage (id, entry_id→run_entries, inventory_id→inventory,
  weight_used_kg, length_used_m)
run_entry_pieces_added (id, entry_id→run_entries, size, qty)

-- Karigars (tailors / workers)
karigars (id, name UNIQUE, payment_type CHECK('piece_rate','salary'), is_active BOOL, created_at)

-- Production batches (pieces issued to karigars from a run)
production_batches (id, run_id→runs, style_code, issued_date, notes,
  issued_sizes JSONB {size: qty},  total_issued INT,
  karigar_ids JSONB [id,...],  karigar_names JSONB [name,...],
  status CHECK('issued','completed'), completed_qty, completed_date, created_at)

-- Production entries (daily stitching output per karigar)
production_entries (id, date, karigar_id→karigars, karigar_name,
  items JSONB [{sku, qty}], created_at)   -- unique(date, karigar_id)

-- Karigar payment records
karigar_payments (id, karigar_id→karigars, date, amount,
  breakdown JSONB [{style_code, pieces, rate, subtotal}], notes, created_at)

-- Style costings
costings (id, style_code UNIQUE, cutting_cost, stitching_cost, trims_cost,
  finishing_cost, fabric_cost_override, updated_date, created_at)
costing_fabric_lines (id, costing_id→costings, fabric_type_id→fabric_types, avg_meters)
costing_custom_lines (id, costing_id→costings, label, amount)

-- Auth / RBAC (added post-initial migration)
user_profiles (id = auth.users.id, username, role CHECK('admin','production_incharge','floor_supervisor','manager'))
user_permissions (user_id→auth.users, can_view_dashboard, can_view_inventory,
  can_edit_inventory, can_delete_inventory, can_view_cuttings, can_edit_cuttings,
  can_delete_cuttings, can_view_production, can_edit_production, can_delete_production,
  can_view_payments, can_edit_payments, can_view_costing, can_edit_costing,
  can_delete_costing, can_view_analytics, can_view_masters, can_edit_masters,
  can_delete_masters, can_manage_users, can_view_alerts, can_edit_alert_settings,
  can_view_shopify)

-- App settings (key-value store for configurable thresholds)
app_settings (key TEXT PRIMARY KEY, value)
-- Keys: alert_rolls_threshold, alert_thans_threshold_m,
--       pipeline_production_lead_days, pipeline_cutting_lead_days,
--       pipeline_fabric_lead_days, pipeline_safety_buffer_days,
--       overdue_batch_days, velocity_lookback_days
```

### Key RPCs (Supabase functions)
- `get_email_by_username(p_username)` — resolves username → email for login (SECURITY DEFINER, callable by anon)
- `pipeline_health()` — returns heavy pipeline status data for the dashboard (cached 15 min in localStorage)

---

## Environment Variables

```bash
# Required — copy .env.local.example → .env.local
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_PUBLIC_KEY
```

The Supabase Edge Functions use server-side secrets configured in the Supabase dashboard — not in .env files. Shopify credentials live in the `private_secrets` table; Unicommerce credentials are the `UNICOMMERCE_USERNAME` / `UNICOMMERCE_PASSWORD` function secrets.

---

## Business Logic Details

### Inventory Tracking
- **Rolls** are tracked by weight (kg): `current_weight_kg` decreases as fabric is used.
- **Thans** are tracked by length (m): `current_length_m` decreases as fabric is used.
- Status auto-sets to `'finished'` when current ≤ 0.05 kg (roll) or ≤ 0.1 m (than).
- Auto-numbering scheme: `ROLL-0001`, `THAN-0001` etc. (sequential within format).
- Fabric usage is recorded per cut entry; deleting an entry reverses the consumption.

### Stock sync (Unicommerce is the system of record)
Unicommerce pushes stock to Shopify and Myntra, so the ERP never writes Shopify stock. Every Shopify order is imported into Unicommerce within seconds, which holds a piece for it and takes it out of stock when Velocity fulfils the order on Shopify (Unicommerce then marks it dispatched). After an order is cancelled on Shopify (RTO) or refunded (Return Prime), Unicommerce opens a "Courier Returned" return on it (RETURN_EXPECTED) that waits to be received. When the piece is physically back, the ERP **receives that return itself** through Unicommerce's API (`/oms/returns/complete`, good stock — Unicommerce puts it away and issues its return invoice), so nobody receives returns in Unicommerce by hand. Lines wait as `waiting` until Unicommerce has opened the return (6–30 min); after 6 h without one the piece is added directly. Orders Unicommerce never had, or never shipped, get a direct stock add; lines added to an order after Unicommerce imported it are skipped (Unicommerce never took them) unless the ERP took them out for an order edit, in which case they are added back. Logic: `supabase/functions/_shared/uc-returns.ts`. Myntra returns are not automated yet.

| Event | Trigger | Rule | Ledger |
|---|---|---|---|
| Batch completed / moved back | ERP UI | ADD / REMOVE per size; SKU = `${style_code}-${size}` | `shopify_batch_inventory_sync` |
| Unshipped Shopify order cancelled | — | **Not the ERP's job.** Unicommerce cancels its copy and releases the piece itself; an ERP ADD would double count (#37715, 30 Sep 2026) | — |
| RTO | tag `rto_delivered` (`orders/updated`) | ADD all units if in Unicommerce or shipped before the opening load; cancel on Shopify (no restock, email). Anything paid (prepaid, part-payment, store credit) is refunded to store credit by the cancel — all of it, shipping included, no expiry — after the ERP cancels the active shipment (Shopify refuses otherwise). Don't cancel RTO shipments by hand: Unicommerce re-imports the order as new | `shopify_order_restocks`, `shopify_rto_orders` |
| Return Prime return | courier status "Returned to warehouse" / request `received` | ADD unless already restocked at refund by the old flow, rejected, or never taken by Unicommerce | `returnprime_restocks` |
| Sold at zero (products set to keep selling at 0 on Shopify) | 15-min job; batch completion | Unicommerce can't go negative: an order with no stock waits (UNFULFILLABLE), but when Velocity ships it Unicommerce marks it dispatched without taking anything out, so the next batch was added in full (Kira Blue L, Oct 2026: 6 too many). The ERP records waiting items; one dispatched while still waiting is **owed**, and owed pieces are taken out as soon as the SKU has stock again (right after a batch adds it, else by the 15-min job). Shown under Analytics → Returns → "Sold at zero" | `unicommerce_backorders` |
| Shopify order edited (size swap, item added/removed) | `orders/edited`, daily sweep, 15-min job | Unicommerce never sees edits and dispatches its stale copy (#37827). Per line: required = current qty + returned − Unicommerce's non-cancelled items; the ERP REMOVEs / ADDs the difference from what it already applied. Reversed if Unicommerce cancels its copy; left alone for orders placed before the opening load. Unicommerce's own order and invoice keep the original items | `shopify_order_edits`, `shopify_order_edit_lines` |

- Opening stock load: Shopify snapshot 2026-09-29 17:07:59 UTC. The old refund-time Shopify restock was switched off at 2026-09-29 23:41:24 UTC.
- Orders tagged `rto_delivered`, and returns back at the warehouse before go-live, are `baseline` rows and are never processed.
- `shopify-order-webhook` only acts on orders tagged `erp-test` until `app_settings.order_webhook_mode = "live"`. RTO cancel and store credit also need `app_settings.rto_shopify_actions = true`.
- **UI removed 12 Oct 2026:** the Analytics → Returns tab (its "Needs attention" board, "Sold at zero" and restock log) and the Pending COD, Stock Health, Costing, Pipeline and Fabric Usage tabs were taken out of the Analytics page at the owner's request, UI only: every function, table, webhook and scheduled job above is unchanged. Failures and anything needing a person are therefore no longer shown on any screen: they are in `shopify_rto_orders` (cancel / credit status), `shopify_order_restocks` and `returnprime_restocks` (status `failed`), `shopify_order_edits` (order edits whose Unicommerce stock was not corrected), `unicommerce_backorders` (sold at zero) and `return_restocks` (the restock log), readable in the database only. The owner will ask for a proper Returns screen later: it must be paged and filterable (the old one was one long scroll with no filters), and should bring the "Needs attention" board back. The old Dashboard link "Active Pipeline → Full view" now opens Cuttings → By style.
- **Unicommerce only accepts its API from whitelisted IPs** (since 2 Oct 2026). Edge functions have no fixed egress, so every `/services/*` call goes through the DB function `public.uc_post` (migration 009, `http` extension), which leaves from the database's whitelisted IPv6 address. That address changes if the project is paused/resumed or Postgres is upgraded; re-whitelist it in Unicommerce (`select content from extensions.http_get('https://api64.ipify.org')`). `/oauth/token` is not IP-restricted and stays in the edge functions.
- Scheduled every 15 min (pg_cron, migration 006; key `private_secrets.erp_stock_cron_key`): `returnprime-sweep` catches returns whose webhook never arrived. (`shopify-cancel-recheck` was dropped in migration 007 along with cancellation handling.)
- Every 15 min (migration 011, same key): `shopify-returns-settle` settles RTO lines waiting for Unicommerce's return and retries failed lines hourly, re-checks edit corrections that are pending or need attention, and follows sold-at-zero items (taking out owed pieces); `returnprime-sweep` does the same for Return Prime lines and sweeps the newest ~150 requests.
- Daily at 06:00 IST (migration 010, same key): `shopify-rto-sweep` processes `rto_delivered` orders from the last 3 days that the ERP has no record of, moves RTOs stuck half-processed to "Needs attention", and re-checks every order edited in those 3 days.
- **Shopify marks an order `edited` whenever a refund removes an item**, so every Return Prime return also reaches the edit logic; the "+ returned" term makes those come out as no change. Return Prime refunds of orders shipped before go-live had their Unicommerce copies cancelled (#37654), hence the pre-load and cancelled-copy rules.
- New products (`shopify-product-webhook`, subscribed 8 Oct 2026 to `products/create` + `products/update`): when a Shopify product is live (Active, or Unlisted), each size SKU missing from Unicommerce is created (fields as `~/Unicommerce/shopify_to_uc.py`; existing SKUs are never edited), then completed ERP batches of that style not yet synced are added. GST by each variant's selling price (not compare-at): ≤ ₹2,500 → code `5`, above → `18`; if Unicommerce rejects `18` the SKU is created at `5` and flagged `needs_review` in `unicommerce_sku_sync`. Linking the Shopify listings to the SKUs is left to Unicommerce: its catalog sync matches them by SKU about 2 minutes after the SKU exists and fills in each listing's product name (`<product title> - <size>`). Don't link listings through the API (`createChannelItemType`): it replaces Unicommerce's listing and blanks that name unless `productName` is sent (Colette Brown, 8 Oct 2026). A SKU can have several listings — the Unlisted lower-price copies of a product share its SKUs — and Unicommerce pushes the SKU's full stock to every copy; orders from any copy draw on the same stock. The product webhook's `dry_run` compares every live listing's Shopify stock with Unicommerce's (`stock_mismatches`).
- `stock-audit` (admin) replays every SKU from a known starting stock (the 30 Sep reset: Shopify available at 2026-09-29 21:53 UTC) through Shopify and Myntra orders, batches, RTOs and returns, and only trusts a SKU whose replay ends on Unicommerce's actual available / reserved / waiting counts. 8 Oct 2026: 267 of 274 SKUs matched; the only sold-at-zero drift was Kira Blue L (6) and S (1).
- Go-live state (2026-09-30): `order_webhook_mode = "live"`, `rto_shopify_actions = true`, Shopify `orders/updated` + `orders/cancelled` and Return Prime `request/received` subscribed. `orders/edited` subscribed 8 Oct 2026.

### Accounting from 1 Oct 2026 (COD payments, store credit, GST) — design in `docs/accounting-ledger.md`
- **Cutoff (hard rule):** the owner closed Tally for September and earlier by hand. Nothing here may change those months: `app_settings.accounting_start_date = 2026-10-01`. Money received, parcels delivered and refunds issued before it are never touched, even if Shopify still shows them unpaid (15 pure-COD orders from August and 11 COD + store-credit orders remitted before October are examples). Sales placed in September whose money arrives in October are October receipts and are in scope.
- **COD paid on delivery** (`cod-paid-on-delivery`, every 15 min, migration 016): the customer pays the courier at the door, so a COD / PPCOD order is marked paid on Shopify (`orderMarkAsPaid`) once Velocity's `cod-remittance` API gives a `delivery_date` on or after the start date. Velocity's `remittance_date` is only a schedule; a `utr_no` means the money was paid, and it is recorded on `cod_deliveries` when it arrives. Never RTO / cancelled / prepaid / already-paid orders; Velocity's COD amount must equal Shopify's outstanding balance or the row is `attention`. `orderMarkAsPaid` refuses a paid order, so it cannot clash with Velocity's own mark-paid at remittance (to be switched off). Why: Return Prime can only record a refund on a paid order; for 9 of 15 COD returns (Sep–Oct 2026) the return came before remittance, so Shopify never showed it.
- **Store credit on COD returns:** Return Prime credits the customer BY HAND on every COD (manual-payment) return and also writes a Shopify refund per payment method. The COD part is "refunded to Cash On Delivery", paperwork that moves no money. A part paid with "Shopify Store Credits" is a real refund: GoKwik (`Gokwik_Brune`) credits it a few seconds later, so the customer gets the refund plus the store credit they spent (36791: +₹1,259.10, 37613: +₹1,340.10, both unspent). Prepaid returns are a single native refund to store credit; plain COD returns one manual credit. `store-credit-guard` (every 2 min) debits the extra credit with `storeCreditAccountDebit`, only when the excess equals the store-credit refund and the balance covers it, else `flagged`. For accounting never read Shopify's COD refund lines as money: read the store credit actually issued (customer's `storeCreditAccounts` transactions) and Unicommerce's return invoice.
- **Retained amounts on a COD return:** store credit = goods paid − discount − ₹99 return fee. The ₹100 COD fee is never refunded. Shopify reverses all the tax on a returned order (current tax 0 while the ₹199 is kept); at 5% the retained ₹199 carries ₹9.48 GST.
- **COD RTO return invoices are short by the COD fee:** Unicommerce's return invoice for a Courier Returned order reverses the goods only (order 37707: sale INS0006 ₹1,499 incl. COD charges ₹95.24, return ISR0001 ₹1,399), leaving ₹100 (₹95.24 + ₹4.76 GST) of a never-collected sale. Nothing was delivered or paid, so the COD fee needs its own credit note (19 COD RTOs since 1 Oct = ₹1,900). Not an issue for customer returns after delivery, where the fee was collected and is kept.
- `app_settings.cod_paid_limit` caps how many orders one run marks paid (default 100); use 1 for the first live run, check it, then raise it.
- **Live since 12 Oct 2026** (functions deployed, migration 016 applied, `cod_paid_mode` and `credit_guard_mode` = "live"). The first run was limited to one order (37711), checked on Shopify, then 23 more were marked (24 in all, ₹37,201.90); the guard reversed 36791 (₹1,259.10) and 37613 (₹1,340.10). Set a mode back to "dry" to make a workflow only record what it would do. The admin actions `status`, `sweep`, `order`, `check`, `reverse` work with an admin JWT or with the `x-cron-key` header.
- **Ledger run (read-only, `accounting-ledger`, deployed):** per order it reads Shopify, Unicommerce (`saleorder/get`, then `invoice/details/get` for the sale and return invoice amounts, via `uc_post`), Return Prime and Velocity, builds facts (`_shared/order-facts.ts`) and the double-entry ledger (`_shared/ledger.ts`), and reports whether the order nets to zero. Actions `order` and `report` (cron key or admin JWT). Orders cancelled before dispatch are "not a sale"; a refunded return whose parcel isn't back is `awaiting_return`; double store credit shows as `store_credit_differs`. Nothing is written. First run on 25 orders: 23 balanced, 1 not a sale, 1 awaiting the parcel (37528).
- **Stored ledger (migration 017):** `ledger_orders` (one row per order: status `complete` / `open` / `attention` / `not_a_sale`, open amount, exceptions, balancing documents, facts), `ledger_entries` (double-entry lines, `exportable` from the start date) and `ledger_runs`. Written only by `accounting-ledger` (`sync`, `tick`) through `ledger_save_orders`; recomputed from scratch each sync, so a rule fix is applied by syncing again. `app_settings.ledger_sync_mode` (`off` / `live`) gates the 10-minute `accounting-ledger-sync` cron. Screen: Analytics → Ledger.
- **Sale date in the ledger = the Shopify order date (IST), for every order (13 Oct 2026):** September was filed from Shopify's sales report (order date), so the ledger books a sale on the day it was ordered, not on the Unicommerce invoice date (which can be days or a month later: orders 37712 and 37716-37729, ordered 30 Sep, invoiced 1 Oct, were being counted in both months). The Unicommerce invoice keeps its number, amounts and GST; its date is `facts.invoiceDate`. Returns still use the return invoice (credit note) date. Rule and reasoning: `docs/accounting-ledger.md`.
- **Ledger account names = Tally ledger names, and the prepaid payout (migration 028, `accounting-ledger` v15-16, 14 Oct 2026):** entries now use the owner's Tally names (`ICICI Bank`, `GST SALES` with a `part` of goods / cod_charge / return_fee, `GST SALES RETURN`, `IGST OUTPUT UP`, `STORE CREDIT BY SHOPIFY`, `Easebuzz Private Limited` as the gateway account, `Payment Gateway Expenses`, `IGST Input  UP`, `ROUND OFF`), sales and credit notes carry `qty`, and GoKwik's settlement report (`gokwik_payments`) books each payout (Dr bank net, Dr gateway fee, Dr IGST input, Cr Easebuzz, document = UTR, dated by settlement). `ledger_orders.gateway_open` is the gateway account's balance; new stages `awaiting_payout` (open), `payout_missing` and `payout_differs` (need a person). **Outages (v17):** an order whose Velocity or Unicommerce call failed (HTTP error, unreadable body; "no such order" is still an answer) is held back: not saved, its last rows kept, listed in `ledger_runs.summary.held` and on the Ledger page, queued again by every later run and retried by the tick 10 minutes later (`kind = manual`). `simulate_down` on any action tests it. Details: `docs/accounting-ledger.md`.
- **State on every order (migration 031, `accounting-ledger` v18, 14 Oct 2026):** the Tally file must put the state the goods go to on every voucher it creates, and an order without one is not exported. State = Shopify shipping-address province first, Unicommerce shipping address second (never billing), resolved to the GST code + standard name by `_shared/gst-states.ts`; stored in `ledger_orders.state` / `state_code` and `facts.state`. An order with no state gets the `no_state` exception (status `attention`). Shopify vs Unicommerce disagreeing, or an invoice charging the wrong tax type for the state, is a note. Tally's spelling of a state is mapped at export time (not built). Analytics → Ledger has a "Ships to" column. All 420 sold orders had a state on first sync. Details: `docs/accounting-ledger.md`.
- **An order is a sale only once Unicommerce has invoiced it (migration 032, `accounting-ledger` v20, 14 Oct 2026):** Shopify and Myntra orders with no Unicommerce sale invoice are stored as `waiting_invoice` (no entries, nothing booked or exported, listed on Analytics → Ledger); when the invoice exists they become a normal sale booked on the order date. Shopify orders placed before `app_settings.uc_orders_from` (29 Sep 2026 17:07:59 UTC) were never in Unicommerce and keep Shopify's amounts. `invoice_overdue` flags orders waiting `invoice_wait_alert_days` (3) or more, dispatched without an invoice, or cancelled only in Unicommerce. A waiting Myntra order is named by its Unicommerce code until invoiced, then its waiting row is deleted. Open question for the accountant: month-end cut-off and whether to book on the invoice date. Details: `docs/accounting-ledger.md`.
- **Cancelled orders and the refund check (`accounting-ledger` v19, 14 Oct 2026):** an order cancelled before dispatch (no tracking, no Unicommerce invoice, not RTO) is never a sale whatever was paid: nothing paid, or store credit all credited back = `not_a_sale`; money through a real gateway, or store credit not all credited back = no entries and the exception `cancelled_after_payment` (a person checks the refund and payout). Order 37937 (store credit, cancelled in 20 s) had been booked as a finished sale because store credit counted as "money moved". Every order is also checked against Shopify: refunded money (`facts.refundedOut`) that the ledger does not show going back is `refund_not_booked`. Details: `docs/accounting-ledger.md`.
- **Myntra in the ledger (migration 027, `accounting-ledger` v14):** Myntra orders (Unicommerce channel `MYNTRAPPMP`) are read from Unicommerce only: the sale invoice (named by its invoice number, Unicommerce order code kept in `ledger_orders.channel_ref`) and return invoices. Booked on Myntra's order time (IST) but never before 1 Oct 2026 (the four September orders are booked 1 Oct). Myntra is a marketplace: we invoice the end customer (B2C, no GSTIN) and Myntra only invoices its fees and deducts TCS/TDS, so `Myntra receivable (order control)` is a clearing account for money Myntra collected and has not paid; a sold order stays `awaiting_settlement` until Myntra's payout is matched. **The payout matching (commission, ₹59 fixed fee, TCS/TDS, return fees) is not built yet**; it waits for the first payout (due 19-25 Oct 2026). `ledger_orders.channel` is `shopify` | `myntra`; `order_id` is null for Myntra. Rules and numbers: `docs/accounting-ledger.md`.
- **Velocity in the ledger (migration 019):** a delivered COD parcel debits "COD receivable (Velocity)"; its remittance (Velocity `utr_no` set) credits it and debits Bank, dated by `remittance_date`. `ledger_orders.cod_open` = collected by the courier, not yet in the bank. Delivered over 10 days with no UTR → `remittance_overdue`; a different amount → `remittance_differs`. Velocity is asked for every COD order without a recorded UTR (13 s between calls). `accounting-ledger` action `velocity_gap` checks COD orders the ledger doesn't hold.
- **RTO cancel retry (`rto-cancel`):** runs the cancel-and-credit step of the RTO flow on one order whose automatic cancel failed (cron key or admin JWT; `{order, dry?, force?}`), recording the result on `shopify_rto_orders`. Same code as the webhook's `cancel` action (`_shared/rto-cancel.ts`, keep them identical). Refuses if the customer already holds a credit close to what the order still holds. Used on 37560 (11 Oct 2026). Approved goodwill credits live in `ledger_adjustments` (migration 018) and are booked to `Goodwill credits` by the ledger.
- **Shipments (migrations 020 + 021, `shipment-watch`, Analytics → Shipments; `docs/shipments.md`):** one row per AWB in `shipments` for forward parcels not delivered, RTOs coming back and customer returns on their way. **Velocity's own `order-tracking` API decides the status** (Shopify and Return Prime lag the courier: 29 of the first 133 "pending" parcels were already delivered or cancelled): a parcel is closed only on a terminal status with evidence, and anything Velocity cannot confirm, a lost parcel, or a failed delivery / pickup (NDR) is flagged, never hidden. `shipping-charges` shows per-parcel wallet credits; Velocity has no API for credit-note documents, claims or tickets (probed, 404). A person marks parcels resolved or ticket-raised through `shipment_review_set` (logged, permission-checked). Velocity does NOT reliably tag RTO orders; it writes `RTO Initiated / In Transit / Delivered on <ts>` and `EDD: <ts>` in the Shopify order note, so the note (`parseNote` in `_shared/shipments.ts`) is the source of truth and the tag only a fallback. Forward parcels past their promised date are escalated (prepaid at 1 day late, COD / part-paid at 2); any parcel pending 45 days from dispatch is credit-note eligible. Thresholds are `app_settings` (`shipment_*`), the schedule (every 30 min) runs when `shipment_watch_mode = "live"`. The ledger reads the same note: an RTO in progress is the open stage `rto_on_the_way`, not "COD in transit".
- **Bank & card (migrations 022-024, `finance-import`, Analytics → Bank & card, admin only; `docs/bank-reconciliation.md`):** the ICICI statement (xlsx), the founder's Kotak card statement (PDF) and GoKwik's `rawSettlementReport` (CSV) are read and **checked before anything is stored** (running balance, the card's own totals, amount − fee − GST = credit); only the lines are kept, never the file, and re-uploading overlapping statements adds only new lines. Each line is classified by `_shared/bank-match.ts`: returned/reversed pairs (the ICICI glitch on the ₹1,06,000 payments), then proof (GoKwik and Velocity payouts by UTR, Meta payments by invoice number in the narration), then the owner's rules (`finance_rules`), then guesses from the UPI note or card merchant; the rest is `needs_review`. A person's decision (`finance_line_assign` / `confirm` / `reset`, logged, admin only) is final: re-matching never touches a decided line. **A bucket is a Tally ledger (migration 029, 14 Oct 2026):** names are the owner's Tally ledger names (`Salary Payable`, `Easebuzz Private Limited`, `COD receivable (Velocity)`, `Suspense` …, spelling as in Tally), the same strings the order ledger posts to; the list is `BUCKETS` in `_shared/bank-match.ts`, mirrored by the migration and checked by `bank-match.test.ts`. `Purchase Accounts` (a Tally group, the bucket for fabric and supplier bills; the supplier's own ledger is linked per payee in the export), `Returned or reversed (no entry)` and `Founder card payment (no company entry)` are not ledgers. `FINANCE COST` (interest and other finance costs) and `Myntra receivable (order control)` (Myntra's payouts) are buckets too (migration 030). The founder's card purchases are company expenses owed to him; his card payments need no company entry. All finance tables are readable only through `finance_admin()` and writable only by the service role or the logged functions. The screen defaults to dates from the accounting start date (1 Oct 2026). The Tally export is not built.
- **Velocity wallet (migration 025, `velocity-import`, Analytics → Velocity wallet, admin only; `docs/velocity-wallet.md`):** Velocity takes charges from a prepaid wallet **GST-inclusive as they happen** and sends ONE tax invoice after month end, so a top-up (UPI ₹10,000 to a Cashfree handle: `shipfast.cf`, `cf.shipfast`, masked `…t.cf@axisban`) is an **advance** and the invoice is the **expense** (Dr Shipping Expenses + GST, Cr Velocity; no bank entry); keep COD collected by Velocity in a separate ledger. The dashboard's Ledger Report CSV (Created At is IST) is checked before storing (balance column must follow from the amounts) and chains month to month; each top-up proves the bank payment that funded it (`finance-import` v3 `velocity_recharge`); a month's charges are compared with its invoice before GST (VAS matches to the paisa; the freight line counts shipping-charge reversals and lost-shipment credits but, apparently, not COD-charge reversals, ₹87.93 off in Sep 2026: inferred from one month). Velocity's public API (newer docs than the PDF) has `shipping-charges` (ledger events per parcel, ex-GST and with-GST, 100 AWBs, 5 requests a minute with `cod-remittance`) and `/shipments` (list by date) but NO wallet endpoint; top-ups and balances come only from the dashboard report, so the scheduled-email inbox is the automation plan. Top-ups with no bank payment were paid from another account (probably personally). Tally ledger names for this are not decided (accountant).
- **Deleting an upload (migration 026; Bank & card and Velocity wallet pages, admin only):** every statement, GoKwik report, Velocity ledger report and Velocity invoice has a Delete button that shows a dry run first (`dry_run` must be exactly `false` to delete). Lines another upload also covers move to it, the rest go, the bank matching is re-run, and the delete is logged in `upload_deletions`. See "Taking an upload back" in `docs/bank-reconciliation.md`.
- Sources: the ERP's Shopify token can write orders and store-credit transactions; Velocity's token is `private_secrets.velocity_api_token`; Return Prime's is the `RETURN_PRIME_TOKEN` function secret (also `private_secrets.returnprime_token` for read-only checks from SQL).

### Cutting Runs
- A **Run** groups all cut entries for a single style code batch.
- `run_pieces` stores the aggregate totals per size (XS/S/M/L/XL + custom sizes).
- Custom (non-standard) sizes are only stored when their qty > 0.
- `isRunActive(run, productionBatches)` — a run is active if any batch is not completed OR any cut pieces remain unissued.

### Production Batches
- Pieces are **issued** from a run to one or more karigars as a batch.
- Completing a batch adds its pieces to **Unicommerce** stock (non-blocking); Unicommerce pushes stock on to Shopify and Myntra. Never write stock to Shopify directly — Unicommerce overwrites it.
- SKU = `${style_code}-${size}`. Sizes whose SKU isn't in the Unicommerce catalog are skipped (create the product there, then Retry).
- The exactly-once ledger `shopify_batch_inventory_sync` keeps its name; rows applied before the switch were pushed to Shopify and are part of the opening stock loaded into Unicommerce (29 Sep 2026), so reverting them removes stock from Unicommerce.
- "Deleting" a completed batch reverts it to `issued` status and reverses the Shopify adjustment.
- `issued_sizes` / `karigar_ids` / `karigar_names` are denormalized JSONB for display speed.

### Costing Formula
```
total_cost_per_piece =
    cutting_cost
  + stitching_cost
  + trims_cost
  + finishing_cost
  + fabric_cost          -- calculated or overridden
  + sum(custom_lines.amount)

fabric_cost (calculated) =
  sum over fabric_lines of:
    avg_meters × supplier_rate_for_fabric_type
    (rate from fabric_type_supplier_rates.cost_per_m or derived from cost_per_kg + chadti)

fabric_cost_override: if set, replaces the calculated fabric_cost entirely.
```

### Karigar Payments
- **Piece-rate** karigars: payment = sum of (pieces × rate) per style code; stored in `breakdown` JSONB.
- **Salary** karigars: flat amount, no breakdown required.
- `production_entries` exists in the schema but is **empty and unused** — no UI ever wrote to it. Do not build on it.
- Payments are manual records — they are not auto-generated from production_entries.

### Production Reporting (Analytics → Production, Karigar Performance)
Two things here are easy to get wrong:

- **Cut / Issued / Completed key off three different dates** — `run_entries.date`, `production_batches.issued_date`, and `completed_date` respectively. Over a bounded range they are **independent flows, not a funnel**: a piece cut in July is often completed in August, so Completed can exceed Cut. Never render conversion percentages between them while a date range is active.
- **Per-karigar output is attributed, not measured.** A batch is assigned to a *group* of karigars and the system never records who stitched what, so each batch is split equally across `karigar_ids` (`attributeBatch` in `lib/constants.js`). 55–86% of monthly pieces sit in shared batches, so these are estimates — always label them "attributed", never "produced".
- To attribute cut pieces to a date you must use `run.entries[].date` + `pieces_added[].qty`; `run.pieces` is a dateless aggregate. Summing per style must **accumulate** — a style commonly has several runs.

### Permissions / RBAC
- `PermissionsContext` provides `can(permKey)` — returns true if user is admin OR has the specific permission.
- Admins bypass all permission checks.
- Permissions are live-synced via Supabase Realtime (changes propagate without page reload).
- Login is username-based: LoginPage resolves username → email via `get_email_by_username` RPC, then calls `signInWithPassword`.

---

## Key Architecture Decisions

### 1. `run_id` Scoping
Production batches are scoped by `run_id` to prevent cross-run data contamination. Always filter production queries by `run_id`.

### 2. IST Timezone Helper — `localToday()`
`localToday()` in `src/lib/constants.js` returns today's date as `YYYY-MM-DD` in local time. Never use `new Date().toISOString()` for dates — it returns UTC and will be wrong for IST users after midnight UTC.

### 3. No `alert()` Calls
All `alert()` / `confirm()` calls have been replaced with inline error/confirmation UI. The app runs in a sandboxed iframe context (PWA) where browser dialogs are blocked. Always use inline state-based error display.

### 4. Single Data Hook (`useAppData`)
All persistent app state lives in `useAppData`. It fetches everything on mount and exposes optimistic mutators (write to Supabase → update React state). A single Supabase Realtime channel syncs all tables — flat tables are patched directly from the payload; complex tables (with joins) do a targeted single-row refetch with a 600 ms delay to let child writes settle.

### 5. URL-Backed Filter State
All filter/sort/search state is stored in URL search params (`useSearchParams`), not component state. This preserves filters across navigation and enables deep-linking.

### 6. `KarigarPaymentCard` as Named Component
Extracted as a proper standalone component to avoid React hooks-inside-map bugs. Do not inline components that use hooks inside `.map()` calls.

### 7. Spinner Suppression on Token Refresh
`App.jsx` uses a `useRef(everLoaded)` flag so that background permission re-fetches (triggered by Supabase token refreshes on `visibilitychange`) never unmount `FabricCuttingModule` or close open modals.

### 8. Pipeline Health Cache
`pipeline_health` RPC result is cached in localStorage (`brune_pipeline_health_v4`) with a 15-minute TTL using a stale-while-revalidate strategy. The module-level `_pipelineInflight` promise deduplicates concurrent callers.

---

## Conventions to Follow

- **Date/time:** Always IST. Use `localToday()` helper, never raw `new Date()` for date strings.
- **Error handling:** Inline UI errors only — no `alert()` or `confirm()`.
- **Components:** Extract any component used inside `.map()` as a proper named component if it uses hooks.
- **Data fetching:** All reads/writes go through the Supabase client directly (no API layer).
- **Styling:** Tailwind CSS utility classes only. Color palette is stone-based (stone-900, stone-50, etc.).
- **No SSR:** This is a Vite SPA — no server-side code, no API routes in the frontend.
- **Sizes:** Standard sizes are `['XS', 'S', 'M', 'L', 'XL']`; use `orderSizes()` to sort any size array.
- **Permissions:** Always gate write actions with `can('can_edit_*')` checks from `usePermissions()`.

---

## Planned Next Steps

All originally planned features are now complete. No known outstanding items.

---

*This file should be kept up to date as the project evolves. Update it at the end of major feature sessions.*
