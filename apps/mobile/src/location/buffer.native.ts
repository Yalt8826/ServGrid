/**
 * The ping buffer engine (PLAN-FRONTEND.md §6). Pings from the background
 * task are written to a local table and uploaded in batches of up to 200,
 * so a technician who spends two hours in a basement surfaces with the
 * real trail rather than a gap.
 *
 * Two rules carry the whole design:
 *
 * - **Prune on acknowledgement, including rejections.** The server's
 *   batch response is per-ping and stays HTTP 200 even when every ping
 *   is rejected (T1.9) — `OUT_OF_WINDOW` is a verdict, not a failure, so
 *   a rejected ping is DONE, never pending. Only a request that did not
 *   complete (network error, non-200 envelope) leaves the buffer intact
 *   for the next flush.
 * - **No compensating timer.** The engine drains what the OS's batching
 *   produced and never re-times or "corrects" cadence — the OS will not
 *   honour 15 minutes precisely and fighting that costs battery for
 *   nothing. The 45-minute staleness threshold in the health view exists
 *   to absorb exactly this jitter.
 *
 * Storage sits behind `PingBufferStore`; the SQLite implementation lives
 * in `bufferStore.native.ts` and tests drive an in-memory store. Pure
 * logic, `.native.ts` by rule — only the native location graph imports it.
 */
import type { LocationPingPayload, PingBatchResultParsed } from '@servgrid/shared';

/** The upload target. `Pick` of the one client keeps this testable
 * without the token store or the network. */
export type PingUploader = {
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts?: { body?: unknown },
  ): Promise<{ ok: boolean; status: number; data: T | null; error: { code: string; message: string } | null }>;
};

/** One buffered row — the engine's handle for pruning after an ack. */
export interface BufferedPing {
  id: number;
  ping: LocationPingPayload;
}

/** The storage seam. Implementations: SQLite on device (`bufferStore.native.ts`),
 * an in-memory fake in tests. Rows leave the table only through `remove`. */
export interface PingBufferStore {
  append(ping: LocationPingPayload): Promise<void>;
  /** The oldest rows, FIFO — a basement trail must reach the server in order. */
  oldest(limit: number): Promise<BufferedPing[]>;
  remove(ids: number[]): Promise<void>;
  count(): Promise<number>;
}

export interface PingBufferDeps {
  store: PingBufferStore;
  api: PingUploader;
  /** Server-side maximum batch size (locationPingBatchSchema). */
  batchSize?: number;
}

export interface PingFlushResult {
  /** Whether the flush round trip COMPLETED (a 200 with rejections counts). */
  completed: boolean;
  /** Rows pulled from the store and offered to the server this flush. */
  sent: number;
  accepted: number;
  rejected: number;
  /** Reject codes seen, at most one entry per ping (`rejected[i].code`). */
  codes: string[];
}

const BATCH_SIZE_MAX = 200;

const PINGS_PATH = '/v1/location/pings';

export interface PingBuffer {
  enqueue(ping: LocationPingPayload): Promise<void>;
  /** Drain up to one batch. Completed flushes prune the sent rows —
   * accepted AND rejected alike. */
  flush(): Promise<PingFlushResult>;
  /** Drain until the buffer is empty or a round trip fails to complete.
   * Iteration is capped so a pathological server cannot spin this forever. */
  flushAll(): Promise<PingFlushResult>;
  count(): Promise<number>;
}

export function createPingBuffer(deps: PingBufferDeps): PingBuffer {
  const batchSize = Math.min(deps.batchSize ?? BATCH_SIZE_MAX, BATCH_SIZE_MAX);

  async function flush(): Promise<PingFlushResult> {
    const rows = await deps.store.oldest(batchSize);
    if (rows.length === 0) {
      return { completed: true, sent: 0, accepted: 0, rejected: 0, codes: [] };
    }
    let result: { ok: boolean; status: number; data: PingBatchResultParsed | null; error: unknown };
    try {
      result = await deps.api.request('POST', PINGS_PATH, {
        body: { pings: rows.map((row) => row.ping) },
      });
    } catch {
      // A throw at the transport layer is an incomplete round trip — the
      // buffer stands and the next flush (next wake, next foreground) tries.
      return { completed: false, sent: rows.length, accepted: 0, rejected: 0, codes: [] };
    }
    if (!result.ok) {
      // Non-200 (rate limit, auth wall after refresh failed, …): the
      // server did not give per-ping verdicts, so nothing may be pruned.
      return { completed: false, sent: rows.length, accepted: 0, rejected: 0, codes: [] };
    }
    // 200 IS the acknowledgement — per-ping verdicts ride the body. A
    // rejection is a completed outcome: OUT_OF_WINDOW pings are done, not
    // pending, so the whole sent batch leaves the buffer.
    const body = result.data;
    const accepted = typeof body?.accepted === 'number' ? body.accepted : 0;
    const rejectedList = Array.isArray(body?.rejected) ? body.rejected : [];
    await deps.store.remove(rows.map((row) => row.id));
    return {
      completed: true,
      sent: rows.length,
      accepted,
      rejected: rejectedList.length,
      codes: rejectedList.map((entry) => entry.code),
    };
  }

  return {
    enqueue: (ping) => deps.store.append(ping),

    flush,

    async flushAll(): Promise<PingFlushResult> {
      // Cap well above any honest backlog: 7 days of pings at the OS's
      // real (batched) rate is hundreds, not thousands. A failed round
      // trip ends the drain — retry storms are what the cap exists to
      // make pointless. The result reported is the last round that
      // actually carried rows, not the empty probe that ended the drain.
      const maxRounds = 25;
      let last: PingFlushResult = { completed: true, sent: 0, accepted: 0, rejected: 0, codes: [] };
      for (let round = 0; round < maxRounds; round += 1) {
        const one = await flush();
        if (one.sent > 0) last = one;
        if (!one.completed || one.sent === 0) break;
      }
      return last;
    },

    count: () => deps.store.count(),
  };
}
