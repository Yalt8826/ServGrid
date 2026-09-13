import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { permit, type Role } from '@servgrid/shared';
import { AppError, PAYLOAD_TOO_LARGE_MESSAGE } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { presignedGetUrl, putObject, type StorageConfig } from '../../lib/storage.js';
import type { AttachmentKind, AttachmentOwnerType } from './repo.js';
import * as repo from './repo.js';

/**
 * Attachments service (PLAN-BACKEND.md §9). One multipart request — not
 * presign/PUT/confirm: three round trips on a flaky 2G link is three
 * chances to fail, and the offline drain would have to reason about a
 * half-created attachment. At 14 users the API can absorb the bytes;
 * presigned direct-to-storage stays the documented scale path.
 *
 * The pipeline, in the order the failures are cheapest:
 *
 *   permission → sniff → size → checksum → re-encode → put → insert
 *
 * Permission first (never process a stranger's bytes); checksum before
 * the storage PUT (bytes that do not hash to the client's `fileChecksum`
 * were truncated on a bad link and are rejected, never stored as a
 * corrupt image nobody looks at until it matters); the PUT before the
 * INSERT (a failure after the PUT strands one orphan object, which the
 * nightly sweep exists for — a failure after the INSERT would strand a
 * row pointing at nothing, which nothing cleans up).
 *
 * Idempotency: the plugin claims the key before this code runs, hashing
 * `fileChecksum + ownerType + ownerId + kind` (§9's multipart
 * `request_hash` — a multipart body has no JSON to canonicalise and its
 * boundary changes between retries). So the same photo resent under the
 * same key is a byte-identical replay — the PUT and INSERT below do not
 * run twice — and a different photo under a reused key is a 422
 * IDEMPOTENCY_KEY_REUSED before the handler is reached.
 */

/** §3.6: `size_bytes` capped 15 MB — the same cap the DB CHECK enforces. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** §9: a completion photo does not need 12 MP. Applied to the long edge of a re-encoded JPEG. */
export const JPEG_MAX_EDGE = 1600;

export const JPEG_QUALITY = 80;

/** §9: the 302 target lives five minutes. */
export const PRESIGN_TTL_SECONDS = 300;

/**
 * Route-level body limit: the cap plus slack for the multipart framing
 * (boundaries, part headers). A body past this dies in the content-type
 * parser — before the handler, before any bytes are buffered twice, and
 * before any claim row exists.
 */
export const UPLOAD_BODY_LIMIT_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

/** What the server accepts, decided by sniffing bytes — never by a client-declared name or header (§9). */
export type SniffedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

/** The fields one multipart upload carries (§9). `file` is the raw part bytes. */
export interface ParsedUpload {
  ownerType: AttachmentOwnerType;
  ownerId: string;
  kind: AttachmentKind;
  capturedAt: string;
  /** sha256 hex of the file bytes, computed on the device before enqueue. */
  fileChecksum: string;
  caption: string | null;
  file: Buffer;
  /** True when busboy cut the stream at the size limit mid-part. */
  truncated: boolean;
}

/**
 * §9's multipart `request_hash` input, verbatim: plain concatenation.
 * Safe without separators — `fileChecksum` is always exactly 64 hex
 * characters, so the field boundaries are unambiguous.
 */
export function uploadHashPayload(u: Pick<ParsedUpload, 'fileChecksum' | 'ownerType' | 'ownerId' | 'kind'>): string {
  return u.fileChecksum + u.ownerType + u.ownerId + u.kind;
}

/** Magic bytes only — a renamed `.exe` never becomes a JPEG here (§9 tests). */
export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'application/pdf'; // %PDF-
  }
  return null;
}

function extensionFor(mime: SniffedMime): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
  }
}

/**
 * §9's object key shape, partitioned by owner type and the UTC month the
 * object lands (the same clock `uploaded_at` uses — the partition is for
 * humans browsing a bucket, and an object belongs to the month it
 * arrived, not the month the shutter fired).
 */
export function buildStorageKey(ownerType: string, mime: SniffedMime, id: string, now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${ownerType}/${yyyy}/${mm}/${id}.${extensionFor(mime)}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The wire shape — exactly `Attachment` in packages/shared (domain.ts). */
export interface AttachmentWire {
  id: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  kind: AttachmentKind;
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
}

/** row → wire, one mapper so the response schema and the client contract cannot drift. */
export function toWire(row: repo.AttachmentRow): AttachmentWire {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    kind: row.kind,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    checksumSha256: row.checksum_sha256,
    caption: row.caption,
    uploadedBy: row.uploaded_by,
    capturedAt: row.captured_at.toISOString(),
    uploadedAt: row.uploaded_at.toISOString(),
  };
}

