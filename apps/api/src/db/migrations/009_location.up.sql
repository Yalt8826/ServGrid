-- Migration 009 — location (PLAN-DATA-MODEL.md §3.8).
-- location_pings, location_requests, and v_employee_tracking_health.
--
-- The health view ships HERE, in Phase 1, not with the Phase 2 ops
-- views: the tracking chip is a Phase 1 deliverable and a Phase 1 exit
-- criterion, and it depends only on employees, devices (003) and
-- location_pings (below) — all of which exist the moment this
-- migration runs. A view that arrives in Phase 2 turns the chip's
-- first field day into "relation does not exist".

-- -----------------------------------------------------------------------
-- location_pings — the append-only trail. Bigint identity per the
-- data-model convention (uuid for business rows, bigint identity for
-- append-only logs). Never updated, never deleted; retention (prune
-- beyond the configured window — 180 days per §3.8, PING_RETENTION_DAYS
-- in the environment) is the nightly job's business, not a constraint.
--
-- UNIQUE (employee_id, recorded_at) is the important line in this
-- migration. The mobile batch drain retries after partial failure, and
-- without it a technician surfacing from a basement double-writes his
-- trail: the retry replays pings the first attempt already landed. The
-- duplicate row is refused, the rest of the batch commits.
--
-- SIZING — do not partition, do not add PostGIS (§3.8). 10 tracked
-- staff × ~40 pings/day × 6 days ≈ 2,400 rows/week, ~125k/year. A
-- btree on (employee_id, recorded_at DESC) covers every query this app
-- makes: the owner's map draws one person's day, at most a few hundred
-- points. battery_pct rides on every ping because it is the Phase 5
-- OEM investigation's evidence base — a trail that stops at 34% on a
-- Xiaomi tells a different story than one that stops at 90%.
-- -----------------------------------------------------------------------
CREATE TABLE location_pings (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id   uuid NOT NULL REFERENCES employees(id),
  device_id     uuid NOT NULL REFERENCES devices(id),
  -- The offline seam, the same shape as job_events: recorded_at is the
  -- device clock when the fix was taken, received_at the server clock
  -- when it landed. A basement at 11:30 that surfaces at 13:00 shows
  -- exactly that gap.
  recorded_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- Which business day the ping belongs to, in IST — generated, so it
  -- cannot drift from recorded_at.
  business_date date GENERATED ALWAYS AS (business_date(recorded_at)) STORED,

  -- WGS84 degrees; the range CHECKs are the database's line against a
  -- handset bug writing 910.0 into the trail.
  latitude      double precision NOT NULL
    CONSTRAINT location_pings_latitude_range CHECK (latitude BETWEEN -90 AND 90),
  longitude     double precision NOT NULL
    CONSTRAINT location_pings_longitude_range CHECK (longitude BETWEEN -180 AND 180),

  -- Telemetry the handset may fail to read on a given ping; NULL is an
  -- honest "not reported this time", never a rejected batch.
  accuracy_m    double precision,
  altitude_m    double precision,
  speed_mps     double precision,
  heading_deg   double precision,
  battery_pct   smallint,
  is_moving     boolean,
  source        ping_source NOT NULL, -- 'manual' is the descope path's check-in

  -- The double-write guard — see the header note.
  CONSTRAINT location_pings_employee_recorded_unique UNIQUE (employee_id, recorded_at)
);

-- §5 index plan, both of them, none extra.
-- Trail + last-ping: the health view's LATERAL below reads exactly the
-- newest row per employee off this index.
CREATE INDEX location_pings_employee_recorded_idx
  ON location_pings (employee_id, recorded_at DESC);
