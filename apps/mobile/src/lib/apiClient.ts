/**
 * The one fetch wrapper (PHASE-0 spec, T0.11). Carries `Idempotency-Key`,
 * `X-Source` and `X-Device-Id` on every call, and implements the 401
 * contract from PLAN-FRONTEND.md §5.1:
 *
 * - 401 → one refresh → one retry.
 * - A refresh that fails because there is no connection (or a 429/5xx,
 *   i.e. no completed rejection of the token) is a RETRY, never a logout:
 *   the stored session survives and the caller retries later.
 * - Only a `TOKEN_REUSED`, or a 401 on a refresh round trip that actually
 *   completed, logs anyone out — and the session is cleared exactly once,
 *   with a failed clear surfaced rather than swallowed.
 */
import type { TokenStore, StoredSession } from './tokenStore';
import type { Role, ErrorCode, ErrorEnvelope } from './types';
import { parseErrorEnvelope } from './types';
import { uuid } from './uuid';

export interface ApiClientOptions {
  baseUrl?: string;
  source?: 'mobile' | 'web';
  fetchImpl?: typeof fetch;
}

/** What the refresh attempt on a 401 actually did. */
export type RefreshOutcome = 'refreshed' | 'refresh-failed-retryable' | 'logged-out';

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId: string;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  /** HTTP status; 0 when the request failed at the network layer. */
  status: number;
  data: T | null;
  error: ApiError | null;
  /** Present whenever the 401 path ran: what the refresh attempt did. */
  refreshOutcome?: RefreshOutcome;
}

export interface RequestInitLite {
  body?: unknown;
  /** Reuses a caller-supplied key (the outbox generates one, at enqueue). */
  idempotencyKey?: string;
  /** Skip the Authorization header (login, refresh). */
  anonymous?: boolean;
}

export interface LoginDevice {
  installId: string;
  platform: string;
  appVersion: string;
  osVersion: string;
  manufacturer: string;
  model: string;
}

/** The authenticated employee record the login response carries. */
export interface LoginEmployee {
  id: string;
  role: Role;
  username: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  employee: LoginEmployee;
  mustChangePassword: boolean;
}

interface RawResponse {
  status: number;
  ok: boolean;
  json: unknown | null;
  parseFailed: boolean;
  networkError: string | null;
}

function networkResult(message: string): RawResponse {
  return { status: 0, ok: false, json: null, parseFailed: false, networkError: message };
}

/** The 401 test: exactly the status, never a guessed body shape. */
function is401(res: RawResponse): boolean {
  return res.status === 401;
}

export interface ApiClient {
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts?: RequestInitLite,
  ): Promise<ApiResult<T>>;
  login(username: string, password: string, device: LoginDevice): Promise<ApiResult<LoginResponse>>;
  logout(): Promise<void>;
  /** Direct store access for the app shell; tests may wrap the store instead. */
  readonly store: TokenStore;
}

