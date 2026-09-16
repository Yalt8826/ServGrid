-- Reverse of 020_customer_search_prefix. Never run in production
-- (PLAN-EXECUTION.md Part I); CI rehearses up → down → up.
DROP INDEX IF EXISTS customers_phone_prefix_idx;
