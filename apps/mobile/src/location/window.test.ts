/**
 * Work-window filter + buffer pruning (T1.16 tests, PLAN-FRONTEND.md §6).
 *
 * The boundary instants are constructed from explicit UTC timestamps so
 * the assertions prove the IST conversion — 09:00 IST is 03:30Z, 19:01
 * IST is 13:31Z — and the half-open `[09:00, 19:00)` convention matches
 * the server's ingest exactly (a boundary ping cannot be judged
 * differently by handset and server).
 *
 * The buffer rule under test: a response that acknowledges the batch —
 * even one containing ONLY rejections — prunes every sent row, because
 * a rejected ping is done, not pending.
 */
import { describe, expect, it } from 'vitest';

import type { LocationPingPayload } from '@servgrid/shared';

import { createPingBuffer, type BufferedPing, type PingBufferStore } from './buffer.native';
import { inWorkWindow, WORK_WINDOW, type WorkWindow } from './window.native';

// 2026-09-14 is a Monday; 2026-09-13 the Sunday before it.
const MONDAY = {
  at_0859_IST: new Date('2026-09-14T03:29:00.000Z'),
  at_0900_IST: new Date('2026-09-14T03:30:00.000Z'),
  at_1859_IST: new Date('2026-09-14T13:29:00.000Z'),
  at_1900_IST: new Date('2026-09-14T13:30:00.000Z'),
  at_1901_IST: new Date('2026-09-14T13:31:00.000Z'),
};

const SUNDAY = {
  at_1000_IST: new Date('2026-09-13T04:30:00.000Z'),
  at_1859_IST: new Date('2026-09-13T13:29:00.000Z'),
};

describe('inWorkWindow (device-side filter, 09:00–19:00 IST Mon–Sat)', () => {
  it('§ discards 08:59 and 19:01 IST', () => {
    expect(inWorkWindow(MONDAY.at_0859_IST)).toBe(false);
    expect(inWorkWindow(MONDAY.at_1901_IST)).toBe(false);
  });

  it('§ buffers 09:00 and 18:59 IST', () => {
    expect(inWorkWindow(MONDAY.at_0900_IST)).toBe(true);
    expect(inWorkWindow(MONDAY.at_1859_IST)).toBe(true);
  });

  it('the window is half-open: 19:00 IST exactly is out, like the server', () => {
    expect(inWorkWindow(MONDAY.at_1900_IST)).toBe(false);
  });

  it('§ discards a Sunday ping regardless of hour', () => {
    expect(inWorkWindow(SUNDAY.at_1000_IST)).toBe(false);
    expect(inWorkWindow(SUNDAY.at_1859_IST)).toBe(false);
  });

  it('judges the IST wall clock, not the device timezone', () => {
    // The same instant, rendered from a hand-set UTC+8 clock, must still
    // be judged by Asia/Kolkata: 12:29 IST (in) is 14:59 in UTC+8.
    const instant = new Date('2026-09-14T06:59:00.000Z'); // 12:29 IST — inside
    expect(inWorkWindow(instant)).toBe(true);
    expect(WORK_WINDOW).toEqual({ start: '09:00', end: '19:00' } satisfies WorkWindow);
  });
});

// ── buffer pruning ──────────────────────────────────────────────────────────

function pingAt(id: number): LocationPingPayload {
  return {
    recordedAt: `2026-09-14T0${id}:30:00.000Z`,
    latitude: 12.9716,
    longitude: 77.5946,
    accuracyM: 20,
    source: 'scheduled',
  };
}

interface MemHarness {
  store: PingBufferStore;
  rows: BufferedPing[];
  removals: number[][];
  appends: LocationPingPayload[];
}

function memoryStore(seed: LocationPingPayload[]): MemHarness {
  const rows: BufferedPing[] = seed.map((ping, i) => ({ id: i + 1, ping }));
  const removals: number[][] = [];
  const appends: LocationPingPayload[] = [];
  return {
    rows,
    removals,
    appends,
    store: {
      append: async (ping) => {
        appends.push(ping);
        rows.push({ id: rows.length + 1000, ping });
      },
      oldest: async (limit) => rows.slice(0, limit),
      remove: async (ids) => {
        // The honest fake: removal takes the rows out, so a flushAll
        // actually drains instead of re-reading the same head forever.
        removals.push(ids);
        const gone = new Set(ids);
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (gone.has(rows[i]!.id)) rows.splice(i, 1);
        }
      },
      count: async () => rows.length,
    },
  };
}

