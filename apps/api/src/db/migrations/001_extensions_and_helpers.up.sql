-- Migration 001 — extensions_and_helpers (PLAN-DATA-MODEL.md §1–§2).
-- Everything later leans on these four objects; nothing else runs first.

-- pgcrypto: digest()/hmac() for opaque refresh tokens and hash storage.
-- (PG13+ ships gen_random_uuid() in core; pgcrypto stays for digests.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- citext: case-insensitive unique names — usernames, company names
-- among active rows (PLAN-DATA-MODEL.md §3.2).
CREATE EXTENSION IF NOT EXISTS citext;

-- business_date(): the single definition of "which business day is it"
-- for everything the company counts per day — jobs, cash handovers,
-- contract visits, sync cursors. All of it keys off Asia/Kolkata.
--
-- Asia/Kolkata has had no transition since 1945 and none is proposed.
-- IMMUTABLE is technically a lie; it is what lets this appear in
-- generated columns and index expressions. The alternative is a
-- redundant column the application must remember to set. If the tz
-- database ever does change Asia/Kolkata, every generated column and
-- index expression built on this function must be rebuilt — recheck the
-- assumption after any timezonedata upgrade.
CREATE OR REPLACE FUNCTION business_date(ts timestamptz) RETURNS date
  LANGUAGE sql IMMUTABLE AS $$
    SELECT (ts AT TIME ZONE 'Asia/Kolkata')::date
  $$;

-- touch_updated_at(): optimistic-concurrency trigger, attached to every
-- mutable table. On an UPDATE that did not already set updated_at, it
-- stamps updated_at = now() and bumps version (when the table carries a
-- version column). When the caller set updated_at deliberately — a
-- backfill, a sync replay — their value stands and version is left
-- alone, so version counts real business changes, not sync bookkeeping.
--
-- Adopting tables carry `updated_at timestamptz NOT NULL` (indexed on
-- the sync-relevant tables — it is the delta-sync cursor) and
-- `version integer NOT NULL DEFAULT 1`. Attach with the same WHEN clause
-- as the integration suite uses, so the trigger stays out of the hot
-- path whenever the caller supplied the timestamp:
--
--   CREATE TRIGGER <name>_touch BEFORE UPDATE ON <table>
--   FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
--   EXECUTE FUNCTION touch_updated_at();
CREATE OR REPLACE FUNCTION touch_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  IF jsonb_exists(to_jsonb(NEW), 'version') THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;
