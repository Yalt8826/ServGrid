-- Reverse of 008_attachments. Down-migrations are never run in
-- production (PLAN-EXECUTION.md Part I); they are how a developer
-- resets locally, and CI rehearses up → down → up on a clean database.
DROP TABLE IF EXISTS attachments;
