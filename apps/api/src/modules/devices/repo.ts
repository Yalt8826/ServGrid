import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Device SQL (PLAN-BACKEND.md §2, §8; PLAN-DATA-MODEL.md §3.1). One row
 * per install, UNIQUE (employee_id, install_id).
 */

/** Anything with `.query` — a `Pool` or the `PoolClient` of a transaction. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface DeviceRegistration {
  employeeId: string;
  installId: string;
  appVersion: string;
  osVersion: string;
  manufacturer: string;
  model: string;
  fcmToken?: string;
  locationPermission?: string;
  batteryOptExempt?: boolean;
  autostartConfirmed?: boolean;
  notificationsEnabled?: boolean;
}

export interface DeviceRow {
  id: string;
  install_id: string;
  manufacturer: string | null;
  model: string | null;
  os_version: string | null;
  app_version: string | null;
  location_permission: string;
  battery_opt_exempt: boolean;
  autostart_confirmed: boolean;
  notifications_enabled: boolean;
  last_seen_at: Date | null;
  is_active: boolean;
}

/**
 * The §8 upsert: called on login, on foreground when permissions change,
 * and after each ladder step. A repeat `installId` updates the row in
 * place — never a second row. Fields the call omits keep their stored
 * value (COALESCE against the existing row), because the ladder reports
 * one mitigation at a time: a background-permission update must not
 * silently clear a battery exemption the device confirmed yesterday. The
 * diagnostics default to their unconfirmed state on first sight, so a
 * handset that never checks in reads unhealthy rather than silently
 * healthy (§3.1).
 */
export async function upsertDeviceWithDiagnostics(db: Db, d: DeviceRegistration): Promise<DeviceRow> {
  const r = await db.query<DeviceRow>(
    `INSERT INTO devices
       (employee_id, install_id, app_version, os_version, manufacturer, model, fcm_token,
        location_permission, battery_opt_exempt, autostart_confirmed, notifications_enabled, last_seen_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7,
             COALESCE($8::device_location_permission, 'none'),
             COALESCE($9::bool, false), COALESCE($10::bool, false), COALESCE($11::bool, false), now())
     ON CONFLICT (employee_id, install_id) DO UPDATE SET
       app_version = EXCLUDED.app_version,
       os_version = EXCLUDED.os_version,
       manufacturer = EXCLUDED.manufacturer,
       model = EXCLUDED.model,
       fcm_token = COALESCE(EXCLUDED.fcm_token, devices.fcm_token),
       location_permission = COALESCE(EXCLUDED.location_permission, devices.location_permission),
       battery_opt_exempt = COALESCE(EXCLUDED.battery_opt_exempt, devices.battery_opt_exempt),
       autostart_confirmed = COALESCE(EXCLUDED.autostart_confirmed, devices.autostart_confirmed),
       notifications_enabled = COALESCE(EXCLUDED.notifications_enabled, devices.notifications_enabled),
       last_seen_at = now()
     RETURNING id, install_id, manufacturer, model, os_version, app_version,
               location_permission, battery_opt_exempt, autostart_confirmed,
               notifications_enabled, last_seen_at, is_active`,
    [
      d.employeeId,
      d.installId,
      d.appVersion,
      d.osVersion,
      d.manufacturer,
      d.model,
      d.fcmToken ?? null,
      d.locationPermission ?? null,
      d.batteryOptExempt ?? null,
      d.autostartConfirmed ?? null,
      d.notificationsEnabled ?? null,
    ],
  );
  return r.rows[0]!;
}
