/**
 * Route-level wiring for the O2 cash reconciliation queue (T4.9). The
 * screen is pure over injected data; this module is the seam that feeds
 * it — the owner is ONLINE-ONLY (PLAN.md §5: no mirror, no outbox), so
 * the seam is a react-query read plus three writes against the api
 * client:
 *
 * - **queue** — `GET /v1/cash/queue` (T4.2). The DEFAULT range is the
 *   server's (last 14 days ending YESTERDAY — never built here, the
 *   device clock has no vote); the Today preset pins `from`/`to` to the
 *   IST business day explicitly. The response's `today` is the caption's
 *   authority.
 * - **confirm / dispute / reopen** — `POST /v1/cash/handovers/:id/…`
 *   (§10), one idempotency key per open intent, regenerated only after a
 *   success — the rep's void rule. The refreshed row the action returns
 *   REPLACES the row in the cache: the flag recomputes in the view, the
 *   row stays in place, resolved.
 * - **day** — `GET /v1/cash/queue/day` (§O2 "View the day"), fetched per
 *   row on demand and dropped on dismiss.
 *
 * **`owner.cash`** gates the screen from `/v1/auth/me` like every flag
 * (PLAN-EXECUTION.md §3) — the route renders the honest placeholder while
 * it is dark; this is T4.9's T0 rollback, treated as an outage (see
 * docs/implementation/T4.9-RUNBOOK.md for the psql fallback).
 */
import { useCallback, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { AuthMeResponse, CashQueueRow, FeatureFlagState } from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { uuid } from '../../lib/uuid';
import { cachedFeatureFlags, setFeatureFlags } from '../../state/featureFlags';
import { useIsOnline } from '../dispatcher/useDispatcherDashboard';
import { istBusinessDate } from './locationModel';
import type { CashQueueDay, CashQueueFlagFilter, CashQueueRange } from './cash-queue';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The queue could not be read. Try again.');
  }
  return res.data;
}

/** POST that throws with the server's message — sheets render it verbatim. */
async function postJson<T>(path: string, body: unknown, idempotencyKey: string): Promise<T> {
  const res = await api.request<T>('POST', path, { body, idempotencyKey });
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The action did not go through. Try again.');
  }
  return res.data;
}

/** `owner.cash`, evaluated from `/v1/auth/me` like every flag. Until an
 * answer exists it reads off — the queue is dark, never half-lit. */
export function useOwnerCashFlag(): boolean {
  const cached = cachedFeatureFlags();
  const [on, setOn] = useState(() => cached?.['owner.cash'] ?? false);
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    if (cached === null) {
      void (async (): Promise<FeatureFlagState | null> => {
        const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
        if (!res.ok || res.data === null) return null;
        const flags = { ...defaultFeatureFlags(), ...res.data.featureFlags };
        setFeatureFlags(flags);
        return flags;
      })()
        .then((flags) => {
          if (flags !== null) setOn(flags['owner.cash']);
        })
        .catch(() => {});
    }
  }
  return on;
}

interface QueueEnvelope {
  today: string;
  from: string;
  to: string;
  rows: CashQueueRow[];
}

export interface CashQueueData {
  flagOn: boolean;
  offline: boolean;
  /** The server's IST today — from the response, never the device clock. */
  today: string;
  rows: CashQueueRow[] | null;
  error: string | null;
  loading: boolean;
  range: CashQueueRange;
  flagFilter: CashQueueFlagFilter;
  onRange: (range: CashQueueRange) => void;
  onFlagFilter: (flag: CashQueueFlagFilter) => void;
  onRetry: () => void;
  actionBusy: boolean;
  actionError: string | null;
  onConfirm: (row: CashQueueRow, confirmedAmount: string) => Promise<boolean>;
  onDispute: (row: CashQueueRow, ownerNote: string) => Promise<boolean>;
  onReopen: (row: CashQueueRow, reason: string) => Promise<boolean>;
  dayOpen: boolean;
  day: CashQueueDay | null;
  dayLoading: boolean;
  dayError: string | null;
  onViewDay: (row: CashQueueRow) => void;
  onDismissDay: () => void;
}

