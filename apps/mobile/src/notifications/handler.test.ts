/**
 * T2.6 — the push handler's contract (PLAN-FRONTEND.md §6), one case per
 * line of the spec:
 *
 * - a data-only message triggers exactly ONE delta sync and one local
 *   notification
 * - the local notification's text comes from the SYNCED ROW, not from
 *   the push payload (which carries nothing to render — `{"type":"sync"}`)
 * - a push for a job the delta did not return raises NOTHING — no
 *   notification for content the client cannot show
 * - with notifications denied, the app still syncs, and the tracking
 *   chip's fourth state reads amber
 *
 * Everything here runs against a fake `PushSyncExecutor` — the seam the
 * mirror provider fills on a handset — so the diff/raise logic is tested
 * directly, with no database and no native surface. `expo-notifications`
 * is module-mocked (getPermissionsAsync / scheduleNotificationAsync are
 * the whole surface the handler touches).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrackingHealth } from '@servgrid/shared';

const notif = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: vi.fn(async (_input: unknown) => 'sched-1'),
}));
vi.mock('expo-notifications', () => notif);

import {
  __resetPushHandlerForTests,
  handlePushWake,
  jobNotificationContent,
  PUSH_LOCAL_KIND,
  SYNC_NOTIFICATION_CHANNEL,
  setPushSyncExecutor,
  type PushJobRow,
  type PushSyncExecutor,
} from './handler';
import { chipViewOf } from '../components/domain/TrackingHealthChip';
import { useSessionStore } from '../state/sessionStore';

const ACTOR = { id: '22222222-2222-4222-8222-222222222222', role: 'technician' as const, username: 'ravi' };

let seq = 0;
function jobRow(overrides: Partial<PushJobRow> = {}): PushJobRow {
  seq += 1;
  return {
    id: `0a000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    jobNumber: `JOB-00${seq}`,
    title: `Pump repair ${seq}`,
    status: 'assigned',
    priority: 'normal',
    scheduledFor: null,
    contactName: null,
    version: 1,
    ...overrides,
  };
}

/** A fake mirror session. `mutate` runs inside sync() — the delta the
 * wake "pulled" lands in the rows the next readJobs() returns. */
