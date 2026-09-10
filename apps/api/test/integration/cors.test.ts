import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { parseOrigins } from '../../src/config.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * CORS (PLAN.md §1: the owner gets a desktop web build).
 *
 * This suite exists because of a gap it is the direct answer to: every
 * other test in this repo calls `app.inject()`, which dispatches
 * in-process and never sends an `Origin` or a preflight. A browser does
 * both. So the API shipped with no CORS at all, `tsc` was happy, 179
 * tests were green, and the *one* Phase 0 exit criterion that needs a
 * browser — "an owner account logs in on desktop web" — could not pass.
 *
 * The lesson generalises past CORS: an in-process test client is not a
 * client. Anything a browser does that `inject()` does not, this file
 * has to assert deliberately.
 */

function server(overrides: Record<string, string> = {}) {
  const config = loadConfig({ ...validEnv(), ...overrides });
  return buildServer(config, { logger: false });
}

const DEV_ORIGIN = 'http://localhost:8082';

describe('preflight — what the browser asks before it will send anything', () => {
  it('answers OPTIONS for an allowed origin, and names the methods and headers the client uses', async () => {
    const app = server({ NODE_ENV: 'development' });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: {
        origin: DEV_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-source,idempotency-key',
      },
    });

    expect(res.statusCode, 'a 404 here is the bug this file was written for').toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(DEV_ORIGIN);
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST');

    // The app client sends all of these (apps/mobile/src/lib/apiClient.ts).
    // A header missing here is a request the browser refuses to send.
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase();
    for (const h of ['content-type', 'authorization', 'idempotency-key', 'if-match', 'x-source', 'x-device-id']) {
      expect(allowed, `${h} must be allowed`).toContain(h);
    }
    await app.close();
  });

  it('reflects the allowed origin on the real request too, with credentials', async () => {
    const app = server({ NODE_ENV: 'development' });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: DEV_ORIGIN },
      payload: { username: 'nobody', password: 'wrong-password-value' },
    });
    expect(res.headers['access-control-allow-origin']).toBe(DEV_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    await app.close();
  });

  it('does not reflect an origin that was never allowed', async () => {
    const app = server({ NODE_ENV: 'development' });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { username: 'nobody', password: 'wrong-password-value' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});

describe('the allowlist — never a wildcard, because credentials ride these', () => {
  it('development defaults to localhost so `expo start --web` works out of the box', () => {
    expect(parseOrigins(undefined, 'development')).toContain('http://localhost:8082');
  });

  it('production and staging default to NOTHING — an origin is named or it is not allowed', () => {
    expect(parseOrigins(undefined, 'production')).toEqual([]);
    expect(parseOrigins(undefined, 'staging')).toEqual([]);
  });

  it('an explicit list wins everywhere, trimmed and without trailing slashes', () => {
    expect(parseOrigins('https://app.example/ , https://admin.example', 'production')).toEqual([
      'https://app.example',
      'https://admin.example',
    ]);
  });

  it('a configured origin is honoured in production; anything else is not', async () => {
    const app = server({ NODE_ENV: 'staging', WEB_ORIGINS: 'https://staging.example' });
    await app.ready();

    const good = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: { origin: 'https://staging.example', 'access-control-request-method': 'POST' },
    });
    expect(good.headers['access-control-allow-origin']).toBe('https://staging.example');

    const bad = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: { origin: 'http://localhost:8082', 'access-control-request-method': 'POST' },
    });
    expect(bad.headers['access-control-allow-origin'], 'a dev origin must not leak into staging').toBeUndefined();
    await app.close();
  });

  it('never answers with `*` — a wildcard plus credentials is refused by every browser', async () => {
    const app = server({ NODE_ENV: 'development' });
    await app.ready();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/auth/login',
      headers: { origin: DEV_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
    await app.close();
  });
});
