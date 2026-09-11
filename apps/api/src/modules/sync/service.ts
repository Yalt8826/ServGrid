import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import {
  type JobCardTechnician,
  type SyncBatchRequest,
  type SyncDeltaResponse,
  type SyncOperation,
  type SyncOperationResult,
  type SyncTombstone,
  type SyncWorkingSet,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import * as repo from './repo.js';

/**
 * Sync service (PLAN-BACKEND.md §7): the three doors of the offline mirror
 * — bootstrap (cold start), delta (catch-up with tombstones), batch (the
 * outbox drain). One actor shape only in Phase 1: the technician. The
 * sales-rep working set (companies + house accounts with balances) is the
 * sales module's door (Phase 2); dispatcher and owner are online by
 * design and use the normal REST surface.
 *
 * THREE DECISIONS THE DIFF DEPENDS ON:
 *
 *  1. One snapshot per sync read. Bootstrap and delta run inside a
 *     REPEATABLE READ READ ONLY transaction, and the cursor they return is
 *     computed in that same snapshot: the newest `updated_at` anywhere in
 *     the five syncable collections. A row the snapshot could see is
 *     therefore delivered (or tombstoned) at that cursor — the response
 *     never hands out a cursor ahead of its own data. What remains is the
 *     in-flight window: a write transaction that started before the
 *     snapshot and commits after it carries `updated_at = now()` of its
 *     start, below the cursor, and lands on the NEXT poll instead. Every
 *     write in this app is a short request transaction, and the client
 *     re-polls — the same trade every `updated_at`-cursor protocol makes
 *     without commit-sequence infrastructure.
 *
 *  2. The delta query runs twice, and only the first half is cursor-
 *     bounded (§7). Rows: the working set under `updated_at > cursor`.
 *     Tombstones: bounded by the bootstrap WINDOW alone — scope exit is a
 *     property of the working set, not of a timestamp, and a cursor-bounded
 *     tombstone scan can lose entries across a multi-page delta. The
 *     out-of-scope job scan is the spec's own query — `assigned_to IS
 *     DISTINCT FROM :actor` over in-window jobs — which over-reports rows
 *     he never held (a tombstone for a row the mirror lacks is a no-op
 *     delete) and under-reports nothing. See repo.ts.
 *
 *  3. The batch executes each operation through the REAL stack —
 *     `app.inject` with the actor's own credentials — not by re-implementing
 *     route semantics here. Each operation is its own request lifecycle:
 *     its own transaction (ordered, not atomic), its own rbac checks, its
 *     own idempotency claim (the op's key replays a stored response as a
 *     `duplicate`), its own error envelope. "Ordered, not atomic" falls out
 *     structurally: one rejection cannot roll a day's other work back,
 *     because nothing shares a transaction.
 *
 * A tombstone never deletes an outbox row — there is nothing server-side
 * to delete: tombstones only describe mirror rows, and a drained op that
 * reaches a reassigned job gets a first-class verdict on drain
 * (OUT_OF_SCOPE / JOB_ALREADY_CLOSED from the jobs service), never a
 * silent discard.
 */

/** Extra headers an operation may carry — `If-Match` for PATCH today. Anything else is a malformed envelope. */
const ALLOWED_OP_HEADERS = new Set(['if-match']);

/** Bootstrap delivers whole collections; the caps below are sanity bounds, not pagination. */
const BOOTSTRAP_ENTITY_LIMIT = 10_000;

/** Cross-op envelope validation (§7: a 4xx on the batch itself is a client bug). */
function validateOperationGraph(operations: readonly SyncOperation[]): void {
  const seen = new Set<string>();
  for (const op of operations) {
    if (seen.has(op.localId)) {
      throw new AppError('VALIDATION_FAILED', `Two queued operations share the local reference ${op.localId}.`);
    }
    seen.add(op.localId);
    if (op.dependsOn !== undefined && !seen.has(op.dependsOn)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Operation ${op.localId} depends on ${op.dependsOn}, which is not an earlier operation in this batch.`,
      );
    }
    for (const [name, value] of Object.entries(op.headers ?? {})) {
      if (!ALLOWED_OP_HEADERS.has(name.toLowerCase())) {
        throw new AppError('VALIDATION_FAILED', `Operation ${op.localId} carries a header this API does not accept: ${name}.`);
      }
      // Header values ride an HTTP request; a control character is forgery, not a header.
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new AppError('VALIDATION_FAILED', `Operation ${op.localId} has a malformed header value for ${name}.`);
      }
    }
  }
}

/**
 * One REPEATABLE READ READ ONLY transaction: all five collections and the
 * cursor read the same snapshot (decision 1). Read-only, so even a bug
 * here cannot write; the sync endpoints are the hottest reads in the app.
 */
async function withReadSnapshot<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

// ── row → wire mappers, one per schema; each returns exactly its schema's keys ──

function isoOrNull(t: Date | null): string | null {
  return t === null ? null : t.toISOString();
}

function toSyncJob(row: repo.SyncJobRow): JobCardTechnician {
  // `contract` needs migration 015 (Phase 2B); the field is null, not
  // absent — the mirror schema is already the contract-bearing shape.
  return {
    id: row.id,
    jobNumber: row.job_number,
    title: row.title,
    status: row.status as JobCardTechnician['status'],
    priority: row.priority as JobCardTechnician['priority'],
    scheduledFor: isoOrNull(row.scheduled_for),
    customerId: row.customer_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    description: row.description,
    contract: null,
    version: row.version,
  };
}

function toSyncCustomer(row: repo.SyncCustomerRow): SyncWorkingSet['customers'][number] {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    altPhone: row.alt_phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes,
    companyId: row.company_id,
    version: row.version,
  };
}

function toSyncCustomerProduct(row: repo.SyncCustomerProductRow): SyncWorkingSet['customerProducts'][number] {
  return {
    id: row.id,
    customerId: row.customer_id,
    productId: row.product_id,
    freeTextName: row.free_text_name,
    serialNumber: row.serial_number,
    quantity: row.quantity,
    installedOn: row.installed_on,
    warrantyExpiresOn: row.warranty_expires_on,
    notes: row.notes,
    version: row.version,
  };
}

function toSyncProduct(row: repo.SyncProductRow): SyncWorkingSet['products'][number] {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category as SyncWorkingSet['products'][number]['category'],
    brand: row.brand,
    modelNumber: row.model_number,
    capacityLabel: row.capacity_label,
    unit: row.unit,
    defaultPrice: row.default_price,
    warrantyMonths: row.warranty_months,
    version: row.version,
  };
}

function toSyncService(row: repo.SyncServiceRow): SyncWorkingSet['services'][number] {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    defaultCharge: row.default_charge,
    version: row.version,
  };
}

interface TaggedRow {
  entity: 'jobs' | 'customers' | 'customerProducts' | 'products' | 'services';
  at: string;
  row: unknown;
}

/**
 * The page cut (§7 "server caps the page"): rows from all five scans,
 * oldest first, cut at a timestamp GROUP boundary so one `updated_at` never
 * splits across pages — the next request resumes strictly after the
 * returned cursor and nothing is re-delivered or skipped. The one way to
 * break the invariant is a single transaction writing more than
 * `DELTA_PAGE_LIMIT` syncable rows (they share one `now()`); the largest
 * write set in this app is a completion, under ten rows.
 */
function pageCut(tagged: TaggedRow[]): { page: TaggedRow[]; hasMore: boolean } {
  if (tagged.length <= repo.DELTA_PAGE_LIMIT) {
    return { page: tagged, hasMore: false };
  }
  let cut = repo.DELTA_PAGE_LIMIT;
  while (cut < tagged.length && tagged[cut]!.at === tagged[cut - 1]!.at) {
    cut++;
  }
  return { page: tagged.slice(0, cut), hasMore: cut < tagged.length };
}

/** Fixed-width cursors: lexicographic IS chronological, so the monotonic clamp is a string compare. */
function cursorMax(a: string, b: string): string {
  return a >= b ? a : b;
}

async function readWorkingSet(
  client: PoolClient,
  actorId: string,
  cursor: string | null,
  limit: number,
): Promise<{ tagged: TaggedRow[]; data: SyncWorkingSet }> {
  // Sequential on purpose: one PoolClient runs one query at a time, and
  // every query here must share the caller's snapshot anyway.
  const jobs = await repo.workingSetJobs(client, actorId, repo.SYNC_WINDOW_DAYS, cursor, limit);
  const customers = await repo.workingSetCustomers(client, actorId, repo.SYNC_WINDOW_DAYS, cursor, limit);
  const customerProducts = await repo.workingSetCustomerProducts(client, actorId, repo.SYNC_WINDOW_DAYS, cursor, limit);
  const products = await repo.workingSetProducts(client, cursor, limit);
  const services = await repo.workingSetServices(client, cursor, limit);
  return {
    tagged: [
      ...jobs.map((row): TaggedRow => ({ entity: 'jobs', at: row.updated_at_text, row })),
      ...customers.map((row): TaggedRow => ({ entity: 'customers', at: row.updated_at_text, row })),
      ...customerProducts.map((row): TaggedRow => ({ entity: 'customerProducts', at: row.updated_at_text, row })),
      ...products.map((row): TaggedRow => ({ entity: 'products', at: row.updated_at_text, row })),
      ...services.map((row): TaggedRow => ({ entity: 'services', at: row.updated_at_text, row })),
    ],
    data: {
      jobs: jobs.map(toSyncJob),
      customers: customers.map(toSyncCustomer),
      customerProducts: customerProducts.map(toSyncCustomerProduct),
      products: products.map(toSyncProduct),
      services: services.map(toSyncService),
    },
  };
}

export function createSyncService(app: FastifyInstance) {
  /** GET /v1/sync/bootstrap — the full working set, one snapshot, cursor = the snapshot's position. */
  async function bootstrap(actorId: string): Promise<{ data: SyncWorkingSet; cursor: string }> {
    return withReadSnapshot(async (client) => {
      const { data } = await readWorkingSet(client, actorId, null, BOOTSTRAP_ENTITY_LIMIT);
      const universe = await repo.universeCursor(client);
      return { data, cursor: universe ?? (await repo.snapshotCursor(client)) };
    });
  }

  /** GET /v1/sync/delta — newer in-scope rows + window-bounded tombstones + a monotonic cursor. */
  async function delta(actorId: string, cursor: string): Promise<SyncDeltaResponse> {
    return withReadSnapshot(async (client) => {
      const { tagged } = await readWorkingSet(client, actorId, cursor, repo.DELTA_PAGE_LIMIT + 1);
      tagged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const { page, hasMore } = pageCut(tagged);

      // Split the delivered page back into the wire collections.
      const pageData: SyncWorkingSet = {
        jobs: [],
        customers: [],
        customerProducts: [],
        products: [],
        services: [],
      };
      for (const entry of page) {
        switch (entry.entity) {
          case 'jobs':
            pageData.jobs.push(toSyncJob(entry.row as repo.SyncJobRow));
            break;
          case 'customers':
            pageData.customers.push(toSyncCustomer(entry.row as repo.SyncCustomerRow));
            break;
          case 'customerProducts':
            pageData.customerProducts.push(toSyncCustomerProduct(entry.row as repo.SyncCustomerProductRow));
            break;
          case 'products':
            pageData.products.push(toSyncProduct(entry.row as repo.SyncProductRow));
            break;
          case 'services':
            pageData.services.push(toSyncService(entry.row as repo.SyncServiceRow));
            break;
        }
      }

      // The second scan (§7): window-bounded, not cursor-bounded — decision 2.
      // Sequential: the scans share this snapshot's single client.
      const jobsOutOfScope = await repo.tombstoneJobsOutOfScope(client, actorId, repo.SYNC_WINDOW_DAYS, repo.TOMBSTONE_LIMIT);
      const customersDeleted = await repo.tombstoneCustomersDeleted(client, actorId, repo.SYNC_WINDOW_DAYS, repo.TOMBSTONE_LIMIT);
      const customersOutOfScope = await repo.tombstoneCustomersOutOfScope(client, actorId, repo.SYNC_WINDOW_DAYS, repo.TOMBSTONE_LIMIT);
      const customerProductsDeleted = await repo.tombstoneCustomerProductsDeleted(client, actorId, repo.SYNC_WINDOW_DAYS, repo.TOMBSTONE_LIMIT);
      const productsDeleted = await repo.tombstoneProductsDeleted(client, repo.SYNC_WINDOW_DAYS, repo.TOMBSTONE_LIMIT);
      const servicesDeleted = await repo.tombstoneServicesDeleted(client, repo.SYNC_WINDOW_DAYS, repo.TOMBSTONE_LIMIT);
      const tombstones: SyncTombstone[] = [
        ...jobsOutOfScope.map((r): SyncTombstone => ({ entity: 'job', id: r.id, reason: 'out_of_scope' })),
        ...customersDeleted.map((r): SyncTombstone => ({ entity: 'customer', id: r.id, reason: 'deleted' })),
        ...customersOutOfScope.map((r): SyncTombstone => ({ entity: 'customer', id: r.id, reason: 'out_of_scope' })),
        ...customerProductsDeleted.map((r): SyncTombstone => ({ entity: 'customer_product', id: r.id, reason: 'deleted' })),
        ...productsDeleted.map((r): SyncTombstone => ({ entity: 'product', id: r.id, reason: 'deleted' })),
        ...servicesDeleted.map((r): SyncTombstone => ({ entity: 'service', id: r.id, reason: 'deleted' })),
      ];

      // The cursor is the server's `updated_at`, never the device clock —
      // and never a step below what the client already has (decision 1).
      const universe = await repo.universeCursor(client);
      const fresh = universe ?? (await repo.snapshotCursor(client));
      return { data: pageData, tombstones, cursor: cursorMax(fresh, cursor), hasMore };
    });
  }

  // ── the batch — the outbox drain (§7) ─────────────────────────────────────

  function parseInnerBody(text: string): unknown {
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** One operation, through the real stack. */
  async function drainOne(
    actorId: string,
    forwarded: Record<string, string>,
    op: SyncOperation,
  ): Promise<SyncOperationResult> {
    // The idempotency layer's stored response IS the duplicate outcome —
    // replay it without touching the route, the reconnect case of §3.2
    // path 3 applied to the drain. A key still in flight elsewhere loses
    // nothing: the injected attempt below gets the plugin's 409 and comes
    // back `rejected` for the client to re-drain.
    if (op.idempotencyKey) {
      const stored = await repo.findStoredIdempotentResponse(getPool(), actorId, op.idempotencyKey);
      if (stored !== null) {
        return {
          localId: op.localId,
          outcome: 'duplicate',
          status: stored.response_status,
          body: parseInnerBody(stored.response_text),
        };
      }
    }

    const headers: Record<string, string> = { ...forwarded };
    if (op.idempotencyKey !== undefined) headers['idempotency-key'] = op.idempotencyKey;
    for (const [name, value] of Object.entries(op.headers ?? {})) {
      headers[name.toLowerCase()] = value;
    }

    // app.inject's overloads confuse the structural extraction of its
    // option type (the last overload carries a Node callback), so the
    // options go in as the exact object literal inject takes and the
    // response is read through the two fields the drain needs.
    const injectOptions: Record<string, unknown> = { method: op.method, url: op.path, headers };
    if (op.body !== undefined) injectOptions.payload = op.body;
    const inner = (await app.inject(injectOptions as never)) as { statusCode: number; body: string };

    const body = parseInnerBody(inner.body);
    if (inner.statusCode < 400) {
      return { localId: op.localId, outcome: 'applied', status: inner.statusCode, body };
    }
    // 4xx is a verdict (rejected); 5xx is a server fault the client may
    // re-drain — the op's idempotency key makes either safe to retry, so
    // both are first-class `rejected` outcomes, never an envelope failure.
    const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    return {
      localId: op.localId,
      outcome: 'rejected',
      status: inner.statusCode,
      error: {
        code: error?.code ?? 'INTERNAL',
        message: error?.message ?? 'The server could not apply this queued update — it will be retried.',
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  /**
   * POST /v1/sync/batch — ordered, not atomic; `dependsOn` short-circuits;
   * always HTTP 200 once the envelope parsed. Each operation runs in its
   * own request lifecycle through `app.inject` (decision 3), so "the child
   * handler never ran" is a property of the real stack, not of a stub.
   */
  async function drain(
    actor: { id: string },
    request: SyncBatchRequest,
    forwarded: { authorization?: string; clientSource?: string },
  ): Promise<{ results: SyncOperationResult[]; cursor: string }> {
    validateOperationGraph(request.operations);

    // The actor's own credentials ride every injected operation: the ops
    // are re-executions of HIS queued requests, authenticated as him.
    const forwardedHeaders: Record<string, string> = {};
    if (forwarded.authorization !== undefined) forwardedHeaders.authorization = forwarded.authorization;
    if (forwarded.clientSource !== undefined) forwardedHeaders['x-client-source'] = forwarded.clientSource;

    const results: SyncOperationResult[] = [];
    const outcomeByLocalId = new Map<string, SyncOperationResult['outcome']>();
    for (const op of request.operations) {
      const parentOutcome = op.dependsOn === undefined ? undefined : outcomeByLocalId.get(op.dependsOn);
      let result: SyncOperationResult;
      if (parentOutcome === 'rejected' || parentOutcome === 'skipped') {
        // §7: a rejected parent returns its child `skipped`, unattempted —
        // a rejected status change must not be followed by a completion
        // that fails for a confusing second reason.
        result = {
          localId: op.localId,
          outcome: 'skipped',
          status: 0,
          error: {
            code: parentOutcome === 'rejected' ? 'PARENT_REJECTED' : 'PARENT_SKIPPED',
            message:
              parentOutcome === 'rejected'
                ? `The queued step ${op.dependsOn} was rejected, so this one was not attempted.`
                : `The queued step ${op.dependsOn} was skipped, so this one was not attempted.`,
          },
        };
      } else {
        result = await drainOne(actor.id, forwardedHeaders, op);
      }
      outcomeByLocalId.set(op.localId, result.outcome);
      results.push(result);
    }

    // §7: "the client drains, then immediately calls delta with the cursor
    // from the batch response". The batch's own writes are committed by
    // now (each op's transaction), so the cursor sees them.
    const cursor = await withReadSnapshot(async (client) => {
      const universe = await repo.universeCursor(client);
      return universe ?? (await repo.snapshotCursor(client));
    });
    return { results, cursor };
  }

  return { bootstrap, delta, drain };
}

export type SyncService = ReturnType<typeof createSyncService>;