function fakeExecutor(initial: PushJobRow[], mutate: () => void = () => {}): PushSyncExecutor & { rows: PushJobRow[] } {
  const rows = initial;
  return {
    rows,
    sync: vi.fn(async () => {
      mutate();
    }),
    readJobs: vi.fn(() => rows.slice()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPushHandlerForTests();
  notif.getPermissionsAsync.mockResolvedValue({ granted: true });
  useSessionStore.getState().setAuthenticated(ACTOR);
});

afterEach(() => {
  useSessionStore.getState().setAnonymous();
});

describe('handlePushWake — the §6 composition', () => {
  it('a data-only message triggers exactly ONE delta sync and one local notification', async () => {
    const job = jobRow();
    const session = fakeExecutor([], () => session.rows.push(job));
    setPushSyncExecutor(session);

    await expect(handlePushWake()).resolves.toBe(true);

    expect(session.sync).toHaveBeenCalledTimes(1);
    expect(notif.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('the local notification’s text comes from the synced row, not from the push payload', async () => {
    const job = jobRow({ jobNumber: 'JOB-0412', title: 'Compressor PM — Site B' });
    const session = fakeExecutor([], () => session.rows.push(job));
    setPushSyncExecutor(session);

    await handlePushWake();

    const call = notif.scheduleNotificationAsync.mock.calls[0]?.[0] as {
      content: { title: string; body: string; data: Record<string, unknown> };
      trigger: { channelId: string };
    };
    // The row's words, verbatim — nothing derived from the payload, which
    // is `{"type":"sync"}` and could not have carried them anyway.
    expect(call.content.title).toBe('New job assigned');
    expect(call.content.body).toBe('JOB-0412 · Compressor PM — Site B');
    expect(call.content.data).toEqual({ kind: PUSH_LOCAL_KIND, jobId: job.id });
    // The channel was created at first launch; the row notification
    // names it on the trigger (Android 8+).
    expect(call.trigger).toEqual({ channelId: SYNC_NOTIFICATION_CHANNEL });
  });

  it('a push for a job the delta did not return raises NOTHING', async () => {
    // The wake is real and the sync runs — but the delta returns nothing
    // the client could not already show, so there is nothing to announce.
    const job = jobRow();
    const session = fakeExecutor([job]);
    setPushSyncExecutor(session);

    await expect(handlePushWake()).resolves.toBe(false);
    expect(session.sync).toHaveBeenCalledTimes(1);
    expect(notif.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('with notifications denied the app still syncs — and the chip reads amber', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ granted: false });
    const job = jobRow();
    const session = fakeExecutor([], () => session.rows.push(job));
    setPushSyncExecutor(session);

    // The sync runs; only the raising is skipped.
    await expect(handlePushWake()).resolves.toBe(false);
    expect(session.sync).toHaveBeenCalledTimes(1);
    expect(notif.scheduleNotificationAsync).not.toHaveBeenCalled();

    // The chip's fourth state is how the technician finds out (§6) —
    // amber, sourced from `devices.notifications_enabled = false`, on the
    // one chip already being looked at.
    const health: TrackingHealth = {
      employeeId: ACTOR.id,
      employeeName: 'Ravi Kumar',
      role: 'technician',
      deviceId: 'd1000000-0000-4000-8000-000000000001',
      locationPermission: 'background',
      notificationsEnabled: false,
      lastPingAt: '2026-09-11T05:54:00.000Z',
      minutesSince: 6,
      health: 'active',
    };
    expect(chipViewOf(health)).toEqual({
      tone: 'warn',
      text: 'Job alerts off — you won’t be told about new jobs',
      fixTo: 'notifications',
    });
  });
});

describe('handlePushWake — the optional-push edges', () => {
  it('a logged-out handset: no sync, no notification', async () => {
    useSessionStore.getState().setAnonymous();
    const session = fakeExecutor([]);
    setPushSyncExecutor(session);
    await expect(handlePushWake()).resolves.toBe(false);
    expect(session.sync).not.toHaveBeenCalled();
    expect(notif.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('no mirror session registered (headless revival, web): nothing raised — push is optional', async () => {
    const session = fakeExecutor([]);
    setPushSyncExecutor(session);
    setPushSyncExecutor(null); // between sessions
    await expect(handlePushWake()).resolves.toBe(false);
    expect(session.sync).not.toHaveBeenCalled();
    expect(notif.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('a version bump on a known row (reassign / priority wake) raises one Job updated', async () => {
    const job = jobRow({ jobNumber: 'JOB-0007', title: 'UPS swap' });
    const session = fakeExecutor([job], () => {
      session.rows[0] = { ...job, version: job.version + 1, priority: 'urgent' };
    });
    setPushSyncExecutor(session);

    await expect(handlePushWake()).resolves.toBe(true);
    expect(notif.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(jobNotificationContent(job, false)).toEqual({ title: 'Job updated', body: 'JOB-0007 · UPS swap' });
  });

  it('two wakes landing together collapse into one sync — rows never announce twice', async () => {
    // A sync that resolves only when the test allows it, so the second
    // wake arrives while the first is genuinely in flight.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rows: PushJobRow[] = [];
    const session: PushSyncExecutor = {
      sync: vi.fn(async () => {
        await gate;
        rows.push(jobRow());
      }),
      readJobs: vi.fn(() => rows.slice()),
    };
    setPushSyncExecutor(session);

    const firstWake = handlePushWake();
    const secondWake = handlePushWake();
    expect(secondWake).toBe(firstWake); // the same in-flight wake
    release();
    await expect(firstWake).resolves.toBe(true);

    expect(session.sync).toHaveBeenCalledTimes(1);
    expect(notif.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('a wake whose sync fails offline announces nothing — the next wake still works', async () => {
    const rows: PushJobRow[] = [];
    setPushSyncExecutor({
      sync: vi.fn(async () => {}), // offline: the drain backs off, nothing lands
      readJobs: () => rows.slice(),
    });
    await expect(handlePushWake()).resolves.toBe(false);
    expect(notif.scheduleNotificationAsync).not.toHaveBeenCalled();

    // The next wake runs its own diff against the mirror as it now is.
    const job = jobRow();
    setPushSyncExecutor({
      sync: vi.fn(async () => {
        rows.push(job);
      }),
      readJobs: () => rows.slice(),
    });
    await expect(handlePushWake()).resolves.toBe(true);
    expect(notif.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});
