/**
 * Route-level wiring for the dispatcher's D2 Job Logs (T2.8). The
 * screen is pure over injected data; this module is the seam that feeds
 * it — and, because the dispatcher is ONLINE-ONLY (PLAN-FRONTEND.md §4),
 * the seam is react-query reads against the api client:
 *
 * - **list** — `GET /v1/jobs` cursor-paginated (limit 200, the api's
 *   cap), every filter translated by `jobLogsListQuery` to what the
 *   server already implements, so filtering happens against the roster
 *   volume, never a truncated page. `useInfiniteQuery` follows the
 *   cursor on end-reached.
 * - **roster** — `GET /v1/technicians/load` twice over: the technician
 *   chip's options and the reassign picker's rows (and the NAMES the
 *   dispatcher reads — `GET /v1/employees` is owner-only).
 * - **offline** — `useIsOnline` (T2.7's hook, reused unchanged).
 * - **flags** — `dispatch.console` gates the screen, `dispatch.bulk`
 *   gates Reassign alone (the risky half, deliberately a second flag);
 *   both read `/v1/auth/me` like every flag (PLAN-EXECUTION.md §3).
 * - **URL** — expo-router params ARE the filter state (§D2: a filtered
 *   view survives a reload and can be shared): `useLocalSearchParams`
 *   reads, `jobLogsFiltersToParams` writes through `router.setParams`.
 * - **bulk** — `POST /v1/jobs/bulk-assign` carries the per-job
 *   `If-Match` (the card version the list showed), and the partial
 *   result is rendered honestly by the screen's outcome banner.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter, useLocalSearchParams } from 'expo-router';

import type {
  AuthMeResponse,
  FeatureFlagState,
  JobCardDispatcher,
  TechnicianLoad,
} from '@servgrid/shared';
import { defaultFeatureFlags } from '@servgrid/shared';
import { api } from '../../lib/api';
import { cachedFeatureFlags, setFeatureFlags } from '../../state/featureFlags';
import { useIsOnline } from './useDispatcherDashboard';
import {
  jobLogsFiltersFromParams,
  jobLogsFiltersToParams,
  jobLogsListQuery,
  type JobLogsJob,
  type JobLogsParams,
} from './jobLogsFilters';
import type { JobLogsBulkOutcome, JobLogsDeps, JobLogsTechnician } from './job-logs';

/** The api's page-size cap for `GET /v1/jobs`. */
const PAGE_LIMIT = 200;

/** One entry of the bulk-assign partial result — the shape shared
 * `BulkAssignResponseSchema` answers with (applied entries carry the
 * reassigned card; refused entries the code and the sentence). The
 * type lives api-side too; this is the client's local view of it. */
interface BulkAssignEntry {
  ok: boolean;
  jobId: string;
  jobNumber: string;
  message?: string;
}

export interface DispatchJobLogsFlags {
  flagsReady: boolean;
  consoleOn: boolean;
  bulkOn: boolean;
}

/** `dispatch.console` and `dispatch.bulk`, evaluated from
 * `/v1/auth/me` like every flag. Until an answer exists both read off —
 * the screen is dark, the bulk action unfindable. A failed fetch keeps
 * the last known answer. */
export function useDispatchJobLogsFlags(): DispatchJobLogsFlags {
  const cached = cachedFeatureFlags();
  const [state, setState] = useState<DispatchJobLogsFlags>(() =>
    cached === null
      ? { flagsReady: false, consoleOn: false, bulkOn: false }
      : { flagsReady: true, consoleOn: cached['dispatch.console'], bulkOn: cached['dispatch.bulk'] },
  );
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
        if (alive && flags !== null) {
          setState({ flagsReady: true, consoleOn: flags['dispatch.console'], bulkOn: flags['dispatch.bulk'] });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The request did not go through. Try again.');
  }
  return res.data;
}

interface JobListEnvelope {
  items: JobCardDispatcher[];
  nextCursor: string | null;
}

function outcomeOf(results: BulkAssignEntry[]): JobLogsBulkOutcome {
  const failures = results
    .filter((r) => !r.ok)
    .map((r) => ({ jobId: r.jobId, jobNumber: r.jobNumber, message: r.message ?? 'That job could not be reassigned.' }));
  return { reassigned: results.length - failures.length, failed: failures.length, failures };
}

/** Only the params this screen owns — unrelated params on the route
 * must not re-derive the filter state. */
function jobLogsParamsKeyOf(params: JobLogsParams): string {
  return JSON.stringify([params.date, params.tech, params.status, params.q]);
}

