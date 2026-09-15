-- Migration 015 — service contracts (PHASE-2B-CONTRACTS.md T2B.1;
-- PLAN-DATA-MODEL.md §3.10, §4; decision of 2026-09-15,
-- docs/decisions/2026-09-15-amc-contracts.md).
--
-- One site, one AMC at a time, and reminders that cannot drift. The
-- owner runs AMCs without a visit schedule: a job links straight to its
-- contract (job_cards.contract_id, below) and the app reminds the
-- dispatcher four months after the customer's LAST COMPLETED JOB — any
-- job at that site, AMC-linked or not (decision 4). Every reminder fact
-- is therefore DERIVED in v_contracts; a stored reminder would be a fact
-- waiting to fall out of step with the jobs it describes. State
-- (upcoming/active/expired) is likewise computed from the dates against
-- business_date(now()) — no status column, no nightly expire job.
--
-- Numbered 015 between 013 and 016: the number records the order the
-- migration was written, not applied (checkOrder: false); 015 was left
-- free by the renumbering of 13 Sep 2026.
--
-- job_cards.contract_visit_id (007) belonged to the replaced design and
-- is retired, not dropped: the previous API image still selects it, so
-- dropping it here would break the T2 rollback. Nothing writes it; the
-- column is removed in Phase 5's cleanup as a contract step.

-- btree_gist lets one exclusion constraint compare a uuid with `=` and a
-- date range with `&&` — the "one AMC per site at a time" rule below.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------
-- service_contracts — one row per AMC against a customer (the site).
-- A nine-site corporate account holds nine of these.
--
-- The number is allocated at CREATE, not at a confirm step: there is no
-- draft. An AMC is recorded once it has been agreed, which is why
-- contract_number is NOT NULL where sales_cards.sale_number (017) is
-- nullable — the difference between a record that begins provisional
-- and one that does not (PLAN-DATA-MODEL.md §3.9).
--
-- CANCEL, never DELETE, and a cancel needs who and why — a wrong AMC is
-- cancelled and recorded again. The trio is all-or-nothing by
-- constraint, and cancelled rows drop out of the overlap rule, so the
-- corrected AMC can be entered the same day.
-- -----------------------------------------------------------------------
CREATE TABLE service_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- AMC-2627-00031 — allocated at create from next_in_sequence('contract:2627');
  -- the format lives in the service layer (packages/shared/src/sequence.ts).
  contract_number text NOT NULL,
  CONSTRAINT service_contracts_number_unique UNIQUE (contract_number),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  contract_value  numeric(12,2) NOT NULL,
  notes           text,
  created_by      uuid NOT NULL REFERENCES employees(id),
  cancelled_at    timestamptz,
  cancelled_by    uuid REFERENCES employees(id),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,

  CONSTRAINT service_contracts_term_ordered CHECK (end_date >= start_date),
  CONSTRAINT service_contracts_value_non_negative CHECK (contract_value >= 0),
  CONSTRAINT service_contracts_cancellation_coherent CHECK (
    (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
    OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) > 0)
  ),
  -- One site, one AMC at a time. Ranges are inclusive at both ends
  -- ('[]'), so an AMC ending 14 Sep and a renewal starting 15 Sep do not
  -- overlap; one starting 14 Sep does. Cancelled rows do not count.
  CONSTRAINT service_contracts_no_overlap EXCLUDE USING gist (
    customer_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (cancelled_at IS NULL)
);

CREATE TRIGGER service_contracts_touch BEFORE UPDATE ON service_contracts
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

-- The ending-soon list and the owner's attention feed scan by end date.
CREATE INDEX service_contracts_end_date_idx ON service_contracts (end_date)
  WHERE cancelled_at IS NULL;

-- (The exclusion constraint's gist index already serves lookups by
-- customer_id.)

-- -----------------------------------------------------------------------
-- The job link. A job dispatched under an AMC; nullable, because most
-- jobs are not AMC jobs. A linked job is an ORDINARY job — nothing about
-- assignment, completion or cancellation branches on it (decision
-- record, "Not changed").
-- -----------------------------------------------------------------------
ALTER TABLE job_cards ADD COLUMN contract_id uuid REFERENCES service_contracts(id);

CREATE INDEX job_cards_contract_idx ON job_cards (contract_id)
  WHERE contract_id IS NOT NULL;

-- v_contracts reads "the customer's latest completed job" and "the
-- customer's earliest open job" per AMC; 007 only indexes
-- (customer_id, created_at).
CREATE INDEX job_cards_customer_status_closed_idx
  ON job_cards (customer_id, status, closed_at DESC);

