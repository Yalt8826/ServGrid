-- Migration 007 — jobs (PLAN-DATA-MODEL.md §3.4).
-- job_cards, job_completions, job_completion_parts, job_cancellations,
-- job_events.
--
-- THE LOAD-BEARING DECISION: job_cards has no money columns. "Dispatchers
-- cannot see revenue" is a property of the schema here, not a promise
-- about every future SELECT — there is nothing to leak, and no view or
-- row-level policy has to hold the line. Money lives one join away, on
-- job_completions, whose read rules are the completion endpoints' to
-- enforce (PLAN-BACKEND.md §6).
--
-- job_cards is mutable and syncable (§6): version/created_at/updated_at
-- and the touch_updated_at trigger, with the (updated_at) index — it is
-- the delta-sync cursor for the technician's mirror, and the scope-exit
-- tombstone protocol (§6.4, PLAN-BACKEND.md §7) reads it.
--
-- job_completions and job_cancellations are 1:1 children that only ever
-- exist once their job reaches a terminal state; job_events is the
-- append-only trail for everything else.

-- -----------------------------------------------------------------------
-- job_cards — one row per job. Status walks
-- unassigned → assigned → en_route → in_progress → completed, with
-- cancelled reachable from any non-terminal state (transitions are
-- validated in PLAN-BACKEND.md §6.1 — application logic, deliberately
-- not a database constraint: the database cannot know that "completed"
-- is illegal because the office cancelled it while the technician was
-- underground, only that both are valid enum values).
--
-- Two nullable context FKs, both earning their place (§3.4):
--
-- customer_product_id names the specific unit. Without it, a site with
-- five UPS units and three battery banks produces a card reading
-- "battery swap" and leaves the technician to work it out on arrival.
-- Nullable because a site survey has no existing unit, and a dispatcher
-- taking a call may not know which one.
--
-- contract_visit_id points at Phase 2B's contract_visits. The column is
-- created NOW and its FOREIGN KEY is added by migration 015 — adding the
-- column later would be an expand/contract cycle on the busiest table in
-- the schema. Until 015 nothing writes to it, and the one-live-per-visit
-- partial unique index below is vacuously satisfied.
--
-- created_by is NULL for system-generated cards: the contract-visit
-- generator (Phase 2B) raises job cards with no human author, the same
-- convention as job_events.actor_id.
-- -----------------------------------------------------------------------
CREATE TABLE job_cards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- JC-2627-00042 — allocated via next_in_sequence('job:2627') at
  -- creation (migration 004); the format lives in the service layer.
  job_number          text NOT NULL,
  CONSTRAINT job_cards_job_number_unique UNIQUE (job_number),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  service_id          uuid NOT NULL REFERENCES services(id),
  customer_product_id uuid REFERENCES customer_products(id),
  contract_visit_id   uuid, -- column now, FK in migration 015
  title               text NOT NULL,
  description         text,
  priority            job_priority NOT NULL DEFAULT 'normal',
  status              job_status NOT NULL DEFAULT 'unassigned',
  assigned_to         uuid REFERENCES employees(id),
  assigned_by         uuid REFERENCES employees(id),
  assigned_at         timestamptz,
  scheduled_for       timestamptz,
  -- Which business day the job is ON, in IST — the dispatcher's day
  -- buckets and the technician's Jobs tabs group on this, never on the
  -- UTC date of the timestamp. Generated, so it cannot drift.
  scheduled_date      date GENERATED ALWAYS AS (business_date(scheduled_for)) STORED,
  contact_name        text,
  contact_phone       text,
  created_by          uuid REFERENCES employees(id), -- NULL = system-generated
  closed_at           timestamptz,

  -- A card is either unassigned with nobody on it, or assigned with
  -- somebody on it — the half-states are unrepresentable.
  CONSTRAINT job_assignment_coherent CHECK (
    (status = 'unassigned' AND assigned_to IS NULL) OR
    (status <> 'unassigned' AND assigned_to IS NOT NULL)
  ),
  -- Closed means closed: completed/cancelled exactly when closed_at is
  -- set. The closure timestamp is never a guess.
  CONSTRAINT job_closed_coherent CHECK (
    (status IN ('completed','cancelled')) = (closed_at IS NOT NULL)
  ),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- §5 index plan, all of them, none extra. Each names the query it
-- serves; anything not listed needs a query to justify it.

-- The technician's Jobs tabs: my day, in status order.
CREATE INDEX job_cards_technician_day_idx ON job_cards (assigned_to, scheduled_date)
  WHERE status NOT IN ('completed', 'cancelled');

