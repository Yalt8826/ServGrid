/**
 * The one `TokenStore` interface, shared by both platform implementations
 * (PLAN-FRONTEND.md §4): Keychain/Keystore through `expo-secure-store` on
 * native, `localStorage` on web. App code imports only types from here —
 * the runtime store arrives through `tokenStore.impl.*`, which Metro
 * resolves per platform. Shared code NEVER touches `expo-secure-store`
 * directly: it is native-only, and the owner's desktop web build is the
 * one surface that must work without it.
 */

/** Session payload persisted under the store's session key. */
export interface StoredSession {
  /** May be expired — presence is not validity. Refreshed lazily. */
  accessToken: string;
  /** Opaque rotating refresh token; the one proof a session is alive. */
  refreshToken: string;
  /** Actor read off the last successful auth; routes the cold start. */
  actor: {
    id: string;
    role: 'technician' | 'dispatcher' | 'sales_rep' | 'owner';
    username: string;
  };
}

/**
 * Persistent, platform-appropriate credential storage. Implementations
 * must reject (not swallow) storage failures, and `clear()` failing must
 * leave the previously stored values readable — a caller that treats a
 * failed clear as a logout has logged a technician out of a session the
 * keystore still holds.
 */
export interface TokenStore {
  /** The stored session, or null when absent or unusable. Never throws for absence. */
  load(): Promise<StoredSession | null>;
  /** Persist the whole session, replacing any previous one. */
  save(session: StoredSession): Promise<void>;
  /** Remove the session. Idempotent; succeeds when nothing is stored. */
  clear(): Promise<void>;
  /**
   * Stable install identifier for `X-Device-Id` and the server's
   * `devices` row. Created on first call; survives `clear()` — device
   * identity is not session state.
   */
  installId(): Promise<string>;
}

/** Validate an unknown parsed value as a StoredSession; null if unusable. */
export function parseStoredSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.accessToken !== 'string' || s.accessToken.length === 0) return null;
  if (typeof s.refreshToken !== 'string' || s.refreshToken.length === 0) return null;
  if (typeof s.actor !== 'object' || s.actor === null) return null;
  const actor = s.actor as Record<string, unknown>;
  if (
    typeof actor.id !== 'string' ||
    typeof actor.username !== 'string' ||
    (actor.role !== 'technician' &&
      actor.role !== 'dispatcher' &&
      actor.role !== 'sales_rep' &&
      actor.role !== 'owner')
  ) {
    return null;
  }
  return {
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    actor: { id: actor.id, role: actor.role, username: actor.username },
  };
}