-- -----------------------------------------------------------------------
-- v_job_cards_dispatcher gains the link. CREATE OR REPLACE VIEW only
-- accepts new columns at the end, with every existing column keeping its
-- name, type and position — so contract_visit_id stays where 013 put it
-- (the old API image reads it) and contract_id is APPENDED. The one
-- semantic change: is_contract_visit now reads the live link,
-- contract_id IS NOT NULL, instead of the retired contract_visit_id.
-- -----------------------------------------------------------------------
CREATE OR REPLACE VIEW v_job_cards_dispatcher AS
SELECT
  j.id,
  j.job_number,
  j.customer_id,
  j.service_id,
  j.customer_product_id,
  j.contract_visit_id,
  j.title,
  j.description,
  j.priority,
  j.status,
  j.assigned_to,
  e.full_name  AS assigned_to_name,
  j.assigned_by,
  j.assigned_at,
  j.scheduled_for,
  j.scheduled_date,
  j.contact_name,
  j.contact_phone,
  j.created_by,
  j.closed_at,
  j.created_at,
  j.updated_at,
  j.version,
  c.reason_code AS cancellation_reason,
  (j.status = 'completed') AS is_completed,
  (j.contract_id IS NOT NULL) AS is_contract_visit,
  (
    j.status NOT IN ('completed', 'cancelled')
    AND j.scheduled_date < business_date(now())
  ) AS is_overdue,
  j.contract_id
FROM job_cards j
LEFT JOIN employees e ON e.id = j.assigned_to
LEFT JOIN job_cancellations c ON c.job_card_id = j.id;

-- -----------------------------------------------------------------------
-- v_contracts — one row per AMC with the derived facts the AMC tab
-- reads. Reminders are a VIEW, not a table (PLAN-DATA-MODEL.md §4):
--
--  - last_service_date is any completed job at the customer, not only
--    AMC-linked ones — the owner's rule (decision 4).
--  - GREATEST(start_date, last_service_date): GREATEST ignores NULL in
--    Postgres, so a customer with no completed job counts from the AMC
--    start; a customer whose last job predates the AMC also counts from
--    the start.
--  - + interval '4 months' then ::date: 31 Aug + 4 months is 31 Dec;
--    31 Oct + 4 months is 28 Feb (Postgres clamps to month end). Never
--    + 120 days.
--  - is_visit_due excludes a customer with an open job — someone
--    already booked is not a reminder.
--  - State is computed, never stored. No cron can forget to run.
-- -----------------------------------------------------------------------
CREATE VIEW v_contracts AS
SELECT
  sc.id,
  sc.contract_number,
  sc.customer_id,
  cu.name                                   AS customer_name,
  sc.start_date,
  sc.end_date,
  sc.contract_value,
  sc.notes,
  sc.created_by,
  cb.full_name                              AS created_by_name,
  sc.created_at,
  sc.cancelled_at,
  sc.cancelled_by,
  sc.cancel_reason,
  sc.version,
  CASE
    WHEN sc.cancelled_at IS NOT NULL      THEN 'cancelled'
    WHEN business_date(now()) < sc.start_date THEN 'upcoming'
    WHEN business_date(now()) > sc.end_date   THEN 'expired'
    ELSE 'active'
  END                                       AS state,
  last_job.last_service_date,
  (GREATEST(sc.start_date, last_job.last_service_date) + interval '4 months')::date
                                            AS next_visit_due,
  open_job.id                               AS open_job_id,
  open_job.job_number                       AS open_job_number,
  open_job.scheduled_for                    AS open_job_scheduled_for,
  (sc.end_date - business_date(now()))      AS days_to_end,
  (
    sc.cancelled_at IS NULL
    AND business_date(now()) BETWEEN sc.start_date AND sc.end_date
    AND (GREATEST(sc.start_date, last_job.last_service_date) + interval '4 months')::date
        <= business_date(now())
    AND open_job.id IS NULL
  )                                         AS is_visit_due,
  (
    sc.cancelled_at IS NULL
    AND business_date(now()) BETWEEN sc.start_date AND sc.end_date
    AND (sc.end_date - business_date(now())) BETWEEN 0 AND 7
  )                                         AS is_ending_soon
FROM service_contracts sc
JOIN customers cu ON cu.id = sc.customer_id
JOIN employees cb ON cb.id = sc.created_by
LEFT JOIN LATERAL (
  SELECT max(business_date(j.closed_at)) AS last_service_date
    FROM job_cards j
   WHERE j.customer_id = sc.customer_id
     AND j.status = 'completed'
) last_job ON true
LEFT JOIN LATERAL (
  SELECT j.id, j.job_number, j.scheduled_for
    FROM job_cards j
   WHERE j.customer_id = sc.customer_id
     AND j.status NOT IN ('completed', 'cancelled')
   ORDER BY j.scheduled_for NULLS LAST, j.job_number
   LIMIT 1
) open_job ON true;
