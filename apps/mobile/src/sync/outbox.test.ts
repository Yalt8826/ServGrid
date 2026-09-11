/**
 * T1.14 — the outbox and drain manager's tests
 * (apps/mobile/src/sync/outbox.test.ts).
 *
 * The seven cases the spec names, plus the drain triggers. The named gate
 * comes first: **the idempotency key is byte-identical across five
 * retries** — the single highest-value assertion in the client. The key is
 * minted once, at enqueue, stored on the ROW, and every retry reads it
 * back from there; nothing in the drain path can regenerate it.
 *
 * Infrastructure (see ./testing.ts): the database is a real SQLite engine
 * via the node:sqlite seam — no mocked database — and the HTTP layer is
 * the real api client over a scripted fetch, so the 401 → refresh-once →
 * retry-once contract is production code under test. Backoff and due-ness
 * run on a hand-advanced clock; the 60-second trigger uses fake timers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetSqliteSeam } from '../test-stubs/expo-sqlite';

import { createDrainManager, drainOnce, type DrainDeps, type DrainEvent } from './drain';
import { ATTACHMENT_ENTITY, backoffSeconds, enqueue, pendingSyncCount, rowById, rowsForEmployee } from './outbox';
import {
  EMPLOYEE_A,
  EMPTY_WORKING_SET,
  FakeStore,
  SESSION_A,
  TestClock,
  batchReply,
  jsonResponse,
  makeClient,
  makeMirror,
  scriptFetch,
  seedCursor,
  type FetchHandler,
  type RecordedCall,
} from './testing';
import type { Mirror, MirrorDatabase } from '../db/mirror';

// ── harness ─────────────────────────────────────────────────────────────────

function makeHarness() {
  const mirror: Mirror = makeMirror();
  const db: MirrorDatabase = mirror.database;
  const clock = new TestClock('2026-09-11T09:00:00.000Z');
  const store = new FakeStore(SESSION_A);
  const events: DrainEvent[] = [];
  let handler: FetchHandler = () => {
    throw new Error('radio off');
  };
  const { calls, fetch: fetchImpl } = scriptFetch((call, index) => handler(call, index));
  const api = makeClient(store, fetchImpl);
  const deps = (): DrainDeps => ({
    mirror,
    send: api.request.bind(api),
    employeeId: EMPLOYEE_A,
    now: clock.now,
    onEvent: (event) => events.push(event),
  });
  return {
    mirror,
    db,
    clock,
    store,
    calls,
    events,
    setHandler: (next: FetchHandler) => {
      handler = next;
    },
    deps,
  };
}

type Harness = ReturnType<typeof makeHarness>;

/** The recorded `/v1/sync/batch` calls, so the wire assertions read plainly. */
function batchCalls(harness: Harness): RecordedCall[] {
  return harness.calls.filter((call) => call.url.endsWith('/v1/sync/batch'));
}

function operationsOf(call: RecordedCall): Array<{ localId: string; idempotencyKey: string }> {
  if (typeof call.body !== 'object' || call.body === null || !('operations' in call.body)) {
    throw new Error('the batch call did not carry an operations envelope');
  }
  return (call.body as { operations: Array<{ localId: string; idempotencyKey: string }> }).operations;
}

beforeEach(() => {
  __resetSqliteSeam();
});

// ── the named cases ─────────────────────────────────────────────────────────