export interface Actor {
  id: string;
  role: Role;
}

/** Which matrix cell governs a mutation against this owner type. */
function jobScoped(ownerType: AttachmentOwnerType): boolean {
  return ownerType === 'job_card' || ownerType === 'job_completion';
}

interface UploadOutcome {
  stored: Buffer;
  storedMime: SniffedMime;
  width: number | null;
  height: number | null;
}

export function createAttachmentsService(s3: StorageConfig) {
  /**
   * POST /v1/attachments — sniff, verify, re-encode, land. Runs inside
   * the idempotency plugin's request transaction: the INSERT (via
   * `withTransaction`, which joins the ambient tx) and the stored
   * response commit together, so a crash loses both and a replay never
   * re-uploads. Reads go through the pool — they gate, they do not
   * write.
   */
  async function upload(actor: Actor, u: ParsedUpload): Promise<AttachmentWire> {
    await checkWriteAccess(actor, u.ownerType, u.ownerId);

    if (u.truncated || u.file.length > MAX_UPLOAD_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', PAYLOAD_TOO_LARGE_MESSAGE);
    }

    const sniffed = sniffMime(u.file);
    if (sniffed === null) {
      throw new AppError('VALIDATION_FAILED', 'Only JPEG, PNG or WebP images and PDF documents can be attached.');
    }

    // §9's free integrity check: bytes that do not hash to what the
    // client computed were truncated on a bad link. Reject before the
    // object exists — a corrupt image nobody looks at until it matters.
    if (sha256Hex(u.file) !== u.fileChecksum) {
      throw new AppError(
        'VALIDATION_FAILED',
        'That file did not arrive complete — the connection dropped mid-upload. Attach it again.',
      );
    }

    const outcome = await processBytes(u.file, sniffed);
    const key = buildStorageKey(u.ownerType, outcome.storedMime, randomUUID(), new Date());

    const put = await putObject(s3, key, outcome.stored, outcome.storedMime);
    if (!put.ok) {
      // Storage down or refusing: an INTERNAL, not a validation error —
      // the outbox retries, and /healthz is already paging on the same
      // probe that would have caught this.
      throw new AppError('INTERNAL', 'The file could not be stored. Nothing was lost — try again in a moment.');
    }

    return withTransaction(async (client) => {
      const row = await repo.insertAttachment(client, {
        ownerType: u.ownerType,
        ownerId: u.ownerId,
        kind: u.kind,
        storageKey: key,
        mimeType: outcome.storedMime,
        sizeBytes: outcome.stored.length,
        width: outcome.width,
        height: outcome.height,
        checksumSha256: sha256Hex(outcome.stored),
        caption: u.caption,
        uploadedBy: actor.id,
        capturedAt: u.capturedAt,
      });
      return toWire(row);
    });
  }

  /**
   * GET /v1/attachments/:id — permission-check the row, then hand back a
   * five-minute presigned URL. The bytes are never proxied: that is the
   * one place the API should not spend bandwidth (§9).
   */
  async function readUrl(actor: Actor, id: string): Promise<{ url: string; row: repo.AttachmentWithOwnerRow }> {
    const row = await repo.findAttachmentWithOwner(getPool(), id);
    if (row === null) {
      throw new AppError('NOT_FOUND', "We couldn't find that attachment.");
    }
    checkReadAccess(actor, row);
    return { url: presignedGetUrl(s3, row.storage_key, PRESIGN_TTL_SECONDS), row };
  }

  return { upload, readUrl };
}

export type AttachmentsService = ReturnType<typeof createAttachmentsService>;

/**
 * §5 by way of §9: attachments on a job (before-photos on the card,
 * after-photos on the completion) are governed by the `job` matrix cells
 * — `update` for uploads, `read` for downloads — so the technician who
 * owns the work, the dispatcher assembling the card and the owner can all
 * attach, and a sales_rep (cell `none`) cannot. Payment proofs (T3.4) ride
 * the `payment` cells the same way: the rep who RECEIVED the payment
 * attaches and reads his proof (`own` = `received_by`, deliberately
 * stricter than the company's house-account visibility), the owner always
 * can. Owner types whose module lands in a later phase (sales_card, …)
 * admit the owner alone until that phase registers their cells; a rule
 * nobody can exercise yet is a rule that cannot be wrong yet either.
 */
