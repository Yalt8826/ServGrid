/**
 * T1.14 — the logout gate's tests (apps/mobile/src/sync/logout.test.ts).
 *
 * The gate in both directions (§5):
 *  - BLOCKED while any row is `queued` (or `inflight`): the count IS the
 *    message — "3 items not yet synced" — and the only offer is *Retry
 *    now*. No confirm-and-lose path exists, because this module exports
 *    nothing that could wipe queued work.
 *  - ALLOWED when only `rejected` rows remain — and those rows SURVIVE
 *    the logout, keyed to their `employee_id`.
 *
 * And the shared-handset rule the column exists for: after a user switch
 * (the mirror is cleared — T1.13's `clearMirror`), employee A's rejected
 * rows are invisible to employee B and reappear for A.
 *
 * Same infrastructure as outbox.test.ts: a real SQLite database, the real
 * api client over a scripted fetch.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { __resetSqliteSeam } from '../test-stubs/expo-sqlite';

import { clearMirror, readRows } from '../db/mirror';
import { enqueue, rowById, rowsForEmployee } from './outbox';
import { drainOnce, type DrainDeps } from './drain';
import { evaluateLogout } from './logout';
import {
  EMPLOYEE_A,
  EMPLOYEE_B,
  FakeStore,
  SESSION_A,
  TestClock,
  batchReply,
  makeClient,
  makeMirror,
  scriptFetch,
  type FetchHandler,
} from './testing';
import type { Mirror, MirrorDatabase } from '../db/mirror';

function makeHarness() {
  const mirror: Mirror = makeMirror();
  const db: MirrorDatabase = mirror.database;
  const clock = new TestClock('2026-09-11T17:30:00.000Z'); // end of a shift
  const store = new FakeStore(SESSION_A);
  let handler: FetchHandler = () => {
    throw new Error('radio off');
  };
  const { calls, fetch: fetchImpl } = scriptFetch((call, index) => handler(call, index));
  const api = makeClient(store, fetchImpl);
  const depsFor = (employeeId: string): DrainDeps => ({
    mirror,
    send: api.request.bind(api),
    employeeId,
    now: clock.now,
  });
  return {
    mirror,
    db,
    clock,
    store,
    calls,
    setHandler: (next: FetchHandler) => {
      handler = next;
    },
    depsFor,
  };
}


/** The office rejects this completion: the job was cancelled while the
 * technician was underground. */
function rejectOnly(localId: string): FetchHandler {
  return (call) => {
    if (!call.url.endsWith('/v1/sync/batch')) throw new Error(`unexpected call ${call.url}`);
    const operations = (call.body as { operations: Array<{ localId: string }> }).operations;
    return batchReply(
      operations.map((operation) =>
        operation.localId === localId
          ? {
              localId,
              outcome: 'rejected' as const,
              status: 409,
              error: { code: 'JOB_ALREADY_CLOSED', message: 'This job was cancelled by the office at 14:32.' },
            }
          : { localId: operation.localId, outcome: 'applied' as const, status: 200 },
      ),
      '2026-09-11T17:00:00.000Z',
    );
  };
}

beforeEach(() => {
  __resetSqliteSeam();
});

