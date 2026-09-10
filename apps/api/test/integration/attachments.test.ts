import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { errorEnvelopeSchema, type ErrorEnvelope } from '@servgrid/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/lib/password.js';
import { signedRequest, type StorageConfig } from '../../src/lib/storage.js';
import { signAccessToken } from '../../src/plugins/auth.js';
import { buildServer } from '../../src/server.js';
import { PRESIGN_TTL_SECONDS, MAX_UPLOAD_BYTES } from '../../src/modules/attachments/service.js';
import { validEnv } from '../helpers/env.js';

/**
 * Attachments integration suite (PHASE-1-TECHNICIAN.md T1.10,
 * PLAN-BACKEND.md §9). Two real dependencies, because the points of
 * failure are exactly the ones a mock cannot have:
 *
 *  - a real Postgres (scratch database, real migrations — §14), for the
 *    attachment rows, the idempotency claims and the job joins the scope
 *    checks read;
 *  - a real S3-compatible MinIO (its own bucket, so object counts are
 *    exact), to prove the two "Done when" facts: a checksum-mismatched
 *    upload leaves NO object behind, and GET is a 302 to a presigned URL
 *    that MinIO itself honours — never a proxied body.
 */

function databaseUrl(): string {
  return process.env.DATABASE_URL ?? 'postgres://servgrid:servgrid@localhost:5432/servgrid';
}

function adminUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

const SCRATCH_DB = 'servgrid_attach_test';
const PASSWORD = 'mv-sunny-workshop-42';

/** This suite's private bucket — object-count assertions are exact because nobody else writes here. */
const TEST_BUCKET = 'servgrid-t110-attach-test';
const s3: StorageConfig = {
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  bucket: TEST_BUCKET,
  accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'servgrid',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'servgrid-minio',
  region: 'us-east-1',
};

let admin: Pool;
let db: Pool;
let app: FastifyInstance;
let config: Config;

interface Actor {
  id: string;
  role: 'owner' | 'dispatcher' | 'technician' | 'sales_rep';
  token: string;
}

const OWNER = { id: '', role: 'owner', token: '' } as Actor;
const DISPATCHER = { id: '', role: 'dispatcher', token: '' } as Actor;
const TECH_A = { id: '', role: 'technician', token: '' } as Actor;
const TECH_B = { id: '', role: 'technician', token: '' } as Actor;
const SALES_REP = { id: '', role: 'sales_rep', token: '' } as Actor;

