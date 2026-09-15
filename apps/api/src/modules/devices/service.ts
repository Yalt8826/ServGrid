import type { DeviceDiagnostic, DeviceUpsert } from '@servgrid/shared';
import { getPool } from '../../db/pool.js';
import * as repo from './repo.js';

/**
 * Device registration service (PLAN-BACKEND.md §8). `POST /v1/devices`
 * is how the health chip becomes truthful: without a fresh
 * `location_permission` the chip can only report absence of pings, not
 * the reason. The employee comes from the signed token — a device row is
 * always the caller's own, so the endpoint needs no matrix cell of its
 * own (there is no `device` resource; the row is self by construction,
 * the same way /v1/auth/me is).
 */

/** Row → the one device shape the API exports (§3.1 diagnostics; the
 * owner's employee detail returns the same schema). */
function toDiagnostic(row: repo.DeviceRow): DeviceDiagnostic {
  return {
    id: row.id,
    installId: row.install_id,
    manufacturer: row.manufacturer,
    model: row.model,
    osVersion: row.os_version,
    appVersion: row.app_version,
    locationPermission: row.location_permission as DeviceDiagnostic['locationPermission'],
    batteryOptExempt: row.battery_opt_exempt,
    autostartConfirmed: row.autostart_confirmed,
    notificationsEnabled: row.notifications_enabled,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    isActive: row.is_active,
  };
}

export function createDevicesService() {
  /** Upsert by (employee_id, install_id); a repeat installId updates in place. */
  async function registerDevice(employeeId: string, input: DeviceUpsert): Promise<DeviceDiagnostic> {
    const row = await repo.upsertDeviceWithDiagnostics(getPool(), {
      employeeId,
      installId: input.installId,
      appVersion: input.appVersion,
      osVersion: input.osVersion,
      manufacturer: input.manufacturer,
      model: input.model,
      fcmToken: input.fcmToken,
      locationPermission: input.locationPermission,
      batteryOptExempt: input.batteryOptExempt,
      autostartConfirmed: input.autostartConfirmed,
      notificationsEnabled: input.notificationsEnabled,
    });
    return toDiagnostic(row);
  }

  /** GET /v1/devices/me — the session's device diagnostics, or null. */
  async function myDevice(employeeId: string, deviceId: string): Promise<DeviceDiagnostic | null> {
    const row = await repo.findOwnDevice(getPool(), employeeId, deviceId);
    return row === null ? null : toDiagnostic(row);
  }

  return { registerDevice, myDevice };
}

export type DevicesService = ReturnType<typeof createDevicesService>;
