/**
 * T1.15 — the cold-start wiring's tests (MirrorProvider + PendingBadge).
 *
 * The database is REAL (the node:sqlite seam behind `expo-sqlite`), and
 * the cases are exactly the ones §5.1 is about:
 *
 *  - a technician session opens the mirror, publishes it, and runs one
 *    sync cycle: bootstrap fills a fresh mirror, then the drain pulls
 *    the delta — all after first render, none of it awaited by one
 *  - OFFLINE, the same cold start publishes the session, attempts the
 *    bootstrap once, and does NOT log anyone out — a status-0 sync is a
 *    retry, never a rejection (the expired-access-token morning)
 *  - a dispatcher session never opens the database at all (open-call
 *    counter; the module-level proof lives in mirror.test.ts) and never
 *    fetches
 *  - the pending badge's count is this employee's queued + inflight rows
 *    only — another employee's rows and settled rows are excluded
 *  - `auth-lost` (a COMPLETED refresh refusal) flips the session store to
 *    anonymous — the one logout that is not a network failure
 *  - a user switch clears the working set (mirror lifetime "until
 *    logout"); an app teardown (unmount) deliberately leaves it for the
 *    next cold start — §5.1's whole premise
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';

import type { SyncBootstrapResponse, SyncDeltaResponse } from '@servgrid/shared';

import { act } from 'react';

import type { ApiResult } from '../lib/apiClient';
import type { DrainSend } from './drain';
import type { MirrorJob } from '../db/mirror';
import { openMirror, readRows } from '../db/mirror';
import { enqueue, settleDone } from './outbox';
import { MirrorProvider, useMirrorSession, type MirrorSession } from './MirrorProvider';
import { PendingBadge } from '../components/domain/PendingBadge';
import { useSessionStore } from '../state/sessionStore';
import { __resetSqliteSeam, __expoSqliteOpenCalls } from '../test-stubs/expo-sqlite';
import { create, findByTestID, allText, toJson } from '../components/ui/testing';

// ── fixtures ────────────────────────────────────────────────────────────────

const A = { id: '01890a5e-0000-7000-8000-00000000000a', role: 'technician', username: 'ravi' } as const;
const B = { id: '01890a5e-0000-7000-8000-00000000000b', role: 'technician', username: 'anitha' } as const;
const DISPATCHER = { id: '01890a5e-0000-7000-8000-00000000000d', role: 'dispatcher', username: 'priya' } as const;

function makeJob(overrides: Partial<MirrorJob> = {}): MirrorJob {
  return {
    id: '01890a5e-1000-7000-8000-000000000001',
    jobNumber: 'JC-2627-00001',
    title: 'UPS battery swap',
    status: 'assigned',
    priority: 'normal',
    scheduledFor: '2026-09-10T05:30:00+05:30', // yesterday, on purpose
    customerId: '01890a5e-2000-7000-8000-000000000001',
    contactName: 'Ravi Kumar',
    contactPhone: '+919000000001',
    description: null,
    contract: null,
    version: 1,
    ...overrides,
  };
}

function workingSet(jobs: MirrorJob[]): SyncBootstrapResponse['data'] {
  return {
    jobs,
    customers: [
      {
        id: '01890a5e-2000-7000-8000-000000000001',
        name: 'Sri Balaji Agencies',
        phone: '+919000000001',
        altPhone: null,
        addressLine1: '14, Gandhi Bazaar',
        addressLine2: null,
        city: 'Coimbatore',
        state: 'Tamil Nadu',
        pincode: '641012',
        latitude: 11.0168,
        longitude: 76.9558,
        notes: null,
        companyId: null,
        version: 1,
      },
    ],
    customerProducts: [],
    products: [],
    services: [],
  };
}

const BOOTSTRAP: SyncBootstrapResponse = { data: workingSet([makeJob()]), cursor: '2026-09-10T09:00:00Z' };

const EMPTY_DELTA: SyncDeltaResponse = {
  data: workingSet([]),
  tombstones: [],
  cursor: '2026-09-10T09:05:00Z',
  hasMore: false,
};

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, status: 200, data, error: null };
}

function offline(): ApiResult<never> {
  return {
    ok: false,
    status: 0,
    data: null,
    error: { code: 'NETWORK', message: 'No connection.', requestId: '' },
  };
}

function refused401(): ApiResult<never> {
  return {
    ok: false,
    status: 401,
    data: null,
    error: { code: 'UNAUTHENTICATED', message: 'The session was refused.', requestId: 'req-1' },
    refreshOutcome: 'logged-out',
  };
}

interface Call {
  method: string;
  path: string;
}

function fakeSend(handler: (call: Call) => ApiResult<unknown>): { send: DrainSend; calls: Call[] } {
  const calls: Call[] = [];
  const send = (async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string) => {
    const call = { method, path };
    calls.push(call);
    return handler(call);
  }) as DrainSend;
  return { send, calls };
}

const NO_TRIGGERS = {};

// ── harness ─────────────────────────────────────────────────────────────────

let captured: MirrorSession | null | undefined;
let activeRenderer: ReactTestRenderer | null = null;

function Probe(): ReactNode {
  captured = useMirrorSession();
  return null;
}

async function renderProvider(send: DrainSend): Promise<ReactTestRenderer> {
  // The provider subscribes to the session STORE, which outlives any one
  // renderer — a previous test's left-mounted provider would react to
  // this test's setActor and race it (same store, same sqlite file).
  // `beforeEach` unmounts; each test's renderer is tracked here.
  activeRenderer = await create(
    <MirrorProvider send={send} triggers={NO_TRIGGERS}>
      <Probe />
    </MirrorProvider>,
  );
  return activeRenderer;
}

/** Flush the open + first sync cycle: macrotask-sized act turns until the
 * captured session stops moving. The loop runs to a fixed floor before it
 * may break, so an early null-vs-null match cannot exit while the gated
 * dynamic import is still landing. */