let jobA = ''; // TECH_A's job — the every-role fixture
let jobB = ''; // TECH_B's job — the out-of-scope case

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function seedActor(role: Actor['role']): Promise<Actor> {
  const username = `t110.${role}.${randomBytes(4).toString('hex')}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO employees (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, await hashPassword(PASSWORD), `Test ${username}`, role],
  );
  const id = r.rows[0]!.id;
  return { id, role, token: signAccessToken({ sub: id, role, deviceId: 'test-device' }, config.jwtSecret) };
}

// ── MinIO helpers, via the same signer the API uses ────────────────────────

async function ensureBucket(): Promise<void> {
  const res = await signedRequest(s3, { method: 'PUT', path: `/${TEST_BUCKET}` });
  if (!res.ok && res.status !== 409) {
    throw new Error(`cannot create test bucket ${TEST_BUCKET}: HTTP ${res.status} — is MinIO up on ${s3.endpoint}?`);
  }
}

async function listKeys(): Promise<string[]> {
  const keys: string[] = [];
  let continuation: string | undefined;
  do {
    const query: Record<string, string> = { 'list-type': '2' };
    if (continuation !== undefined) query['continuation-token'] = continuation;
    const res = await signedRequest(s3, { method: 'GET', path: `/${TEST_BUCKET}/`, query });
    expect(res.ok, `ListObjectsV2 answered ${res.status}`).toBe(true);
    const xml = await res.text();
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!));
    continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (continuation !== undefined);
  return keys;
}

async function getObject(key: string): Promise<{ status: number; body: Buffer; contentType: string | null }> {
  const res = await signedRequest(s3, { method: 'GET', path: `/${TEST_BUCKET}/${key}` });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

async function emptyAndDeleteBucket(): Promise<void> {
  for (const key of await listKeys()) {
    await signedRequest(s3, { method: 'DELETE', path: `/${TEST_BUCKET}/${key}` });
  }
  await signedRequest(s3, { method: 'DELETE', path: `/${TEST_BUCKET}` });
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

interface UploadFile {
  data: Buffer;
  filename: string;
}

/** Hand-built multipart body — field order deliberately varies between calls, like real retries do. */
function multipartBody(
  fields: Record<string, string>,
  files: UploadFile | UploadFile[] | null,
): { payload: Buffer; contentType: string } {
  const list = files === null ? [] : Array.isArray(files) ? files : [files];
  const boundary = `----servgridt110${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  for (const file of list) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function upload(
  actor: Actor,
  input: { fields: Record<string, string>; file: UploadFile | null; key?: string },
) {
  const { payload, contentType } = multipartBody(input.fields, input.file);
  const headers: Record<string, string> = {
    authorization: `Bearer ${actor.token}`,
    'content-type': contentType,
  };
  if (input.key !== undefined) headers['idempotency-key'] = input.key;
  return app.inject({ method: 'POST', url: '/v1/attachments', headers, payload });
}

function get(actor: Actor, id: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/attachments/${id}`,
    headers: { authorization: `Bearer ${actor.token}` },
  });
}

function envelopeOf(status: number, body: string): ErrorEnvelope['error'] {
  expect(status).toBeGreaterThanOrEqual(400);
  const parsed = errorEnvelopeSchema.parse(JSON.parse(body)) as unknown as ErrorEnvelope;
  return parsed.error;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The fields for a plain photo upload against a job, with a consistent checksum. */
function jobPhotoFields(jobId: string, file: Buffer, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ownerType: 'job_card',
    ownerId: jobId,
    kind: 'photo',
    capturedAt: '2026-09-11T08:45:00Z',
    fileChecksum: sha256(file),
    ...extra,
  };
}

async function pngBytes(width = 32, height = 24): Promise<Buffer> {
  // A fresh colour per call: two "different" PNGs must never share a
  // checksum by accident in the row-count assertions below.
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: randomBytes(1)[0]!, g: randomBytes(1)[0]!, b: randomBytes(1)[0]! },
    },
  })
    .png()
    .toBuffer();
}

async function jpegBytes(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** A Windows PE executable — the bytes a `.exe` renamed to `.jpg` actually has. */
function exeBytes(size = 512): Buffer {
  const mzHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  return Buffer.concat([mzHeader, randomBytes(size - mzHeader.length)]);
}

beforeAll(async () => {
  await ensureBucket();

  admin = new Pool({ connectionString: adminUrlFor(databaseUrl()), max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);

  const scratchUrl = new URL(databaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  process.env.DATABASE_URL = scratchUrl.toString();
  db = new Pool({ connectionString: scratchUrl.toString(), max: 5 });
  await runMigrations({ pool: db });

  config = loadConfig(validEnv({ DATABASE_URL: scratchUrl.toString(), S3_BUCKET: TEST_BUCKET }));
  app = buildServer(config, { logger: false });
  await app.ready();

  for (const actor of [OWNER, DISPATCHER, TECH_A, TECH_B, SALES_REP]) {
    const seeded = await seedActor(actor.role);
    actor.id = seeded.id;
    actor.token = seeded.token;
  }

  const customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO customers (name, phone) VALUES ('T110 Customer', '9811000000') RETURNING id`,
    )
  ).rows[0]!.id;
  const serviceId = (
    await db.query<{ id: string }>(
      `INSERT INTO services (code, name) VALUES ('T110-INT', 'T1.10 integration service') RETURNING id`,
    )
  ).rows[0]!.id;

  async function seedJob(number: string, assignedTo: string): Promise<string> {
    return (
      await db.query<{ id: string }>(
        `INSERT INTO job_cards (job_number, customer_id, service_id, title, status, assigned_to, assigned_at)
         VALUES ($1, $2, $3, 'T1.10 job', 'assigned', $4, now()) RETURNING id`,
        [number, customerId, serviceId, assignedTo],
      )
    ).rows[0]!.id;
  }
  jobA = await seedJob(`JC-T110-${randomBytes(3).toString('hex')}`, TECH_A.id);
  jobB = await seedJob(`JC-T110-${randomBytes(3).toString('hex')}`, TECH_B.id);

  // A completion on TECH_A's job — job_completions is keyed by job_card_id.
  await db.query(
    `INSERT INTO job_completions (job_card_id, completed_by, completed_at, work_summary, cost, collection_mode)
     VALUES ($1, $2, now() - interval '1 hour', 'Replaced capacitor, tested output.', 250.00, 'cash')`,
    [jobA, TECH_A.id],
  );
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  await closePool();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  }
  await emptyAndDeleteBucket();
});

// ── the §9 test list ────────────────────────────────────────────────────────

