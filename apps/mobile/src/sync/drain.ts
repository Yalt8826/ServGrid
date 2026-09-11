/**
 * The drain manager (T1.14, PLAN-FRONTEND.md §5): the loop that turns the
 * outbox into server state, and the one place network outcomes are judged.
 *
 * **Two passes per cycle**, because attachments cannot ride the JSON batch
 * (§5: "an agent writing a drain that base64s a 2 MB photo into a batch
 * body" is the named failure):
 *
 *  1. **JSON pass** — up to 50 ordered non-attachment operations to
 *     `POST /v1/sync/batch`, each carrying the idempotency key minted at
 *     enqueue (stored on the row; nothing here regenerates one).
 *  2. **Binary pass** — each attachment row whose `depends_on` is `done`
 *     uploads individually to `POST /v1/attachments`, SEQUENTIALLY, each
 *     with its own key. A parent that is `rejected` or still `queued`
 *     means the child is skipped this cycle. Sequential because these
 *     upload from a van on 2G.
 *
 * **The delta call happens after both passes**, so the cursor reflects the
 * attachments too and server-assigned numbers land in the same cycle.
 * Reconciliation of the local mirror is the delta's job: the drain never
 * writes the mirror from batch result bodies, it lets the immediately
 * following delta (applied atomically by T1.13's `applyDeltaPage`) bring
 * the server's truth down — one round trip, no parallel write path.
 *
 * Per-outcome handling (§5 table): `applied`/`duplicate` → `done` (a
 * replay is a success) · `skipped` → back to `queued` · `rejected` →
 * `rejected`, record kept, banner event with the server's message verbatim
 * · network error → `attempts++`, backoff `2^n` capped at 5 min, stay
 * `queued` · `401` → the api client refreshes once and retries once with
 * the SAME keys; if the refresh failed retryably (no completed refusal)
 * the rows go back to `queued` untouched and the session stands; if the
 * session is actually dead the drain PAUSES and emits `auth-lost` — rows
 * are never discarded on any of these paths.
 *
 * **Triggers** (§5): reconnect, app foreground, a 60-second timer while
 * active, and manual pull-to-refresh — the first three wired by
 * `start(triggers)` around the platform subscriptions, the last being
 * `drainNow()`. All triggers funnel through one single-flight cycle.
 */
import type { Mirror } from '../db/mirror';
import { applyDeltaPage, readCursor } from '../db/mirror';
import type { SyncBatchResponse, SyncDeltaResponse, SyncOperation } from '@servgrid/shared';
import { SYNC_BATCH_MAX_OPERATIONS } from '@servgrid/shared';
import type { ApiClient, ApiResult } from '../lib/apiClient';
import { uuid } from '../lib/uuid';
import {
  ATTACHMENT_ENTITY,
  attachmentUploadOf,
  operationBodyOf,
  postponeRow,
  returnToQueued,
  rowById,
  settleDone,
  settleRejected,
  unclaimRow,
  type AttachmentUpload,
  type OutboxRow,
} from './outbox';

/** The send seam: the app hands in `apiClient.request`, so the 401 →
 * refresh-once → retry-once contract and key reuse are THE client's, not a
 * parallel implementation. */
export type DrainSend = ApiClient['request'];

export interface DrainDeps {
  /** The opened mirror — its database holds the outbox table and receives
   * the delta pages. */
  mirror: Mirror;
  send: DrainSend;
  /** The employee this session drains for; every read is scoped to him. */
  employeeId: string;
  /** Injectable clock — backoff scheduling and due-ness. */
  now?: () => Date;
  /** Banner and auth events (§5 rejection UX / re-login prompt). */
  onEvent?: (event: DrainEvent) => void;
}