-- The dispatcher's Job Logs filter and Overdue (open past its date).
CREATE INDEX job_cards_status_scheduled_idx ON job_cards (status, scheduled_date DESC);

-- A customer's history, newest first.
CREATE INDEX job_cards_customer_created_idx ON job_cards (customer_id, created_at DESC);

-- Unit service history and the warranty check — one join off
-- customer_product_id.
CREATE INDEX job_cards_customer_product_idx ON job_cards (customer_product_id)
  WHERE customer_product_id IS NOT NULL;

-- Delta-sync cursor (§6).
CREATE INDEX job_cards_updated_at_idx ON job_cards (updated_at);

-- At most one LIVE job per contract visit (§3.4). A visit can produce
-- several cards across attempts — the technician who finds no access
-- cancels, and the rescheduled visit raises a second card — but only one
-- may be live at a time, and the generator's idempotency leans on this
-- index rather than trusting its own query.
CREATE UNIQUE INDEX job_cards_one_live_per_visit ON job_cards (contract_visit_id)
  WHERE contract_visit_id IS NOT NULL AND status <> 'cancelled';

-- Attempt history for a visit, including the cancelled attempts — the
-- record of what was tried that the one-live index deliberately keeps.
CREATE INDEX job_cards_visit_history_idx ON job_cards (contract_visit_id);

CREATE TRIGGER job_cards_touch BEFORE UPDATE ON job_cards
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

-- Every stack change traces to the job that caused it (§3.3): the
-- forward-referenced column from migration 006 gets its constraint now
-- that job_cards exists.
ALTER TABLE customer_products
  ADD CONSTRAINT customer_products_source_job_fk
  FOREIGN KEY (source_job_id) REFERENCES job_cards(id);

