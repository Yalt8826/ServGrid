-- Reverse of 015_contracts. Never run in production (PLAN-EXECUTION.md
-- Part I) — this exists so migration:check can prove 015 is exactly
-- reversible: up → down → up leaves the schema identical. The down must
-- leave the schema exactly as 019 left it.
--
-- No CASCADE anywhere: if a later object ever depends on
-- v_job_cards_dispatcher, the down must fail loudly rather than silently
-- drop it. (Today nothing does — only 013 creates it — but the rule
-- protects the future.)

DROP VIEW IF EXISTS v_contracts;

-- v_job_cards_dispatcher cannot lose a column through CREATE OR REPLACE,
-- so drop it and recreate 013's definition verbatim.
DROP VIEW IF EXISTS v_job_cards_dispatcher;
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

DROP INDEX IF EXISTS job_cards_customer_status_closed_idx;
DROP INDEX IF EXISTS job_cards_contract_idx;
ALTER TABLE job_cards DROP COLUMN IF EXISTS contract_id;
DROP TABLE IF EXISTS service_contracts;
DROP EXTENSION IF EXISTS btree_gist;
