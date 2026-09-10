-- Reverse of 007_jobs. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
--
-- Children before parents, and the customer_products FK from the up
-- before job_cards itself: job_events → job_cancellations (self-FK on
-- replacement_job_id drops with it) → job_completion_parts →
-- job_completions → job_cards.

ALTER TABLE customer_products DROP CONSTRAINT IF EXISTS customer_products_source_job_fk;
DROP TABLE IF EXISTS job_events;
DROP TABLE IF EXISTS job_cancellations;
DROP TABLE IF EXISTS job_completion_parts;
DROP TABLE IF EXISTS job_completions;
DROP TABLE IF EXISTS job_cards;
