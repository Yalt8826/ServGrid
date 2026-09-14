import { z } from 'zod';
import { businessDateSchema, isoDateTime, roleSchema, uuid } from '@servgrid/shared';

/**
 * Location console wire schemas (PHASE-4 T4.4, PLAN-BACKEND.md §8).
 *
 * These are `apps/api`-local on purpose: `packages/shared` is the one
 * file every parallel stage-2 task would have to touch, and the
 * orchestration rules mark it serial within a phase (implementation
 * README §7). The Phase 4 console screen (T4.10) reads these shapes off
 * the wire; if a later task needs them on the client too, lifting them
 * into `@servgrid/shared` then — when `packages/shared` is free — is a
 * mechanical move.
 *
 * Every schema is `.strict()`: the errors plugin asserts 2xx payloads
 * against these outside production, and an unknown key must be a
 * failure rather than something zod quietly drops (§3.4).
 */

/** `location_request_mode` (migration 002). */
export const locationRequestModeSchema = z.enum(['fix', 'live']);
export type LocationRequestMode = z.infer<typeof locationRequestModeSchema>;

export const locationRequestCreateSchema = z
  .object({
    employeeId: uuid,
    mode: locationRequestModeSchema,
  })
  .strict();

/**
 * The request lifecycle, derived from the row's own columns — never
 * stored, so the console cannot disagree with the row:
 *
 *   failed     `failure_reason` is set (the push could not be handed to
 *              FCM, there was no pushable device, or the expiry sweep
 *              closed it unanswered) — terminal, the honest "no".
 *   fulfilled  `fulfilled_at` is set (a ping answered it) — the honest
 *              "yes", with the ping in the trail.
 *   expired    past `expires_at` with neither of the above — the sweep
 *              owns the write, but the read reports it the instant the
 *              deadline passes so the console never waits on the timer.
 *   pushed     the push was handed to FCM and the window is still open.
 *   requested  not yet attempted (a race between insert and send).
 */
export const locationRequestStatusSchema = z.enum([
  'requested',
  'pushed',
  'fulfilled',
  'expired',
  'failed',
]);
export type LocationRequestStatus = z.infer<typeof locationRequestStatusSchema>;

/** One locate-now request, as `POST /v1/location/requests` returns it and
 * `GET /v1/location/requests/:id` serves it to the polling console. */
export const locationRequestSchema = z
  .object({
    id: uuid,
    requestedBy: uuid,
    targetEmployeeId: uuid,
    mode: locationRequestModeSchema,
    status: locationRequestStatusSchema,
    requestedAt: isoDateTime,
    expiresAt: isoDateTime,
    pushedAt: isoDateTime.nullable(),
    fulfilledAt: isoDateTime.nullable(),
    fulfilledPingId: z.number().int().nullable(),
    failureReason: z.string().nullable(),
  })
  .strict();

export type LocationRequest = z.infer<typeof locationRequestSchema>;

/** The latest fix of a tracked employee — the coordinates the Phase 2
 * health surfaces deliberately do NOT carry (§5: `location.read`, not
 * `location.health`). Null when the employee has never reported. */
export const trackedPositionSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    recordedAt: isoDateTime,
    accuracyM: z.number().nullable(),
    batteryPct: z.number().int().nullable(),
    source: z.enum(['scheduled', 'on_demand', 'live', 'manual']),
  })
  .strict();

/**
 * One roster row of `GET /v1/location/employees`: the Phase 2 health row
 * (the same fields `trackingHealthSchema` serves, so "health" means the
 * same thing on every surface) PLUS the latest position — this is the
 * owner-only endpoint the dispatcher's roster warning must never grow.
 */
export const trackedEmployeeLocationSchema = z
  .object({
    employeeId: uuid,
    employeeName: z.string(),
    role: roleSchema,
    deviceId: uuid.nullable(),
    locationPermission: z.enum(['none', 'foreground', 'background']).nullable(),
    notificationsEnabled: z.boolean().nullable(),
    health: z.enum(['permission_missing', 'never_reported', 'stale', 'active']),
    lastPingAt: isoDateTime.nullable(),
    minutesSince: z.number().nullable(),
    position: trackedPositionSchema.nullable(),
  })
  .strict();

export type TrackedEmployeeLocation = z.infer<typeof trackedEmployeeLocationSchema>;

/** One ping of a day's trail, ordered by `recorded_at`. */
export const trailPingSchema = z
  .object({
    recordedAt: isoDateTime,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyM: z.number().nullable(),
    altitudeM: z.number().nullable(),
    speedMps: z.number().nullable(),
    headingDeg: z.number().nullable(),
    batteryPct: z.number().int().nullable(),
    isMoving: z.boolean().nullable(),
    source: z.enum(['scheduled', 'on_demand', 'live', 'manual']),
  })
  .strict();

export type TrailPing = z.infer<typeof trailPingSchema>;

export const locationRequestParamsSchema = z.object({ id: uuid }).strict();

/** `?date=` — the IST business date whose trail the console draws. */
export const trailQuerySchema = z.object({ date: businessDateSchema }).strict();
