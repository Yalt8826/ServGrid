-- The tracking-health view picked the newest-CREATED device row, and any
-- login creates one — a test script or an API integration that signs in
-- as a technician adds a device with location_permission 'none', and the
-- roster then reads permission_missing for a technician whose pings are
-- demonstrably arriving. If ANY device of his has background permission,
-- he has granted it; a headless login may not darken that (2026-09-18,
-- found while verifying tracking on the A059).
CREATE OR REPLACE VIEW v_employee_tracking_health AS
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
-- A device with background permission outranks a newer headless login;
-- among equals the newest install wins, as before.
LEFT JOIN LATERAL (
  SELECT dv.id AS device_id, dv.location_permission, dv.notifications_enabled
  FROM devices dv
  WHERE dv.employee_id = e.id
  ORDER BY (dv.location_permission = 'background') DESC, dv.created_at DESC
  LIMIT 1
) d ON true
LEFT JOIN LATERAL (
  SELECT p.recorded_at AS last_ping_at,
         (EXTRACT(EPOCH FROM (now() - p.recorded_at)) / 60.0) AS minutes_since
  FROM location_pings p
  WHERE p.employee_id = e.id
  ORDER BY p.recorded_at DESC
  LIMIT 1
) lp ON true
WHERE e.is_active;
