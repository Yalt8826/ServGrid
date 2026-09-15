/**
 * Runtime query client: created once, the first time a role is known
 * (PLAN-FRONTEND.md §4). Every role runs `networkMode: 'online'` — the app
 * is online-only since 2026-09-15 — so a failed fetch surfaces immediately.
 * The cache lives in memory only; nothing is persisted to the device.
 */
import { QueryClient } from '@tanstack/react-query';
import type { Role } from '../lib/types';
import { staleTimeFor } from './queryClient';

let client: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (client !== null) return client;
  throw new Error('QueryClient requested before bootstrap assigned a role');
}

export function configureQueryClient(_role: Role): QueryClient {
  if (client === null) {
    client = new QueryClient({
      defaultOptions: {
        queries: {
          networkMode: 'online',
          retry: 1,
          refetchOnWindowFocus: false,
          gcTime: 30 * 60 * 1000,
        },
        mutations: {
          networkMode: 'online',
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
