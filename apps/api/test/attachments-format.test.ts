import { describe, expect, it } from 'vitest';
import { presignedGetUrl, type StorageConfig } from '../src/lib/storage.js';
import {
  buildStorageKey,
  sniffMime,
  uploadHashPayload,
  JPEG_MAX_EDGE,
  MAX_UPLOAD_BYTES,
  PRESIGN_TTL_SECONDS,
} from '../src/modules/attachments/service.js';

/**
 * The pure halves of the attachments module (PLAN-BACKEND.md §9): MIME
 * sniffing by magic bytes, the §9 object-key shape, the §9 multipart
 * request_hash input, and the structure of the presigned URL the GET
 * route 302s to. No I/O — the pipeline and the endpoints they feed are
 * exercised against real MinIO in test/integration/attachments.test.ts.
 */

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_MAGIC = [...Buffer.from('%PDF-1.7\n', 'ascii')];
/** A Windows PE — the `.exe` renamed `.jpg` case. */
const EXE_MAGIC = [0x4d, 0x5a, 0x90, 0x00];

function bytesOf(...prefix: number[]): Uint8Array {
  return new Uint8Array(prefix);
}

describe('sniffMime — the server trusts bytes, never names (§9)', () => {
  it('recognises JPEG, PNG, WebP and PDF by magic', () => {
    expect(sniffMime(bytesOf(...JPEG_MAGIC))).toBe('image/jpeg');
    expect(sniffMime(bytesOf(...PNG_MAGIC))).toBe('image/png');
    expect(sniffMime(bytesOf(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
    expect(sniffMime(bytesOf(...PDF_MAGIC))).toBe('application/pdf');
  });

  it('refuses a PE binary however it is named', () => {
    expect(sniffMime(bytesOf(...EXE_MAGIC))).toBeNull();
  });

  it('refuses truncations, text and the empty body', () => {
    expect(sniffMime(bytesOf(0xff, 0xd8))).toBeNull(); // JPEG header cut mid-magic
    expect(sniffMime(new TextEncoder().encode('hello world'))).toBeNull();
    expect(sniffMime(new Uint8Array(0))).toBeNull();
  });
});

describe('buildStorageKey — {ownerType}/{yyyy}/{mm}/{uuid}.{ext} (§9)', () => {
  it('partitions by owner type, the UTC month of arrival, and a fresh uuid', () => {
    const key = buildStorageKey('job_card', 'image/jpeg', 'abc-123', new Date('2026-09-11T10:30:00Z'));
    expect(key).toBe('job_card/2026/09/abc-123.jpg');
  });

  it('zero-pads the month and picks the extension from the sniffed type', () => {
    expect(buildStorageKey('payment', 'image/png', 'x', new Date('2026-01-05T00:00:00Z'))).toBe('payment/2026/01/x.png');
    expect(buildStorageKey('job_completion', 'application/pdf', 'x', new Date('2026-12-31T23:59:59Z'))).toBe('job_completion/2026/12/x.pdf');
    expect(buildStorageKey('customer', 'image/webp', 'x', new Date('2026-03-01T12:00:00Z'))).toBe('customer/2026/03/x.webp');
  });
});

describe('uploadHashPayload — the multipart request_hash input (§9)', () => {
  const checksum = 'a'.repeat(64);

  it('is the plain concatenation the spec names', () => {
    expect(uploadHashPayload({ fileChecksum: checksum, ownerType: 'job_card', ownerId: 'o1', kind: 'photo' })).toBe(
      `${checksum}job_cardo1photo`,
    );
  });

  it('moves when any field moves — a different file or owner under the same key must not collide', () => {
    const base = { fileChecksum: checksum, ownerType: 'job_card' as const, ownerId: 'o1', kind: 'photo' as const };
    expect(uploadHashPayload(base)).not.toBe(uploadHashPayload({ ...base, fileChecksum: 'b'.repeat(64) }));
    expect(uploadHashPayload(base)).not.toBe(uploadHashPayload({ ...base, ownerId: 'o2' }));
    expect(uploadHashPayload(base)).not.toBe(uploadHashPayload({ ...base, kind: 'signature' }));
  });

  it('ignores capturedAt — a resent upload may carry re-serialized timestamps and still replay', () => {
    // The hash input type has no capturedAt field at all; this pins the
    // absence by construction, matching §9's four-field list.
    const payload = uploadHashPayload({ fileChecksum: checksum, ownerType: 'job_card', ownerId: 'o1', kind: 'photo' });
    expect(payload).not.toContain('T00');
  });
});

describe('presignedGetUrl — query-string SigV4 the GET route 302s to', () => {
  const config: StorageConfig = {
    endpoint: 'http://localhost:9000',
    bucket: 'servgrid-attachments',
    accessKeyId: 'ACCESSKEY',
    secretAccessKey: 'SECRET',
    region: 'us-east-1',
  };

  it('targets the bucket, carries the query parameters, and expires in five minutes', () => {
    const url = new URL(
      presignedGetUrl(config, 'job_card/2026/09/uuid.jpg', PRESIGN_TTL_SECONDS, new Date('2026-09-11T10:30:00Z')),
    );
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe('/servgrid-attachments/job_card/2026/09/uuid.jpg');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('ACCESSKEY/20260911/us-east-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260911T103000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_TTL_SECONDS));
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for a fixed clock and changes with the key', () => {
    const now = new Date('2026-09-11T10:30:00Z');
    const a = presignedGetUrl(config, 'job_card/2026/09/uuid.jpg', 300, now);
    expect(presignedGetUrl(config, 'job_card/2026/09/uuid.jpg', 300, now)).toBe(a);
    expect(presignedGetUrl(config, 'job_card/2026/09/other.jpg', 300, now)).not.toBe(a);
  });
});

describe('the §9 constants the pipeline and the route both read', () => {
  it('keeps the 15 MB cap, the 1600px edge and the 5-minute TTL aligned with the spec', () => {
    expect(MAX_UPLOAD_BYTES).toBe(15 * 1024 * 1024); // §3.6: size_bytes capped 15 MB
    expect(JPEG_MAX_EDGE).toBe(1600); // §9: max 1600px long edge
    expect(PRESIGN_TTL_SECONDS).toBe(300); // §9: a 5-minute presigned URL
  });
});