export type DrainEvent =
  | {
      /** A row the server REJECTED — raise the banner with the server's
       * message verbatim; the local record is kept. */
      type: 'row-rejected';
      rowId: string;
      entityType: string;
      entityLocalId: string;
      errorCode: string;
      message: string;
    }
  | {
      /** The session is dead (refresh refused, or the refreshed token was
       * refused too): the drain pauses and the app prompts re-login. Every
       * queued row stays exactly where it is. */
      type: 'auth-lost';
      reason: 'refresh-refused' | 'session-refused';
    }
  | { type: 'cycle-done'; result: DrainResult };

export interface DrainResult {
  /** False when the drain was paused (auth) — nothing was attempted. */
  ran: boolean;
  paused: boolean;
  /** This cycle ended with the session judged dead; the manager pauses. */
  authLost: boolean;
  applied: number;
  duplicates: number;
  rejected: number;
  /** `skipped` outcomes returned to the queue. */
  skipped: number;
  /** Attachment uploads that finished this cycle. */
  uploaded: number;
  /** Rows deferred by a network error (backoff scheduled). */
  deferred: number;
  /** Delta pages applied to the mirror. */
  deltaPages: number;
}

function emptyResult(): DrainResult {
  return { ran: true, paused: false, authLost: false, applied: 0, duplicates: 0, rejected: 0, skipped: 0, uploaded: 0, deferred: 0, deltaPages: 0 };
}

// ── batch selection ─────────────────────────────────────────────────────────

/**
 * The JSON pass's ordered slice: queued, non-attachment, due, in seq
 * order, capped. A row whose `depends_on` parent is neither `done` nor in
 * this batch is HELD BACK — a parent rejected in an earlier cycle means
 * the child is never sent (its resolution comes first, §5); a parent
 * still queued (beyond the cap or behind backoff) holds the child too,
 * which is exactly the server's `skipped` short-circuit, decided early.
 */
function selectJsonBatch(mirror: Mirror, employeeId: string, nowIso: string, limit: number): OutboxRow[] {
  const candidates = mirror.database
    .getAllSync<Record<string, unknown>>(
      `SELECT * FROM outbox
       WHERE status = 'queued'
         AND employee_id = ?
         AND entity_type != ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY seq`,
      employeeId,
      ATTACHMENT_ENTITY,
      nowIso,
    )
    .map((record) => ({
      id: String(record.id),
      dependsOn: record.depends_on === null || record.depends_on === undefined ? null : String(record.depends_on),
    }));

  const batch: OutboxRow[] = [];
  const inBatch = new Set<string>();
  for (const candidate of candidates) {
    if (batch.length >= limit) break;
    if (candidate.dependsOn !== null && !inBatch.has(candidate.dependsOn)) {
      const parent = rowById(mirror.database, candidate.dependsOn);
      if (parent !== null && parent.status !== 'done') continue;
    }
    const row = rowById(mirror.database, candidate.id);
    if (row === null || row.status !== 'queued') continue;
    batch.push(row);
    inBatch.add(row.id);
  }
  return batch;
}

/** Due attachment rows for this employee, in seq order — eligibility
 * against their parents is judged per row in the loop (the parent may
 * settle mid-pass). */
function selectDueAttachments(mirror: Mirror, employeeId: string, nowIso: string): OutboxRow[] {
  return mirror.database
    .getAllSync<Record<string, unknown>>(
      `SELECT id FROM outbox
       WHERE status = 'queued'
         AND employee_id = ?
         AND entity_type = ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY seq`,
      employeeId,
      ATTACHMENT_ENTITY,
      nowIso,
    )
    .map((record) => rowById(mirror.database, String(record.id)))
    .filter((row): row is OutboxRow => row !== null && row.status === 'queued');
}

// ── outcome helpers ─────────────────────────────────────────────────────────

interface AuthVerdict {
  authLost: false;
}

interface AuthLostVerdict {
  authLost: true;
  reason: 'refresh-refused' | 'session-refused';
}

/**
 * The 401 handling shared by both passes, on top of the api client's own
 * refresh-once-retry-once (which already reused the SAME keys):
 *  - refresh failed without a completed refusal (no connection, 5xx, 429)
 *    → a retry, not a rejection: rows go back to `queued` untouched and
 *    the session stands (§5.1 — the basement case).
 *  - the refresh was refused, or a refreshed token was refused anyway →
 *    the drain pauses and the app prompts re-login. Rows stay queued —
 *    NEVER discarded.
 */
