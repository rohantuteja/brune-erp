-- ============================================================
-- Brune ERP — initial schema
-- Run this once in the Supabase SQL editor for your project.
-- ============================================================

-- ── Suppliers ────────────────────────────────────────────────
create table if not exists suppliers (
  id            bigserial    primary key,
  name          text         not null,
  contact_person text        not null default '',
  phone         text         not null default '',
  email         text         not null default '',
  address       text         not null default '',
  created_at    timestamptz  not null default now()
);

-- ── Fabric types ─────────────────────────────────────────────
create table if not exists fabric_types (
  id          bigserial   primary key,
  name        text        not null,
  composition text        not null default '',
  gsm         integer,
  format      text        not null check (format in ('roll', 'than')),
  created_at  timestamptz not null default now()
);

-- ── Supplier rates per fabric type ───────────────────────────
-- For rolls: cost_per_kg + chadti (meters-per-kg ratio)
-- For thans: cost_per_m
create table if not exists fabric_type_supplier_rates (
  id             bigserial primary key,
  fabric_type_id bigint    not null references fabric_types(id) on delete cascade,
  supplier_id    bigint    not null references suppliers(id)    on delete cascade,
  cost_per_kg    numeric,
  chadti         numeric,
  cost_per_m     numeric,
  unique (fabric_type_id, supplier_id)
);

-- ── Style codes master ────────────────────────────────────────
create table if not exists style_codes (
  id         bigserial   primary key,
  code       text        not null unique,
  created_at timestamptz not null default now()
);

-- ── Karigars (tailors / workers) ─────────────────────────────
create table if not exists karigars (
  id           bigserial   primary key,
  name         text        not null unique,
  payment_type text        not null default 'piece_rate'
                           check (payment_type in ('piece_rate', 'salary')),
  created_at   timestamptz not null default now()
);

-- ── Fabric inventory (rolls and thans) ───────────────────────
create table if not exists inventory (
  id                bigserial   primary key,
  inventory_number  text        not null unique,
  format            text        not null check (format in ('roll', 'than')),
  fabric_type_id    bigint      not null references fabric_types(id),
  color             text,
  supplier_id       bigint      not null references suppliers(id),
  width_cm          numeric,
  -- roll fields
  initial_weight_kg numeric,
  current_weight_kg numeric,
  -- than fields
  initial_length_m  numeric,
  current_length_m  numeric,
  rate              numeric,
  received_date     date,
  status            text        not null default 'available'
                                check (status in ('available', 'finished')),
  notes             text,
  created_at        timestamptz not null default now()
);

-- ── Cutting runs (one logical run per style-code batch) ──────
create table if not exists runs (
  id               bigserial   primary key,
  style_code       text        not null,
  first_cut_date   date,
  last_append_date date,
  created_at       timestamptz not null default now()
);

-- ── Aggregate pieces per size per run ────────────────────────
create table if not exists run_pieces (
  id       bigserial primary key,
  run_id   bigint    not null references runs(id) on delete cascade,
  size     text      not null,
  quantity integer   not null default 0,
  unique (run_id, size)
);

-- ── Individual cut entries within a run ──────────────────────
create table if not exists run_entries (
  id         bigserial   primary key,
  run_id     bigint      not null references runs(id) on delete cascade,
  date       date        not null,
  notes      text        not null default '',
  created_at timestamptz not null default now()
);

-- ── Inventory consumed per cut entry ─────────────────────────
create table if not exists run_entry_usage (
  id            bigserial primary key,
  entry_id      bigint    not null references run_entries(id) on delete cascade,
  inventory_id  bigint    not null references inventory(id),
  weight_used_kg numeric,
  length_used_m  numeric
);

-- ── Pieces cut (by size) per cut entry ───────────────────────
create table if not exists run_entry_pieces_added (
  id       bigserial primary key,
  entry_id bigint    not null references run_entries(id) on delete cascade,
  size     text      not null,
  qty      integer   not null default 0
);

-- ── Style costings (one per style code) ──────────────────────
create table if not exists costings (
  id              bigserial   primary key,
  style_code      text        not null unique,
  cutting_cost    numeric     not null default 0,
  stitching_cost  numeric     not null default 0,
  trims_cost      numeric     not null default 0,
  finishing_cost  numeric     not null default 0,
  updated_date    date,
  created_at      timestamptz not null default now()
);

-- ── Fabric lines within a costing ────────────────────────────
create table if not exists costing_fabric_lines (
  id             bigserial primary key,
  costing_id     bigint    not null references costings(id) on delete cascade,
  fabric_type_id bigint    references fabric_types(id),
  avg_meters     numeric   not null default 0
);

-- ── Custom cost lines within a costing ───────────────────────
create table if not exists costing_custom_lines (
  id         bigserial primary key,
  costing_id bigint    not null references costings(id) on delete cascade,
  label      text,
  amount     numeric   not null default 0
);

-- ── Production batches (pieces issued to karigars) ───────────
-- issued_sizes: JSONB map of { "XS": 0, "S": 10, ... }
-- karigar_ids / karigar_names: JSONB arrays (denormalised for display speed)
create table if not exists production_batches (
  id             bigserial   primary key,
  run_id         bigint      not null references runs(id),
  style_code     text        not null,
  issued_date    date,
  notes          text        not null default '',
  issued_sizes   jsonb       not null default '{}',
  total_issued   integer     not null default 0,
  karigar_ids    jsonb       not null default '[]',
  karigar_names  jsonb       not null default '[]',
  status         text        not null default 'issued'
                             check (status in ('issued', 'completed')),
  completed_qty  integer,
  completed_date date,
  created_at     timestamptz not null default now()
);

-- ── Production entries (stitching output per karigar per day) ─
-- items: JSONB array of [{ sku, qty }]
create table if not exists production_entries (
  id           bigserial   primary key,
  date         date        not null,
  karigar_id   bigint      not null references karigars(id),
  karigar_name text,
  items        jsonb       not null default '[]',
  created_at   timestamptz not null default now(),
  unique (date, karigar_id)
);

-- ── Karigar payment records ───────────────────────────────────
-- breakdown: JSONB array of [{ style_code, pieces, rate, subtotal }]
create table if not exists karigar_payments (
  id          bigserial   primary key,
  karigar_id  bigint      not null references karigars(id),
  date        date        not null,
  amount      numeric     not null,
  breakdown   jsonb       not null default '[]',
  notes       text        not null default '',
  created_at  timestamptz not null default now()
);

-- ── Row-level security ────────────────────────────────────────
-- RLS is disabled for now. Enable and add per-user policies once
-- Supabase Auth is integrated.
alter table suppliers                 disable row level security;
alter table fabric_types              disable row level security;
alter table fabric_type_supplier_rates disable row level security;
alter table style_codes               disable row level security;
alter table karigars                  disable row level security;
alter table inventory                 disable row level security;
alter table runs                      disable row level security;
alter table run_pieces                disable row level security;
alter table run_entries               disable row level security;
alter table run_entry_usage           disable row level security;
alter table run_entry_pieces_added    disable row level security;
alter table costings                  disable row level security;
alter table costing_fabric_lines      disable row level security;
alter table costing_custom_lines      disable row level security;
alter table production_batches        disable row level security;
alter table production_entries        disable row level security;
alter table karigar_payments          disable row level security;