-- -----------------------------------------------------------------------
-- job_completions — 1:1 with job_cards; the PK IS the job. This is the
-- money table the dispatcher must never read.
--
-- completed_at is the CLIENT's clamped completedAt, not now(): a
-- technician who completes underground at 14:10 and syncs at 16:40 took
-- the money at 14:10. business_date is generated from it, so cash
-- collected on Monday lands on Monday whenever it syncs.
--
-- The discount rule is the database's, not the service's: amount_collected
-- is generated (cost − discount), a discount needs a reason, and a
-- shortfall with no explanation is unrepresentable. The alternative is a
-- silent gap between what was owed and what arrived at the handover,
-- surfacing weeks later as an unexplained variance. A warranty job and
-- an upfront AMC visit are the same shape — cost 0, discount 0, mode
-- none — and pass unchanged.
--
-- Mutable (the owner amends with a reason, PLAN-DATA-MODEL.md §3.4), so
-- version/updated_at and the touch trigger apply; the before/after pair
-- of every amendment goes to job_events as completion_amended. No
-- updated_at index per §5 — completions are pulled by job scope, not
-- cursor.
-- -----------------------------------------------------------------------
CREATE TABLE job_completions (
  job_card_id       uuid PRIMARY KEY REFERENCES job_cards(id),
  completed_by      uuid NOT NULL REFERENCES employees(id),
  completed_at      timestamptz NOT NULL,
  business_date     date GENERATED ALWAYS AS (business_date(completed_at)) STORED,
  work_summary      text NOT NULL,
  cost              numeric(12,2) NOT NULL
    CONSTRAINT completion_cost_non_negative CHECK (cost >= 0),
  discount_amount   numeric(12,2) NOT NULL DEFAULT 0
    CONSTRAINT completion_discount_non_negative CHECK (discount_amount >= 0),
  discount_reason   text,
  amount_collected  numeric(12,2) GENERATED ALWAYS AS (cost - discount_amount) STORED,
  collection_mode   collection_mode NOT NULL,
  payment_reference text, -- UPI txn id / cheque number; NULL for cash
  customer_signed   boolean NOT NULL DEFAULT false, -- signature photo lives in attachments (§3.6)
  latitude          double precision,
  longitude         double precision,
  CONSTRAINT job_completions_latlng_paired
    CHECK ((latitude IS NULL) = (longitude IS NULL)),

  -- A discount is bounded by what was owed, and it is justified or it
  -- does not exist. Mode coherence: nothing to collect means 'none' is
  -- honest; anything owed means the money moved by SOME mode.
  CONSTRAINT completion_discount_bounded   CHECK (discount_amount <= cost),
  CONSTRAINT completion_discount_justified CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
  CONSTRAINT completion_mode_coherent      CHECK ((cost - discount_amount) = 0 OR collection_mode <> 'none'),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- §5 index plan: the expected-cash view walks one technician's cash day;
-- the owner's revenue dashboard walks days.
CREATE INDEX job_completions_cash_idx ON job_completions (completed_by, business_date)
  WHERE collection_mode = 'cash';
CREATE INDEX job_completions_business_date_idx ON job_completions (business_date DESC);

CREATE TRIGGER job_completions_touch BEFORE UPDATE ON job_completions
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------
-- job_completion_parts — what was physically fitted or consumed, shipped
-- now (not with contracts in 015) because a battery swap consumes parts
-- whether or not a contract caused it, and a later pass over the
-- completion form is exactly the complexity this plan refuses.
--
-- NOT AN INVOICE. cost on job_completions stays one figure the
-- technician enters; parts are a record of what was fitted. Anyone
-- deriving cost from SUM(quantity × unit_cost) is reimplementing
-- invoicing, which PLAN.md §4 rules out. unit_cost is nullable because a
-- technician in a stairwell does not know what the part cost. Nothing is
-- decremented anywhere — this is not an inventory model (§9 open item 3).
--
-- Rows are written once with the completion and rewritten in full by an
-- owner amendment; the before/after lives in job_events. No
-- version/updated_at plumbing — there is no partial update to order and
-- no mirror cursor reads them.
-- -----------------------------------------------------------------------
CREATE TABLE job_completion_parts (
  job_card_id       uuid NOT NULL REFERENCES job_completions(job_card_id),
  line_no           integer NOT NULL,
  product_id        uuid REFERENCES products(id), -- NULL = third-party kit
  free_text_name    text, -- required when product_id IS NULL
  quantity          numeric(10,2) NOT NULL,
  unit_cost         numeric(12,2),
  serial_number     text, -- the fitted unit's serial, when it has one
  from_customer_stock boolean NOT NULL DEFAULT false, -- customer-supplied: not a cost to the business
  CONSTRAINT job_completion_parts_pk PRIMARY KEY (job_card_id, line_no),
  CONSTRAINT job_completion_parts_quantity_positive CHECK (quantity > 0),
  CONSTRAINT job_completion_parts_product_or_name
    CHECK (product_id IS NOT NULL OR free_text_name IS NOT NULL)
);

-- -----------------------------------------------------------------------
-- job_cancellations — the OTHER terminal outcome, kept 1:1 and separate
-- from job_completions so the two cannot both be present and neither
-- pollutes the dispatcher's row.
--
-- Moving a job to a different day is NOT a cancellation — it is a PATCH
-- of scheduled_for under If-Match emitting a rescheduled event, and an
-- open job past its date simply surfaces as Overdue. replacement_job_id
-- records "cancelled AND a successor was raised", which the cancel flow
-- creates in the same transaction.
--
-- Written once at cancellation time; history corrections go through
-- job_events, so no mutable plumbing.
-- -----------------------------------------------------------------------
CREATE TABLE job_cancellations (
  job_card_id        uuid PRIMARY KEY REFERENCES job_cards(id),
  cancelled_by       uuid NOT NULL REFERENCES employees(id),
  cancelled_at       timestamptz NOT NULL,
  reason_code        cancellation_reason NOT NULL,
  reason_note        text,
  -- 'other' without a note is an excuse, not a reason.
  CONSTRAINT job_cancellations_other_justified
    CHECK (reason_code <> 'other' OR reason_note IS NOT NULL),
  replacement_job_id uuid REFERENCES job_cards(id)
);

-- -----------------------------------------------------------------------
-- job_events — the append-only trail. Bigint identity per the
-- data-model convention (uuid for business rows, bigint identity for
-- append-only logs). Never updated, never deleted — the offline seam
-- lives here: occurred_at is when it happened on site, recorded_at is
-- when the server heard about it. A completion at 14:10 that syncs at
-- 16:40 is exactly that gap; reports read occurred_at, sync debugging
-- reads the difference.
--
-- idempotency_key is the client's per-event key; the batch drain
-- (PLAN-BACKEND.md §7) uses the request-level idempotency_keys table
-- first, and this column is what makes a partially-applied batch
-- recognisable by hand. payload carries the event's business detail
-- (the amendment's before/after, a cancellation's reason context).
-- -----------------------------------------------------------------------
CREATE TABLE job_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_card_id     uuid NOT NULL REFERENCES job_cards(id),
  event_type      job_event_type NOT NULL,
  actor_id        uuid REFERENCES employees(id), -- NULL = system
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  from_status     job_status,
  to_status       job_status,
  source          event_source NOT NULL,
  idempotency_key text,
  payload         jsonb
);

-- §5 index plan: the job timeline, newest first.
CREATE INDEX job_events_job_occurred_idx ON job_events (job_card_id, occurred_at DESC);
