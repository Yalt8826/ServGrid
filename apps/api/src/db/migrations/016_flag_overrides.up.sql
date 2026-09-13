-- Migration 016 — employee feature-flag overrides (PLAN-EXECUTION.md §3).
-- Flags are "server-driven, returned in GET /v1/auth/me, evaluated per
-- employee and per role", and they are the T0 rollback tier: during the
-- field parallel run "the flags are the instrument", so "turn tech.jobs
-- off for that person" must be a row, not a recompile.
--
-- OVERRIDES ONLY, no role rows. Role defaults stay in code
-- (packages/shared flags.ts, all false) because the rollout the plan
-- describes is per person first — dark launch "for one named person for
-- a week before the role" — and with a roster of fourteen, a role-wide
-- rollout is fourteen rows written through one endpoint. A role-defaults
-- table would need an evaluation order (override beats role beats code)
-- that nothing can test until Phase 4 has a second admin surface.
--
-- NO CHECK CONSTRAINT on `flag`. The valid set is the shared registry
-- (FEATURE_FLAGS) and the service validates against it; a CHECK would
-- duplicate that list in SQL, and the next flag added to shared would
-- silently fail to persist until someone remembered the migration.
-- Unknown names that reach the table anyway are ignored by evaluation,
-- never trusted.
--
-- Numbered 016, out of phase order, on purpose (PLAN-DATA-MODEL.md §1:
-- "numbers record the order migrations were written, phases record when
-- they run"). It shipped in Phase 1, before 011 and 013 were written,
-- which is why migrate.ts sets checkOrder: false. Phase 3's sales
-- migrations were renumbered 017–018 around it and T2.5's 011.

CREATE TABLE employee_flag_overrides (
  employee_id uuid        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  flag        text        NOT NULL,
  enabled     boolean     NOT NULL,
  updated_by  uuid        REFERENCES employees(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, flag)
);
