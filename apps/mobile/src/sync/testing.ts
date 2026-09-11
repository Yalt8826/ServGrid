/**
 * Test infrastructure for the sync module's tests (T1.14), following the
 * `components/ui/testing.tsx` precedent: shared doubles, not a framework.
 *
 * - The database is REAL: `openSqliteMirror` runs against the node:sqlite
 *   seam (the repo's "no mocked database" rule) — the same open path the
 *   app uses, mirror tables and outbox table together.
 * - The HTTP layer is the REAL `createApiClient` over a scripted
 *   `fetchImpl` — the api client's 401 → refresh-once → retry-once
 *   contract is production code under test, never re-implemented here.
 *   (The brief says "MSW"; this repo's established seam is the injectable
 *   fetch — same interception point, one less dependency.)
 * - Time is an injectable clock the tests advance by hand; the trigger
 *   tests use vitest's fake timers for the 60-second interval.
 */
import type { SyncWorkingSet } from '@servgrid/shared';
import { createApiClient } from '../lib/apiClient';
import type { StoredSession, TokenStore } from '../lib/tokenStore';
import type { Mirror } from '../db/mirror';
import { applyBootstrap } from '../db/mirror';
import { openSqliteMirror } from '../db/sqliteMirror';

/** A fresh, real database with the mirror AND outbox tables. */
export function makeMirror(): Mirror {
  return openSqliteMirror();
}

export const EMPLOYEE_A = '11111111-1111-4111-8111-111111111111';
export const EMPLOYEE_B = '22222222-2222-4222-8222-222222222222';

export const SESSION_A: StoredSession = {
  accessToken: 'at-a-old',
  refreshToken: 'rt-a-old',
  actor: { id: EMPLOYEE_A, role: 'technician', username: 'ravi' },
};

/** In-memory TokenStore that records what the 401 path did to it. */
export class FakeStore implements TokenStore {
  session: StoredSession | null = null;
  saves = 0;
  clears = 0;

  constructor(session: StoredSession | null = null) {
    this.session = session === null ? null : { ...session };
  }

  async load(): Promise<StoredSession | null> {
    return this.session === null ? null : { ...this.session };
  }
  async save(session: StoredSession): Promise<void> {
    this.saves += 1;
    this.session = { ...session };
  }
  async clear(): Promise<void> {
    this.clears += 1;
    this.session = null;
  }
  async installId(): Promise<string> {
    return 'device-1';
  }
}

// ── the scripted fetch ──────────────────────────────────────────────────────

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body when the body was a JSON string; the raw value
   * (e.g. FormData) otherwise. */
  body: unknown;
  bodyIsFormData: boolean;
}

export type FetchHandler = (call: RecordedCall, index: number) => Response;

export interface ScriptedFetch {
  calls: RecordedCall[];
  fetch: typeof fetch;
}

/**
 * Records every call and hands it to the handler, in order. A handler that
 * throws produces a network-level failure — exactly what `rawSend` sees
 * when the radio is off.
 */
export function scriptFetch(handler: FetchHandler): ScriptedFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: unknown, init?: unknown): Promise<Response> => {
    const typedInit = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: unknown };
    const rawBody = typedInit.body;
    const call: RecordedCall = {
      url: String(url),
      method: typedInit.method ?? 'GET',
      headers: typedInit.headers ?? {},
      body:
        typeof rawBody === 'string'
          ? (JSON.parse(rawBody) as unknown)
          : rawBody,
      bodyIsFormData: typeof FormData !== 'undefined' && rawBody instanceof FormData,
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  };
  return { calls, fetch: fetchImpl as unknown as typeof fetch };
}

/** Deterministic API client over the script, with the session the 401
 * paths act on. */
export function makeClient(store: FakeStore, fetchImpl: typeof fetch): ReturnType<typeof createApiClient> {
  return createApiClient(store, { baseUrl: '', fetchImpl });
}

export function jsonResponse(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

// ── the clock ───────────────────────────────────────────────────────────────

/** Hand-advanced clock: deterministic backoff assertions without a
 * timer-mocking framework in the loop. */
export class TestClock {
  private ms: number;

  constructor(iso: string) {
    this.ms = Date.parse(iso);
  }

  now = (): Date => new Date(this.ms);

  /** Advance the clock; returns the new instant. */
  advance(seconds: number): Date {
    this.ms += seconds * 1000;
    return new Date(this.ms);
  }

  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

// ── sync payloads ───────────────────────────────────────────────────────────

export const EMPTY_WORKING_SET: SyncWorkingSet = {
  jobs: [],
  customers: [],
  customerProducts: [],
  products: [],
  services: [],
};

/** Plant a delta cursor as if a bootstrap happened, so the drain's delta
 * step has a position to call from. */
export function seedCursor(mirror: Mirror, cursor: string): void {
  applyBootstrap(mirror, { data: EMPTY_WORKING_SET, cursor });
}

/** Batch outcome the drain applies: every operation rejected/skipped per
 * the script. */
export function batchReply(
  results: Array<{ localId: string; outcome: 'applied' | 'duplicate' | 'rejected' | 'skipped'; status: number; error?: { code: string; message: string } }>,
  cursor: string,
): Response {
  return jsonResponse(200, {
    results: results.map((r) => ({ ...r, ...(r.error ? { error: r.error } : {}) })),
    cursor,
  });
}