describe('outbox drain (T1.14)', () => {
  it('the idempotency key is byte-identical across five retries', async () => {
    const harness = makeHarness();
    harness.setHandler(() => {
      throw new Error('ECONNRESET: the van went under a bridge');
    });

    const row = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed', occurredAt: harness.clock.iso() },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await drainOnce(harness.deps());
      expect(result.deferred).toBe(1);
      expect(result.authLost).toBe(false);

      // Still queued, still his, nothing discarded — and the backoff the
      // failure bought is 2^attempt seconds.
      const after = rowById(harness.db, row.id);
      expect(after?.status).toBe('queued');
      expect(after?.attempts).toBe(attempt);
      expect(after?.nextAttemptAt).toBe(
        new Date(harness.clock.now().getTime() + Math.min(2 ** attempt, 300) * 1000).toISOString(),
      );
      expect(pendingSyncCount(harness.db, EMPLOYEE_A)).toBe(1);

      // Become due again for the next cycle.
      harness.clock.advance(2 ** attempt);
    }

    // Five cycles, five batch attempts, ONE key — and it is the row's.
    const attempts = batchCalls(harness);
    expect(attempts).toHaveLength(5);
    const keysOnTheWire = attempts.map((call) => operationsOf(call)[0]?.idempotencyKey);
    expect(new Set(keysOnTheWire).size).toBe(1);
    expect(keysOnTheWire[0]).toBe(row.idempotencyKey);
    expect(rowById(harness.db, row.id)?.status).toBe('queued');
    expect(rowsForEmployee(harness.db, EMPLOYEE_A)).toHaveLength(1);
  });

  it('backoff is 2^n capped at 5 minutes', () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(2)).toBe(4);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(4)).toBe(16);
    expect(backoffSeconds(5)).toBe(32);
    expect(backoffSeconds(6)).toBe(64);
    expect(backoffSeconds(7)).toBe(128);
    expect(backoffSeconds(8)).toBe(256);
    expect(backoffSeconds(9)).toBe(300); // the cap: 5 minutes, not 512s
    expect(backoffSeconds(10)).toBe(300);
    expect(backoffSeconds(50)).toBe(300);
  });

  it('a child whose parent is rejected stays queued and is never sent again', async () => {
    const harness = makeHarness();

    const parent = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/status',
      body: { to: 'in_progress' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });
    const child = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
      dependsOn: parent.id,
    });
    const other = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000002/notes',
      body: { text: 'gate code 4321' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000002',
    });

    harness.setHandler((call) => {
      if (!call.url.endsWith('/v1/sync/batch')) throw new Error(`unexpected call ${call.url}`);
      // The server judges in order: parent rejected, its child skipped
      // without being attempted, the unrelated op applied.
      return batchReply(
        operationsOf(call).map((operation) => {
          if (operation.localId === parent.id) {
            return {
              localId: parent.id,
              outcome: 'rejected' as const,
              status: 409,
              error: { code: 'JOB_ALREADY_CLOSED', message: 'This job was closed by the office at 14:32.' },
            };
          }
          if (operation.localId === child.id) {
            return { localId: child.id, outcome: 'skipped' as const, status: 0 };
          }
          return { localId: operation.localId, outcome: 'applied' as const, status: 200 };
        }),
        '2026-09-11T08:59:00.000Z',
      );
    });

    // Cycle 1: parent, child and the unrelated op ride together; the
    // server rejects the parent and short-circuits the child.
    await drainOnce(harness.deps());
    expect(rowById(harness.db, parent.id)?.status).toBe('rejected');
    expect(rowById(harness.db, parent.id)?.errorMessage).toBe('This job was closed by the office at 14:32.');
    expect(rowById(harness.db, child.id)?.status).toBe('queued'); // skipped → back to queued
    expect(rowById(harness.db, other.id)?.status).toBe('done');
    expect(harness.events.some((event) => event.type === 'row-rejected')).toBe(true);

    // Cycle 2: the child must not go back on the wire. With the parent
    // rejected and everything else settled, nothing is eligible — no
    // batch call happens at all.
    harness.calls.length = 0;
    await drainOnce(harness.deps());
    expect(batchCalls(harness)).toHaveLength(0);
    expect(rowById(harness.db, child.id)?.status).toBe('queued');
  });

  it('401 → refresh → retry once → success, with nothing discarded', async () => {
    const harness = makeHarness();
    const row = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });

    harness.setHandler((call) => {
      if (call.url.endsWith('/v1/auth/refresh')) {
        return jsonResponse(200, { accessToken: 'at-a-new', refreshToken: 'rt-a-new' });
      }
      if (call.url.endsWith('/v1/sync/batch')) {
        if (batchCalls(harness).length === 1) {
          // First attempt: the access token expired.
          return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'The session expired.' } });
        }
        return batchReply([{ localId: row.id, outcome: 'applied' as const, status: 200 }], '2026-09-11T08:30:00.000Z');
      }
      if (call.url.includes('/v1/sync/delta')) {
        return jsonResponse(200, { data: EMPTY_WORKING_SET, tombstones: [], cursor: '2026-09-11T09:00:00.000Z', hasMore: false });
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    const result = await drainOnce(harness.deps());
    expect(result.applied).toBe(1);
    expect(result.authLost).toBe(false);
    expect(result.deltaPages).toBe(1);

    // Exactly one refresh and exactly one retry: batch, refresh, batch —
    // then the delta that reconciles the mirror from the applied change.
    const shape = harness.calls.map((call) =>
      call.url.endsWith('/v1/auth/refresh')
        ? 'refresh'
        : call.url.endsWith('/v1/sync/batch')
          ? 'batch'
          : call.url.includes('/v1/sync/delta')
            ? 'delta'
            : 'other',
    );
    expect(shape).toEqual(['batch', 'refresh', 'batch', 'delta']);

    // The SAME operation key rode both attempts — the api client retried
    // the batch and the row's key came back from the row, unchanged.
    const firstBatch = harness.calls[0];
    const retriedBatch = harness.calls[2];
    if (firstBatch === undefined || retriedBatch === undefined) throw new Error('expected batch, refresh, batch');
    expect(operationsOf(firstBatch)[0]?.idempotencyKey).toBe(row.idempotencyKey);
    expect(operationsOf(retriedBatch)[0]?.idempotencyKey).toBe(row.idempotencyKey);
    expect(retriedBatch.headers['Authorization']).toBe('Bearer at-a-new');

    // Session rotated, never cleared; the row is done; the queue lost
    // nothing — one row, still his.
    expect(harness.store.session?.refreshToken).toBe('rt-a-new');
    expect(harness.store.clears).toBe(0);
    expect(rowById(harness.db, row.id)?.status).toBe('done');
    expect(rowsForEmployee(harness.db, EMPLOYEE_A)).toHaveLength(1);
  });

  it('401 whose refresh fails on a network error leaves the queue and session intact', async () => {
    const harness = makeHarness();
    const row = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });

    harness.setHandler((call) => {
      if (call.url.endsWith('/v1/auth/refresh')) {
        throw new Error('network gone'); // a basement, not a refusal
      }
      if (call.url.endsWith('/v1/sync/batch')) {
        return jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'The session expired.' } });
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    const manager = createDrainManager(harness.deps());
    const result = await manager.drainNow();

    // A retry, not a rejection: the drain is NOT paused, no re-login
    // prompt, nothing penalised.
    expect(result.authLost).toBe(false);
    expect(manager.isPaused()).toBe(false);
    expect(harness.events.filter((event) => event.type === 'auth-lost')).toHaveLength(0);

    // Queue intact — same row, same key, no attempts, eligible now.
    const after = rowById(harness.db, row.id);
    expect(after?.status).toBe('queued');
    expect(after?.idempotencyKey).toBe(row.idempotencyKey);
    expect(after?.attempts).toBe(0);
    expect(after?.nextAttemptAt).toBeNull();

    // Session intact — the refresh never completed, so nothing rotated
    // and nothing was cleared.
    expect(harness.store.session?.accessToken).toBe('at-a-old');
    expect(harness.store.session?.refreshToken).toBe('rt-a-old');
    expect(harness.store.clears).toBe(0);
    expect(harness.store.saves).toBe(0);
  });

  it('attachment rows are excluded from the JSON batch and uploaded individually afterwards; the delta call comes last', async () => {
    const harness = makeHarness();
    seedCursor(harness.mirror, '2026-09-11T00:00:00.000Z');

    const op = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/status',
      body: { to: 'in_progress' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });
    const photo = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/attachments',
      entityType: ATTACHMENT_ENTITY,
      entityLocalId: 'local-photo-1',
      dependsOn: op.id,
      body: {
        fileUri: 'file:///data/user/0/app/files/photo1.jpg',
        mimeType: 'image/jpeg',
        fileName: 'photo1.jpg',
        ownerType: 'job_card',
        ownerId: '01890a5e-1000-7000-8000-000000000001',
        kind: 'photo',
        capturedAt: '2026-09-11T08:00:00.000Z',
        fileChecksum: 'aa'.repeat(32),
      },
    });

    harness.setHandler((call) => {
      if (call.url.endsWith('/v1/sync/batch')) {
        return batchReply([{ localId: op.id, outcome: 'applied' as const, status: 200 }], '2026-09-11T08:45:00.000Z');
      }
      if (call.url.endsWith('/v1/attachments')) {
        return jsonResponse(200, { id: '01890a5e-3000-7000-8000-000000000009' });
      }
      if (call.url.includes('/v1/sync/delta')) {
        return jsonResponse(200, { data: EMPTY_WORKING_SET, tombstones: [], cursor: '2026-09-11T09:00:00.000Z', hasMore: false });
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    const result = await drainOnce(harness.deps());
    expect(result.applied).toBe(1);
    expect(result.uploaded).toBe(1);
    expect(result.deltaPages).toBe(1);

    // Two transports, in order: JSON batch, then the individual upload,
    // then the delta — the cursor reflects the attachments too.
    const shape = harness.calls.map((call) =>
      call.url.endsWith('/v1/sync/batch')
        ? 'batch'
        : call.url.endsWith('/v1/attachments')
          ? 'attachment'
          : call.url.includes('/v1/sync/delta')
            ? 'delta'
            : 'other',
    );
    expect(shape).toEqual(['batch', 'attachment', 'delta']);

    // The batch carried ONLY the JSON op — the photo never rode it.
    const ops = operationsOf(harness.calls[0]!);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.localId).toBe(op.id);

    // The upload carried the row's own key and the multipart fields.
    const upload = harness.calls[1]!;
    expect(upload.headers['Idempotency-Key']).toBe(photo.idempotencyKey);
    expect(upload.bodyIsFormData).toBe(true);
    const form = upload.body as FormData;
    expect(form.get('ownerType')).toBe('job_card');
    expect(form.get('ownerId')).toBe('01890a5e-1000-7000-8000-000000000001');
    expect(form.get('kind')).toBe('photo');
    expect(form.get('capturedAt')).toBe('2026-09-11T08:00:00.000Z');
    expect(form.get('fileChecksum')).toBe('aa'.repeat(32));
    expect(form.has('file')).toBe(true);

    // The delta ran from the BATCH's cursor, not the stored one.
    expect(harness.calls[2]?.url).toBe('/v1/sync/delta?cursor=2026-09-11T08%3A45%3A00.000Z');

    // Both rows settled, neither discarded.
    expect(rowById(harness.db, op.id)?.status).toBe('done');
    expect(rowById(harness.db, photo.id)?.status).toBe('done');
  });

  it('an attachment whose parent is rejected is not sent', async () => {
    const harness = makeHarness();

    const op = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });
    const photo = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/attachments',
      entityType: ATTACHMENT_ENTITY,
      entityLocalId: 'local-photo-1',
      dependsOn: op.id,
      body: {
        fileUri: 'file:///data/user/0/app/files/photo1.jpg',
        mimeType: 'image/jpeg',
        fileName: 'photo1.jpg',
        ownerType: 'job_completion',
        ownerId: '01890a5e-1000-7000-8000-000000000001',
        kind: 'photo',
        capturedAt: '2026-09-11T08:00:00.000Z',
        fileChecksum: 'bb'.repeat(32),
      },
    });

    harness.setHandler((call) => {
      if (call.url.endsWith('/v1/sync/batch')) {
        return batchReply(
          [
            {
              localId: op.id,
              outcome: 'rejected' as const,
              status: 422,
              error: { code: 'JOB_ALREADY_CLOSED', message: 'This job was cancelled by the office at 14:32.' },
            },
          ],
          '2026-09-11T08:50:00.000Z',
        );
      }
      if (call.url.endsWith('/v1/attachments')) {
        return jsonResponse(200, { id: '01890a5e-3000-7000-8000-000000000009' });
      }
      throw new Error(`unexpected call ${call.url}`);
    });

    // Cycle 1 and cycle 2: the parent is rejected, so the photo is
    // skipped this cycle — both times.
    await drainOnce(harness.deps());
    harness.clock.advance(60);
    await drainOnce(harness.deps());

    expect(harness.calls.filter((call) => call.url.endsWith('/v1/attachments'))).toHaveLength(0);
    expect(rowById(harness.db, photo.id)?.status).toBe('queued');

    // The parent's rejection is kept verbatim, and the banner event named it.
    expect(rowById(harness.db, op.id)?.status).toBe('rejected');
    expect(rowById(harness.db, op.id)?.errorMessage).toBe('This job was cancelled by the office at 14:32.');
    const rejection = harness.events.find((event) => event.type === 'row-rejected');
    expect(rejection?.type === 'row-rejected' && rejection.message).toBe('This job was cancelled by the office at 14:32.');
  });
});

