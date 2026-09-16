import type { Db } from '../auth/repo.js';

/**
 * The DB enum `attachment_owner_type` / `attachment_kind` (migration
 * 002) as TypeScript unions — the same members as the wire side of
 * `Attachment` in packages/shared (domain.ts), which is where the
 * client-facing type lives.
 */
export type AttachmentOwnerType =
  | 'job_card'
  | 'job_completion'
  | 'payment'
  | 'sales_card'
  | 'customer'
  | 'employee'
  | 'service_contract';

export type AttachmentKind = 'photo' | 'signature' | 'document';

/**
 * Attachments SQL (PLAN-BACKEND.md §2 module shape, §9; table per
 * PLAN-DATA-MODEL.md §3.6, migration 008). Every function takes its
 * executor explicitly — the Pool for autocommit reads, or the
 * transaction client of a caller's `withTransaction`, the same rule
 * jobs/repo.ts runs under. The insert is the only write: attachments
 * are immutable once landed (no UPDATE, no DELETE — orphan cleanup is a
 * nightly job, not a code path).
 */

/** The wire-facing row — every column migration 008 defines. */
export interface AttachmentRow {
  id: string;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  kind: AttachmentKind;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  checksum_sha256: string;
  caption: string | null;
  uploaded_by: string;
  captured_at: Date;
  uploaded_at: Date;
}

export interface InsertAttachment {
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
  /** The device clock at capture — arrives pre-validated (ISO, offset required). */
  capturedAt: string;
}

export async function insertAttachment(db: Db, a: InsertAttachment): Promise<AttachmentRow> {
  const r = await db.query<AttachmentRow>(
    `INSERT INTO attachments
       (owner_type, owner_id, kind, storage_key, mime_type, size_bytes,
        width, height, checksum_sha256, caption, uploaded_by, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, owner_type, owner_id, kind, storage_key, mime_type,
               size_bytes, width, height, checksum_sha256, caption,
               uploaded_by, captured_at, uploaded_at`,
    [
      a.ownerType,
      a.ownerId,
      a.kind,
      a.storageKey,
      a.mimeType,
      a.sizeBytes,
      a.width,
      a.height,
      a.checksumSha256,
      a.caption,
      a.uploadedBy,
      a.capturedAt,
    ],
  );
  return r.rows[0]!;
}

/**
 * The one attachment row plus *the fact every scope check on the read path
 * turns on*: whose job the owner's card is assigned to, or — for a payment
 * proof (T3.4) — who received the payment. A `job_card` attachment hangs
 * off the card directly; a `job_completion` attachment reaches its card
 * through the completion; a `payment` attachment reaches `received_by`
 * through its parent payment. Every other `owner_type` has no module behind
 * it yet and both scope columns come back NULL (its matrix cells land with
 * the phase that owns the row — until then the service admits the owner
 * alone).
 *
 * LEFT JOINs on purpose: `owner_id` deliberately carries no FK
 * (§3.6), so a missing owner row must not hide an attachment that
 * exists — the NULL simply fails the technician's `own` check and the
 * owner reads it regardless. `job_completions` is keyed by
 * `job_card_id` (migration 007), so both the join and the upload-path
 * lookup key on it, not on an id column the table does not have.
 */
export interface AttachmentWithOwnerRow extends AttachmentRow {
  job_assigned_to: string | null;
  payment_received_by: string | null;
}

const WITH_OWNER_SELECT = `
  SELECT a.id, a.owner_type, a.owner_id, a.kind, a.storage_key, a.mime_type,
         a.size_bytes, a.width, a.height, a.checksum_sha256, a.caption,
         a.uploaded_by, a.captured_at, a.uploaded_at,
         CASE
           WHEN a.owner_type = 'job_card' THEN jc.assigned_to
           WHEN a.owner_type = 'job_completion' THEN jcj.assigned_to
         END AS job_assigned_to,
         CASE WHEN a.owner_type = 'payment' THEN pay.received_by END AS payment_received_by
  FROM attachments a
  LEFT JOIN job_cards jc ON a.owner_type = 'job_card' AND jc.id = a.owner_id
  LEFT JOIN job_completions comp ON a.owner_type = 'job_completion' AND comp.job_card_id = a.owner_id
  LEFT JOIN job_cards jcj ON jcj.id = comp.job_card_id
  LEFT JOIN payments pay ON a.owner_type = 'payment' AND pay.id = a.owner_id`;

export async function findAttachmentWithOwner(db: Db, id: string): Promise<AttachmentWithOwnerRow | null> {
  const r = await db.query<AttachmentWithOwnerRow>(`${WITH_OWNER_SELECT} WHERE a.id = $1`, [id]);
  return r.rows[0] ?? null;
}

/** `job_cards.assigned_to` for an upload against a `job_card` owner. */
export async function findJobAssignedTo(db: Db, jobId: string): Promise<string | null> {
  const r = await db.query<{ assigned_to: string | null }>(
    'SELECT assigned_to FROM job_cards WHERE id = $1',
    [jobId],
  );
  return r.rows[0]?.assigned_to ?? null;
}

/** `job_cards.assigned_to` for an upload against a `job_completion` owner — through the completion's card. */
export async function findCompletionAssignedTo(db: Db, completionId: string): Promise<string | null> {
  const r = await db.query<{ assigned_to: string | null }>(
    `SELECT jc.assigned_to
     FROM job_completions comp JOIN job_cards jc ON jc.id = comp.job_card_id
     WHERE comp.job_card_id = $1`,
    [completionId],
  );
  return r.rows[0]?.assigned_to ?? null;
}

/** `payments.received_by` for an upload against a `payment` owner — the proof photo's scope fact (T3.4). */
export async function findPaymentReceivedBy(db: Db, paymentId: string): Promise<string | null> {
  const r = await db.query<{ received_by: string | null }>(
    'SELECT received_by FROM payments WHERE id = $1',
    [paymentId],
  );
  return r.rows[0]?.received_by ?? null;
}

/**
 * The newest attachment of one kind on one owner row — the payment
 * proof-photo lookup behind GET /v1/payments/:id/proof. The ledger's
 * payment rows carry no attachment id (§9: the photo is its own
 * document, uploaded after the money), so the read goes owner → latest
 * photo, newest upload wins. NULL owner columns ride WITH_OWNER_SELECT
 * so checkReadAccess sees the same row shape as the by-id read.
 */
export async function findLatestOwnerAttachment(
  db: Db,
  ownerType: AttachmentOwnerType,
  ownerId: string,
  kind: AttachmentKind,
): Promise<AttachmentWithOwnerRow | null> {
  const r = await db.query<AttachmentWithOwnerRow>(
    `${WITH_OWNER_SELECT} WHERE a.owner_type = $1 AND a.owner_id = $2 AND a.kind = $3
     ORDER BY a.uploaded_at DESC
     LIMIT 1`,
    [ownerType, ownerId, kind],
  );
  return r.rows[0] ?? null;
}