describe('logout gate (T1.14)', () => {
  it('logout is blocked with a queued row, and the count in the message is correct', async () => {
    const harness = makeHarness();

    // One queued row: blocked, and the message says one.
    const first = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });
    let gate = evaluateLogout(harness.db, EMPLOYEE_A);
    expect(gate.allowed).toBe(false);
    expect(gate.pendingCount).toBe(1);
    expect(gate.message).toBe('1 items not yet synced');

    // The spec's example: three items not yet synced.
    for (const n of [2, 3]) {
      await enqueue(harness.db, {
        employeeId: EMPLOYEE_A,
        method: 'POST',
        path: `/v1/jobs/01890a5e-1000-7000-8000-00000000000${n}/status`,
        body: { to: 'in_progress' },
        entityType: 'job',
        entityLocalId: `job-${n}`,
      });
    }
    gate = evaluateLogout(harness.db, EMPLOYEE_A);
    expect(gate.allowed).toBe(false);
    expect(gate.pendingCount).toBe(3);
    expect(gate.message).toBe('3 items not yet synced');

    // A row still in flight blocks too.
    harness.db.runSync(`UPDATE outbox SET status = 'inflight' WHERE id = ?`, first.id);
    expect(evaluateLogout(harness.db, EMPLOYEE_A).pendingCount).toBe(3);

    // And another employee's rows are not his problem.
    await enqueue(harness.db, {
      employeeId: EMPLOYEE_B,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000009/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: 'job-9',
    });
    expect(evaluateLogout(harness.db, EMPLOYEE_A).pendingCount).toBe(3);
    expect(evaluateLogout(harness.db, EMPLOYEE_B).pendingCount).toBe(1);
  });

  it('logout is allowed with only rejected rows, and those rows survive', async () => {
    const harness = makeHarness();

    // A completion the server rejects, plus one that drains clean.
    const doomed = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });
    const fine = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000002/status',
      body: { to: 'in_progress' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000002',
    });
    harness.setHandler((call) => {
      if (!call.url.endsWith('/v1/sync/batch')) throw new Error(`unexpected call ${call.url}`);
      const operations = (call.body as { operations: Array<{ localId: string }> }).operations;
      return batchReply(
        operations.map((operation) =>
          operation.localId === doomed.id
            ? {
                localId: doomed.id,
                outcome: 'rejected' as const,
                status: 409,
                error: { code: 'JOB_ALREADY_CLOSED', message: 'This job was cancelled by the office at 14:32.' },
              }
            : { localId: operation.localId, outcome: 'applied' as const, status: 200 },
        ),
        '2026-09-11T17:00:00.000Z',
      );
    });
    await drainOnce(harness.depsFor(EMPLOYEE_A));

    // Nothing queued or in flight: the gate opens, no message.
    const gate = evaluateLogout(harness.db, EMPLOYEE_A);
    expect(gate.allowed).toBe(true);
    expect(gate.pendingCount).toBe(0);
    expect(gate.message).toBeNull();
    expect(rowById(harness.db, fine.id)?.status).toBe('done'); // the clean one settled

    // Logout proceeds: the session ends and the mirror is cleared (user
    // switch, T1.13). The outbox is deliberately untouched by both.
    await harness.store.clear();
    clearMirror(harness.mirror);

    // The rejected row SURVIVES — kept, with the server's message the
    // technician has already seen in the banner.
    const kept = rowById(harness.db, doomed.id);
    expect(kept?.status).toBe('rejected');
    expect(kept?.employeeId).toBe(EMPLOYEE_A);
    expect(kept?.errorMessage).toBe('This job was cancelled by the office at 14:32.');
    // The applied row settled to done and is kept as well; the point is
    // that NEITHER was wiped by the logout.
    const afterLogout = rowsForEmployee(harness.db, EMPLOYEE_A);
    expect(afterLogout.map((row) => row.status).sort()).toEqual(['done', 'rejected']);
  });

  it("after a user switch, employee A's rejected rows are invisible to employee B and reappear for A", async () => {
    const harness = makeHarness();

    // A's shift ends with one rejected completion.
    const rejected = await enqueue(harness.db, {
      employeeId: EMPLOYEE_A,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000001/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000001',
    });
    harness.setHandler(rejectOnly(rejected.id));
    await drainOnce(harness.depsFor(EMPLOYEE_A));
    expect(rowById(harness.db, rejected.id)?.status).toBe('rejected');

    // The handover: A logs out (gate open — only a rejected row remains),
    // the session clears, the mirror clears. The OUTBOX is not wiped.
    await harness.store.clear();
    clearMirror(harness.mirror);
    expect(readRows(harness.mirror, 'job')).toHaveLength(0); // B starts from a bootstrap, not A's mirror

    // B logs in on the same handset and works. He must not see A's row —
    // not in his queue, not in his count, not in his logout gate.
    await enqueue(harness.db, {
      employeeId: EMPLOYEE_B,
      method: 'POST',
      path: '/v1/jobs/01890a5e-1000-7000-8000-000000000007/complete',
      body: { to: 'completed' },
      entityType: 'job',
      entityLocalId: '01890a5e-1000-7000-8000-000000000007',
    });
    const bRows = rowsForEmployee(harness.db, EMPLOYEE_B);
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.id).not.toBe(rejected.id);
    expect(evaluateLogout(harness.db, EMPLOYEE_B).pendingCount).toBe(1);

    // B drains his own row: A's rejected row is not dragged along.
    harness.setHandler((call) => {
      if (!call.url.endsWith('/v1/sync/batch')) throw new Error(`unexpected call ${call.url}`);
      const operations = (call.body as { operations: Array<{ localId: string }> }).operations;
      expect(operations.map((operation) => operation.localId)).not.toContain(rejected.id);
      return batchReply(
        operations.map((operation) => ({ localId: operation.localId, outcome: 'applied' as const, status: 200 })),
        '2026-09-11T18:00:00.000Z',
      );
    });
    await drainOnce(harness.depsFor(EMPLOYEE_B));

    // A's next login on this handset: his rejection is still his — same
    // status, same key, same message.
    const again = rowsForEmployee(harness.db, EMPLOYEE_A);
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(rejected.id);
    expect(again[0]?.status).toBe('rejected');
    expect(again[0]?.idempotencyKey).toBe(rejected.idempotencyKey);
    expect(again[0]?.errorMessage).toBe('This job was cancelled by the office at 14:32.');
  });
});
