-- The service performed, recorded as data rather than as a sentence
-- (2026-09-16).
--
-- The technician's complete sheet used to take the work as free text: the
-- office could read what he wrote and nothing else. It could not count the
-- water top-ups, group the repairs, or reconcile a price against the
-- catalogue — the only copy of "what was done" was prose in one column.
-- `services` has carried the catalogue and its `default_charge` since 005,
-- and a completion can now name the row it used. That is also what lets
-- the sheet fill the amount from the catalogue instead of asking a
-- technician in a stairwell to type a figure.
--
-- Nullable on purpose: every completion filed before this migration has no
-- service and never will, and a NOT NULL default would be a lie about
-- history. A retired service (`is_active = false`) stays referenced — the
-- completion records what was done, not what is currently sellable, and
-- the FK must not be the thing that prevents retiring a service.
ALTER TABLE job_completions
  ADD COLUMN service_id uuid REFERENCES services(id);

-- Reporting reads "what did we do this month" by service. The partial
-- index keeps that off a sequential scan of every completion ever filed,
-- and stays small because only the priced work since this migration is in
-- it.
CREATE INDEX job_completions_service_idx ON job_completions (service_id)
  WHERE service_id IS NOT NULL;
