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
| Shopify Inventory | ✅ Done | Read Shopify stock; auto-sync on batch completion via Edge Function |
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
    shopify-adjust-inventory/   # Adjust Shopify stock when a batch is completed/reverted
    shopify-inventory-webhook/  # Receive Shopify inventory_level/update webhooks
    shopify-return-webhook/     # Handle Shopify return events
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

The Supabase Edge Functions use server-side secrets (SHOPIFY_ACCESS_TOKEN, SHOPIFY_SHOP_DOMAIN, etc.) configured in the Supabase dashboard — not in .env files.

---

## Business Logic Details

### Inventory Tracking
- **Rolls** are tracked by weight (kg): `current_weight_kg` decreases as fabric is used.
- **Thans** are tracked by length (m): `current_length_m` decreases as fabric is used.
- Status auto-sets to `'finished'` when current ≤ 0.05 kg (roll) or ≤ 0.1 m (than).
- Auto-numbering scheme: `ROLL-0001`, `THAN-0001` etc. (sequential within format).
- Fabric usage is recorded per cut entry; deleting an entry reverses the consumption.

### Cutting Runs
- A **Run** groups all cut entries for a single style code batch.
- `run_pieces` stores the aggregate totals per size (XS/S/M/L/XL + custom sizes).
- Custom (non-standard) sizes are only stored when their qty > 0.
- `isRunActive(run, productionBatches)` — a run is active if any batch is not completed OR any cut pieces remain unissued.

### Production Batches
- Pieces are **issued** from a run to one or more karigars as a batch.
- Completing a batch triggers a Shopify inventory adjustment (non-blocking).
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
