-- Reverse of 009_location. The view before its tables, children before
-- parents: location_requests holds the fulfilled_ping_id FK.
-- Down-migrations are never run in production (PLAN-EXECUTION.md
-- Part I); they are how a developer resets locally, and CI rehearses
-- up → down → up on a clean database.
DROP VIEW IF EXISTS v_employee_tracking_health;
DROP TABLE IF EXISTS location_requests;
DROP TABLE IF EXISTS location_pings;
