-- Reverse of 005_reference_data. Down-migrations are never run in
-- production (PLAN-EXECUTION.md Part I); they are how a developer resets
-- locally, and CI rehearses up → down → up on a clean database.
--
-- Children before parents: customers references companies. The indexes
-- and triggers go with their tables.

DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS services;
