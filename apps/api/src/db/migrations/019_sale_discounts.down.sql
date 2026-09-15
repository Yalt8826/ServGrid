-- Reverse of 019_sale_discounts. Down-migrations are never run in production
-- (PLAN-EXECUTION.md Part I); they are how a developer resets locally,
-- and CI rehearses up → down → up on a clean database.
ALTER TABLE sales_card_items
  DROP CONSTRAINT IF EXISTS sales_card_items_discount_explains_price,
  DROP CONSTRAINT IF EXISTS sales_card_items_discount_pct_range,
  DROP CONSTRAINT IF EXISTS sales_card_items_list_price_non_negative,
  DROP CONSTRAINT IF EXISTS sales_card_items_discount_paired,
  DROP COLUMN IF EXISTS discount_pct,
  DROP COLUMN IF EXISTS list_price;
