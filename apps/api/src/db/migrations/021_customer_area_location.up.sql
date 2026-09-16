-- Migration 021 — the customer's area, and a validated site pin (2026-09-17).
--
-- Two changes to `customers`, both from the owner's request that a site
-- read as three things: **where it is** (area), **its address** (the
-- structured lines it already has), and **exactly where to drive to**
-- (the coordinates a technician captures on site).
--
-- 1. `area` — the locality, as the owner names it: Rajajinagar,
--    Koramangala, HSR Layout. It did not exist as a column, and the
--    console was faking it: `OwnerCustomerRow.area` derived itself from
--    `address_line1 ?? city`, so the "area" column showed a street
--    ("80 Feet Road, HSR Layout") and could not be searched or sorted as
--    a place. A locality is a fact about a site that the office knows and
--    the address lines only imply, so it becomes its own column.
--
--    BACKFILL, and its deliberate narrowness. Every seeded address_line1
--    is "<street>, <locality>" — the locality is the tail after the last
--    comma — so the column can start populated rather than empty. The
--    rule is written to REFUSE more than it accepts: a comma must exist,
--    the tail must be 3..60 characters, carry no digits, and read as at
--    most four words. "Plot 7, Industrial Area, Phase 2" therefore yields
--    NULL rather than the wrong answer "Phase 2", and a one-line address
--    with no comma yields NULL rather than its whole street. It reads
--    `address_line1` and never writes it, so a guess that is wrong is
--    visible in one column and correctable in the UI — the address the
--    office typed is untouched either way.
--
-- 2. Range checks on the site pin. `latitude`/`longitude` have existed
--    since 005 with a paired check (both or neither) but no bounds, which
--    was survivable while nothing could write them. Migration 021 is the
--    same release that gives them a write path — the technician's capture
--    (see `jobs`), and the owner's form — so the bounds land with it, the
--    way `location_pings` has always validated its own. A coordinate
--    outside the planet is a bug in the capture, and a CHECK is the only
--    place that can refuse it for every writer at once.
--
-- Safe to validate: no customer carries a coordinate today (checked
-- before writing this), so the constraint cannot fail on existing rows.

ALTER TABLE customers ADD COLUMN area text;

ALTER TABLE customers
  ADD CONSTRAINT customers_latitude_range CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT customers_longitude_range CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

UPDATE customers
SET area = btrim(regexp_replace(address_line1, '^.*,', ''))
WHERE address_line1 IS NOT NULL
  AND position(',' IN address_line1) > 0
  AND btrim(regexp_replace(address_line1, '^.*,', '')) <> ''
  AND length(btrim(regexp_replace(address_line1, '^.*,', ''))) BETWEEN 3 AND 60
  AND btrim(regexp_replace(address_line1, '^.*,', '')) !~ '[0-9]'
  AND array_length(regexp_split_to_array(btrim(regexp_replace(address_line1, '^.*,', '')), '\s+'), 1) <= 4;
