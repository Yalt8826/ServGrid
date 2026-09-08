/**
 * Data-only FCM push (PLAN-BACKEND.md §2 lib/fcm.ts, §12.1). Talks to
 * the FCM v1 HTTP API with a service-account JWT (OAuth2
 * client_credentials). The message carries NO notification and NO job
 * content: it wakes the app, which runs a delta sync and raises a local
 * notification from the rows it just received. A push that carried the
 * job would be stale the moment the office changed something and would
 * deliver job details to a handset that may since have been logged out.
 *
 * The system must remain correct with every push dropped (§12.1): this
 * module is a latency improvement, never the transport for anything.
 * Failures are reported to the caller — `unregistered` is the signal to
 * clear the stale `devices.push_token`, exactly as the location-request
 * path does (§8).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const fcmEndpoint = (projectId: string): string =>
  `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

/** The service-account fields FCM v1 needs; parsed from FCM_SERVICE_ACCOUNT. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmSendResult {
  /** FCM accepted the message (at-least-once from here). */
  ok: boolean;
  /** Give up — bad token or bad payload. Never true for transient errors. */
  permanent: boolean;
  /** Token is stale (app uninstalled / FCM rotated it): clear devices.push_token (§12.1). */
  unregistered: boolean;
  httpStatus: number | null;
  error: string | null;
}

/** The data-only payload. Values must be strings — FCM v1 rejects maps. */
export interface DataOnlyMessage {
  token: string;
  data?: Record<string, string>;
}

/** initFcm() has not run (or failed): configuration error, not a send failure. */
export class FcmNotConfiguredError extends Error {
  constructor() {
    super('FCM is not configured: call initFcm() with FCM_SERVICE_ACCOUNT at boot');
    this.name = 'FcmNotConfiguredError';
  }
}

interface AccessToken {
  value: string;
  expiresAtMs: number;
}

/**
 * Parse FCM_SERVICE_ACCOUNT: either the JSON itself or a path to the
 * JSON file. Throws with the field named — config fails at boot, never
 * at 3am (T0.6 rule, applied to the one secret this module owns).
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().length > 0 && raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid service-account JSON');
  }
  const sa = parsed as Record<string, unknown>;
  for (const field of ['project_id', 'client_email', 'private_key'] as const) {
    if (typeof sa[field] !== 'string' || (sa[field] as string).length === 0) {
      throw new Error(`FCM_SERVICE_ACCOUNT is missing "${field}"`);
    }
  }
  return {
    project_id: sa['project_id'] as string,
    client_email: sa['client_email'] as string,
    private_key: sa['private_key'] as string,
  };
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_SEND_ATTEMPTS = 3;

class FcmClient {
  private account: ServiceAccount | null = null;
  private token: AccessToken | null = null;

  init(account: ServiceAccount): void {
    this.account = account;
    this.token = null;
  }

  /** Test helper: drop the cached OAuth token so the next send re-authenticates. */
  resetAuthCache(): void {
    this.token = null;
  }

  get configured(): boolean {
    return this.account !== null;
  }

  /** OAuth2 access token, cached until 60s before expiry. */
  private async accessToken(now: number): Promise<string> {
    const account = this.account;
    if (account === null) throw new FcmNotConfiguredError();
    const cached = this.token;
    if (cached !== null && cached.expiresAtMs > now + 60_000) return cached.value;

    const issuedAt = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({
        iss: account.client_email,
        scope: FCM_SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    ).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(account.private_key).toString('base64url');
    const assertion = `${header}.${claims}.${signature}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      throw new Error(`FCM OAuth token exchange failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error('FCM OAuth token exchange returned no access_token');
    }
    const expiresInS = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAtMs: now + expiresInS * 1000 };
    return body.access_token;
  }

  /**
   * Send one data-only message. Retries transient failures (429/5xx)
   * with linear backoff; never retries permanent ones. Network errors
   * are transient by definition (§12.1: the system is correct with
   * every push dropped, so a dropped send is a latency loss only).
   */
  async send(message: DataOnlyMessage, now = Date.now()): Promise<FcmSendResult> {
    const account = this.account;
    if (account === null) throw new FcmNotConfiguredError();

    let last: FcmSendResult = {
      ok: false,
      permanent: false,
      unregistered: false,
      httpStatus: null,
      error: 'not attempted',
    };
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        const accessToken = await this.accessToken(now);
        // Data-only: the `notification` key stays absent — the wake must
        // never show remote content or carry job payload (§12.1).
        const res = await fetch(fcmEndpoint(account.project_id), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: { token: message.token, data: message.data ?? {} } }),
        });
        if (res.ok) {
          return { ok: true, permanent: false, unregistered: false, httpStatus: res.status, error: null };
        }
        const detail = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
        const messageText =
          typeof detail?.error?.message === 'string' ? detail.error.message : `HTTP ${res.status}`;
        // Canonical unregistered signals: 404 "Requested entity was not
        // found.", 410 Gone, or a message naming the registration token.
        const unregistered =
          res.status === 404 ||
          res.status === 410 ||
          /unregistered|not registered|registration token/i.test(messageText);
        const permanent = !RETRYABLE_STATUSES.has(res.status);
        last = {
          ok: false,
          permanent,
          unregistered,
          httpStatus: res.status,
          error: messageText,
        };
        if (permanent) return last;
      } catch (err) {
        last = {
          ok: false,
          permanent: false,
          unregistered: false,
          httpStatus: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (attempt < MAX_SEND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    return last;
  }
}

const client = new FcmClient();

/** Configure from FCM_SERVICE_ACCOUNT (inline JSON or file path). Throws at boot. */
export function initFcm(raw: string): void {
  client.init(parseServiceAccount(raw));
}

/** True once initFcm() has succeeded. */
export function fcmConfigured(): boolean {
  return client.configured;
}

/** Test helper: drop the cached OAuth token so the next send re-authenticates. */
export function __resetFcmForTests(): void {
  client.resetAuthCache();
}

/** Send one data-only wake. Throws only when unconfigured (boot bug). */
export async function sendDataOnly(message: DataOnlyMessage): Promise<FcmSendResult> {
  return client.send(message);
}
