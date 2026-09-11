/**
 * The outbox (T1.14, PLAN-FRONTEND.md §5): the technician's pending
 * mutations, made durable at the moment of the optimistic write, plus the
 * per-row state machine the drain (./drain) drives.
 *
 * The table is exactly the one §5 specifies — including `employee_id`,
 * which is the column that lets "keep the rejected rows" and "clear the
 * previous user's data" be two different operations on a shared handset.
 * Rows are never deleted: `done` and `rejected` are terminal *statuses*,
 * not removals, so a `depends_on` parent always resolves and a preserved
 * rejection survives logout and re-login intact. The table is bounded by a
 * shift's work, and the pending badge reads only `queued` + `inflight`.
 *
 * **The idempotency key is generated once, here, at enqueue** (§5: "the
 * single easiest mistake to make in this codebase"). It lives on the ROW —
 * never in a request builder — so every retry, refresh or drain cycle
 * re-reads the same bytes. `drain.ts` sends `row.idempotencyKey` verbatim
 * and has no key-generating code of its own for operations.
 *
 * **Enqueue is synchronous with the optimistic write** (§5 / PLAN.md §6):
 * the caller updates the mirror, then awaits `enqueue` — a local SQLite
 * insert and a CSPRNG read, microseconds, no network — and the UI already
 * shows the new state. Nothing in the UI blocks on the network.
 *
 * `body_json` carries a uniform envelope `{ body, headers }`: the JSON
 * request body the batch re-posts verbatim, plus the sparse extra headers
 * a target route needs (the sync contract's optional `headers`). For
 * attachment rows the envelope's `body` is an `AttachmentUpload`
 * descriptor — photos queue as local file URIs (§5) and travel in the
 * binary pass, never in the JSON batch.
 */
import type { MirrorDatabase } from '../db/mirror';
import { uuid } from '../lib/uuid';

/** Row statuses per §5. `failed` is defined by the contract (and excluded
 * from the logout gate) but nothing in Phase 1 sets it: an operation is
 * queued until the server judges it, and a network error is a retry, never
 * a failure verdict. */
export type OutboxStatus = 'queued' | 'inflight' | 'done' | 'rejected' | 'failed';

/** The `entity_type` value that routes a row to the binary pass. */
export const ATTACHMENT_ENTITY = 'attachment';

/** One outbox row, camelCase over the §5 table. */
export interface OutboxRow {
  /** The operation's `localId` on the wire; also what `depends_on` names. */
  id: string;
  createdAt: string;
  /** Monotonic insertion order — the JSON batch is ordered, not atomic. */
  seq: number;
  /** Whose work this is; a handset may be shared (§5). */
  employeeId: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  bodyJson: string | null;
  /** Generated once at enqueue, reused across every retry (§5). */
  idempotencyKey: string;
  entityType: string;
  entityLocalId: string;
  /** An earlier row's id; a rejected parent holds its children back. */
  dependsOn: string | null;
  status: OutboxStatus;
  attempts: number;
  /** ISO instant the row becomes eligible again; null = now. */
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** The multipart upload descriptor an attachment row carries in
 * `body_json` (§5: photos queue as local file URIs). `fileChecksum` is
 * computed at capture time, before enqueue, so the drain only reads. */
export interface AttachmentUpload {
  fileUri: string;
  mimeType: string;
  fileName: string;
  ownerType: string;
  ownerId: string;
  kind: 'photo' | 'signature' | 'document';
  capturedAt: string;
  /** hex sha256 of the file, computed once before enqueue (§9). */
  fileChecksum: string;
  caption?: string;
}

export interface EnqueueInput {
  employeeId: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Sparse extras a route needs in headers (e.g. `If-Match`). */
  headers?: Record<string, string>;
  entityType: string;
  /** The local id of the entity the operation acts on. */
  entityLocalId: string;
  /** An earlier outbox row's id this operation depends on. */
  dependsOn?: string;
}

// ── schema ──────────────────────────────────────────────────────────────────
//
// Same database file as the mirror (one database per app, separate tables —
// see db/sqliteMirror.ts), so the outbox DDL is executed by the same open.
// Column names are the §5 table verbatim. No foreign key on `depends_on`:
// enqueue order guarantees the parent row exists (a child is enqueued after
// the operation it follows), matching the mirror's documented no-FK style.

export const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL UNIQUE,
  employee_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('POST', 'PATCH', 'DELETE')),
  path TEXT NOT NULL,
  body_json TEXT,
  idempotency_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_local_id TEXT NOT NULL,
  depends_on TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'inflight', 'done', 'rejected', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS outbox_drain_idx ON outbox (status, seq);
