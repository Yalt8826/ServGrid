/**
 * Fixture — must fire: location.split defence. A dispatcher repo module
 * must never read the raw location tables; a dispatcher may know a
 * device went quiet, never where anyone is. Health reads the
 * `v_employee_tracking_health` view instead.
 */

// ── rule3-location-tables/repo.dispatcher.ts — must fire ─────────────
// The location.split defence (PLAN-BACKEND.md §5).

/** Deliberate violation: dispatcher repo reading raw positions. */
export const latestPings = `
  SELECT lp.employee_id, lp.lat, lp.lng
  FROM location_pings lp
  ORDER BY lp.recorded_at DESC
`;
