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
| Analytics | ✅ Done | Charts and summaries (inventory value, WIP, COD, returns, stock health) |
| Master Data | ✅ Done | Reference data (karigars, fabric types, suppliers, style codes) |
| Auth / RBAC | ✅ Done | Supabase Auth + role-based permissions (admin/production_incharge/floor_supervisor/manager) |
| Shopify Inventory | ✅ Done | Read Shopify stock (Unicommerce now pushes stock to Shopify) |
| Unicommerce stock sync | ✅ Live | Batch completion, RTO and Return Prime returns → Unicommerce (see Stock sync below) |
| Monthly Snapshots | ✅ Done | 4 snapshot types: Inventory, WIP, Shopify Stock, COD Pending — each with its own Edge Function and table |
| User Management | ✅ Done | Admin UI to create/edit users and assign granular permissions |

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
    unicommerce-adjust-inventory/ # Add/remove Unicommerce stock when a batch is completed/reverted
    shopify-adjust-inventory/   # Legacy: adjusted Shopify stock directly (replaced by unicommerce-adjust-inventory)
    shopify-inventory-webhook/  # Receive Shopify inventory_level/update webhooks
    shopify-return-webhook/     # Log Return Prime refunds for the Returns screen (no stock change)
    shopify-order-webhook/      # RTO Shopify orders → Unicommerce stock, cancel on Shopify, store credit
    returnprime-webhook/        # Return Prime returns back at warehouse → Unicommerce stock
    shopify-product-webhook/    # Product goes live → create its SKUs in Unicommerce (GST 5, or 18 above ₹2,500), add waiting batches, link its listings
    shopify-sync/               # Full sync of Shopify product inventory into Supabase
    take-cod-snapshot/          # Daily COD analytics snapshot

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
| Shopify order edited (size swap, item added/removed) | `orders/edited`, daily sweep, 15-min job | Unicommerce never sees edits and dispatches its stale copy (#37827). Per line: required = current qty + returned − Unicommerce's non-cancelled items; the ERP REMOVEs / ADDs the difference from what it already applied. Reversed if Unicommerce cancels its copy; left alone for orders placed before the opening load. Unicommerce's own order and invoice keep the original items | `shopify_order_edits`, `shopify_order_edit_lines` |

- Opening stock load: Shopify snapshot 2026-09-29 17:07:59 UTC. The old refund-time Shopify restock was switched off at 2026-09-29 23:41:24 UTC.
- Orders tagged `rto_delivered`, and returns back at the warehouse before go-live, are `baseline` rows and are never processed.
- `shopify-order-webhook` only acts on orders tagged `erp-test` until `app_settings.order_webhook_mode = "live"`. RTO cancel and store credit also need `app_settings.rto_shopify_actions = true`.
- Failures and anything needing a person show under Analytics → Returns → "Needs attention".
- **Unicommerce only accepts its API from whitelisted IPs** (since 2 Oct 2026). Edge functions have no fixed egress, so every `/services/*` call goes through the DB function `public.uc_post` (migration 009, `http` extension), which leaves from the database's whitelisted IPv6 address. That address changes if the project is paused/resumed or Postgres is upgraded; re-whitelist it in Unicommerce (`select content from extensions.http_get('https://api64.ipify.org')`). `/oauth/token` is not IP-restricted and stays in the edge functions.
- Scheduled every 15 min (pg_cron, migration 006; key `private_secrets.erp_stock_cron_key`): `returnprime-sweep` catches returns whose webhook never arrived. (`shopify-cancel-recheck` was dropped in migration 007 along with cancellation handling.)
- Every 15 min (migration 011, same key): `shopify-returns-settle` settles RTO lines waiting for Unicommerce's return and retries failed lines hourly, and re-checks edit corrections that are pending or need attention; `returnprime-sweep` does the same for Return Prime lines and sweeps the newest ~150 requests.
- Daily at 06:00 IST (migration 010, same key): `shopify-rto-sweep` processes `rto_delivered` orders from the last 3 days that the ERP has no record of, moves RTOs stuck half-processed to "Needs attention", and re-checks every order edited in those 3 days.
- **Shopify marks an order `edited` whenever a refund removes an item**, so every Return Prime return also reaches the edit logic; the "+ returned" term makes those come out as no change. Return Prime refunds of orders shipped before go-live had their Unicommerce copies cancelled (#37654), hence the pre-load and cancelled-copy rules.
- New products (`shopify-product-webhook`, subscribed 8 Oct 2026 to `products/create` + `products/update`): when a Shopify product is Active, each size SKU missing from Unicommerce is created (fields as `~/Unicommerce/shopify_to_uc.py`; existing SKUs are never edited), then completed ERP batches of that style not yet synced are added. GST by each variant's selling price (not compare-at): ≤ ₹2,500 → code `5`, above → `18`; if Unicommerce rejects `18` the SKU is created at `5` and flagged `needs_review` in `unicommerce_sku_sync`. Then each listing is linked to its SKU in Unicommerce (`createChannelItemType`, channel `SHOPIFY`, listing id `<product id>-<variant id>`), or Unicommerce never pushes stock to it. A SKU can have several listings: the Unlisted lower-price copies of a product share its SKUs, and Unicommerce pushes the SKU's full stock to every copy (orders from any copy draw on the same stock). Links are recorded in `unicommerce_channel_links` (migration 013); the 319 listings Unicommerce had already linked on 8 Oct 2026 are `baseline` rows and never touched.
- Go-live state (2026-09-30): `order_webhook_mode = "live"`, `rto_shopify_actions = true`, Shopify `orders/updated` + `orders/cancelled` and Return Prime `request/received` subscribed. `orders/edited` subscribed 8 Oct 2026.

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
