-- Reverse of 021_customer_area_location. Down-migrations are never run in
-- production (PLAN-EXECUTION.md Part I); they are how a developer resets
-- locally, and CI rehearses up → down → up on a clean database.
--
-- The dropped `area` takes its backfilled values with it: the derivation
-- was a guess from `address_line1`, which survives untouched, so a
-- re-run of the up-migration reconstructs exactly the same values.
ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_longitude_range,
  DROP CONSTRAINT IF EXISTS customers_latitude_range;

ALTER TABLE customers DROP COLUMN IF EXISTS area;
