-- Reverse of 018_views_money. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
DROP VIEW IF EXISTS v_cash_reconciliation_queue;
DROP VIEW IF EXISTS v_employee_expected_cash;
DROP VIEW IF EXISTS v_company_balances;
DROP VIEW IF EXISTS v_sales_card_totals;
