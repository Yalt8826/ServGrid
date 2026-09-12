-- Migration 013 — ops views (PLAN-DATA-MODEL.md §4, PHASE-2-DISPATCHER.md
-- T2.1). Two views, one purpose: the dispatcher's reads and the
-- assignment picker answer from objects the schema owns, so the list,
-- the dashboard count and any future report CANNOT disagree about what
-- "overdue" means or who is busy.
--
-- v_job_cards_dispatcher is an explicit MONEY-FREE projection of
-- job_cards — every column named, no SELECT *. `billing` and
-- `contract_visit_id`-adjacent scheduling facts are welcome here; money
-- is absent by construction (the dispatcher guarantee, PLAN.md §5). The
-- schema makes revenue absent; the view makes the query surface one
-- reviewable object. Dispatcher endpoints select FROM this view, never
-- from job_cards — T2.2's lint rules and money-leak suite hold that line.
--
-- is_overdue lives here and nowhere else: status not terminal AND
-- scheduled_date < business_date(now()). Nothing advances a date
-- automatically — an open job stays on the day it was promised for,
-- because moving it silently hides the missed commitment the dispatcher
-- exists to see.
--
-- v_technician_load answers "Ravi · 3 today" (PLAN.md §8) per ACTIVE
-- technician. active_since is the promised start of the job he is
-- currently ON (in_progress); job_cards has no started-at column — the
-- promised start is the honest proxy until a real one earns its place.

CREATE VIEW v_job_cards_dispatcher AS
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
  (j.contract_visit_id IS NOT NULL) AS is_contract_visit,
  (
    j.status NOT IN ('completed', 'cancelled')
    AND j.scheduled_date < business_date(now())
  ) AS is_overdue
FROM job_cards j
LEFT JOIN employees e ON e.id = j.assigned_to
LEFT JOIN job_cancellations c ON c.job_card_id = j.id;

CREATE VIEW v_technician_load AS
SELECT
  e.id          AS employee_id,
  e.full_name   AS technician_name,
  count(*) FILTER (
    WHERE j.status NOT IN ('completed', 'cancelled')
      AND j.scheduled_date = business_date(now())
  )             AS open_today,
  count(*) FILTER (
    WHERE j.status = 'completed'
      AND business_date(j.closed_at) = business_date(now())
  )             AS done_today,
  count(*) FILTER (
    WHERE j.status NOT IN ('completed', 'cancelled')
  )             AS open_total,
  min(j.scheduled_for) FILTER (
    WHERE j.status = 'in_progress'
  )             AS active_since
FROM employees e
LEFT JOIN job_cards j ON j.assigned_to = e.id
WHERE e.role = 'technician'
  AND e.is_active
GROUP BY e.id, e.full_name;