async function settle(): Promise<void> {
  let previous: MirrorSession | null | undefined = undefined;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    stable = captured === previous ? stable + 1 : 0;
    previous = captured;
    if (i >= 12 && stable >= 5) break;
  }
}

function setActor(actor: typeof A | typeof B | typeof DISPATCHER | null): void {
  act(() => {
    if (actor === null) useSessionStore.getState().setAnonymous();
    else useSessionStore.getState().setAuthenticated({ ...actor });
  });
}

beforeEach(() => {
  // Unmount FIRST: a still-mounted provider from the previous test shares
  // the session store and the sqlite file, and would race this test.
  activeRenderer?.unmount();
  activeRenderer = null;
  __resetSqliteSeam();
  setActor(null);
  captured = undefined;
});

// Pre-warm the gated dynamic import so the flush loop is pure microtasks
// after the first test, and every test starts from a closed seam.
beforeEach(async () => {
  await openMirror('technician');
  __resetSqliteSeam();
});

describe('MirrorProvider — the T1.15 cold-start wiring', () => {
  it('a technician cold start opens the mirror, bootstraps it, and publishes the session', async () => {
    setActor(A);
    const { send, calls } = fakeSend((call) => {
      if (call.path === '/v1/sync/bootstrap') return ok(BOOTSTRAP);
      if (call.path.startsWith('/v1/sync/delta')) return ok(EMPTY_DELTA);
      return offline();
    });

    await renderProvider(send);
    await settle();

    expect(captured).not.toBeNull();
    expect(captured?.employeeId).toBe(A.id);
    expect(calls[0]).toEqual({ method: 'GET', path: '/v1/sync/bootstrap' });
    // The drain's delta pass ran after the bootstrap landed (cursor now set).
    expect(calls.some((c) => c.method === 'GET' && c.path.startsWith('/v1/sync/delta'))).toBe(true);
    // The mirror holds the working set — what the dashboard renders.
    expect(readRows(captured!.mirror, 'job')).toHaveLength(1);
    expect(readRows(captured!.mirror, 'customer')).toHaveLength(1);
  });

  it('offline, the same cold start publishes the session and never logs out', async () => {
    setActor(A);
    const { send, calls } = fakeSend(() => offline());

    await renderProvider(send);
    await settle();

    // The session stands: the bootstrap was attempted once, failed at the
    // network layer, and the technician is still signed in.
    expect(captured).not.toBeNull();
    expect(calls).toEqual([{ method: 'GET', path: '/v1/sync/bootstrap' }]);
    expect(useSessionStore.getState().status).toBe('authenticated');
    expect(useSessionStore.getState().actor?.id).toBe(A.id);
    // Nothing synced, so nothing is pending and the mirror is empty — the
    // dashboard will render its honest empty state, not a spinner.
    expect(captured?.pendingCount).toBe(0);
    expect(readRows(captured!.mirror, 'job')).toHaveLength(0);
  });

  it('a dispatcher session never opens the database and never fetches', async () => {
    const opensBefore = __expoSqliteOpenCalls();
    setActor(DISPATCHER);
    const { send, calls } = fakeSend(() => offline());

    await renderProvider(send);
    await settle();

    expect(captured).toBeNull();
    expect(__expoSqliteOpenCalls()).toBe(opensBefore);
    expect(calls).toEqual([]);
  });

  it('the pending count is this employee’s queued + inflight rows only', async () => {
    setActor(A);
    const { send } = fakeSend(() => offline());
    await renderProvider(send);
    await settle();
    const database = captured!.mirror.database;

    // Three queued rows for A, one of them settled done, plus one queued
    // row for employee B on the shared handset: the badge counts A's
    // queued + inflight only — 2, not 3 (done excluded) and not 3+1
    // (another employee's rows are his own).
    const first = await enqueue(database, {
      employeeId: A.id, method: 'POST', path: '/v1/jobs', entityType: 'job', entityLocalId: 'local-1',
    });
    await enqueue(database, {
      employeeId: A.id, method: 'POST', path: '/v1/jobs', entityType: 'job', entityLocalId: 'local-2',
    });
    await enqueue(database, {
      employeeId: A.id, method: 'POST', path: '/v1/jobs', entityType: 'job', entityLocalId: 'local-4',
    });
    settleDone(database, first.id);
    await enqueue(database, {
      employeeId: B.id, method: 'POST', path: '/v1/jobs', entityType: 'job', entityLocalId: 'local-3',
    });

    // A sync cycle refreshes the count through the drain's single flight.
    act(() => {
      captured?.syncNow();
    });
    await settle();

    expect(captured?.pendingCount).toBe(2);
  });

  it('a completed refresh refusal logs out; the mirror is cleared with the session', async () => {
    setActor(A);
    const { send } = fakeSend((call) => {
      if (call.path === '/v1/sync/batch') return refused401();
      return offline();
    });
    const renderer = await renderProvider(send);
    await settle();

    // Queue work, then drain: the batch comes back 401 with a COMPLETED
    // refusal — the one logout that is real (§5.1).
    await enqueue(captured!.mirror.database, {
      employeeId: A.id, method: 'POST', path: '/v1/jobs', entityType: 'job', entityLocalId: 'local-1',
    });
    act(() => {
      captured?.syncNow();
    });
    await settle();

    expect(useSessionStore.getState().status).toBe('anonymous');
    // The store flip re-runs the provider effect: the session (and its
    // working set) is gone.
    expect(captured).toBeNull();
    const mirror = await openMirror('technician');
    expect(readRows(mirror, 'job')).toHaveLength(0);
    renderer.unmount();
  });

  it('a user switch clears the working set; an app teardown leaves it for the next cold start', async () => {
    // The server answers the FIRST and THIRD bootstrap, not the second:
    // B's fresh mirror must be empty even though the fake has data —
    // anything readable there after the switch would be A's leftover.
    let bootstraps = 0;
    const handler = (call: Call): ApiResult<unknown> => {
      if (call.path === '/v1/sync/bootstrap') {
        bootstraps += 1;
        return bootstraps === 2 ? offline() : ok(BOOTSTRAP);
      }
      if (call.path.startsWith('/v1/sync/delta')) return ok(EMPTY_DELTA);
      return offline();
    };
    const { send } = fakeSend(handler);
    setActor(A);
    const renderer = await renderProvider(send);
    await settle();
    expect(readRows(captured!.mirror, 'job')).toHaveLength(1);

    // Employee B signs in on the shared handset: A's working set is
    // cleared, and B's own bootstrap fails (offline) — so an empty jobs
    // table proves the clear; a leftover row here would be A's data.
    setActor(B);
    await settle();
    expect(captured?.employeeId).toBe(B.id);
    expect(readRows(captured!.mirror, 'job')).toHaveLength(0);

    // A returns, syncs again, then the app is torn down (unmount). That
    // is NOT a user switch: the working set must survive to the next
    // cold start — possibly with no radio (§5.1's whole premise).
    setActor(null);
    await settle();
    setActor(A);
    await settle();
    expect(readRows(captured!.mirror, 'job')).toHaveLength(1);
    renderer.unmount();
    const survivor = await openMirror('technician');
    expect(readRows(survivor, 'job')).toHaveLength(1);
  });
});

describe('PendingBadge', () => {
  it('renders nothing at zero — drained is quiet', async () => {
    const renderer = await create(<PendingBadge count={0} testID="pending-badge" />);
    expect(findByTestID(toJson(renderer), 'pending-badge')).toBeUndefined();
  });

  it('renders the count tabular, labelled for the screen reader', async () => {
    const renderer = await create(<PendingBadge count={3} testID="pending-badge" />);
    const badge = findByTestID(toJson(renderer), 'pending-badge');
    expect(badge).toBeTruthy();
    // The host stub splits the JSX text interpolation; join before matching.
    // T1.17's badge renders the count and its label as sibling texts.
    const text = allText(toJson(renderer)).join('');
    expect(text).toContain('3');
    expect(text).toContain('Pending');
    expect(badge?.props.accessibilityLabel).toBe('3 items waiting to sync — tap to sync now');
  });
});