describe('T1.10 — POST /v1/attachments', () => {
  it('a 20 MB upload is 413 before any bytes are written', async () => {
    const big = randomBytes(20 * 1024 * 1024);
    const keysBefore = await listKeys();

    const res = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, big),
      file: { data: big, filename: 'big.jpg' },
      key: randomUUID(),
    });

    expect(res.statusCode).toBe(413);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('PAYLOAD_TOO_LARGE');

    // Before the bytes are written: the bucket is untouched and no
    // attachment row exists — the refusal happened in the parser, before
    // the handler, before the idempotency claim.
    expect(await listKeys()).toEqual(keysBefore);
    const rows = await db.query(`SELECT 1 FROM attachments WHERE checksum_sha256 = $1`, [sha256(big)]);
    expect(rows.rows).toHaveLength(0);
  }, 30_000);

  it('a file just over the cap is 413 from the handler (under the body limit, over the size cap)', async () => {
    const overCap = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(MAX_UPLOAD_BYTES - 3)]);
    const keysBefore = await listKeys();

    const res = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, overCap),
      file: { data: overCap, filename: 'cap.jpg' },
    });

    expect(res.statusCode).toBe(413);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('PAYLOAD_TOO_LARGE');
    expect(await listKeys()).toEqual(keysBefore);
  }, 30_000);

  it('a .exe renamed .jpg is rejected on sniffed MIME, not on extension', async () => {
    const exe = exeBytes();
    const keysBefore = await listKeys();

    const res = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, exe),
      file: { data: exe, filename: 'photo.jpg' }, // the lie is in the name
    });

    expect(res.statusCode).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');
    expect(await listKeys()).toEqual(keysBefore);
  });

  it('a corrupted upload (checksum mismatch) is rejected and leaves no object in MinIO', async () => {
    const bytes = await jpegBytes(64, 64);
    const keysBefore = await listKeys();
    const key = randomUUID();
    // The client hashed the bytes it MEANT to send; the link truncated them.
    const claimed = sha256(randomBytes(bytes.length));

    const res = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, bytes, { fileChecksum: claimed }),
      file: { data: bytes, filename: 'truncated.jpg' },
      key,
    });

    expect(res.statusCode).toBe(422);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('VALIDATION_FAILED');

    // Done when: the mismatch is proven to leave no object — byte count
    // and key list both unchanged, and no row carries either checksum.
    expect(await listKeys()).toEqual(keysBefore);
    expect((await db.query(`SELECT 1 FROM attachments WHERE checksum_sha256 = ANY($1)`, [[claimed, sha256(bytes)]])).rows)
      .toHaveLength(0);
    // And the claim was released, so a corrected retry with the same key executes.
    const keyRow = await db.query(`SELECT 1 FROM idempotency_keys WHERE key = $1`, [key]);
    expect(keyRow.rows).toHaveLength(0);
  });

  it('a 4000px JPEG comes back at 1600px long edge, and the presigned fetch round-trips those bytes', async () => {
    const source = await jpegBytes(4000, 3000);
    const keysBefore = await listKeys();
    const key = randomUUID();
    const res = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, source, { capturedAt: '2026-09-11T07:10:00+05:30', caption: 'Before — burnt board' }),
      file: { data: source, filename: 'before.jpg' },
      key,
    });

    expect(res.statusCode).toBe(200);
    const created = res.json<{
      id: string;
      ownerType: string;
      ownerId: string;
      kind: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      checksumSha256: string;
      caption: string | null;
      uploadedBy: string;
      capturedAt: string | null;
      uploadedAt: string;
    }>();

    expect(created.ownerType).toBe('job_card');
    expect(created.ownerId).toBe(jobA);
    expect(created.kind).toBe('photo');
    expect(created.mimeType).toBe('image/jpeg');
    expect(created.width).toBe(1600); // 4000×3000 → long edge 1600
    expect(created.height).toBe(1200); // aspect preserved
    expect(created.sizeBytes).toBeLessThan(source.length); // the re-encode bought real bytes back
    expect(created.checksumSha256).not.toBe(sha256(source)); // over the STORED bytes (§3.6), not the upload's
    expect(created.caption).toBe('Before — burnt board');
    expect(created.uploadedBy).toBe(TECH_A.id);
    expect(created.capturedAt).toBe('2026-09-11T01:40:00.000Z'); // the device clock, normalised to UTC
    expect(created.uploadedAt).toBeTruthy();
    expect(created.storageKey).toMatch(/^job_card\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);

    // Exactly one object, and its bytes hash to what the row claims.
    const keys = await listKeys();
    expect(keys.length).toBe(keysBefore.length + 1);
    const object = await getObject(created.storageKey);
    expect(object.status).toBe(200);
    expect(sha256(object.body)).toBe(created.checksumSha256);
    const meta = await sharp(object.body).metadata();
    expect(meta.width).toBe(1600);
    expect(meta.height).toBe(1200);
  });

  it('a PNG is stored byte-for-byte with real dimensions; a PDF stores without them', async () => {
    const png = await pngBytes();
    const res = await upload(OWNER, {
      fields: jobPhotoFields(jobA, png, { kind: 'signature' }),
      file: { data: png, filename: 'docket.png' },
    });
    expect(res.statusCode).toBe(200);
    const created = res.json<{ mimeType: string; width: number; height: number; checksumSha256: string; kind: string }>();
    expect(created.mimeType).toBe('image/png');
    expect(created.kind).toBe('signature'); // §3.6: a photo of the signed paper docket
    expect(created.width).toBe(32);
    expect(created.height).toBe(24);
    expect(created.checksumSha256).toBe(sha256(png)); // passthrough: stored bytes are the sent bytes

    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'ascii'), randomBytes(256)]);
    const pdfRes = await upload(OWNER, {
      fields: { ...jobPhotoFields(jobA, pdf), kind: 'document' },
      file: { data: pdf, filename: 'docket.pdf' },
    });
    expect(pdfRes.statusCode).toBe(200);
    const pdfRow = pdfRes.json<{ mimeType: string; width: number | null; height: number | null }>();
    expect(pdfRow.mimeType).toBe('application/pdf');
    expect(pdfRow.width).toBeNull();
    expect(pdfRow.height).toBeNull();
  });

  it('a technician cannot upload to another technician’s job, a sales_rep to nobody’s', async () => {
    const bytes = await pngBytes();
    const keysBefore = await listKeys();

    const other = await upload(TECH_B, {
      fields: jobPhotoFields(jobA, bytes),
      file: { data: bytes, filename: 'not-mine.png' },
    });
    expect(other.statusCode).toBe(403);
    expect(envelopeOf(other.statusCode, other.body).code).toBe('OUT_OF_SCOPE');

    const rep = await upload(SALES_REP, {
      fields: jobPhotoFields(jobA, bytes),
      file: { data: bytes, filename: 'rep.png' },
    });
    expect(rep.statusCode).toBe(403);
    expect(envelopeOf(rep.statusCode, rep.body).code).toBe('FORBIDDEN');

    // The dispatcher assembling the card CAN attach the photo the
    // customer sent (§3.6's reason job_card exists at all).
    const dispatcher = await upload(DISPATCHER, {
      fields: jobPhotoFields(jobB, bytes),
      file: { data: bytes, filename: 'customer-sent.png' },
    });
    expect(dispatcher.statusCode).toBe(200);

    // MinIO lists in uuid order, not insertion order — compare as sets.
    expect((await listKeys()).sort()).toEqual([...keysBefore, (dispatcher.json<{ storageKey: string }>()).storageKey].sort());
  });

  it('a photo can hang off a job_completion and reaches its technician through the completion', async () => {
    const bytes = await pngBytes();

    const mine = await upload(TECH_A, {
      fields: { ...jobPhotoFields(jobA, bytes), ownerType: 'job_completion' },
      file: { data: bytes, filename: 'after.png' },
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json<{ storageKey: string }>()).storageKey).toMatch(/^job_completion\//);

    const notMine = await get(TECH_B, (mine.json<{ id: string }>()).id);
    expect(notMine.statusCode).toBe(403);
    expect(envelopeOf(notMine.statusCode, notMine.body).code).toBe('OUT_OF_SCOPE');
  });

  it('rejects unknown content and a second file with a clear validation error', async () => {
    const keysBefore = await listKeys();
    const text = randomBytes(64); // no magic at all
    const bad = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, text),
      file: { data: text, filename: 'blob.bin' },
    });
    expect(bad.statusCode).toBe(422);
    expect(envelopeOf(bad.statusCode, bad.body).code).toBe('VALIDATION_FAILED');

    const png = await pngBytes();
    const twoFiles = multipartBody(jobPhotoFields(jobA, png), [
      { data: png, filename: 'a.png' },
      { data: png, filename: 'b.png' },
    ]);    const both = await app.inject({
      method: 'POST',
      url: '/v1/attachments',
      headers: { authorization: `Bearer ${TECH_A.token}`, 'content-type': twoFiles.contentType },
      payload: twoFiles.payload,
    });
    expect(both.statusCode).toBe(422);

    expect(await listKeys()).toEqual(keysBefore);
  });
});

