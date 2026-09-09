-- Migration 005 — reference_data (PLAN-DATA-MODEL.md §3.2).
-- companies, customers, products, services.
--
-- The parties and catalogue the rest of the schema points at: jobs are
-- for customers, sales are to companies, completions reference products,
-- job_cards.service_id references services. All four are mutable and
-- syncable (§6), so each carries version/created_at/updated_at and the
-- touch_updated_at trigger (migration 001).

-- -----------------------------------------------------------------------
-- companies — B2B accounts the sales reps sell to; dues accrue here.
--
-- owner_rep_id is ownership: each rep sees his accounts, and NULL means
-- a house account visible to every rep (the rbac scope `own` on company
-- becomes `owner_rep_id = :actor OR owner_rep_id IS NULL`). The nullable
-- case is load-bearing — a company created by the owner lands here, and
-- it is how leave is handled: the owner nulls or reassigns a rep's
-- accounts for the duration, and the change leaves a trail.
--
-- name is citext, so the active-name uniqueness below is
-- case-insensitive for free (same reasoning as employees.username,
-- migration 003).
-- -----------------------------------------------------------------------
CREATE TABLE companies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           citext NOT NULL,
  contact_person text,
  phone          text,
  email          text,
  address_line1  text,
  address_line2  text,
  city           text,
  state          text,
  pincode        text,
  gstin          text,
  CONSTRAINT companies_gstin_shape CHECK (gstin ~ '^[0-9A-Z]{15}$'),
  notes        text,
  owner_rep_id uuid REFERENCES employees(id), -- NULL = house account, every rep
  is_active    boolean NOT NULL DEFAULT true, -- soft delete, never DELETE
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1
);

-- Case-insensitive unique name among ACTIVE rows only (§3.2): a
-- deactivated 'Sharma Enterprises' must not block re-entering it. citext
-- equality does the case-folding; the WHERE clause does the rest. Not a
-- table CONSTRAINT because exclusions-partial rules only exist as
-- indexes.
CREATE UNIQUE INDEX companies_active_name_unique ON companies (name) WHERE is_active;

-- §5 index plan: a rep's account list.
CREATE INDEX companies_owner_rep_active_idx ON companies (owner_rep_id) WHERE is_active;

-- -----------------------------------------------------------------------
-- customers — service recipients. Distinct parties from companies: jobs
-- are for customers, sales are to companies. company_id is a CONTEXT
-- link only — this site belongs to that corporate account — and creates
-- no financial relationship ("no customer credit" is a plan-level rule,
-- PLAN.md §4). If a corporate site's jobs must one day bill to the
-- company account, that is a new feature, not this nullable column
-- doing double duty.
--
-- latitude/longitude are paired: a site is located or it is not, and a
-- lone half would render as (0,0)-adjacent nonsense on the owner's map.
-- The dispatcher search indexes (phone, below) and the GIN name index
-- come from the §5 index plan.
-- -----------------------------------------------------------------------
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  phone         text NOT NULL,
  alt_phone     text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  pincode       text,
  latitude      double precision,
  longitude     double precision,
  CONSTRAINT customers_latlng_paired CHECK ((latitude IS NULL) = (longitude IS NULL)),
  notes      text,
  company_id uuid REFERENCES companies(id),
  is_active  boolean NOT NULL DEFAULT true, -- soft delete, never DELETE
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    integer NOT NULL DEFAULT 1
);

CREATE INDEX customers_phone_idx ON customers (phone);

-- GIN over the name for dispatcher search. The two-argument
-- to_tsvector('simple', ...) is required: the one-argument form depends
-- on default_text_search_config and is not IMMUTABLE, so Postgres
-- refuses to index it. 'simple' — no stemming — is right for names.
CREATE INDEX customers_name_tsv_idx ON customers
  USING gin (to_tsvector('simple', name::text));

-- -----------------------------------------------------------------------
-- products — the catalogue. sku UNIQUE outright (a retired SKU must not
-- be reissued onto records that still point at it). capacity_label is
-- display-only ("850VA", "150Ah") — nothing computes against it;
-- default_price is what the sale screen pre-fills, and the sale line
-- snapshots the price at sale time (§3.5), so repricing never rewrites
-- history.
-- -----------------------------------------------------------------------
CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL,
  CONSTRAINT products_sku_unique UNIQUE (sku),
  name            text NOT NULL,
  category        product_category NOT NULL,
  brand           text,
  model_number    text,
  capacity_label  text, -- display-only: "850VA", "150Ah"
  unit            text, -- "NOS", "PCS"
  default_price   numeric(12,2),
  warranty_months smallint,
  is_active       boolean NOT NULL DEFAULT true, -- soft delete, never DELETE
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------
-- services — the job-type catalogue; job_cards.service_id points here.
-- code UNIQUE outright, same reasoning as products.sku. INSTALL, AMC and
-- BATT-SWAP ship via seed/002_services.sql, not here (§8) — the
-- migration owns shape, the seed owns rows.
-- -----------------------------------------------------------------------
CREATE TABLE services (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  CONSTRAINT services_code_unique UNIQUE (code),
  name           text NOT NULL,
  description    text,
  default_charge numeric(12,2),
  is_active      boolean NOT NULL DEFAULT true, -- soft delete, never DELETE
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        integer NOT NULL DEFAULT 1
);

-- touch_updated_at on every mutable table (PLAN-DATA-MODEL.md §2), with
-- the WHEN clause from migration 001: the trigger stays out of the hot
-- path whenever the caller supplied updated_at deliberately (a sync
-- replay). updated_at is the delta-sync cursor for these tables on the
-- mobile mirror; per §5 no secondary index on it yet — no query needs
-- one until a sync-cursor query on reference data exists.
CREATE TRIGGER companies_touch BEFORE UPDATE ON companies
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER services_touch BEFORE UPDATE ON services
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();