/**
 * The screen's deps, as one hook. Every piece composes from the pure
 * helpers, so the route file stays a mount point, not a brain.
 */
export function useJobLogs(): JobLogsDeps {
  const router = useRouter();
  const params = useLocalSearchParams() as JobLogsParams;
  const offline = !useIsOnline();

  // The URL is the filter state's home (§D2): re-derived only when the
  // params this screen owns actually change, so an unrelated navigation
  // re-render never rebuilds the view.
  const paramsKey = jobLogsParamsKeyOf(params);
  const { filters, query } = useMemo(
    () => jobLogsFiltersFromParams(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey],
  );

  const flags = useDispatchJobLogsFlags();

  // The list query string IS the view: filters + search. Pagination
  // rides the cursor, not the key — a page turn must not reset the list.
  const now = new Date();
  const listQuery = jobLogsListQuery(filters, query, now);
  const list = useInfiniteQuery({
    queryKey: ['dispatch', 'job-logs', listQuery],
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      fetchJson<JobListEnvelope>(
        `/v1/jobs?${listQuery}${listQuery === '' ? '' : '&'}limit=${PAGE_LIMIT}${pageParam === null ? '' : `&cursor=${encodeURIComponent(pageParam)}`}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last: JobListEnvelope) => last.nextCursor,
  });

  const rosterData = useQuery({
    queryKey: ['dispatch', 'technician-load'],
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

  const nameOf = useCallback(
    (employeeId: string | null): string | null => {
      if (employeeId === null) return null;
      return technicians.find((t) => t.employeeId === employeeId)?.name ?? null;
    },
    [technicians],
  );

  const jobs: JobLogsJob[] | null = useMemo(() => {
    if (list.data === undefined) return null;
    return list.data.pages
      .flatMap((page: JobListEnvelope) => page.items)
      .map(
        (card: JobCardDispatcher): JobLogsJob => ({
          id: card.id,
          jobNumber: card.jobNumber,
          title: card.title,
          customerName: card.customerName,
          status: card.status,
          overdue: card.isOverdue,
          scheduledFor: card.scheduledFor,
          technicianName: nameOf(card.assignedTo),
        }),
      );
  }, [list.data, nameOf]);

  // The card versions the list showed — the per-job `If-Match` a bulk
  // assign sends (schemas.ts: a multi-select spans cards last seen at
  // DIFFERENT versions, so the precondition rides per job).
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkOutcome, setBulkOutcome] = useState<JobLogsBulkOutcome | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const onReassign = useCallback(
    async (jobIds: string[], technicianId: string): Promise<void> => {
      const cards = new Map(
        (list.data?.pages ?? []).flatMap((page: JobListEnvelope) => page.items).map((card) => [card.id, card] as const),
      );
      setBulkBusy(true);
      setBulkError(null);
      setBulkOutcome(null);
      try {
        const entries = jobIds.map((id) => {
          const card = cards.get(id);
          if (card === undefined) throw new Error('That job is no longer in this view — clear the selection and choose again.');
          return { id, ifMatch: card.version };
        });
        const res = await api.request<{ results: BulkAssignEntry[] }>('POST', '/v1/jobs/bulk-assign', {
          body: { jobIds: entries, technicianId },
        });
        if (!res.ok || res.data === null) {
          setBulkError(res.error?.message ?? 'The reassign did not go through. Try again.');
          return;
        }
        setBulkOutcome(outcomeOf(res.data.results));
        void list.refetch(); // the reassigned cards changed — the list re-reads
      } catch (error) {
        setBulkError(error instanceof Error ? error.message : 'The reassign did not go through. Try again.');
      } finally {
        setBulkBusy(false);
      }
    },
    [list],
  );

  return {
    now,
    offline,
    loading: list.isLoading,
    jobs,
    error: list.isError ? (list.error?.message ?? 'The jobs could not be read. Try again.') : null,
    technicians,
    filters,
    query,
    bulkFlagOn: flags.bulkOn,
    bulkBusy,
    bulkOutcome,
    bulkError,
    onFiltersChange: (next) => router.setParams(jobLogsFiltersToParams(next, query)),
    onQueryChange: (next) => router.setParams(jobLogsFiltersToParams(filters, next)),
    onOpenJob: (jobId) => router.push(`/jobs/${jobId}`),
    onReassign: (jobIds, technicianId) => void onReassign(jobIds, technicianId),
    onDismissBulk: () => {
      setBulkOutcome(null);
      setBulkError(null);
    },
    onRetry: () => void list.refetch(),
    onLoadMore: () => {
      if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
    },
  };
}
