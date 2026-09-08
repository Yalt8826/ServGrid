-- Reverse of 001_extensions_and_helpers. Down-migrations are never run
-- in production (PLAN-EXECUTION.md Part I); they are how a developer
-- resets locally, and this one is rehearsed up → down → up in CI on a
-- clean database.

-- Functions first: anything still referencing them fails loudly here
-- rather than silently losing the helper.
DROP FUNCTION IF EXISTS touch_updated_at();
DROP FUNCTION IF EXISTS business_date(ts timestamptz);

-- Extensions last, only on a database where nothing depends on them —
-- which is exactly what the clean-database rehearsal guarantees.
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS pgcrypto;
