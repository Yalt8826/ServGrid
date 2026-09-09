import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../../src/config.js';
import { probeStorage } from '../../src/lib/storage.js';
import { buildServer } from '../../src/server.js';
import { validEnv } from '../helpers/env.js';

/**
 * `/healthz` (PHASE-0-FOUNDATION.md T0.6, PLAN-BACKEND.md §13): green
 * with Postgres and MinIO both up, red when either is down — storage
 * matters because an attachment upload failing at 09:00 behind a green
 * check is a bad morning.
 *
 * The outage cases point the server at ports nothing listens on rather
 * than stopping the shared compose containers: the same signal the
 * uptime checker would see, with no side effects on the suites that
 * follow. Each instance gets its own `Pool` because the process pool is
 * a singleton keyed on the first `DATABASE_URL` it sees.
 */

// Nothing listens here; connection refused is immediate.
const DEAD_DB_URL = 'postgres://servgrid:servgrid@127.0.0.1:59998/servgrid';
const DEAD_S3_ENDPOINT = 'http://127.0.0.1:59999';

const live: Config = loadConfig(validEnv());

interface Instance {
  app: FastifyInstance;
  pool: Pool;
}

async function instance(config: Config): Promise<Instance> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 1_500 });
  // A dead database must not take the whole suite down with an unhandled
  // pool error; the probe reports it as a check result instead.
  pool.on('error', () => {});
  const app = buildServer(config, { logger: false, db: pool });
  await app.ready();
  return { app, pool };
}

const instances: Instance[] = [];

async function healthz(config: Config) {
  const inst = await instance(config);
  instances.push(inst);
  const res = await inst.app.inject({ method: 'GET', url: '/healthz' });
  return { status: res.statusCode, body: res.json<{ status: string; checks: { db: boolean; storage: boolean } }>() };
}

beforeAll(async () => {
  const storage = await probeStorage(live.s3);
  if (!storage.ok) {
    throw new Error(
      `MinIO is not reachable at ${live.s3.endpoint} (${storage.detail}). ` +
        'Run `pnpm compose:up` — the health suite needs both db and minio.',
    );
  }
});

afterAll(async () => {
  for (const { app, pool } of instances) {
    await app.close();
    await pool.end();
  }
});

describe('/healthz', () => {
  it('is green with Postgres and MinIO both up', async () => {
    const { status, body } = await healthz(live);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', checks: { db: true, storage: true } });
  });

  it('goes red for a storage outage, with the database still reported healthy', async () => {
    const { status, body } = await healthz({
      ...live,
      s3: { ...live.s3, endpoint: DEAD_S3_ENDPOINT },
    });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy', checks: { db: true, storage: false } });
  });

  it('goes red when storage is reachable but the credentials are wrong', async () => {
    // Reachability alone would pass this; an upload would not.
    const { status, body } = await healthz({
      ...live,
      s3: { ...live.s3, secretAccessKey: 'not-the-secret' },
    });
    expect(status).toBe(503);
    expect(body.checks).toEqual({ db: true, storage: false });
  });

  it('goes red for a database outage, with storage still reported healthy', async () => {
    const { status, body } = await healthz({ ...live, databaseUrl: DEAD_DB_URL });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'unhealthy', checks: { db: false, storage: true } });
  });
});
