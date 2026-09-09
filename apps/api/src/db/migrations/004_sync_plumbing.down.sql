-- Reverse of 004_sync_plumbing. Down-migrations are never run in
-- production (PLAN-EXECUTION.md Part I); they are how a developer resets
-- locally, and CI rehearses up → down → up on a clean database.
--
-- The function goes first: Postgres 14+ tracks the table references
-- inside SQL-function bodies, so dropping sequences first would be
-- refused with "other objects depend on it".

DROP FUNCTION IF EXISTS next_in_sequence(text);
DROP TABLE IF EXISTS sequences;
DROP TABLE IF EXISTS idempotency_keys;