type FakeResponse = {
  ok: boolean;
  status: number;
  data: { accepted: number; rejected: Array<{ index: number; code: string }> } | null;
  error: { code: string; message: string } | null;
};

function apiAnswering(answer: FakeResponse | 'throw'): {
  api: Parameters<typeof createPingBuffer>[0]['api'];
  bodies: unknown[];
} {
  const bodies: unknown[] = [];
  return {
    bodies,
    api: {
      request: async <T,>(_method: string, _path: string, opts?: { body?: unknown }) => {
        bodies.push(opts?.body);
        if (answer === 'throw') throw new Error('network gone');
        return {
          ok: answer.ok,
          status: answer.status,
          data: answer.data as T | null,
          error: answer.error,
        };
      },
    },
  };
}

describe('ping buffer (batched upload, prune on acknowledgement)', () => {
  it('§ prunes the whole batch on a response containing only rejections', async () => {
    const harness = memoryStore([pingAt(1), pingAt(2), pingAt(3)]);
    const { api } = apiAnswering({
      ok: true,
      status: 200,
      data: {
        accepted: 0,
        rejected: [
          { index: 0, code: 'OUT_OF_WINDOW' },
          { index: 1, code: 'OUT_OF_WINDOW' },
          { index: 2, code: 'TOO_OLD' },
        ],
      },
      error: null,
    });
    const buffer = createPingBuffer({ store: harness.store, api });

    const result = await buffer.flush();

    expect(result.completed).toBe(true);
    expect(result.sent).toBe(3);
    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(3);
    // An OUT_OF_WINDOW ping is done, not pending: every sent row is gone.
    expect(harness.removals).toEqual([[1, 2, 3]]);
  });

  it('prunes accepted and rejected alike on a mixed verdict, and reports the codes', async () => {
    const harness = memoryStore([pingAt(1), pingAt(2)]);
    const { api } = apiAnswering({
      ok: true,
      status: 200,
      data: { accepted: 1, rejected: [{ index: 1, code: 'DUPLICATE' }] },
      error: null,
    });
    const buffer = createPingBuffer({ store: harness.store, api });

    const result = await buffer.flush();

    expect(harness.removals).toEqual([[1, 2]]);
    expect(result.accepted).toBe(1);
    expect(result.codes).toEqual(['DUPLICATE']);
  });

  it('keeps the buffer when the round trip does not complete (non-200, network)', async () => {
    const harness = memoryStore([pingAt(1)]);
    const refused = apiAnswering({ ok: false, status: 429, data: null, error: { code: 'RATE_LIMITED', message: 'x' } });
    const bufferRefused = createPingBuffer({ store: harness.store, api: refused.api });
    const refused1 = await bufferRefused.flush();
    expect(refused1.completed).toBe(false);
    expect(harness.removals).toEqual([]);

    const threw = apiAnswering('throw');
    const bufferThrew = createPingBuffer({ store: harness.store, api: threw.api });
    const threw1 = await bufferThrew.flush();
    expect(threw1.completed).toBe(false);
    expect(harness.removals).toEqual([]);
  });

  it('uploads in batches of up to 200, oldest first, and drains in order', async () => {
    const seed = Array.from({ length: 250 }, (_, i) => pingAt((i % 9) + 1));
    const harness = memoryStore(seed);
    const { api, bodies } = apiAnswering({
      ok: true,
      status: 200,
      data: { accepted: 200, rejected: [] },
      error: null,
    });
    const buffer = createPingBuffer({ store: harness.store, api });

    const first = await buffer.flush();
    expect(first.sent).toBe(200);
    // Server-side cap (locationPingBatchSchema: pings max 200).
    expect((bodies[0] as { pings: unknown[] }).pings).toHaveLength(200);
    expect(harness.removals[0]).toHaveLength(200);

    const last = await buffer.flushAll();
    expect(last.sent).toBe(50);
    expect(bodies).toHaveLength(2);
  });

  it('flush on an empty buffer completes without a request', async () => {
    const harness = memoryStore([]);
    const { api, bodies } = apiAnswering({ ok: true, status: 200, data: { accepted: 0, rejected: [] }, error: null });
    const buffer = createPingBuffer({ store: harness.store, api });

    const result = await buffer.flush();

    expect(result).toEqual({ completed: true, sent: 0, accepted: 0, rejected: 0, codes: [] });
    expect(bodies).toHaveLength(0);
  });
});
