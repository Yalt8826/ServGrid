-- Reverse of 003_identity. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
--
-- Children before parents: consents and refresh_tokens reference
-- employees and devices, refresh_tokens also references itself, and
-- devices references employees.

DROP TABLE IF EXISTS consents;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS employees;
