-- Migration 010 — cash (PLAN-DATA-MODEL.md §3.7).
-- cash_reconciliations — the DECLARATION side of the daily handover,
-- and nothing else: what the employee says he is handing over. What he
-- should have handed over is derived — v_employee_expected_cash
-- (migration 012) sums job_completions and payments; a stored
-- expectation is a second copy of a number that can drift, and the
-- whole plan keeps derived money in views for exactly that reason.
--
-- KEYED ON employee_id, NOT technician_id (§3.7). Technicians collect
-- cash at completion, but a sales rep occasionally collects it from a
-- company — and because rep cash is rare, giving the handover to
-- technicians alone would create an unreconciled path nobody exercises
-- and nobody notices is broken.
--
-- NO EXPENSE COLUMNS, and that is a decision, not an oversight (§3.7).
-- An earlier draft carried expenses_amount/expenses_note for a part or
-- fuel bought out of collected cash — which would make a handover short
-- BY DESIGN and raise a variance that is not one. The owner has
-- confirmed this does not happen: technicians do not spend from
-- collections, so every variance in the queue (migration 012's
-- v_cash_reconciliation_queue) is a real one, which is what makes the
-- flag worth reading. The columns were removed rather than left
-- dormant — an unused nullable column is a thing every future reader
-- must reason about on every touch. The symptom to watch for, recorded
-- here in case that decision is ever wrong: a SMALL, RECURRING
-- SHORTFALL FOR ONE PARTICULAR EMPLOYEE — never large, never for
-- everyone. If that shape appears, the answer is those two columns,
-- not an investigation.

CREATE TABLE cash_reconciliations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL REFERENCES employees(id),
  business_date    date NOT NULL, -- the IST day the money was collected on
  -- One declaration per person per day; the retry-after-offline path
  -- (the declare endpoint is idempotent, PLAN-BACKEND.md §10) leans on
  -- this rather than trusting its own check-then-insert.
  CONSTRAINT cash_reconciliations_employee_date_unique
    UNIQUE (employee_id, business_date),

  declared_amount  numeric(12,2) NOT NULL,
  declared_at      timestamptz NOT NULL,
  employee_note    text,

  status           reconciliation_status NOT NULL DEFAULT 'submitted',

  confirmed_amount numeric(12,2),
  confirmed_by     uuid REFERENCES employees(id),
  confirmed_at     timestamptz,
  owner_note       text,

  -- 'confirmed' blocks completion amendment until reopened (§2.1); a
  -- reopen returns the row to 'submitted' and the CHECK below forces
  -- the confirmation timestamp out with it.
  reopened_at      timestamptz,
  reopened_by      uuid REFERENCES employees(id),
  reopen_reason    text,

  -- Submitted means not yet answered: a submitted row can never carry a
  -- confirmation timestamp, and a confirmed/disputed row always does.
  CONSTRAINT cash_submitted_means_unanswered
    CHECK ((status = 'submitted') = (confirmed_at IS NULL)),
  -- A dispute without the owner's note is not a dispute he can act on
  -- tomorrow, or explain at the month end.
  CONSTRAINT cash_disputed_justified
    CHECK (status <> 'disputed' OR owner_note IS NOT NULL),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1
);

-- §5 index plan lists no secondary index: the (employee, business_date)
-- unique constraint above serves the point lookups, and the owner's
-- queue view (migration 012) is a day-scanned aggregate by design.

CREATE TRIGGER cash_reconciliations_touch BEFORE UPDATE ON cash_reconciliations
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();
