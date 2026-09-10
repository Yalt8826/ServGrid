-- Migration 006 — customer_products (PLAN-DATA-MODEL.md §3.3).
--
-- What is physically installed at a site. Distinct from products (the
-- catalogue) and customers (the site): this is the intersection — a
-- particular unit, at a particular site, with its serial and warranty.
-- The technician's app reads it offline and writes to it after an
-- install (PLAN.md §4), and job_cards.customer_product_id (migration
-- 007) is what finally makes the stored warranty data answerable with
-- one join.
--
-- Mutable and syncable (§6): the mirror carries the site stack, so the
-- usual version/created_at/updated_at plumbing and the touch_updated_at
-- trigger apply. Soft delete only — is_active = false is what releases
-- a serial back into circulation; no row is ever deleted.
CREATE TABLE customer_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  product_id          uuid REFERENCES products(id), -- NULL = third-party kit
  free_text_name      text,  -- required when product_id IS NULL, same
                             -- shape as job_completion_parts (migration 007)
  serial_number       text NOT NULL,
  quantity            integer NOT NULL DEFAULT 1,
  CONSTRAINT customer_products_quantity_positive CHECK (quantity > 0),
  CONSTRAINT customer_products_product_or_name
    CHECK (product_id IS NOT NULL OR free_text_name IS NOT NULL),
  installed_on         date,
  warranty_expires_on  date,
  installed_by         uuid REFERENCES employees(id), -- NULL for opening stock entered by hand
  -- Forward reference: job_cards does not exist until migration 007, so
  -- the column is declared here and its FOREIGN KEY is added there.
  -- Every stack change must trace to the job that caused it (§3.3) —
  -- this column is that trace. The same column-before-constraint
  -- pattern as job_cards.contract_visit_id, for the same reason:
  -- adding the column later would be an expand/contract cycle on a
  -- table the technician's app writes from the field.
  source_job_id        uuid,
  notes                text,
  is_active            boolean NOT NULL DEFAULT true, -- soft delete, never DELETE
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1
);

-- §5 index plan. A serial cannot be installed at two sites at once.
-- lower(): serials arrive typed by hand on a stairwell; 'UPS-88120' and
-- 'ups-88120' are the same unit. Among ACTIVE rows only — de-install
-- (is_active = false) releases the serial, and a customer who sells a
-- unit to another customer must not wedge the buyer's install. Not a
-- table CONSTRAINT because partial rules only exist as indexes.
CREATE UNIQUE INDEX customer_products_active_serial_unique
  ON customer_products (lower(serial_number)) WHERE is_active;

-- §5 index plan: the site's stack is read as one list.
CREATE INDEX customer_products_customer_active_idx
  ON customer_products (customer_id) WHERE is_active;

-- Per §5 no updated_at index on this table: the mirror pulls it inside
-- the customer/job scope queries, and no standalone sync-cursor query
-- exists yet — the same call migration 005 made for reference data.

-- touch_updated_at on every mutable table (§2), with the WHEN clause
-- from migration 001: the trigger stays out of the hot path whenever
-- the caller supplied updated_at deliberately (a sync replay).
CREATE TRIGGER customer_products_touch BEFORE UPDATE ON customer_products
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();
