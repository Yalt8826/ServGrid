/**
 * This phone's diagnostics, read from the server (`GET /v1/devices/me`).
 * The permission ladder's two steps Android cannot read back — the
 * battery-optimisation exemption and the OEM autostart confirmation — used
 * to be remembered in AsyncStorage. Online-only (decision 2026-09-15): the
 * ladder posts them to `POST /v1/devices` when they happen, and this reads
 * them back, so nothing about them is stored on the phone.
 *
 * A phone that has not registered yet, or a read that fails, answers
 * null: the steps then read "Not confirmed", which is the honest default.
 */
import type { DeviceDiagnostic } from '@servgrid/shared';

import { api } from './api';

export async function loadMyDevice(): Promise<DeviceDiagnostic | null> {
  try {
    const res = await api.request<DeviceDiagnostic>('GET', '/v1/devices/me');
    return res.ok && res.data !== null ? res.data : null;
  } catch {
    return null;
  }
}
