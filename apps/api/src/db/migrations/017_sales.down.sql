-- Reverse of 017_sales. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sales_card_items;
DROP TABLE IF EXISTS sales_cards;
