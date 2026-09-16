/**
 * API client behaviour tests (PHASE-0 spec, T0.11). The three spec'd
 * cases are marked with §: refresh success, network-failed refresh, and
 * TOKEN_REUSED. A fake TokenStore keeps the session visible, and a
 * scripted fetch exercises the 401 paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from './apiClient';
import { cachedAuthMe, resetAuthMe, setAuthMe } from '../state/authMe';
import type { StoredSession, TokenStore } from './tokenStore';
import type { Role } from './types';

const SESSION: StoredSession = {
  accessToken: 'at-old',
  refreshToken: 'rt-old',
  actor: { id: '22222222-2222-4222-8222-222222222222', role: 'technician' as Role, username: 'ravi' },
};

/** Scripted response for one fetch call. */
type Scripted = {
  status?: number;
  body?: unknown;
  reject?: boolean;
  nonJson?: boolean;
};

class FakeStore implements TokenStore {
  session: StoredSession | null = { ...SESSION };
  clearCount = 0;
  failNextClear = false;
  lastSaved: StoredSession | null = null;

  async load(): Promise<StoredSession | null> {
    return this.session === null ? null : { ...this.session };
  }
  async save(session: StoredSession): Promise<void> {
    this.lastSaved = { ...session };
    this.session = { ...session };
  }
  async clear(): Promise<void> {
    this.clearCount += 1;
    if (this.failNextClear) {
      this.failNextClear = false;
      throw new Error('storage clear failed');
    }
    this.session = null;
  }
  async installId(): Promise<string> {
    return 'device-1';
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** A fetch that plays responses in order and records every call. */
function scriptedFetch(script: Scripted[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next.reject) throw new TypeError('Network request failed');
    const status = next.status ?? 200;
    if (next.nonJson) {
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      } as unknown as Response;
    }
    return jsonResponse(status, next.body ?? null);
  });
  return { calls, impl };
}

const UNAUTHENTICATED_401 = {
  status: 401,
  body: { error: { code: 'UNAUTHENTICATED', message: 'Session expired.', requestId: 'req-1' } },
};
const TOKEN_REUSED_401 = {
  status: 401,
  body: { error: { code: 'TOKEN_REUSED', message: 'Refresh token reuse detected; chain revoked.', requestId: 'req-2' } },
};

function api(fetchImpl: ReturnType<typeof scriptedFetch>['impl'], store?: FakeStore): ApiClient {
  return createApiClient(store ?? new FakeStore(), { baseUrl: 'https://api.test', fetchImpl, source: 'mobile' });
}