describe('T1.10 — idempotent upload (§9 request_hash)', () => {
  it('retrying with the same key and the same file replays: one row, one object, byte-identical response', async () => {
    const bytes = await pngBytes();
    const key = randomUUID();

    const first = await upload(TECH_A, { fields: jobPhotoFields(jobA, bytes), file: { data: bytes, filename: 'a.png' }, key });
    expect(first.statusCode).toBe(200);
    const keysAfterFirst = await listKeys();

    // Different field ORDER and re-serialized capturedAt — a real retry does this.
    const second = await upload(TECH_A, {
      fields: {
        fileChecksum: sha256(bytes),
        capturedAt: '2026-09-11T08:45:00.000+00:00',
        kind: 'photo',
        ownerId: jobA,
        ownerType: 'job_card',
      },
      file: { data: bytes, filename: 'a-retry.png' },
      key,
    });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body); // byte-identical replay — the handler did not run again
    expect(await listKeys()).toEqual(keysAfterFirst); // no second object
    const rows = await db.query(`SELECT count(*)::int AS n FROM attachments WHERE owner_id = $1`, [jobA]);
    expect(rows.rows[0]?.n).toBeGreaterThan(0);
    const exact = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attachments WHERE checksum_sha256 = $1 AND uploaded_by = $2`,
      [sha256(bytes), TECH_A.id],
    );
    expect(exact.rows[0]!.n).toBe(1); // exactly one row for this photo
  });

  it('the same key with a different file is 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const a = await pngBytes();
    const b = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), randomBytes(64)]);
    const key = randomUUID();

    const first = await upload(TECH_A, { fields: jobPhotoFields(jobA, a), file: { data: a, filename: 'a.png' }, key });
    expect(first.statusCode).toBe(200);

    const second = await upload(TECH_A, { fields: jobPhotoFields(jobA, b), file: { data: b, filename: 'b.png' }, key });
    expect(second.statusCode).toBe(422);
    expect(envelopeOf(second.statusCode, second.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('T1.10 — GET /v1/attachments/:id', () => {
  let attachmentId = '';

  beforeAll(async () => {
    const bytes = await pngBytes();
    const res = await upload(TECH_A, {
      fields: jobPhotoFields(jobA, bytes),
      file: { data: bytes, filename: 'fixture.png' },
      key: randomUUID(),
    });
    expect(res.statusCode).toBe(200);
    attachmentId = res.json<{ id: string }>().id;
  });

  it('is a 302 to a five-minute presigned URL with no body — never a proxy', async () => {
    const res = await get(TECH_A, attachmentId);

    // Done when: the status code and the absence of a body are asserted.
    expect(res.statusCode).toBe(302);
    expect(res.body).toBe('');
    const location = res.headers['location'];
    expect(typeof location).toBe('string');
    const url = new URL(location as string);
    expect(url.host).toBe(new URL(s3.endpoint).host); // points at MinIO, not back at the API
    expect(url.pathname).toContain(encodeURIComponent(TEST_BUCKET));
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_TTL_SECONDS));
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('the presigned URL actually serves the bytes from MinIO', async () => {
    const res = await get(OWNER, attachmentId);
    expect(res.statusCode).toBe(302);
    const object = await fetch(res.headers['location'] as string);
    expect(object.status).toBe(200);
    const bytes = Buffer.from(await object.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    const row = await db.query<{ checksum_sha256: string }>(
      'SELECT checksum_sha256 FROM attachments WHERE id = $1',
      [attachmentId],
    );
    expect(sha256(bytes)).toBe(row.rows[0]!.checksum_sha256);
  });

  it('a technician for another technician’s job’s attachment is 403', async () => {
    const res = await get(TECH_B, attachmentId);
    expect(res.statusCode).toBe(403);
    expect(envelopeOf(res.statusCode, res.body).code).toBe('OUT_OF_SCOPE');
  });

  it('the matrix lands role by role: rep is FORBIDDEN, anon UNAUTHENTICATED, missing is 404', async () => {
    const rep = await get(SALES_REP, attachmentId);
    expect(rep.statusCode).toBe(403);
    expect(envelopeOf(rep.statusCode, rep.body).code).toBe('FORBIDDEN');

    const anon = await app.inject({ method: 'GET', url: `/v1/attachments/${attachmentId}` });
    expect(anon.statusCode).toBe(401);
    expect(envelopeOf(anon.statusCode, anon.body).code).toBe('UNAUTHENTICATED');

    const missing = await get(OWNER, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(envelopeOf(missing.statusCode, missing.body).code).toBe('NOT_FOUND');
  });
});