function authVerdictOf(res: Awaited<ReturnType<DrainSend>>): AuthVerdict | AuthLostVerdict {
  if (res.status !== 401) return { authLost: false };
  if (res.refreshOutcome === 'refresh-failed-retryable') return { authLost: false };
  if (res.refreshOutcome === 'logged-out') return { authLost: true, reason: 'refresh-refused' };
  return { authLost: true, reason: 'session-refused' };
}

// ── one cycle ───────────────────────────────────────────────────────────────

/**
 * One drain cycle: JSON pass → binary pass → delta. Exposed through
 * `createDrainManager` (which adds the pause state and the single-flight
 * all triggers share); `drainOnce` itself is pause-free so tests can drive
 * cycles directly.
 */
export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  const mirror = deps.mirror;
  const database = mirror.database;
  const now = deps.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const result = emptyResult();
  let batchCursor: string | null = null;

  // ── pass 1: JSON batch ──────────────────────────────────────────────────
  const batch = selectJsonBatch(mirror, deps.employeeId, nowIso, SYNC_BATCH_MAX_OPERATIONS);
  if (batch.length > 0) {
    claimQueued(database, batch);

    const operations: SyncOperation[] = batch.map((row) => {
      const body = operationBodyOf(row);
      const operation: SyncOperation = {
        localId: row.id,
        idempotencyKey: row.idempotencyKey,
        method: row.method,
        path: row.path,
      };
      if (row.dependsOn !== null) operation.dependsOn = row.dependsOn;
      if (body !== null) operation.body = body;
      return operation;
    });

    // The batch's own key is separate from every operation's key (the
    // server refuses a batch that reuses one); it is minted per attempt —
    // the stability contract lives on the operation rows, not the envelope.
    const res = await deps.send<SyncBatchResponse>('POST', '/v1/sync/batch', {
      body: { operations },
      idempotencyKey: await uuid(),
    });

    if (res.status === 0) {
      for (const row of batch) {
        postponeRow(database, row.id, now(), res.error?.message ?? 'No connection.');
      }
      result.deferred += batch.length;
    } else {
      const verdict = authVerdictOf(res);
      if (res.status === 401) {
        if (verdict.authLost) {
          for (const row of batch) unclaimRow(database, row.id);
          result.authLost = true;
          deps.onEvent?.({ type: 'auth-lost', reason: verdict.reason });
        } else {
          // Refreshable (no completed refusal): rows queued, no penalty.
          for (const row of batch) unclaimRow(database, row.id);
        }
      } else if (res.ok && res.data !== null && Array.isArray(res.data.results)) {
        const byLocalId = new Map(batch.map((row) => [row.id, row]));
        for (const outcome of res.data.results) {
          const row = byLocalId.get(outcome.localId);
          if (row === undefined) continue;
          switch (outcome.outcome) {
            case 'applied':
              settleDone(database, row.id);
              result.applied += 1;
              break;
            case 'duplicate':
              // A replay is a success (§5 / §7).
              settleDone(database, row.id);
              result.duplicates += 1;
              break;
            case 'rejected':
              settleRejected(
                database,
                row.id,
                outcome.error?.code ?? 'REJECTED',
                outcome.error?.message ?? 'The server refused this operation.',
              );
              result.rejected += 1;
              deps.onEvent?.({
                type: 'row-rejected',
                rowId: row.id,
                entityType: row.entityType,
                entityLocalId: row.entityLocalId,
                errorCode: outcome.error?.code ?? 'REJECTED',
                message: outcome.error?.message ?? 'The server refused this operation.',
              });
              break;
            case 'skipped':
              // Its parent was rejected in-batch; held from the next cycle
              // by the client-side dependency rule.
              returnToQueued(database, row.id);
              result.skipped += 1;
              break;
          }
        }
        batchCursor = typeof res.data.cursor === 'string' ? res.data.cursor : null;
      } else {
        // The batch envelope itself failed (a client bug per §7) or the
        // response was unreadable: back off and retry later rather than
        // spin — the rows are unchanged.
        for (const row of batch) {
          postponeRow(database, row.id, now(), res.error?.message ?? 'The sync batch could not be read.');
        }
        result.deferred += batch.length;
      }
    }
  }

  // ── pass 2: attachments, sequential, one request each ───────────────────
  for (const row of selectDueAttachments(mirror, deps.employeeId, nowIso)) {
    if (result.authLost) break; // paused mid-pass: nothing else is attempted

    const parentState = row.dependsOn === null ? 'done' : (rowById(database, row.dependsOn)?.status ?? 'queued');
    if (parentState !== 'done') {
      // Parent rejected or still unresolved: skipped THIS CYCLE (§5) —
      // an attachment never arrives for a job the server refused.
      continue;
    }

    const upload = attachmentUploadOf(row);
    if (upload === null) {
      // A descriptor that cannot be read will never upload; keep the row
      // and surface it as a rejection rather than loop on it forever.
      settleRejected(database, row.id, 'UNREADABLE_UPLOAD', 'The queued attachment could not be read from this phone.');
      result.rejected += 1;
      deps.onEvent?.({
        type: 'row-rejected',
        rowId: row.id,
        entityType: row.entityType,
        entityLocalId: row.entityLocalId,
        errorCode: 'UNREADABLE_UPLOAD',
        message: 'The queued attachment could not be read from this phone.',
      });
      continue;
    }

    database.runSync(`UPDATE outbox SET status = 'inflight' WHERE id = ? AND status = 'queued'`, row.id);
    const res = await deps.send('POST', '/v1/attachments', {
      body: multipartFor(upload),
      idempotencyKey: row.idempotencyKey, // its own key, minted at enqueue
    });

    if (res.ok) {
      // Uploaded (or an idempotent replay of the upload): the local file's
      // release is triggered by the row leaving `queued` for `done`.
      settleDone(database, row.id);
      result.uploaded += 1;
    } else if (res.status === 0) {
      postponeRow(database, row.id, now(), res.error?.message ?? 'No connection.');
      result.deferred += 1;
    } else if (res.status === 401) {
      const verdict = authVerdictOf(res);
      unclaimRow(database, row.id);
      if (verdict.authLost) {
        result.authLost = true;
        deps.onEvent?.({ type: 'auth-lost', reason: verdict.reason });
      }
    } else if (res.status >= 500) {
      // The server is in trouble, not the work: retry with backoff.
      postponeRow(database, row.id, now(), res.error?.message ?? 'The server could not take the upload.');
      result.deferred += 1;
    } else {
      settleRejected(
        database,
        row.id,
        res.error?.code ?? 'REJECTED',
        res.error?.message ?? 'The server refused this upload.',
      );
      result.rejected += 1;
      deps.onEvent?.({
        type: 'row-rejected',
        rowId: row.id,
        entityType: row.entityType,
        entityLocalId: row.entityLocalId,
        errorCode: res.error?.code ?? 'REJECTED',
        message: res.error?.message ?? 'The server refused this upload.',
      });
    }
  }

  // ── delta, after both passes (§5) ───────────────────────────────────────
  if (!result.authLost) {
    const stored = batchCursor ?? readCursor(mirror);
    if (stored !== null) {
      let cursor: string = stored;
      for (;;) {
        const res: ApiResult<SyncDeltaResponse> = await deps.send<SyncDeltaResponse>(
          'GET',
          `/v1/sync/delta?cursor=${encodeURIComponent(cursor)}`,
        );
        if (res.status === 401) {
          const verdict = authVerdictOf(res);
          if (verdict.authLost) {
            result.authLost = true;
            deps.onEvent?.({ type: 'auth-lost', reason: verdict.reason });
            break;
          }
          break; // retryable: next trigger re-polls from the same cursor
        }
        if (!res.ok || res.data === null) break; // network/server trouble: the stored cursor is untouched, the next cycle re-polls
        applyDeltaPage(mirror, res.data);
        result.deltaPages += 1;
        cursor = res.data.cursor;
        if (!res.data.hasMore) break;
      }
    }
  }

  result.paused = result.authLost;
  deps.onEvent?.({ type: 'cycle-done', result });
  return result;
}

