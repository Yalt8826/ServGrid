/**
 * Data seam for the owner's O4 jobs screens (T4.11, §O4). The same
 * layering as `useOwnerData`: the screens are pure over injected deps,
 * this hook owns the online reads and the writes, and the URL owns the
 * filter state — the dispatcher's rule (§D2), kept because the owner's
 * phone list mounts the dispatcher's filter bar.
 *
 * - **list** — `GET /v1/jobs`, the owner envelope (`JobCardOwner[]` —
 *   the schema that carries the money the dispatcher's never does), the
 *   filters translated by the dispatcher's `jobLogsListQuery`, cursor
 *   paginated. Technician names ride the roster read
 *   (`GET /v1/technicians/load`), the same source Job Logs uses.
 * - **detail** — `GET /v1/jobs/:id/events` (§6.3) for the side
 *   detail: the full `job_events` timeline plus the completion with its
 *   parts.
 * - **amend** — `POST /v1/jobs/:id/completion/amend`, reason required,
 *   one idempotency key per intent. A 409
 *   `RECONCILIATION_CONFIRMED` becomes the refusal the sheet renders
 *   WITH its reconciliation (`details.reconciliation`), which is what
 *   lets the UI offer the reopen — `POST
 *   /v1/cash/handovers/:id/reopen`, its own reason, its own key. Two
 *   deliberate steps: reopen succeeds, then the owner presses Amend
 *   again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';

import type {
  AuthMeResponse,
  FeatureFlagState,
  JobCardOwner,
  JobTimelineOwnerResponse,
  TechnicianLoad,
} from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { uuid } from '../../lib/uuid';
import { cachedFeatureFlags, setFeatureFlags } from '../../state/featureFlags';
import { useIsOnline } from '../dispatcher/useDispatcherDashboard';
import {
  jobLogsFiltersFromParams,
  jobLogsFiltersToParams,
  jobLogsListQuery,
  type JobLogsParams,
} from '../dispatcher/jobLogsFilters';
import type { JobLogsTechnician } from '../dispatcher/job-logs';
import type { AmendRefusal } from './AmendSheet';
import type { JobRow } from './jobsModel';

const PAGE_LIMIT = 200;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

interface JobListEnvelope {
  items: JobCardOwner[];
  nextCursor: string | null;
}

/** `owner.amend`, evaluated from `/v1/auth/me` like every flag. */
export function useOwnerAmendFlag(): boolean {
  const cached = cachedFeatureFlags();
  const [on, setOn] = useState<boolean>(cached?.['owner.amend'] ?? false);
  useEffect(() => {
    if (cachedFeatureFlags() !== null) return;
    let alive = true;
    void (async (): Promise<FeatureFlagState | null> => {
      const res = await api.request<AuthMeResponse>('GET', '/v1/auth/me');
      if (!res.ok || res.data === null) return null;
      const flags = { ...defaultFeatureFlags(), ...res.data.featureFlags };
      setFeatureFlags(flags);
      return flags;
    })()
      .then((flags) => {
        if (alive && flags !== null) setOn(flags['owner.amend']);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cached]);
  return on;
}

function jobLogsParamsKeyOf(params: JobLogsParams): string {
  return JSON.stringify([params.date, params.tech, params.status, params.q]);
}

/** The list + roster + flag. The detail reads live in `useOwnerJobDetail` below. */
export function useOwnerJobs(): {
  offline: boolean;
  loading: boolean;
  error: string | null;
  rows: JobRow[] | null;
  technicians: JobLogsTechnician[];
  filters: ReturnType<typeof jobLogsFiltersFromParams>['filters'];
  query: string;
  amendFlagOn: boolean;
  onFiltersChange(next: ReturnType<typeof jobLogsFiltersFromParams>['filters']): void;
  onQueryChange(query: string): void;
  onRetry(): void;
  onLoadMore(): void;
} {
  const router = useRouter();
  const params = useLocalSearchParams() as JobLogsParams;
  const offline = !useIsOnline();

  const paramsKey = jobLogsParamsKeyOf(params);
  const { filters, query } = useMemo(
    () => jobLogsFiltersFromParams(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey],
  );

  const amendFlagOn = useOwnerAmendFlag();

  const now = new Date();
  const listQuery = jobLogsListQuery(filters, query, now);
  const list = useInfiniteQuery({
    queryKey: ['owner', 'jobs', listQuery],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchJson<JobListEnvelope>(
        `/v1/jobs?${listQuery}${listQuery === '' ? '' : '&'}limit=${PAGE_LIMIT}${pageParam === null ? '' : `&cursor=${encodeURIComponent(pageParam)}`}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: JobListEnvelope) => last.nextCursor,
  });

  const rosterData = useQuery({
    queryKey: ['owner', 'technician-load'],
    queryFn: () => fetchJson<TechnicianLoad[]>('/v1/technicians/load'),
  }).data;

  const technicians: JobLogsTechnician[] = useMemo(
    () =>
      (rosterData ?? []).map((row) => ({
        employeeId: row.employeeId,
        name: row.technicianName,
        openTotal: row.openTotal,
      })),
    [rosterData],
  );

  const rows: JobRow[] | null = useMemo(() => {
    if (list.data === undefined) return null;
    return list.data.pages
      .flatMap((page: JobListEnvelope) => page.items)
      .map((card: JobCardOwner) => ({
        card,
        technicianName:
          card.assignedTo === null
            ? null
            : (technicians.find((t) => t.employeeId === card.assignedTo)?.name ?? null),
      }));
  }, [list.data, technicians]);

  return {
    offline,
    loading: list.isLoading,
    error: list.isError ? (list.error?.message ?? 'The jobs could not be read. Try again.') : null,
    rows,
    technicians,
    filters,
    query,
    amendFlagOn,
    onFiltersChange: (next) => router.setParams(jobLogsFiltersToParams(next, query)),
    onQueryChange: (next) => router.setParams(jobLogsFiltersToParams(filters, next)),
    onRetry: () => void list.refetch(),
    onLoadMore: () => {
      if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
    },
  };
}

/** The amend refusal as the sheet reads it — pulls the reconciliation out of the envelope's details. */
function amendRefusalOf(code: string | undefined, message: string, details: unknown): AmendRefusal {
  const reconciliation =
    code === 'RECONCILIATION_CONFIRMED' &&
    details !== null &&
    typeof details === 'object' &&
    'reconciliation' in details &&
    details.reconciliation !== null &&
    typeof details.reconciliation === 'object'
      ? (details.reconciliation as { id: string; businessDate: string; status: string })
      : null;
  return { message, reconciliation };
}

/** The amend + reopen writes, and the refusal that opens the reopen offer. */
export function useAmendCompletion(jobId: string | null, onDone: () => void): {
  amendBusy: boolean;
  amendError: AmendRefusal | null;
  reopenBusy: boolean;
  onAmend(input: { cost: string; discountAmount: string; discountReason: string; reason: string }): void;
  onReopen(reason: string): void;
} {
  const [amendBusy, setAmendBusy] = useState(false);
  const [amendError, setAmendError] = useState<AmendRefusal | null>(null);
  const [reopenBusy, setReopenBusy] = useState(false);
  const amendKeyRef = useRef<string | null>(null);
  const reopenKeyRef = useRef<string | null>(null);

  const onAmend = useCallback(
    (input: { cost: string; discountAmount: string; discountReason: string; reason: string }): void => {
      if (jobId === null) return;
      setAmendBusy(true);
      setAmendError(null);
      void (async () => {
        try {
          if (amendKeyRef.current === null) amendKeyRef.current = await uuid();
          const res = await api.request('POST', `/v1/jobs/${jobId}/completion/amend`, {
            body: {
              cost: input.cost,
              discountAmount: input.discountAmount,
              discountReason: input.discountReason === '' ? undefined : input.discountReason,
              reason: input.reason,
            },
            idempotencyKey: amendKeyRef.current,
          });
          if (!res.ok || res.data === null) {
            amendKeyRef.current = null; // a refused intent may be retried as itself
            setAmendError(
              amendRefusalOf(res.error?.code, res.error?.message ?? 'The amendment was refused. Try again.', res.error?.details),
            );
            return;
          }
          amendKeyRef.current = null;
          setAmendBusy(false);
          onDone();
        } catch (error) {
          setAmendBusy(false);
          setAmendError({
            message: error instanceof Error ? error.message : 'The amendment was refused. Try again.',
            reconciliation: null,
          });
        }
      })();
    },
    [jobId, onDone],
  );

  const onReopen = useCallback(
    (reason: string): void => {
      const reconciliation = amendError?.reconciliation;
      if (reconciliation === undefined || reconciliation === null) return;
      setReopenBusy(true);
      void (async () => {
        try {
          if (reopenKeyRef.current === null) reopenKeyRef.current = await uuid();
          const res = await api.request('POST', `/v1/cash/handovers/${reconciliation.id}/reopen`, {
            body: { reason },
            idempotencyKey: reopenKeyRef.current,
          });
          reopenKeyRef.current = null;
          if (!res.ok || res.data === null) {
            setReopenBusy(false);
            setAmendError({
              message: res.error?.message ?? 'The reopen was refused. Try again.',
              reconciliation,
            });
            return;
          }
          // The day is open again. The offer closes; the owner still has
          // to press Amend again — two deliberate steps (§6.2b).
          setReopenBusy(false);
          setAmendError(null);
        } catch (error) {
          setReopenBusy(false);
          setAmendError({
            message: error instanceof Error ? error.message : 'The reopen was refused. Try again.',
            reconciliation,
          });
        }
      })();
    },
    [amendError],
  );

  return { amendBusy, amendError, reopenBusy, onAmend, onReopen };
}

/** The card read for the pushed detail screen's header. */
export function useOwnerJobCard(jobId: string | null): {
  card: JobCardOwner | null;
  loading: boolean;
  error: string | null;
} {
  const card = useQuery({
    queryKey: ['owner', 'job-card', jobId],
    queryFn: () => fetchJson<JobCardOwner>(`/v1/jobs/${jobId ?? ''}`),
    enabled: jobId !== null,
  });
  return {
    card: card.data ?? null,
    loading: card.isLoading,
    error: card.isError ? (card.error?.message ?? "The job could not be read. Try again.") : null,
  };
}

/** The detail read for the side detail / pushed screen. */
export function useOwnerJobDetail(jobId: string | null): {
  detail: JobTimelineOwnerResponse | null;
  detailLoading: boolean;
  detailError: string | null;
  amend: ReturnType<typeof useAmendCompletion>;
  reload(): void;
} {
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const enabled = jobId !== null;
  const detail = useQuery({
    queryKey: ['owner', 'job-timeline', jobId, tick],
    queryFn: () => fetchJson<JobTimelineOwnerResponse>(`/v1/jobs/${jobId ?? ''}/events`),
    enabled,
  });
  const amend = useAmendCompletion(jobId, reload);
  return {
    detail: detail.data ?? null,
    detailLoading: detail.isLoading,
    detailError: detail.isError ? (detail.error?.message ?? 'The detail could not be read. Try again.') : null,
    amend,
    reload,
  };
}
