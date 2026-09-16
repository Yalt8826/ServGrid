DROP INDEX IF EXISTS job_completions_service_idx;
ALTER TABLE job_completions DROP COLUMN IF EXISTS service_id;
