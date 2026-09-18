ALTER TABLE job_completions ADD COLUMN service_id uuid REFERENCES services(id);
UPDATE job_completions jc
   SET service_id = line.service_id
  FROM (SELECT DISTINCT ON (job_card_id) job_card_id, service_id
          FROM job_completion_services ORDER BY job_card_id, line_no) line
 WHERE line.job_card_id = jc.job_card_id;
ALTER TABLE job_completions ALTER COLUMN service_id DROP NOT NULL;
DROP TABLE job_completion_services;
