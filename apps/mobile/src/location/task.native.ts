/**
 * The background location task (PLAN-FRONTEND.md §6). Registered at
 * MODULE SCOPE — a requirement, not a style choice: the OS revives the
 * app process straight into this task, so the definition must exist
 * before anything user-driven can run. The import that puts this module
 * in the graph happens in `trackingGate.native.ts`, which the root
 * layout loads on every start-up, native only (the web bundle has no
 * counterpart of this file and never resolves one).
 *
 * Configuration is the one set that survives Android 8+: a foreground
 * service with a persistent notification. `Accuracy.Balanced` is ample
 * for "where is this technician" — `High` is reserved for on-demand
 * fixes. Cadence targets 15 minutes with deferred updates so Android can
 * batch; the task neither compensates for the resulting jitter nor
 * treats it as failure.
 *
 * Per fix, in order: the work-window filter (out-of-window fixes are
 * discarded here, before buffering — filter, don't schedule), the buffer
 * append, then a best-effort batched upload. Nothing in this body may
 * throw: a background task that crashes is a task the OS stops calling.
 */
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { COLORS } from '@servgrid/shared';
import type { LocationPingPayload } from '@servgrid/shared';

import { api } from '../lib/api';
import { explicitFlagState } from '../state/featureFlags';
import { createPingBuffer, type PingBuffer } from './buffer.native';
import { createSqlitePingStore } from './bufferStore.native';
import { inWorkWindow } from './window.native';

/** The task name the OS registers; stable across versions. */
export const LOCATION_TASK_NAME = 'servgrid-location';

const INTERVAL_MS = 15 * 60 * 1000;

/** The notification the foreground service carries (Android 8+). It is
 * the reason tracking survives a killed app, and the honest, always
 * visible statement of what the app is doing. */
const NOTIFICATION_TITLE = 'ServGrid tracking';
const NOTIFICATION_BODY = 'Recording your location during work hours (09:00–19:00, Mon–Sat).';
const NOTIFICATION_COLOR = COLORS.accent;

/** The one buffer for this process; the task body and the foreground
 * flush both drain it. */
export const pingBuffer: PingBuffer = createPingBuffer({
  store: createSqlitePingStore(),
  api,
});

/** One OS fix → one wire ping. Invalid readings are omitted, never
 * guessed: expo signals an absent speed/heading with a negative value. */
export function toPing(loc: Location.LocationObject, recordedAt: Date): LocationPingPayload {
  const speed = typeof loc.coords.speed === 'number' && loc.coords.speed >= 0 ? loc.coords.speed : undefined;
  const heading =
    typeof loc.coords.heading === 'number' && loc.coords.heading >= 0 ? loc.coords.heading : undefined;
  return {
    recordedAt: recordedAt.toISOString(),
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracyM: Math.max(0, loc.coords.accuracy ?? 0),
    altitudeM: loc.coords.altitude ?? undefined,
    speedMps: speed,
    headingDeg: heading,
    isMoving: speed !== undefined && speed > 0.5,
    source: 'scheduled',
  };
}

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }: { data?: unknown; error?: unknown }) => {
  if (error) return; // a failed batch is jitter, not a task failure
  // T0 rollback tier (PLAN-EXECUTION.md Phase 1 rollback table): the
  // device "stops the task on next foreground" when tech.location is
  // off. Unknown (no flag answer yet — offline cold start) keeps
  // buffering; the server rejects authoritatively either way.
  if (explicitFlagState('tech.location') === false) return;
  const locations = (data as { locations?: Location.LocationObject[] } | null)?.locations ?? [];
  for (const loc of locations) {
    try {
      const recordedAt = new Date(loc.timestamp);
      // Work-window filter BEFORE buffering: the task stays alive at
      // every hour; out-of-window fixes are discarded locally. The
      // server checks again independently.
      if (!inWorkWindow(recordedAt)) continue;
      await pingBuffer.enqueue(toPing(loc, recordedAt));
    } catch {
      // One malformed fix must not take the batch down.
    }
  }
  try {
    await pingBuffer.flushAll();
  } catch {
    // Upload failing leaves the trail buffered for the next wake.
  }
});

/** Start the foreground-service updates. Returns true when the task is
 * running afterwards. Callers are the ladder's step-2 completion and the
 * gate below — both native. Never throws: tracking failing to start is
 * a state the health chip reports, not a crash. */
export async function startBackgroundLocationUpdates(): Promise<boolean> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME)) return true;
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: INTERVAL_MS,
      distanceInterval: 100,
      deferredUpdatesInterval: INTERVAL_MS,
      foregroundService: {
        notificationTitle: NOTIFICATION_TITLE,
        notificationBody: NOTIFICATION_BODY,
        notificationColor: NOTIFICATION_COLOR,
      },
      pausesUpdatesAutomatically: false,
    });
    return true;
  } catch {
    return false;
  }
}
