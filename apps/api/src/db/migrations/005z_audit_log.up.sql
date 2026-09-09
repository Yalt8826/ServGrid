-- Migration 005z — audit_log (PLAN-BACKEND.md §4 break-glass, PLAN-GAPS.md G16).
--
-- Why 005z and not 006: PLAN-DATA-MODEL.md §1 pins 006–010 to the Phase 1
-- migrations by number ("006 customer_products", "v_employee_tracking_health
-- ships with 009", …), and future tasks read those numbers off the docs.
-- This table is a Phase 0 append that owns no dependencies beyond
-- employees (003), so it slots after 005 under a lettered number and
-- leaves every documented number where its readers expect it. The `z`
-- matters: node-pg-migrate orders files with a punctuation-ignoring locale
-- compare, under which `005a` sorts BEFORE `005_reference_data` and refuses
-- to run against any database that already applied 005; `005z` sorts after
-- it and before any 006.
--
-- The break-glass password-reset CLI (apps/api/scripts/
-- admin-reset-password.ts) is the only writer today. PLAN-BACKEND.md §2
-- anticipates a plugins/audit.ts writing "job_events / generic audit
-- rows"; job_events arrives with migration 007 as the *job* trail, and
-- this table is the generic one. Later writers extend `action`, never
-- the shape: append-only evidence follows the consents rule (003) —
-- nothing updates a row, so there is no version counter, no
-- touch_updated_at trigger and no soft delete. Rows are written by
-- security-relevant paths and read by the owner by hand.
--
-- Bigint identity PK per the data-model convention: "primary keys are
-- uuid except append-only logs, which use bigint identity".
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  action      text NOT NULL, -- dotted verb, e.g. 'password.reset.break_glass'
  employee_id uuid REFERENCES employees(id), -- NULL when the subject is not an employee
  actor       text NOT NULL, -- who did it: 'break-glass' today; a request actor id later
  details     jsonb          -- action-specific; for the reset: tokens_revoked count
);

-- The owner reads "what happened to this account, when" by hand — the
-- (employee_id, at DESC) walk is that query, and there is no other.
CREATE INDEX audit_log_employee_at_idx ON audit_log (employee_id, at DESC);
