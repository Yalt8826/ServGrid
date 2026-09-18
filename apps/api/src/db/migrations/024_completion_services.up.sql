-- Several services on one completion (2026-09-18, Yashas: the technician
-- "can choose multiple service from the completion form and not just one
-- and the price is summed up"). Migration 022 gave job_completions ONE
-- service_id; a visit that is a repair plus a battery swap had no honest
-- row. The lines carry the service's default_charge AT COMPLETION — the
-- catalogue's price moves, the record of what the visit was quoted must
-- not.
CREATE TABLE job_completion_services (
  job_card_id uuid NOT NULL REFERENCES job_completions(job_card_id) ON DELETE CASCADE,
  line_no int NOT NULL,
  service_id uuid NOT NULL REFERENCES services(id),
  charge numeric(12,2),
  CONSTRAINT job_completion_services_pk PRIMARY KEY (job_card_id, line_no),
  CONSTRAINT job_completion_services_service_unique UNIQUE (job_card_id, service_id),
  CONSTRAINT job_completion_services_line_no_positive CHECK (line_no > 0)
);

-- The single-service rows come forward as line 1.
INSERT INTO job_completion_services (job_card_id, line_no, service_id, charge)
SELECT jc.job_card_id, 1, jc.service_id, s.default_charge
  FROM job_completions jc
  JOIN services s ON s.id = jc.service_id
 WHERE jc.service_id IS NOT NULL;

ALTER TABLE job_completions DROP COLUMN service_id;