CREATE INDEX IF NOT EXISTS outbox_employee_idx ON outbox (employee_id, status);
`;

/** Created by the same database open that stamps the mirror (db/sqliteMirror.ts). */
export function ensureOutboxTable(database: MirrorDatabase): void {
  database.execSync(OUTBOX_DDL);
}

// ── the body envelope ───────────────────────────────────────────────────────

interface BodyEnvelope {
  body: unknown;
  headers: Record<string, string> | null;
}

function encodeBodyJson(input: Pick<EnqueueInput, 'body' | 'headers'>): string {
  const envelope: BodyEnvelope = { body: input.body ?? null, headers: input.headers ?? null };
  return JSON.stringify(envelope);
}

function decodeBodyJson(bodyJson: string | null): BodyEnvelope {
  if (bodyJson === null) return { body: null, headers: null };
  try {
    const parsed: unknown = JSON.parse(bodyJson);
    if (typeof parsed === 'object' && parsed !== null && 'body' in parsed && 'headers' in parsed) {
      const envelope = parsed as BodyEnvelope;
      return { body: envelope.body ?? null, headers: envelope.headers ?? null };
    }
    // A bare value (never written by this module, but harmless): it is the body.
    return { body: parsed, headers: null };
  } catch {
    return { body: null, headers: null };
  }
}

/** The JSON payload a JSON-pass row contributes to the batch operation. */
export function operationBodyOf(row: OutboxRow): unknown {
  return decodeBodyJson(row.bodyJson).body;
}

/** The upload descriptor a binary-pass row carries (or null for JSON rows). */
export function attachmentUploadOf(row: OutboxRow): AttachmentUpload | null {
  if (row.entityType !== ATTACHMENT_ENTITY) return null;
  const { body } = decodeBodyJson(row.bodyJson);
  if (typeof body !== 'object' || body === null) return null;
  const upload = body as Partial<AttachmentUpload>;
  if (
    typeof upload.fileUri !== 'string' ||
    typeof upload.mimeType !== 'string' ||
    typeof upload.ownerType !== 'string' ||
    typeof upload.ownerId !== 'string' ||
    typeof upload.kind !== 'string' ||
    typeof upload.capturedAt !== 'string' ||
    typeof upload.fileChecksum !== 'string'
  ) {
    return null;
  }
  return {
    fileUri: upload.fileUri,
    mimeType: upload.mimeType,
    fileName: typeof upload.fileName === 'string' ? upload.fileName : 'attachment',
    ownerType: upload.ownerType,
    ownerId: upload.ownerId,
    kind: upload.kind as AttachmentUpload['kind'],
    capturedAt: upload.capturedAt,
    fileChecksum: upload.fileChecksum,
    caption: typeof upload.caption === 'string' ? upload.caption : undefined,
  };
}

// ── row mapping ─────────────────────────────────────────────────────────────

interface OutboxRowRecord {
  id: string;
  created_at: string;
  seq: number;
  employee_id: string;
  method: string;
  path: string;
  body_json: string | null;
  idempotency_key: string;
  entity_type: string;
  entity_local_id: string;
  depends_on: string | null;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

const METHODS = ['POST', 'PATCH', 'DELETE'] as const;
const STATUSES: readonly OutboxStatus[] = ['queued', 'inflight', 'done', 'rejected', 'failed'];

function toRow(record: OutboxRowRecord): OutboxRow {
  const method = METHODS.find((m) => m === record.method);
  const status = STATUSES.find((s) => s === record.status);
  if (method === undefined || status === undefined) {
    throw new Error(`Outbox row ${record.id} has an unreadable method/status — the schema was violated.`);
  }
  return {
    id: record.id,
    createdAt: record.created_at,
    seq: record.seq,
    employeeId: record.employee_id,
    method,
    path: record.path,
    bodyJson: record.body_json,
    idempotencyKey: record.idempotency_key,
    entityType: record.entity_type,
    entityLocalId: record.entity_local_id,
    dependsOn: record.depends_on,
    status,
    attempts: record.attempts,
    nextAttemptAt: record.next_attempt_at,
    errorCode: record.error_code,
    errorMessage: record.error_message,
  };
}

// ── enqueue ─────────────────────────────────────────────────────────────────

/**
 * Make an optimistic write durable. The row id and the idempotency key are
 * minted HERE, once, and stored on the row — `drain.ts` reads them back on
 * every retry and never regenerates (the "If it fails" clause of T1.14).
 */
export async function enqueue(database: MirrorDatabase, input: EnqueueInput): Promise<OutboxRow> {
  const id = await uuid();
  const idempotencyKey = await uuid();
  const createdAt = new Date().toISOString();
  let row: OutboxRow | null = null;
  database.withTransactionSync(() => {
    const next =
      database.getFirstSync<{ next: number | null }>('SELECT MAX(seq) AS next FROM outbox')?.next ?? null;
    const seq = (next ?? 0) + 1;
    database.runSync(
      `INSERT INTO outbox (
        id, created_at, seq, employee_id, method, path, body_json,
        idempotency_key, entity_type, entity_local_id, depends_on,
        status, attempts, next_attempt_at, error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL)`,
      id,
      createdAt,
      seq,
      input.employeeId,
      input.method,
      input.path,
      encodeBodyJson(input),
      idempotencyKey,
      input.entityType,
      input.entityLocalId,
      input.dependsOn ?? null,
    );
    row = rowById(database, id);
  });
  if (row === null) throw new Error(`Enqueued outbox row ${id} could not be read back.`);
  return row;
}

// ── reads ───────────────────────────────────────────────────────────────────

export function rowById(database: MirrorDatabase, id: string): OutboxRow | null {
  const record = database.getFirstSync<OutboxRowRecord>('SELECT * FROM outbox WHERE id = ?', id);
  return record === null ? null : toRow(record);
}

/** Every row that belongs to this employee, in drain order (§5: the outbox
 * is filtered by `employee_id`, never wiped). */
export function rowsForEmployee(database: MirrorDatabase, employeeId: string): OutboxRow[] {
  return database
    .getAllSync<OutboxRowRecord>('SELECT * FROM outbox WHERE employee_id = ? ORDER BY seq', employeeId)
    .map(toRow);
}

/**
 * Queued + inflight rows for this employee — the pending badge's count and
 * the logout gate's count (§5, and the ProfileScreen contract: `rejected`
 * and `failed` are excluded; kept rows never trap someone at shift end).
 */
export function pendingSyncCount(database: MirrorDatabase, employeeId: string): number {
  const row = database.getFirstSync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM outbox WHERE employee_id = ? AND status IN ('queued', 'inflight')",
    employeeId,
  );
  return row?.n ?? 0;
}

// ── state transitions (drain.ts's vocabulary) ───────────────────────────────

/** claimed (queued → inflight) for a cycle. */
export function claimRows(database: MirrorDatabase, ids: readonly string[]): void {
  database.withTransactionSync(() => {
    for (const id of ids) {
      database.runSync(`UPDATE outbox SET status = 'inflight' WHERE id = ? AND status = 'queued'`, id);
    }
  });
}

/** Terminal success — `applied` and `duplicate` both land here (§5: a
 * replay is a success). The row is kept. */
export function settleDone(database: MirrorDatabase, id: string): void {
  database.runSync(
    `UPDATE outbox SET status = 'done', next_attempt_at = NULL, error_code = NULL, error_message = NULL WHERE id = ?`,
    id,
  );
}

/** Terminal rejection — the local record is KEPT and the banner event
 * carries the server's message verbatim (§5 rejection UX). */
export function settleRejected(
  database: MirrorDatabase,
  id: string,
  errorCode: string,
  errorMessage: string,
): void {
  database.runSync(
    `UPDATE outbox SET status = 'rejected', next_attempt_at = NULL, error_code = ?, error_message = ? WHERE id = ?`,
    errorCode,
    errorMessage,
    id,
  );
}

/** Server said `skipped` (its parent was rejected in-batch): back to
 * queued, unattempted, to be held by the client-side dependency rule from
 * the next cycle on. */
export function returnToQueued(database: MirrorDatabase, id: string): void {
  database.runSync(`UPDATE outbox SET status = 'queued' WHERE id = ? AND status = 'inflight'`, id);
}

/**
 * Network error: `attempts++`, exponential backoff `2^n` capped at 5
 * minutes, stay `queued` (§5 outcome table). The key and the payload are
 * untouched — only the schedule moves.
 */
export function postponeRow(database: MirrorDatabase, id: string, now: Date, message: string): void {
  database.withTransactionSync(() => {
    const row = rowById(database, id);
    if (row === null) return;
    const attempts = row.attempts + 1;
    const nextAttemptAt = new Date(now.getTime() + backoffSeconds(attempts) * 1000).toISOString();
    database.runSync(
      `UPDATE outbox SET status = 'queued', attempts = ?, next_attempt_at = ?, error_code = 'NETWORK', error_message = ? WHERE id = ?`,
      attempts,
      nextAttemptAt,
      message,
      id,
    );
  });
}

/** The 401-with-retryable-refresh path: back to queued with NO penalty —
 * the session stands, the row was never judged, and the next trigger
 * retries it as-is (a technician in a basement keeps his outbox). */
export function unclaimRow(database: MirrorDatabase, id: string): void {
  database.runSync(`UPDATE outbox SET status = 'queued', next_attempt_at = NULL WHERE id = ? AND status = 'inflight'`, id);
}

// ── backoff ─────────────────────────────────────────────────────────────────

export const BACKOFF_CAP_SECONDS = 5 * 60;

/** `2^n` seconds, capped at 5 minutes (§5). `n` is the attempt number that
 * just failed: the first failure waits 2s, the ninth waits 300s. */
export function backoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, BACKOFF_CAP_SECONDS);
}
