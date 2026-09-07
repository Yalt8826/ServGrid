/**
 * Runtime query client: created once, the first time a role is known
 * (PLAN-FRONTEND.md §4 — `networkMode` comes from the role's capability,
 * so the client cannot be built during cold start, which must not block
 * on anything but a local read). Online roles run `'online'` so a failed
 * fetch surfaces immediately; offline roles run `'offlineFirst'`.
 */
import { QueryClient } from '@tanstack/react-query';
import type { Role } from '../lib/types';
import { ROLE_CAPABILITIES } from '../lib/types';
import { staleTimeFor } from './queryClient';

let client: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (client !== null) return client;
  throw new Error('QueryClient requested before bootstrap assigned a role');
}

export function configureQueryClient(role: Role): QueryClient {
  if (client === null) {
    const capabilities = ROLE_CAPABILITIES[role];
    client = new QueryClient({
      defaultOptions: {
        queries: {
          networkMode: capabilities.networkMode,
          retry: 1,
          refetchOnWindowFocus: false,
          gcTime: 30 * 60 * 1000,
        },
        mutations: {
          networkMode: capabilities.networkMode,
        },
      },
    });
  }
  return client;
}

/** Test helper: discard the singleton. */
export function __resetQueryClient(): void {
  client = null;
}

export type { staleTimeFor };