async function checkWriteAccess(actor: Actor, ownerType: AttachmentOwnerType, ownerId: string): Promise<void> {
  if (ownerType === 'payment') {
    const scope = permit(actor.role, 'payment', 'update');
    if (scope === 'none') {
      throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
    }
    if (scope === 'all') return; // owner: whole surface
    // sales_rep (`own` = received_by): the proof photo belongs to the
    // collection he took. A missing owner row is a dangling reference (no
    // FK on owner_id, §3.6), not a permission answer, so it reads as
    // NOT_FOUND — the same rule the job branches run under.
    const receivedBy = await repo.findPaymentReceivedBy(getPool(), ownerId);
    if (receivedBy === null) {
      throw new AppError('NOT_FOUND', "We couldn't find that payment.");
    }
    if (receivedBy !== actor.id) {
      throw new AppError('OUT_OF_SCOPE', 'That payment was collected by someone else.');
    }
    return;
  }
  if (!jobScoped(ownerType)) {
    if (actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Attachments on this record are attached by the owner.');
    }
    return;
  }
  const scope = permit(actor.role, 'job', 'update');
  if (scope === 'none') {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
  if (scope === 'all') return; // owner and dispatcher: whole surface

  // Technician (`own`): the job must be his — no status filter, the same
  // rule the rbac job predicate runs under. A photo taken on site reaches
  // the API after the job closed, and the closed job is the ordinary
  // case. A missing owner row is a dangling reference, not a permission
  // answer, so it reads as NOT_FOUND.
  const assignedTo =
    ownerType === 'job_card'
      ? await repo.findJobAssignedTo(getPool(), ownerId)
      : await repo.findCompletionAssignedTo(getPool(), ownerId);
  if (assignedTo === null) {
    throw new AppError('NOT_FOUND', "We couldn't find that job.");
  }
  if (assignedTo !== actor.id) {
    throw new AppError('OUT_OF_SCOPE', 'That job belongs to another technician.');
  }
}

/** The read-side twin — `job` × `read` for job attachments, `payment` × `read` for proofs (T3.4), resolved from the row the repo joined. */
function checkReadAccess(actor: Actor, row: repo.AttachmentWithOwnerRow): void {
  if (row.owner_type === 'payment') {
    const scope = permit(actor.role, 'payment', 'read');
    if (scope === 'none') {
      throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
    }
    if (scope === 'all') return;
    if (row.payment_received_by === null) {
      throw new AppError('NOT_FOUND', "We couldn't find that payment.");
    }
    if (row.payment_received_by !== actor.id) {
      throw new AppError('OUT_OF_SCOPE', 'That payment was collected by someone else.');
    }
    return;
  }
  if (!jobScoped(row.owner_type)) {
    if (actor.role !== 'owner') {
      throw new AppError('FORBIDDEN', 'Attachments on this record are read by the owner.');
    }
    return;
  }
  const scope = permit(actor.role, 'job', 'read');
  if (scope === 'none') {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
  if (scope === 'all') return;
  if (row.job_assigned_to !== actor.id) {
    // A job that has vanished since upload, or another technician's:
    // either way the row is not his to open.
    throw new AppError(
      row.job_assigned_to === null ? 'NOT_FOUND' : 'OUT_OF_SCOPE',
      row.job_assigned_to === null ? "We couldn't find that job." : 'That job belongs to another technician.',
    );
  }
}

/**
 * §9: re-encode a JPEG to a 1600px long edge; every other accepted type
 * is stored byte-for-byte. `.rotate()` with no angle auto-orients from
 * EXIF before resizing — a phone photo stored sensor-native must not
 * come back sideways. `fit: 'inside'` preserves aspect; a smaller image
 * is never enlarged.
 */
async function processBytes(bytes: Buffer, mime: SniffedMime): Promise<UploadOutcome> {
  if (mime === 'image/jpeg') {
    try {
      const out = await sharp(bytes)
        .rotate()
        .resize({ width: JPEG_MAX_EDGE, height: JPEG_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer({ resolveWithObject: true });
      return { stored: out.data, storedMime: 'image/jpeg', width: out.info.width, height: out.info.height };
    } catch {
      // Magic bytes said JPEG; the codec disagreed. The checksum guard
      // already passed, so this is a corrupt-on-arrival file, not a
      // truncated transfer — refuse it as validation, not as a retry.
      throw new AppError('VALIDATION_FAILED', 'That image could not be processed. Try a different one.');
    }
  }

  if (mime === 'image/png' || mime === 'image/webp') {
    // No re-encode for these (§9 names JPEG only) — but read the header,
    // so the width/height columns are real and a header-valid but
    // corrupt frame is refused rather than stored blind.
    try {
      const meta = await sharp(bytes).metadata();
      if (meta.width !== undefined && meta.height !== undefined) {
        return { stored: bytes, storedMime: mime, width: meta.width, height: meta.height };
      }
    } catch {
      throw new AppError('VALIDATION_FAILED', 'That image could not be processed. Try a different one.');
    }
  }
  // Documents have no dimensions (§3.6: "documents may not have any").
  return { stored: bytes, storedMime: mime, width: null, height: null };
}
