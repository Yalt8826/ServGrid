/**
 * Cold-start bootstrap (PLAN-FRONTEND.md §5.1). Reads the stored actor
 * from the token store — a local read, never a network call — and routes
 * to the role's landing screen. No refresh is awaited before first paint:
 * an expired access token is refreshed lazily, on the first request that
 * needs it, which for an offline role may be hours later.
 */
import type { ApiClient } from '../lib/apiClient';
import type { StoredActor } from '../lib/types';

export interface BootstrapOutcome {
  authenticated: boolean;
  actor: StoredActor | null;
}

/**
 * Reads the session locally and applies it to the session store.
 * Storage failures (a lost keystore) land on the login screen rather
 * than crashing the start-up path; they do NOT clear the store, because
 * a read failure is not a logout.
 */
export async function bootstrapSession(api: ApiClient): Promise<BootstrapOutcome> {
  let session: Awaited<ReturnType<typeof api.store.load>> = null;
  try {
    session = await api.store.load();
  } catch {
    session = null;
  }
  if (session === null) {
    return { authenticated: false, actor: null };
  }
  return { authenticated: true, actor: session.actor };
}