/**
 * The batches' rows were already `queued` when selected; claim them
 * inflight for the flight so a logout gate and a concurrent trigger see
 * the truth. Rows another cycle already settled (impossible under the
 * single-flight manager, cheap to guard) are left alone.
 */
function claimQueued(database: Mirror['database'], rows: readonly OutboxRow[]): void {
  database.withTransactionSync(() => {
    for (const row of rows) {
      database.runSync(`UPDATE outbox SET status = 'inflight' WHERE id = ? AND status = 'queued'`, row.id);
    }
  });
}

/** The binary pass's multipart body (§9): one file part plus the five
 * fields the route validates, built from the descriptor stored at enqueue.
 * The `{ uri, name, type }` file part is React Native's FormData shape —
 * the DOM type does not know it, hence the cast.
 */
function multipartFor(upload: AttachmentUpload): FormData {
  const form = new FormData();
  form.append('ownerType', upload.ownerType);
  form.append('ownerId', upload.ownerId);
  form.append('kind', upload.kind);
  form.append('capturedAt', upload.capturedAt);
  form.append('fileChecksum', upload.fileChecksum);
  if (upload.caption !== undefined) form.append('caption', upload.caption);
  form.append(
    'file',
    { uri: upload.fileUri, name: upload.fileName, type: upload.mimeType } as unknown as Blob,
  );
  return form;
}

