import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  REQUIRED_ENV_VARS,
  loadConfig,
  responseValidationEnabled,
} from '../../src/config.js';
import { TEST_FCM_SERVICE_ACCOUNT, validEnv } from '../helpers/env.js';

/**
 * Boot-time config (PHASE-0-FOUNDATION.md T0.6, PLAN-BACKEND.md §13):
 * a missing variable fails loudly at boot with the variable named — not
 * at 3am when the first code path that reads it runs.
 */

function bootFailure(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig accepted an environment it should have refused');
}

describe('config — a complete environment', () => {
  it('parses into the typed shape the server boots on', () => {
    const config = loadConfig(validEnv());
    expect(config.nodeEnv).toBe('test');
    expect(config.databaseUrl).toMatch(/^postgres:\/\//);
    expect(config.s3).toEqual({
      endpoint: expect.stringMatching(/^http/),
      bucket: expect.any(String),
      accessKeyId: expect.any(String),
      secretAccessKey: expect.any(String),
      region: 'us-east-1',
    });
    expect(config.workWindow).toEqual({ start: '09:00', end: '19:00' });
    expect(config.pingRetentionDays).toBe(90);
    expect(config.logLevel).toBe('error');
  });

  it('defaults the optional knobs', () => {
    const config = loadConfig(validEnv({ NODE_ENV: undefined }));
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.s3.region).toBe('us-east-1');
  });

  it('accepts a file path for FCM_SERVICE_ACCOUNT as well as inline JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servgrid-config-'));
    const path = join(dir, 'fcm.json');
    writeFileSync(path, TEST_FCM_SERVICE_ACCOUNT);
    try {
      expect(loadConfig(validEnv({ FCM_SERVICE_ACCOUNT: path })).fcmServiceAccount).toBe(path);
      expect(loadConfig(validEnv()).fcmServiceAccount).toContain('"project_id"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('config — each required variable missing in turn fails boot', () => {
  it.each(REQUIRED_ENV_VARS)('without %s: refuses to start and names it', (name) => {
    const env = validEnv();
    delete env[name];

    const failure = bootFailure(env);
    expect(failure.variables).toEqual([name]);
    expect(failure.message).toContain(name);
    expect(failure.message).toMatch(/will not start/);
  });

  it.each(REQUIRED_ENV_VARS)('with %s empty: treated as missing', (name) => {
    const failure = bootFailure(validEnv({ [name]: '' }));
    expect(failure.variables).toEqual([name]);
    expect(failure.message).toContain(name);
  });

  it('names every offending variable in one message, not one per boot', () => {
    const env = validEnv();
    delete env.JWT_SECRET;
    delete env.S3_BUCKET;
    delete env.LOG_LEVEL;

    const failure = bootFailure(env);
    expect(failure.variables).toEqual(
      expect.arrayContaining(['JWT_SECRET', 'S3_BUCKET', 'LOG_LEVEL']),
    );
    expect(failure.variables).toHaveLength(3);
  });

  it('exports the same required list the .env.example documents', () => {
    // A variable required by the schema but absent from the list would
    // pass this suite silently — the list is what the table test walks.
    const env = validEnv();
    for (const name of REQUIRED_ENV_VARS) expect(env[name]).toBeTruthy();
  });
});

describe('config — malformed values are boot failures too', () => {
  it.each([
    ['DATABASE_URL', 'mysql://nope', /postgres:\/\//],
    ['JWT_SECRET', 'short', /32 characters/],
    ['S3_ENDPOINT', 'not-a-url', /URL/],
    ['S3_BUCKET', 'ab', /3 characters/],
    ['FCM_SERVICE_ACCOUNT', '{"project_id":"x"}', /client_email/],
    ['FCM_SERVICE_ACCOUNT', '{not json', /service-account JSON/],
    ['WORK_WINDOW_START', '9am', /HH:MM/],
    ['WORK_WINDOW_END', '25:00', /HH:MM/],
    ['PING_RETENTION_DAYS', '0', /at least 1/],
    ['PING_RETENTION_DAYS', 'ninety', /number/i],
    ['LOG_LEVEL', 'loud', /LOG_LEVEL/],
  ] as const)('%s=%s is refused', (name, value, reason) => {
    const failure = bootFailure(validEnv({ [name]: value }));
    expect(failure.variables).toEqual([name]);
    expect(failure.message).toMatch(reason);
  });

  it('refuses a work window that ends before it starts', () => {
    const failure = bootFailure(validEnv({ WORK_WINDOW_START: '19:00', WORK_WINDOW_END: '09:00' }));
    expect(failure.variables).toEqual(['WORK_WINDOW_END']);
    expect(failure.message).toMatch(/later than WORK_WINDOW_START/);
  });
});

describe('config — S3_BUCKET_EXPECTED pins the environment bucket (T0.16)', () => {
  it('is optional — unset means no pin, which is how local dev boots', () => {
    const config = loadConfig(validEnv());
    expect(config.s3.bucketExpected).toBeUndefined();
  });

  it('boots when the bucket matches the pin', () => {
    const env = validEnv({
      S3_BUCKET: 'servgrid-attachments-staging',
      S3_BUCKET_EXPECTED: 'servgrid-attachments-staging',
    });
    expect(loadConfig(env).s3).toMatchObject({
      bucket: 'servgrid-attachments-staging',
      bucketExpected: 'servgrid-attachments-staging',
    });
  });

  it('refuses to boot when S3_BUCKET points at another environment\'s bucket', () => {
    // The staging failure mode: someone copies the production .env over
    // the staging one. The pin lives in the compose override, so the
    // copy cannot carry it along.
    const failure = bootFailure(
      validEnv({
        S3_BUCKET: 'servgrid-attachments',
        S3_BUCKET_EXPECTED: 'servgrid-attachments-staging',
      }),
    );
    expect(failure.variables).toEqual(['S3_BUCKET']);
    expect(failure.message).toContain("'servgrid-attachments'");
    expect(failure.message).toContain("'servgrid-attachments-staging'");
    expect(failure.message).toMatch(/another environment's bucket|refusing to boot/);
  });
});

describe('response validation switch (§3.4)', () => {
  it('is on in development, staging and test — off only in production', () => {
    expect(responseValidationEnabled('development')).toBe(true);
    expect(responseValidationEnabled('staging')).toBe(true);
    expect(responseValidationEnabled('test')).toBe(true);
    expect(responseValidationEnabled('production')).toBe(false);
  });
});
