-- Seed 004 — DEMO DATA, dev only. Ten customers whose last completed job was
-- six months ago, so the Calls tab has a full "Due now" list to show.
-- (Yashas, 2026-09-19: "add 10 jobs to different customers that was
-- completed 6 months ago so it can show in the calls tab").
--
-- NOT part of first boot, and not for staging or production: this is
-- demo dressing, not the product's own data. Run it by hand when a demo
-- needs the queue populated:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed/004_demo_service_calls.sql
--
-- What it does:
--   * ten customers in Bengaluru localities (all new names);
--   * one COMPLETED job each, closed six months ago plus 2..11 days so the
--     ages differ, half to tech1 and half to ravi;
--   * the matching `job_completions` row, so an old job opens as a
--     finished visit rather than a card with no work behind it.
--
-- The view does the rest: `v_service_calls` derives due_on = last service
-- + 6 months and is_due = that day arrived with no open job at the site,
-- so these ten appear the moment they are inserted.
--
-- Job numbers are seeded in the 901..910 block and the allocator is moved
-- past them (the last statement), so the next real dispatch takes 911 and
-- can never collide with a seeded row.

BEGIN;

CREATE TEMP TABLE seed_calls (n int, name text, phone text, area text, days_ago int, tech text);
INSERT INTO seed_calls VALUES
  ( 1, 'Sri Sai Borewells',     '9845011001', 'Jayanagar',      2,  'tech1'),
  ( 2, 'Amruth Pharmacy',       '9845011002', 'Electronic City', 3,  'ravi'),
  ( 3, 'Green Leaf Hostel',     '9845011003', 'Bellandur',      4,  'tech1'),
  ( 4, 'Bharat Cold Storage',   '9845011004', 'Yeshwanthpur',   5,  'ravi'),
  ( 5, 'City Public School',    '9845011005', 'Indiranagar',    6,  'tech1'),
  ( 6, 'Anand Bhojanalaya',     '9845011006', 'HSR Layout',     7,  'ravi'),
  ( 7, 'Deepa Electronics',     '9845011007', 'Bellandur',      8,  'tech1'),
  ( 8, 'Nandi Motors',          '9845011008', 'Rajajinagar',    9,  'ravi'),
  ( 9, 'Whitefield Grand Stay', '9845011009', 'Whitefield',     10, 'tech1'),
  (10, 'Vega Diagnostics',      '9845011010', 'Koramangala',    11, 'ravi');

INSERT INTO customers (name, phone, area, city, state, pincode, is_active)
SELECT name, phone, area, 'Bengaluru', 'Karnataka', '5600' || lpad(n::text, 2, '0'), true
FROM seed_calls;

-- closed_at and scheduled_for are the same instant: the visit happened that day.
INSERT INTO job_cards
  (job_number, customer_id, service_id, title, description, priority, status,
   assigned_to, assigned_by, assigned_at, scheduled_for, contact_name, contact_phone, created_by, closed_at)
SELECT
  'JC-2627-0' || (900 + s.n)::text,
  c.id,
  (SELECT id FROM services WHERE code = 'BATT-SWAP'),
  'Battery replacement',
  'Six-month cycle: batteries tested and replaced at the site.',
  'normal'::job_priority,
  'completed'::job_status,
  e.id, e.id, t.closed, t.closed, c.name, c.phone, e.id, t.closed
FROM seed_calls s
JOIN customers c ON c.name = s.name
JOIN employees e ON e.username = s.tech
CROSS JOIN LATERAL (
  SELECT now() - interval '6 months' - (s.days_ago || ' days')::interval AS closed
) t;

INSERT INTO job_completions
  (job_card_id, completed_by, completed_at, work_summary, cost, discount_amount, collection_mode, customer_signed)
SELECT j.id, j.assigned_to, j.closed_at, 'Battery replacement — six-month service',
       '250.00', '0', 'cash', true
FROM job_cards j
JOIN seed_calls s ON j.job_number = 'JC-2627-0' || (900 + s.n)::text;

UPDATE sequences SET current_value = 910, updated_at = now() WHERE scope = 'job:2627';

COMMIT;

SELECT count(*) FILTER (WHERE is_due) AS due_now, count(*) AS rows_total FROM v_service_calls;
