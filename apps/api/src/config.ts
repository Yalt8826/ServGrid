import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseServiceAccount } from './lib/fcm.js';

/**
 * Environment config (PLAN-BACKEND.md §13): zod-parsed, fails at boot,
 * never at 3am. `loadConfig` is pure over the env object it is handed so
 * the boot-failure suite can drop one variable at a time without touching
 * `process.env`; `getConfig` is the memoised process-wide instance.
 *
 * A failure names every offending variable in one message. Fixing them
 * one boot at a time is the 3am experience this file exists to prevent.
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Boot refuses to proceed without every one of these. */
export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'JWT_SECRET',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'FCM_SERVICE_ACCOUNT',
  'WORK_WINDOW_START',
  'WORK_WINDOW_END',
  'PING_RETENTION_DAYS',
  'LOG_LEVEL',
] as const;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `WEB_ORIGINS` as a list. Development gets localhost by default so
 * `expo start --web` talks to a locally-running API without ceremony;
 * every other environment must name its origins explicitly, because a
 * default that silently allows an origin is how one leaks into
 * production.
 */
export function parseOrigins(raw: string | undefined, nodeEnv: NodeEnv): string[] {
  const listed = (raw ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
  if (listed.length > 0) return listed;
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    // Metro's web port, and the port it falls back to when 8081 is taken.
    return ['http://localhost:8081', 'http://localhost:8082', 'http://localhost:19006'];
  }
  return [];
}

const required = (name: string) => z.string({ required_error: `${name} is not set` }).min(1, `${name} is empty`);

const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),

    DATABASE_URL: required('DATABASE_URL').refine(
      (v) => /^postgres(ql)?:\/\//.test(v),
      'DATABASE_URL must be a postgres:// URL',
    ),
    // HS256 (§4): anything shorter than 32 bytes is a brute-forceable key.
    JWT_SECRET: required('JWT_SECRET').min(32, 'JWT_SECRET must be at least 32 characters'),

    S3_ENDPOINT: required('S3_ENDPOINT').url('S3_ENDPOINT must be an http(s) URL'),
    S3_BUCKET: required('S3_BUCKET').min(3, 'S3_BUCKET must be at least 3 characters'),
    // Environment pin (T0.16): the compose override on the VPS hardcodes
    // the bucket this deployment may write to. A hand-edited .env that
    // points staging at the production bucket therefore fails at boot —
    // loudly — instead of silently writing one environment's attachments
    // into the other's bucket.
    S3_BUCKET_EXPECTED: z.string().min(3, 'S3_BUCKET_EXPECTED must be at least 3 characters').optional(),
    S3_ACCESS_KEY_ID: required('S3_ACCESS_KEY_ID'),
    S3_SECRET_ACCESS_KEY: required('S3_SECRET_ACCESS_KEY'),
    S3_REGION: z.string().min(1).default('us-east-1'),

    // Inline JSON or a path to it; lib/fcm.ts owns the field checks.
    FCM_SERVICE_ACCOUNT: required('FCM_SERVICE_ACCOUNT').superRefine((raw, ctx) => {
      try {
        parseServiceAccount(raw);
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'FCM_SERVICE_ACCOUNT is unreadable',
        });
      }
    }),

    WORK_WINDOW_START: required('WORK_WINDOW_START').regex(HH_MM, 'WORK_WINDOW_START must be HH:MM (24h)'),
    WORK_WINDOW_END: required('WORK_WINDOW_END').regex(HH_MM, 'WORK_WINDOW_END must be HH:MM (24h)'),
    PING_RETENTION_DAYS: required('PING_RETENTION_DAYS').pipe(
      z.coerce.number().int('PING_RETENTION_DAYS must be a whole number of days').positive(
        'PING_RETENTION_DAYS must be at least 1',
      ),
    ),
    LOG_LEVEL: z.enum(LOG_LEVELS, {
      required_error: 'LOG_LEVEL is not set',
      invalid_type_error: `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`,
    }),

    /**
     * Browser origins allowed to call this API, comma-separated.
     *
     * The owner's desktop build is a browser (PLAN.md §1), and "an owner
     * account logs in on desktop web" is a Phase 0 exit criterion — which
     * a browser refuses to attempt without CORS. Optional and empty by
     * default: native clients are not browsers and send no Origin, so a
     * deployment that serves the API only to handsets adds nothing.
     *
     * Never `*`. Credentials ride these requests, and a wildcard with
     * credentials is the one combination browsers refuse outright.
     */
    WEB_ORIGINS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Only meaningful once both halves parsed; a malformed half is already reported.
    if (
      HH_MM.test(env.WORK_WINDOW_START) &&
      HH_MM.test(env.WORK_WINDOW_END) &&
      env.WORK_WINDOW_START >= env.WORK_WINDOW_END
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WORK_WINDOW_END'],
        message: 'WORK_WINDOW_END must be later than WORK_WINDOW_START',
      });
    }
    if (env.S3_BUCKET_EXPECTED !== undefined && env.S3_BUCKET !== env.S3_BUCKET_EXPECTED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['S3_BUCKET'],
        message:
          `S3_BUCKET is '${env.S3_BUCKET}' but this environment may only use ` +
          `'${env.S3_BUCKET_EXPECTED}' — refusing to boot rather than write ` +
          `attachments into another environment's bucket`,
      });
    }
  });

export interface Config {
  nodeEnv: NodeEnv;
  /** Browser origins allowed to call this API. Empty means none. */
  webOrigins: string[];
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  s3: {
    endpoint: string;
    bucket: string;
    /** Set per environment on the VPS — the only bucket this deployment may use. */
    bucketExpected?: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  };
  /** Raw value — `initFcm()` parses it; kept raw so the secret is not duplicated in memory. */
  fcmServiceAccount: string;
  workWindow: { start: string; end: string };
  pingRetentionDays: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(
    readonly variables: readonly string[],
    detail: string,
  ) {
    super(`Invalid environment — the API will not start.\n${detail}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const variable = String(issue.path[0] ?? '?');
      // zod's own wording for a missing key is "Required"; the variable name is the message.
      const message = issue.message === 'Required' ? `${variable} is not set` : issue.message;
      return `  ${variable}: ${message}`;
    });
    const variables = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '?')))];
    throw new ConfigError(variables, lines.join('\n'));
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    s3: {
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      bucketExpected: e.S3_BUCKET_EXPECTED,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      region: e.S3_REGION,
    },
    fcmServiceAccount: e.FCM_SERVICE_ACCOUNT,
    workWindow: { start: e.WORK_WINDOW_START, end: e.WORK_WINDOW_END },
    pingRetentionDays: e.PING_RETENTION_DAYS,
    logLevel: e.LOG_LEVEL,
    webOrigins: parseOrigins(e.WEB_ORIGINS, e.NODE_ENV),
  };
}

let memo: Config | undefined;

/** The process-wide config, parsed once from `process.env`. */
export function getConfig(): Config {
  memo ??= loadConfig();
  return memo;
}

/**
 * Response validation (§3.4) runs everywhere except production: dev and
 * staging catch a completion field reaching a dispatcher payload before a
 * user does, and the integration suites assert on it.
 */
export function responseValidationEnabled(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== 'production';
}

/**
 * Load the repo-root `.env` (the one compose reads) into `process.env` if
 * it exists. Existing variables win, matching Node's own semantics, so a
 * CI export is never overridden by a stale local file.
 */
export function loadDotEnv(): boolean {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