// ── the manager: pause state, single flight, triggers ───────────────────────

export interface DrainTriggers {
  /** Reconnect (expo-network / NetInfo). */
  onReconnect?: (notify: () => void) => () => void;
  /** App foreground (AppState). */
  onForeground?: (notify: () => void) => () => void;
  /** Whether the app is foregrounded — gates the 60-second timer ("while
   * active"); absent means always active. */
  isActive?: () => boolean;
}

export interface DrainManager {
  /** Manual trigger — pull-to-refresh, the profile's *Retry now*. */
  drainNow(): Promise<DrainResult>;
  /** Wire the system triggers; returns the unsubscribe. */
  start(triggers: DrainTriggers): () => void;
  isPaused(): boolean;
  /** After a successful re-login the app lifts the pause. */
  resume(): void;
}

const DRAIN_INTERVAL_MS = 60_000;

export function createDrainManager(deps: DrainDeps): DrainManager {
  let paused = false;
  let inFlight: Promise<DrainResult> | null = null;

  function cycle(): Promise<DrainResult> {
    if (paused) {
      return Promise.resolve({ ...emptyResult(), ran: false, paused: true });
    }
    return drainOnce(deps).then((result) => {
      if (result.authLost) paused = true;
      return result;
    });
  }

  return {
    drainNow() {
      // One cycle at a time, whatever triggered it (§5: the triggers share
      // the drain; a reconnect during a pull-to-refresh waits for it).
      inFlight ??= cycle().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    start(triggers) {
      const unsubscribes: Array<() => void> = [];
      if (triggers.onReconnect !== undefined) {
        unsubscribes.push(triggers.onReconnect(() => void this.drainNow()));
      }
      if (triggers.onForeground !== undefined) {
        unsubscribes.push(triggers.onForeground(() => void this.drainNow()));
      }
      const timer = setInterval(() => {
        if (triggers.isActive?.() ?? true) void this.drainNow();
      }, DRAIN_INTERVAL_MS);
      unsubscribes.push(() => clearInterval(timer));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },

    isPaused() {
      return paused;
    },

    resume() {
      paused = false;
    },
  };
}
