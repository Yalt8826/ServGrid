/**
 * Route-level wiring for the owner's O1 dashboard (T4.8). The screen is
 * pure over injected data; this module is the seam that feeds it — the
 * owner is ONLINE-ONLY (PLAN.md §5: no mirror, no outbox), so the seam
 * is two react-query reads against the api client:
 *
 * - `GET /v1/dashboard/owner` — the four figures and the two charts,
 *   computed server-side from the views that own their definitions
 *   (T4.6); the client never derives a figure.
 * - `GET /v1/dashboard/owner/attention` — the feed in consequence
 *   order; the mapper preserves the server's order, never re-sorts.
 *
 * `offline` is `useIsOnline`'s reachability read — the same hook the
 * dispatcher's dashboard runs, reused rather than retyped: unknown
 * counts as online, because dimming live figures on a guess is the
 * mistake §O1's offline state exists to avoid.
 *
 * There is no feature flag on this surface: the door is the api's
 * permission gate (`cash.confirm` × `read` at scope `all` — the one
 * matrix cell only the owner holds at `all`), exactly as T4.6 shipped
 * it; PHASE-4-OWNER.md names no flag for T4.8.
 */
import { useQuery } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { useIsOnline } from '../dispatcher/useDispatcherDashboard';
import {
  attentionRowsOf,
  figuresOf,
  type AttentionItem,
  type AttentionRowVm,
  type OwnerDashboardResponse,
  type OwnerFigure,
} from './model';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'This screen could not be read. Try again.');
  }
  return res.data;
}

export interface OwnerDashboardData {
  offline: boolean;
  figures: OwnerFigure[] | null;
  jobsPerDay: OwnerDashboardResponse['jobsPerDay'] | null;
  revenuePerWeek: OwnerDashboardResponse['revenuePerWeek'] | null;
  dashboardError: string | null;
  attention: AttentionRowVm[] | null;
  attentionError: string | null;
  retry: () => void;
}

/** The dashboard's two reads, as one hook. */
export function useOwnerDashboard(now: Date): OwnerDashboardData {
  const offline = !useIsOnline();

  const dashboard = useQuery({
    queryKey: ['owner', 'dashboard'],
    queryFn: () => fetchJson<OwnerDashboardResponse>('/v1/dashboard/owner'),
  });
  const attention = useQuery({
    queryKey: ['owner', 'attention'],
    queryFn: () => fetchJson<{ items: AttentionItem[] }>('/v1/dashboard/owner/attention'),
  });

  const message = (error: { message: string } | null): string =>
    error?.message ?? 'This section could not be read. Try again.';

  return {
    offline,
    figures: dashboard.data === undefined ? null : figuresOf(dashboard.data),
    jobsPerDay: dashboard.data === undefined ? null : dashboard.data.jobsPerDay,
    revenuePerWeek: dashboard.data === undefined ? null : dashboard.data.revenuePerWeek,
    dashboardError: dashboard.isError ? message(dashboard.error) : null,
    attention:
      attention.data === undefined
        ? null
        : attentionRowsOf(attention.data.items, now),
    attentionError: attention.isError ? message(attention.error) : null,
    retry: () => {
      void dashboard.refetch();
      void attention.refetch();
    },
  };
}