export function useCashQueue(): CashQueueData {
  const flagOn = useOwnerCashFlag();
  const offline = !useIsOnline();
  const queryClient = useQueryClient();

  const [range, setRange] = useState<CashQueueRange>('last14');
  const [flagFilter, setFlagFilter] = useState<CashQueueFlagFilter>('all');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState(false);
  const [day, setDay] = useState<CashQueueDay | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState<string | null>(null);

  const todayIst = istBusinessDate(Date.now());
  const query = range === 'today' ? `from=${todayIst}&to=${todayIst}` : '';
  const keyedQuery = flagFilter === 'all' ? query : `${query}${query === '' ? '' : '&'}flag=${flagFilter}`;
  const queueKey = ['owner', 'cash', 'queue', range, flagFilter] as const;

  const queue = useQuery({
    queryKey: queueKey,
    queryFn: () => fetchJson<QueueEnvelope>(`/v1/cash/queue${keyedQuery === '' ? '' : `?${keyedQuery}`}`),
    enabled: flagOn,
  });

  /** Replace one row with the refreshed row an action returned — the row
   * stays where it was, resolved; the flag recomputed in the view. */
  const replaceRow = useCallback(
    (refreshed: CashQueueRow) => {
      queryClient.setQueryData<QueueEnvelope>(queueKey, (prev) =>
        prev === undefined
          ? prev
          : {
              ...prev,
              rows: prev.rows.map((r) =>
                r.employeeId === refreshed.employeeId && r.businessDate === refreshed.businessDate ? refreshed : r,
              ),
            },
      );
    },
    [queryClient, queueKey],
  );

  /** One key per open intent (the rep's void rule): generated on the
   * first press, kept across retries of THAT intent, cleared on success
   * so the next action gets a fresh one. */
  const actionKey = useRef<string | null>(null);
  const runAction = useCallback(
    async (row: CashQueueRow, path: 'confirm' | 'dispute' | 'reopen', body: Record<string, string>): Promise<boolean> => {
      if (row.declarationId === null) return false;
      if (actionKey.current === null) actionKey.current = await uuid();
      setActionBusy(true);
      setActionError(null);
      try {
        const refreshed = await postJson<CashQueueRow>(
          `/v1/cash/handovers/${row.declarationId}/${path}`,
          body,
          actionKey.current,
        );
        actionKey.current = null;
        setActionBusy(false);
        replaceRow(refreshed);
        return true;
      } catch (e) {
        setActionBusy(false);
        setActionError(e instanceof Error && e.message !== '' ? e.message : 'The action did not go through. Try again.');
        return false;
      }
    },
    [replaceRow],
  );

  const onConfirm = useCallback(
    (row: CashQueueRow, confirmedAmount: string) => runAction(row, 'confirm', { confirmedAmount }),
    [runAction],
  );
  const onDispute = useCallback(
    (row: CashQueueRow, ownerNote: string) => runAction(row, 'dispute', { ownerNote }),
    [runAction],
  );
  const onReopen = useCallback(
    (row: CashQueueRow, reason: string) => runAction(row, 'reopen', { reason }),
    [runAction],
  );

  const onViewDay = useCallback(
    (row: CashQueueRow) => {
      setDayOpen(true);
      setDayLoading(true);
      setDayError(null);
      setDay(null);
      void fetchJson<CashQueueDay>(
        `/v1/cash/queue/day?employeeId=${row.employeeId}&businessDate=${row.businessDate}`,
      )
        .then((d) => {
          setDay(d);
          setDayLoading(false);
        })
        .catch((e) => {
          setDayError(e instanceof Error && e.message !== '' ? e.message : 'The day could not be read. Try again.');
          setDayLoading(false);
        });
    },
    [],
  );

  const onDismissDay = useCallback(() => {
    setDayOpen(false);
    setDay(null);
    setDayError(null);
  }, []);

  return {
    flagOn,
    offline,
    today: queue.data?.today ?? todayIst,
    rows: queue.data?.rows ?? null,
    error: queue.isError ? (queue.error instanceof Error ? queue.error.message : 'The queue could not be read.') : null,
    loading: queue.isLoading,
    range,
    flagFilter,
    onRange: setRange,
    onFlagFilter: setFlagFilter,
    onRetry: () => void queue.refetch(),
    actionBusy,
    actionError,
    onConfirm,
    onDispute,
    onReopen,
    dayOpen,
    day,
    dayLoading,
    dayError,
    onViewDay,
    onDismissDay,
  };
}