export function createApiClient(store: TokenStore, options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const source = options.source ?? 'mobile';

  // Device identity is stable across logouts — resolve once per client.
  let deviceId: string | null = null;

  // Single-flight: two concurrent 401s must not run two refreshes, because
  // the refresh token rotates on every use and the loser would replay the
  // winner's token — a self-inflicted TOKEN_REUSED.
  let refreshInFlight: Promise<RefreshOutcome> | null = null;

  // Same single-flight idea for clearing: two concurrent TOKEN_REUSED
  // results share one store.clear(). A LATER logout starts a fresh clear —
  // the mutex deduplicates an instant, not a lifetime.
  let clearInFlight: Promise<void> | null = null;

  async function deviceHeaderValue(): Promise<string> {
    if (deviceId === null) deviceId = await store.installId();
    return deviceId;
  }

  function clearSession(): Promise<void> {
    if (clearInFlight === null) {
      // Rethrows when the keystore/localStorage write fails: a failed
      // clear is not a logout, and the caller must know the credentials
      // survive.
      clearInFlight = store.clear().finally(() => {
        clearInFlight = null;
      });
    }
    return clearInFlight;
  }

  async function saveSession(session: StoredSession): Promise<void> {
    await store.save(session);
  }

  async function rawSend(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body: unknown,
    idempotencyKey: string | undefined,
    accessToken: string | undefined,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Source': source,
      'X-Device-Id': await deviceHeaderValue(),
    };
    if (accessToken !== undefined) headers.Authorization = `Bearer ${accessToken}`;
    let wireBody: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      wireBody = JSON.stringify(body);
    }
    if (method !== 'GET' && idempotencyKey !== undefined) {
      // Mutations carry a key; the same logical operation keeps it across
      // every retry (PLAN-FRONTEND.md §5 — never regenerate).
      headers['Idempotency-Key'] = idempotencyKey;
    }
    try {
      const res = await fetchImpl(url, { method, headers, body: wireBody });
      let json: unknown = null;
      let parseFailed = false;
      try {
        json = await res.json();
      } catch {
        parseFailed = true; // proxy HTML, empty body, truncated response
      }
      return { status: res.status, ok: res.ok, json, parseFailed, networkError: null };
    } catch (err) {
      return networkResult(err instanceof Error ? err.message : String(err));
    }
  }

  function toError(res: RawResponse): ApiError {
    if (res.networkError !== null) {
      return { code: 'NETWORK', message: res.networkError, requestId: '' };
    }
    const envelope: ErrorEnvelope['error'] | null = parseErrorEnvelope(res.json);
    if (envelope !== null) return envelope;
    if (res.parseFailed || res.json === null) {
      return {
        code: 'UNKNOWN',
        message: 'The server returned a response this app could not read.',
        requestId: '',
      };
    }
    return {
      code: 'UNKNOWN',
      message: 'The server returned an error this app did not recognise.',
      requestId: '',
    };
  }

  function toResult<T>(res: RawResponse, refreshOutcome?: RefreshOutcome): ApiResult<T> {
    if (res.networkError !== null) {
      return { ok: false, status: 0, data: null, error: toError(res), refreshOutcome };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        error: toError(res),
        refreshOutcome,
      };
    }
    return { ok: true, status: res.status, data: (res.json as T) ?? null, error: null, refreshOutcome };
  }

  async function doRefresh(): Promise<RefreshOutcome> {
    const session = await store.load();
    if (session === null) return 'logged-out'; // nothing to refresh
    const key = await uuid();
    const res = await rawSend(
      'POST',
      `${baseUrl}/v1/auth/refresh`,
      { refreshToken: session.refreshToken },
      key,
      undefined,
    );
    if (res.networkError !== null) return 'refresh-failed-retryable';
    if (res.status === 429 || res.status >= 500) return 'refresh-failed-retryable';
    if (res.ok) {
      const body = res.json as { accessToken?: unknown; refreshToken?: unknown } | null;
      if (
        body !== null &&
        typeof body === 'object' &&
        typeof body.accessToken === 'string' &&
        typeof body.refreshToken === 'string'
      ) {
        await saveSession({ ...session, accessToken: body.accessToken, refreshToken: body.refreshToken });
        return 'refreshed';
      }
      // A malformed 2xx is not a completed rejection either, but the
      // rotation may have consumed the old token — treat as retryable and
      // let the next round trip decide.
      return 'refresh-failed-retryable';
    }
    // The round trip completed and the server refused the token: the
    // session is done, whatever the refusal looked like.
    await clearSession();
    return 'logged-out';
  }

  function refreshOnce(): Promise<RefreshOutcome> {
    if (refreshInFlight === null) {
      refreshInFlight = doRefresh().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  return {
    store,

    async request(method, path, opts) {
      const idempotencyKey = method !== 'GET' ? (opts?.idempotencyKey ?? (await uuid())) : undefined;
      const session = await store.load();
      const url = `${baseUrl}${path}`;

      let res = await rawSend(
        method,
        url,
        opts?.body,
        idempotencyKey,
        opts?.anonymous ? undefined : session?.accessToken,
      );

      // A revoked-chain rejection can arrive on any call; it is terminal
      // wherever it appears.
      if (is401(res) && toError(res).code === 'TOKEN_REUSED') {
        await clearSession();
        return toResult(res, 'logged-out');
      }

      if (is401(res)) {
        const outcome = await refreshOnce();
        if (outcome === 'logged-out') {
          return toResult(res, outcome);
        }
        if (outcome === 'refresh-failed-retryable') {
          // No completed round trip refused the token: the session stands
          // and the caller retries later (a technician in a basement keeps
          // his outbox).
          return toResult(res, outcome);
        }
        // refreshed — exactly one retry, with the same Idempotency-Key.
        const fresh = await store.load();
        res = await rawSend(method, url, opts?.body, idempotencyKey, fresh?.accessToken);
        if (is401(res)) {
          // One refresh and one retry is the whole contract; a second 401
          // is returned, never a second refresh and never a logout.
          return toResult(res, outcome);
        }
        // Retry succeeded — keep the refresh outcome on the result.
        return toResult(res, outcome);
      }
      return toResult(res);
    },

    async login(username, password, device) {
      const res = await rawSend('POST', `${baseUrl}/v1/auth/login`, { username, password, device }, await uuid(), undefined);
      if (!res.ok) return toResult(res);
      const body = res.json as {
        accessToken?: unknown;
        refreshToken?: unknown;
        mustChangePassword?: unknown;
        employee?: { id?: unknown; role?: unknown; username?: unknown };
      } | null;
      if (
        body === null ||
        typeof body !== 'object' ||
        typeof body.accessToken !== 'string' ||
        typeof body.refreshToken !== 'string' ||
        typeof body.employee?.id !== 'string' ||
        typeof body.employee.role !== 'string' ||
        typeof body.employee.username !== 'string'
      ) {
        return {
          ok: false,
          status: res.status,
          data: null,
          error: { code: 'UNKNOWN', message: 'Login response was not in the expected shape.', requestId: '' },
        };
      }
      const employee: LoginEmployee = {
        id: body.employee.id,
        role: body.employee.role as Role,
        username: body.employee.username,
      };
      await saveSession({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        actor: employee,
      });
      const result: ApiResult<LoginResponse> = {
        ok: true,
        status: res.status,
        data: {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          employee,
          mustChangePassword: body.mustChangePassword === true,
        },
        error: null,
      };
      return result;
    },

    async logout() {
      const session = await store.load();
      if (session !== null) {
        // Best-effort revocation: a network failure here must not keep
        // credentials on a shared handset. The server's remaining windows
        // are the 60-day expiry and reuse detection.
        await rawSend(
          'POST',
          `${baseUrl}/v1/auth/logout`,
          { refreshToken: session.refreshToken },
          await uuid(),
          session.accessToken,
        );
      }
      await clearSession();
    },
  };
}
