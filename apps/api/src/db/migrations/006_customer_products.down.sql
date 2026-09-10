-- Reverse of 006_customer_products. Down-migrations are never run in
-- production (PLAN-EXECUTION.md Part I); they are how a developer resets
-- locally, and CI rehearses up → down → up on a clean database.
--
-- The source_job_id FOREIGN KEY added by migration 007 drops with the
-- table; nothing else references customer_products until migration 007.

DROP TABLE IF EXISTS customer_products;