// ── the drain triggers ──────────────────────────────────────────────────────

describe('drain triggers (T1.14)', () => {
  it('reconnect and foreground drain now; the 60-second timer drains only while active; stop is stop', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      harness.setHandler(() => {
        throw new Error('radio off'); // every attempt defers with backoff
      });
      const row = await enqueue(harness.db, {
        employeeId: EMPLOYEE_A,
        method: 'POST',
        path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
        body: { to: 'completed' },
        entityType: 'job',
        entityLocalId: '01890a5e-1000-7000-8000-000000000001',
      });

      let active = true;
      const reconnects: Array<() => void> = [];
      const manager = createDrainManager(harness.deps());
      const stop = manager.start({
        onReconnect: (notify) => {
          reconnects.push(notify);
          return () => {};
        },
        isActive: () => active,
      });

      // Reconnect: the drain runs now.
      reconnects[0]?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(batchCalls(harness)).toHaveLength(1);

      // The 60-second timer, while active: due again after its 2s backoff,
      // the next tick retries.
      harness.clock.advance(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(batchCalls(harness)).toHaveLength(2);

      // Backgrounded: the timer ticks but the drain stays quiet.
      active = false;
      harness.clock.advance(300);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(batchCalls(harness)).toHaveLength(2);

      // Stopped is stopped, active or not.
      stop();
      active = true;
      harness.clock.advance(300);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(batchCalls(harness)).toHaveLength(2);

      // Two attempts so far — the key across them is still the row's.
      const keys = batchCalls(harness).map((call) => operationsOf(call)[0]?.idempotencyKey);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toBe(row.idempotencyKey);
    } finally {
      vi.useRealTimers();
    }
  });
});
