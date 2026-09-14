import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { loadConfig, loadDotEnv, type Config } from './config.js';
import { closePool, getPool, observeSlowQueries } from './db/pool.js';
import { initFcm } from './lib/fcm.js';
import { probeStorage } from './lib/storage.js';
import cors from '@fastify/cors';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';
import { idempotencyPlugin } from './plugins/idempotency.js';
import { rbacPlugin } from './plugins/rbac.js';
import { genRequestId, requestContextPlugin } from './plugins/request-context.js';
import { startWindowOpenReleaseScheduler } from './jobs/release-held-notifications.js';
import { authRoutes } from './modules/auth/routes.js';
import { attachmentsRoutes } from './modules/attachments/routes.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { cashRoutes } from './modules/cash/routes.js';
import { companiesRoutes } from './modules/companies/routes.js';
import { consentRoutes } from './modules/consents/routes.js';
import { customersRoutes } from './modules/customers/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { devicesRoutes } from './modules/devices/routes.js';
import { employeesRoutes } from './modules/employees/routes.js';
import { flagsRoutes } from './modules/flags/routes.js';
import { jobsRoutes } from './modules/jobs/routes.js';
import { locationRoutes } from './modules/location/routes.js';
import { paymentsRoutes } from './modules/payments/routes.js';
import { salesRoutes } from './modules/sales/routes.js';
import { syncRoutes } from './modules/sync/routes.js';

/**
 * The Fastify instance (PLAN-BACKEND.md §2 server.ts): plugin
 * registration, `/healthz`, graceful shutdown. `buildServer` is pure over
 * its config so the integration suites can stand up several instances —
 * one against the live stack, one against a dead storage port — in the
 * same process; `startServer` is the boot path.
 */

/** The one thing `/healthz` needs from the database. */
export interface DbProbe {
  query(text: string): Promise<unknown>;
}

export interface ServerOptions {
  /** `false` silences logs in tests; defaults to pino at `config.logLevel`. */
  logger?: boolean;
  /**
   * Database handle for `/healthz`. Defaults to the process pool, which
   * is a singleton keyed on the first `DATABASE_URL` it sees — a test
   * that needs a second database passes its own `Pool`.
   */
  db?: DbProbe;
}

const HEALTH_TIMEOUT_MS = 2_000;

export const healthResponseSchema = z
  .object({
    status: z.enum(['ok', 'unhealthy']),
    checks: z.object({ db: z.boolean(), storage: z.boolean() }).strict(),
  })
  .strict();

async function probeDb(db: DbProbe): Promise<{ ok: boolean; detail?: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no reply in ${HEALTH_TIMEOUT_MS}ms`)), HEALTH_TIMEOUT_MS);
      }),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export function buildServer(config: Config, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    genReqId: genRequestId,
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // Never trust an inbound request id: the ULID is ours so a log line
    // can be traced to exactly one request.
    requestIdHeader: false,
    trustProxy: true,
  });

  // CORS before anything that answers a request. The owner's desktop
  // build is a browser, so its preflight has to be answered or the
  // login it is a Phase 0 exit criterion for never leaves the tab.
  //
  // `credentials` is on because the refresh flow may move to a cookie,
  // and an allowlist — never `*` — is what makes that safe: a wildcard
  // with credentials is the one combination browsers refuse outright.
  // With no origins configured the plugin still registers and simply
  // matches nothing, which is the correct answer for a handset-only
  // deployment.
  app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'If-Match',
      'X-Source',
      'X-Device-Id',
    ],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  });

  app.register(requestContextPlugin);
  app.register(errorsPlugin, { nodeEnv: config.nodeEnv });
  app.register(authPlugin, { jwtSecret: config.jwtSecret });
  app.register(rbacPlugin);
  app.register(idempotencyPlugin);
  app.register(authRoutes, { jwtSecret: config.jwtSecret });
  app.register(attachmentsRoutes, { s3: config.s3 });
  app.register(employeesRoutes);
  app.register(flagsRoutes);
  app.register(consentRoutes);
  app.register(jobsRoutes, { workWindow: config.workWindow });
  app.register(customersRoutes);
  app.register(companiesRoutes);
  app.register(catalogRoutes);
  app.register(devicesRoutes);
  app.register(locationRoutes, { workWindow: config.workWindow });
  app.register(syncRoutes);
  app.register(cashRoutes);
  app.register(salesRoutes);
  app.register(paymentsRoutes);
  app.register(dashboardRoutes);

  const ownsPool = options.db === undefined;
  const db: DbProbe = options.db ?? getPool({ connectionString: config.databaseUrl });
  if (ownsPool) {
    observeSlowQueries(({ text, durationMs }) =>
      app.log.warn({ durationMs, sql: text.slice(0, 200) }, 'slow query'),
    );
    app.addHook('onClose', async () => {
      observeSlowQueries(null);
      await closePool();
    });
  }

  // DB *and* storage (§13): an attachment upload failing at 09:00 behind a
  // green health check is a bad morning. 503 so the uptime checker pages.
  app.get('/healthz', { config: { responseSchema: healthResponseSchema as ZodTypeAny } }, async (request, reply) => {
    const [dbResult, storageResult] = await Promise.all([
      probeDb(db),
      probeStorage(config.s3, HEALTH_TIMEOUT_MS),
    ]);
    const ok = dbResult.ok && storageResult.ok;
    if (!ok) {
      request.log.warn(
        { db: dbResult, storage: storageResult },
        'healthz: dependency down',
      );
    }
    reply.status(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'unhealthy',
      checks: { db: dbResult.ok, storage: storageResult.ok },
    };
  });

  return app;
}

/** Boot: FCM, the window-open release scheduler, listen, and a SIGTERM/SIGINT path that drains before exiting. */
export async function startServer(config: Config): Promise<FastifyInstance> {
  initFcm(config.fcmServiceAccount);
  const app = buildServer(config);

  // §12.1 with §15 item 6 (decision B1): the send path is event-driven,
  // but the morning batch needs something to fire when the window opens.
  // Stopped with the app so a shutdown is never held open by a push.
  const releaseScheduler = startWindowOpenReleaseScheduler({
    workWindow: config.workWindow,
    log: app.log,
  });
  app.addHook('onClose', async () => {
    releaseScheduler.stop();
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      app.log.error('shutdown deadline passed; exiting');
      process.exit(1);
    }, 10_000);
    deadline.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
  return app;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    // Config failures throw here, before anything listens — the whole point of config.ts.
    loadDotEnv();
    const config = loadConfig();
    startServer(config).catch((error: unknown) => {
      console.error('api: FAILED —', error instanceof Error ? error.message : error);
      process.exit(1);
    });
  } catch (error) {
    console.error('api: FAILED —', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
