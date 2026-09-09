import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorEnvelope } from '@servgrid/shared';
import { loadConfig } from '../../src/config.js';
import { AppError } from '../../src/plugins/errors.js';
import { DEVICE_HEADER, SOURCE_HEADER } from '../../src/plugins/request-context.js';
import { buildServer } from '../../src/server.js';
import { ULID, validEnv } from '../helpers/env.js';

/**
 * Error envelope + response validation (PHASE-0-FOUNDATION.md T0.6,
 * PLAN-BACKEND.md §3.1, §3.4). Routes are registered on a real server
 * instance and driven through Fastify's inject so the whole hook chain —
 * request context, handler, error handler, serialisation — is the one a
 * handset talks to.
 */

const SECRET = 'pg password leaked into an exception message';

const strictBody = z.object({ name: z.string().min(1), qty: z.number().int() }).strict();
const typedResponse = z.object({ id: z.string() }).strict() as ZodTypeAny;

function registerProbes(app: FastifyInstance): void {
  app.post('/t/app-error', async () => {
    throw new AppError(
      'JOB_ALREADY_CLOSED',
      'This job was cancelled by the office at 14:32.',
      { jobId: '3f0c…', status: 'cancelled' },
    );
  });
  app.post('/t/zod', async (request) => {
    strictBody.parse(request.body);
    return { ok: true };
  });
  app.get('/t/boom', async () => {
    throw new Error(SECRET);
  });
  app.get<{ Querystring: { leak?: string } }>(
    '/t/typed',
    { config: { responseSchema: typedResponse } },
    async (request) => (request.query.leak ? { id: 'x', cost: '1200.00' } : { id: 'x' }),
  );
  app.get('/t/context', async (request) => request.context);
}

// No database in this suite; the probe handle is never called.
const noDb = { query: async () => [] };

let app: FastifyInstance;
let production: FastifyInstance;

beforeAll(async () => {
  app = buildServer(loadConfig(validEnv()), { logger: false, db: noDb });
  registerProbes(app);
  await app.ready();

  production = buildServer(loadConfig(validEnv({ NODE_ENV: 'production' })), {
    logger: false,
    db: noDb,
  });
  registerProbes(production);
  await production.ready();
});

afterAll(async () => {
  await app?.close();
  await production?.close();
});

function envelopeOf(body: string): ErrorEnvelope['error'] {
  const parsed = JSON.parse(body) as ErrorEnvelope;
  expect(Object.keys(parsed)).toEqual(['error']);
  return parsed.error;
}

describe('error envelope — one shape, always', () => {
  it('a thrown AppError produces the envelope with all four fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/t/app-error', payload: {} });

    expect(res.statusCode).toBe(ERROR_HTTP_STATUS.JOB_ALREADY_CLOSED);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const error = envelopeOf(res.body);
    expect(Object.keys(error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
    expect(error.code).toBe('JOB_ALREADY_CLOSED');
    // Verbatim: this is the string the offline conflict banner shows.
    expect(error.message).toBe('This job was cancelled by the office at 14:32.');
    expect(error.details).toEqual({ jobId: '3f0c…', status: 'cancelled' });
    expect(error.requestId).toMatch(ULID);
    expect(res.headers['x-request-id']).toBe(error.requestId);
  });

  it('a zod failure produces 422 VALIDATION_FAILED with populated details.issues', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/t/zod',
      payload: { name: '', qty: 1.5, extra: true },
    });

    expect(res.statusCode).toBe(422);
    const error = envelopeOf(res.body);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.requestId).toMatch(ULID);
    const issues = (error.details as { issues: Array<{ path: string; message: string; code: string }> })
      .issues;
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['name', 'qty']));
    for (const issue of issues) {
      expect(issue.message).toBeTruthy();
      expect(issue.code).toBeTruthy();
    }
  });

  it('a body that is not JSON is still the envelope, not Fastify\'s default 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/t/zod',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });

    expect(res.statusCode).toBe(422);
    const error = envelopeOf(res.body);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect((error.details as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('an unhandled exception produces a 500 envelope with a requestId and no stack trace', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/boom' });

    expect(res.statusCode).toBe(500);
    const error = envelopeOf(res.body);
    expect(error.code).toBe('INTERNAL');
    expect(error.requestId).toMatch(ULID);
    expect(error.message).not.toContain(SECRET);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toMatch(/stack|\bat \w+ \(/);
    expect(error).not.toHaveProperty('details');
  });

  it('an unknown route is a NOT_FOUND envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/nothing/here' });

    expect(res.statusCode).toBe(404);
    const error = envelopeOf(res.body);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.requestId).toMatch(ULID);
  });
});

describe('response validation (§3.4) — active in NODE_ENV=test', () => {
  it('lets a payload matching the route schema through', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/typed' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'x' });
  });

  it('refuses a payload carrying a field the schema does not declare', async () => {
    // The completion-field-in-a-dispatcher-payload case, in miniature.
    const res = await app.inject({ method: 'GET', url: '/t/typed?leak=1' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('1200.00');
    const error = envelopeOf(res.body);
    expect(error.code).toBe('INTERNAL');
    const issues = (error.details as { issues: Array<{ code: string; message: string }> }).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('unrecognized_keys');
    expect(issues[0]?.message).toContain('cost');
  });

  it('is switched off in production', async () => {
    const res = await production.inject({ method: 'GET', url: '/t/typed?leak=1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'x', cost: '1200.00' });
  });
});

describe('request context (§3.3)', () => {
  it('carries a ULID requestId, the declared source and a valid deviceId', async () => {
    const deviceId = '6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c';
    const res = await app.inject({
      method: 'GET',
      url: '/t/context',
      headers: { [SOURCE_HEADER]: 'mobile', [DEVICE_HEADER]: deviceId.toUpperCase() },
    });

    expect(res.statusCode).toBe(200);
    const context = res.json<{ requestId: string; actor: unknown; source: string; deviceId: string }>();
    expect(context.requestId).toMatch(ULID);
    expect(context.requestId).toBe(res.headers['x-request-id']);
    expect(context.actor).toBeNull();
    expect(context.source).toBe('mobile');
    expect(context.deviceId).toBe(deviceId);
  });

  it('treats a missing or unknown source as system and a malformed deviceId as absent', async () => {
    const missing = await app.inject({ method: 'GET', url: '/t/context' });
    expect(missing.json().source).toBe('system');
    expect(missing.json().deviceId).toBeNull();

    const bogus = await app.inject({
      method: 'GET',
      url: '/t/context',
      headers: { [SOURCE_HEADER]: 'toaster', [DEVICE_HEADER]: 'not-a-uuid' },
    });
    expect(bogus.json().source).toBe('system');
    expect(bogus.json().deviceId).toBeNull();
  });

  it('issues distinct, time-ordered ids across requests', async () => {
    const first = await app.inject({ method: 'GET', url: '/t/context' });
    const second = await app.inject({ method: 'GET', url: '/t/context' });
    const a = first.json<{ requestId: string }>().requestId;
    const b = second.json<{ requestId: string }>().requestId;
    expect(a).not.toBe(b);
    expect(a < b).toBe(true);
  });
});