describe('apiClient — 401 contract', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it('§ 401 → one refresh → one retry → success', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401, // original request
      { status: 200, body: { accessToken: 'at-new', refreshToken: 'rt-new' } }, // refresh
      { status: 200, body: { ok: true } }, // retry succeeds
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ok: true });
    expect(result.refreshOutcome).toBe('refreshed');

    // Exactly three HTTP calls: original, refresh, retry.
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.init.method).toBe('GET');
    const [refreshCall, retryCall] = [f.calls[1]!, f.calls[2]!];
    expect(refreshCall.url).toBe('https://api.test/v1/auth/refresh');
    expect(JSON.parse(String(refreshCall.init.body)).refreshToken).toBe('rt-old');
    expect(retryCall.init.headers).toMatchObject({ Authorization: 'Bearer at-new' });

    // The rotated pair is persisted for the next cold start.
    expect(store.session).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    // And no logout happened.
    expect(store.clearCount).toBe(0);
  });

  it('§ 401 → refresh fails with a network error → retried later, session survives', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      { reject: true }, // refresh hits a dead network
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    // The failure is reported, but nobody was logged out. The result
    // carries the ORIGINAL 401 — stale credentials are the honest state —
    // with refreshOutcome marking it as retryable, not a rejection.
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error?.code).toBe('UNAUTHENTICATED');
    expect(result.refreshOutcome).toBe('refresh-failed-retryable');

    // Two calls only: the original and the failed refresh — no retry.
    expect(f.calls).toHaveLength(2);

    // THE assertion: the stored session survives intact, and nothing
    // cleared it — the technician in the basement keeps his outbox.
    expect(store.session).toMatchObject({ accessToken: 'at-old', refreshToken: 'rt-old' });
    expect(store.clearCount).toBe(0);
  });

  it('§ 401 → refresh returns TOKEN_REUSED → session cleared exactly once', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      TOKEN_REUSED_401, // the refresh round trip completes with the reuse verdict
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.ok).toBe(false);
    expect(result.refreshOutcome).toBe('logged-out');

    // No retry after a refused refresh.
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.url).toBe('https://api.test/v1/auth/refresh');

    // The session is gone, and the clear ran exactly once.
    expect(store.session).toBeNull();
    expect(store.clearCount).toBe(1);
  });

  it('TOKEN_REUSED on the original request is terminal without a refresh', async () => {
    const f = scriptedFetch([TOKEN_REUSED_401]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.refreshOutcome).toBe('logged-out');
    expect(f.calls).toHaveLength(1); // no refresh attempt at all
    expect(store.session).toBeNull();
    expect(store.clearCount).toBe(1);
  });

  it('a 429 on refresh is retryable, not a logout', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too fast.', requestId: 'r' } } },
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.refreshOutcome).toBe('refresh-failed-retryable');
    expect(store.session).not.toBeNull();
    expect(store.clearCount).toBe(0);
  });

  it('a 5xx on refresh is retryable, not a logout', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      { status: 503, body: { error: { code: 'NOT_FOUND', message: 'overloaded', requestId: 'r' } } },
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.refreshOutcome).toBe('refresh-failed-retryable');
    expect(store.session).not.toBeNull();
    expect(store.clearCount).toBe(0);
  });

  it('a completed 401 on refresh logs out (the round trip finished)', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Unknown refresh token.', requestId: 'r' } } },
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.refreshOutcome).toBe('logged-out');
    expect(store.session).toBeNull();
    expect(store.clearCount).toBe(1);
  });

  it('exactly one retry: a second 401 after refresh is returned, not refreshed again', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      { status: 200, body: { accessToken: 'at-new', refreshToken: 'rt-new' } },
      UNAUTHENTICATED_401, // retry also 401s
      { status: 200, body: { accessToken: 'at-never', refreshToken: 'rt-never' } }, // must NOT happen
    ]);
    const result = await api(f.impl, store).request('GET', '/v1/jobs');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(f.calls).toHaveLength(3); // original + refresh + one retry
    expect(store.clearCount).toBe(0); // a completed refresh is not a logout
  });

  it('a failing store clear() rethrows and leaves the session in place', async () => {
    const f = scriptedFetch([TOKEN_REUSED_401]);
    store.failNextClear = true;
    const client = api(f.impl, store);

    // The logout must not be pretended: the credentials survive.
    await expect(client.request('GET', '/v1/jobs')).rejects.toThrow('storage clear failed');
    expect(store.session).not.toBeNull();
  });

  it('a failed clear is reported; a later logout still clears for real', async () => {
    // After a TOKEN_REUSED whose store clear failed, a subsequent
    // logout() must genuinely clear — the mutex deduplicates a single
    // instant, it does not block later logouts.
    const f = scriptedFetch([TOKEN_REUSED_401]);
    const client = api(f.impl, store);
    store.failNextClear = true;
    await expect(client.request('GET', '/v1/jobs')).rejects.toThrow();
    expect(store.clearCount).toBe(1);
    store.failNextClear = false;
    await client.logout();
    expect(store.session).toBeNull();
    expect(store.clearCount).toBe(2);
  });
});