-- Day view across staff (the owner's map).
CREATE INDEX location_pings_business_date_employee_idx
  ON location_pings (business_date, employee_id);

-- -----------------------------------------------------------------------
-- location_requests — "Locate now", persisted rather than fired and
-- forgotten. The persistence is what lets the owner's console say
-- "requested 40s ago, device has not answered" instead of spinning, and
-- a request that expires unfulfilled is itself a tracking-health
-- signal. failure_reason records the FCM-level outcome.
--
-- Mutable (requested → pushed → fulfilled|failed is a lifecycle), so
-- the usual version/created_at/updated_at plumbing applies. §5 lists no
-- secondary index — the console reads a person's recent requests, a
-- handful of rows a day.
-- -----------------------------------------------------------------------
CREATE TABLE location_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by       uuid NOT NULL REFERENCES employees(id),
  target_employee_id uuid NOT NULL REFERENCES employees(id),
  mode               location_request_mode NOT NULL, -- fix | live
  requested_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  pushed_at          timestamptz,
  fulfilled_at       timestamptz,
  fulfilled_ping_id  bigint REFERENCES location_pings(id),
  failure_reason     text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1
);

CREATE TRIGGER location_requests_touch BEFORE UPDATE ON location_requests
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------
-- v_employee_tracking_health — the tracking chip's single source of
-- truth (§4). One row per ACTIVE employee, resolving to ONE health
-- value; the precedence below is load-bearing and proven fixture by
-- fixture in schema-location.test.ts:
--
--   permission state wins over ping recency, ALWAYS. A device whose
--   background permission was revoked after its last ping is not
--   healthy, however fresh that ping is — it is the one case where
--   "recent ping" and the truth disagree, and the truth is on the
--   device row, which POST /v1/devices keeps current (PLAN-BACKEND.md
--   §8: "this endpoint is how the health chip becomes truthful").
--
--   not_tracked      role is owner or dispatcher — they are not followed
--   permission_missing  newest device's permission is not 'background'
--                       (or there is no device yet — none is background)
--   never_reported   background granted, but no ping has ever landed
--   stale            last ping older than 45 minutes — three missed
--                    15-minute cadences, chosen from reasoning, not
--                    measurement; revisit after Phase 5 field data
--                    (PLAN-DATA-MODEL.md §9 item 2)
--   active           otherwise
--
-- notifications_enabled is carried through but deliberately NOT folded
-- into health: a technician with notifications off is still tracking
-- correctly, so collapsing it would either hide it or misreport a
-- healthy device as unhealthy. The client renders it as a separate chip
-- state (PLAN-FRONTEND.md §6) reading this same row.
--
-- The view carries the ping's AGE and no coordinates anywhere (§7):
-- a dispatcher may know that a device has gone quiet, never where
-- anyone is — location.health, not location.read.
-- -----------------------------------------------------------------------
CREATE VIEW v_employee_tracking_health AS
SELECT
  e.id                  AS employee_id,
  e.full_name           AS employee_name,
  e.role                AS role,
  d.device_id           AS device_id,
  d.location_permission AS location_permission,
  d.notifications_enabled AS notifications_enabled,
  lp.last_ping_at       AS last_ping_at,
  lp.minutes_since      AS minutes_since,
  CASE
    WHEN e.role IN ('owner', 'dispatcher') THEN 'not_tracked'
    WHEN COALESCE(d.location_permission, 'none') <> 'background'
      THEN 'permission_missing'
    WHEN lp.last_ping_at IS NULL THEN 'never_reported'
    WHEN lp.minutes_since > 45 THEN 'stale'
    ELSE 'active'
  END                   AS health
FROM employees e
-- Newest device wins: (employee_id, install_id) is unique, so a
-- reinstall adds a row and the diagnostics that matter are the latest
-- install's.
LEFT JOIN LATERAL (
  SELECT dv.id AS device_id, dv.location_permission, dv.notifications_enabled
  FROM devices dv
  WHERE dv.employee_id = e.id
  ORDER BY dv.created_at DESC
  LIMIT 1
) d ON true
-- Last ping via LATERAL — one indexed probe per employee off
-- location_pings_employee_recorded_idx, not a GROUP BY over the table.
LEFT JOIN LATERAL (
  SELECT p.recorded_at AS last_ping_at,
         (EXTRACT(EPOCH FROM (now() - p.recorded_at)) / 60.0) AS minutes_since
  FROM location_pings p
  WHERE p.employee_id = e.id
  ORDER BY p.recorded_at DESC
  LIMIT 1
) lp ON true
-- Soft delete, never DELETE: a deactivated employee leaves the roster
-- and the view together.
WHERE e.is_active;
