-- Reverse of 013_views_ops. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
DROP VIEW IF EXISTS v_technician_load;
DROP VIEW IF EXISTS v_job_cards_dispatcher;
