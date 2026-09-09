import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { z, type ZodTypeAny } from 'zod';
import { loadConfig, loadDotEnv, type Config } from './config.js';
import { closePool, getPool, observeSlowQueries } from './db/pool.js';
import { initFcm } from './lib/fcm.js';
import { probeStorage } from './lib/storage.js';
import { errorsPlugin } from './plugins/errors.js';
import { genRequestId, requestContextPlugin } from './plugins/request-context.js';

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

  app.register(requestContextPlugin);
  app.register(errorsPlugin, { nodeEnv: config.nodeEnv });

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

/** Boot: FCM, listen, and a SIGTERM/SIGINT path that drains before exiting. */
export async function startServer(config: Config): Promise<FastifyInstance> {
  initFcm(config.fcmServiceAccount);
  const app = buildServer(config);

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
