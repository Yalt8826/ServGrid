-- Seed 002 — the service catalogue (PLAN-DATA-MODEL.md §8).
-- Every environment: job_cards.service_id points at these codes, so a
-- database without them cannot raise a job. The migration (005) owns
-- the table's shape; the seed owns the rows — the same split as
-- products below.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed/002_services.sql
--
-- Idempotent: ON CONFLICT (code) DO NOTHING, so re-running after a
-- restore rehearsal or a missed environment changes nothing.

INSERT INTO services (code, name, description, default_charge) VALUES
  ('INSTALL',     'Installation',
   'New UPS / inverter / battery installation at the customer site, including wiring check and handover demo.',
   750.00),
  ('AMC',         'AMC visit',
   'Annual maintenance contract visit — inspection, cleaning, terminal tightening and load test.',
   350.00),
  ('BATT-SWAP',   'Battery replacement',
   'Swap failed batteries for replacements; old batteries logged and returned to the store.',
   250.00),
  ('SITE-SURVEY', 'Site survey',
   'Pre-sale load assessment and quotation survey at the customer site.',
   500.00),
  ('REPAIR',      'Repair',
   'Workshop or on-site repair of a UPS / inverter unit.',
   450.00)
ON CONFLICT (code) DO NOTHING;

-- The five codes read back, or the operator looks.
SELECT code, name, default_charge, is_active
FROM services
ORDER BY code;