describe('apiClient — headers, keys, and single-flight', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it('carries Idempotency-Key, X-Source and X-Device-Id; none on GET keys', async () => {
    const f = scriptedFetch([{ status: 200, body: { ok: true } }]);
    const client = api(f.impl);

    await client.request('POST', '/v1/jobs', { body: { customerId: 'c1' } });
    await client.request('GET', '/v1/jobs');
    const postHeaders = f.calls[0]!.init.headers as Record<string, string>;
    const getHeaders = f.calls[1]!.init.headers as Record<string, string>;

    expect(postHeaders['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(postHeaders['X-Source']).toBe('mobile');
    expect(postHeaders['X-Device-Id']).toBe('device-1');
    expect(getHeaders['Idempotency-Key']).toBeUndefined();
    expect(getHeaders['Authorization']).toMatch(/^Bearer /);
  });

  it('keeps the caller-supplied Idempotency-Key across the refresh retry', async () => {
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      { status: 200, body: { accessToken: 'at-new', refreshToken: 'rt-new' } },
      { status: 200, body: { ok: true } },
    ]);
    await api(f.impl, store).request('POST', '/v1/jobs', {
      body: { customerId: 'c1' },
      idempotencyKey: 'fixed-key-from-outbox',
    });

    const first = (f.calls[0]!.init.headers as Record<string, string>)['Idempotency-Key'];
    const retry = (f.calls[2]!.init.headers as Record<string, string>)['Idempotency-Key'];
    expect(first).toBe('fixed-key-from-outbox');
    expect(retry).toBe('fixed-key-from-outbox');
  });

  it('concurrent 401s run a single refresh (single-flight)', async () => {
    // The refresh token rotates on every use: two parallel refreshes would
    // make the loser replay the winner's token — a self-inflicted
    // TOKEN_REUSED.
    const f = scriptedFetch([
      UNAUTHENTICATED_401,
      UNAUTHENTICATED_401,
      { status: 200, body: { accessToken: 'at-new', refreshToken: 'rt-new' } },
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    const client = api(f.impl, store);
    const [a, b] = await Promise.all([
      client.request('GET', '/v1/jobs'),
      client.request('GET', '/v1/jobs'),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const refreshes = f.calls.filter((c) => c.url.endsWith('/v1/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('login() stores the session and reports mustChangePassword', async () => {
    const f = scriptedFetch([
      {
        status: 200,
        body: {
          accessToken: 'at-login',
          refreshToken: 'rt-login',
          employee: { id: 'e1', role: 'owner', username: 'owner' },
          mustChangePassword: true,
          consent: { required: false, version: '2026-09-01' },
        },
      },
    ]);
    const result = await api(f.impl, store).login('owner', 'pw', {
      installId: 'device-1',
      platform: 'android',
      appVersion: '0.1.0',
      osVersion: '15',
      manufacturer: 'Xiaomi',
      model: 'Redmi',
    });

    expect(result.ok).toBe(true);
    expect(result.data?.mustChangePassword).toBe(true);
    expect(result.data?.consent).toEqual({ required: false, version: '2026-09-01' });
    expect(result.data?.employee.role).toBe('owner');
    expect(store.session).toMatchObject({
      accessToken: 'at-login',
      refreshToken: 'rt-login',
      actor: { id: 'e1', role: 'owner', username: 'owner' },
    });
  });

  it('logout() posts the revocation even when offline, then clears locally', async () => {
    const f = scriptedFetch([
      { reject: true }, // /v1/auth/logout is unreachable
    ]);
    await api(f.impl, store).logout();

    // The local session is gone regardless — a shared handset must not
    // keep credentials because the office was unreachable.
    expect(store.session).toBeNull();
    expect(store.clearCount).toBe(1);
  });

  it('logout() drops the cached /auth/me answer — the dashboard greets by that name', async () => {
    resetAuthMe();
    // A shared handset: the next person to sign in must never be
    // greeted by the name of the person who just left, and every flag
    // the leaver held rides the same cached answer.
    setAuthMe({
      employee: { id: 'e-owner', role: 'owner', username: 'owner', fullName: 'ServGrid Owner' },
      permissions: {},
      featureFlags: {},
      consent: {},
    } as unknown as Parameters<typeof setAuthMe>[0]);
    expect(cachedAuthMe()).not.toBeNull();

    const f = scriptedFetch([{ status: 200, body: {} }]);
    await api(f.impl, store).logout();

    expect(cachedAuthMe()).toBeNull();
  });
});
