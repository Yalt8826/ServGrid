/**
 * Service calls — the hook (2026-09-17, Yashas).
 *
 * One read (`GET /v1/service-calls`, the two lists the page renders) and
 * one write (`POST /v1/customers/:id/follow-ups`, the call that was made).
 * Online-only, like every other dispatcher surface: the cycle the server
 * derives is the truth, and a stale phone's idea of "six months" is worse
 * than no list at all — the offline gate covers the screen.
 *
 * The write is not keyed: a double tap files the same call twice, and the
 * view's "latest wins" read makes that harmless (the second row says the
 * same thing as the first). What it never does is lose a call — a small
 * over-count in a history is the cheaper failure.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { FollowUpBody, ServiceCall, ServiceCallsResponse } from '@servgrid/shared';
import { api } from '../../lib/api';
import { useSessionStore } from '../../state/sessionStore';
import { useIsOnline } from './useDispatcherDashboard';

export const SERVICE_CALLS_KEY = ['service-calls'] as const;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await api.request<T>('GET', path);
  if (!res.ok || res.data === null) {
    throw new Error(res.error?.message ?? 'The call list could not be read. Try again.');
  }
  return res.data;
}

export interface ServiceCallsDeps {
  offline: boolean;
  loading: boolean;
  error: string | null;
  due: ServiceCall[] | null;
  pushed: ServiceCall[] | null;
  /** Filing a call in flight — the row's buttons stand down. */
  saving: boolean;
  /** The server's sentence when a call was refused. */
  saveError: string | null;
  onRetry(): void;
  onRecord(customerId: string, body: FollowUpBody): Promise<void>;
  onDismissError(): void;
}

/** The signed-in dispatcher's own id — the API stamps the call with it. */
function useActorId(): string | null {
  return useSessionStore((s) => s.actor?.id ?? null);
}

export function useServiceCalls(): ServiceCallsDeps {
  const queryClient = useQueryClient();
  const offline = !useIsOnline();
  const actorId = useActorId();

  const query = useQuery({
    queryKey: SERVICE_CALLS_KEY,
    enabled: actorId !== null,
    queryFn: () => fetchJson<ServiceCallsResponse>('/v1/service-calls'),
  });

  const mutation = useMutation({
    mutationFn: async ({ customerId, body }: { customerId: string; body: FollowUpBody }): Promise<ServiceCall> => {
      const res = await api.request<ServiceCall>('POST', `/v1/customers/${customerId}/follow-ups`, { body });
      if (!res.ok || res.data === null) {
        throw new Error(res.error?.message ?? 'That call could not be saved. Try again.');
      }
      return res.data;
    },
    onSuccess: () => {
      // The lists move a customer between them, so both are re-read.
      void queryClient.invalidateQueries({ queryKey: SERVICE_CALLS_KEY });
    },
  });

  return {
    offline,
    loading: query.isLoading,
    error: query.isError ? (query.error?.message ?? 'The call list could not be read. Try again.') : null,
    due: query.data?.due ?? null,
    pushed: query.data?.pushed ?? null,
    saving: mutation.isPending,
    saveError: mutation.isError ? (mutation.error?.message ?? 'That call could not be saved. Try again.') : null,
    onRetry: () => void query.refetch(),
    onRecord: async (customerId, body) => {
      try {
        await mutation.mutateAsync({ customerId, body });
      } catch {
        // The sheet stays open with what the dispatcher typed — the hook
        // surfaces the sentence through `saveError`.
      }
    },
    onDismissError: () => mutation.reset(),
  };
}
