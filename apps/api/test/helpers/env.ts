/**
 * A complete, valid environment for `loadConfig`. Infrastructure
 * coordinates come from the real environment when present (CI, a local
 * .env with a moved port) and fall back to the compose defaults.
 */
export const TEST_FCM_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'servgrid-test',
  client_email: 'test@servgrid-test.iam.gserviceaccount.com',
  private_key: 'placeholder',
});

export function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid',
    JWT_SECRET: 'test-only-signing-key-with-at-least-32-characters',
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    S3_BUCKET: process.env.S3_BUCKET ?? 'servgrid-attachments',
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'servgrid',
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'servgrid-minio',
    FCM_SERVICE_ACCOUNT: TEST_FCM_SERVICE_ACCOUNT,
    WORK_WINDOW_START: '09:00',
    WORK_WINDOW_END: '19:00',
    PING_RETENTION_DAYS: '90',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

/** Crockford base32, 26 chars — what `ulid()` produces. */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
