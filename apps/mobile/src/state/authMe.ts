/**
 * Process-level cache of `GET /v1/auth/me` — the signed-in employee, and
 * the one read every feature flag comes from.
 *
 * Deliberately dependency-free, exactly like `featureFlags.ts` beside it:
 * `apiClient` clears this on logout, and apiClient is unit-tested without
 * a React Native runtime, so importing anything Expo-backed here would
 * drag expo-modules-core into a pure test (it did — 2026-09-17). The
 * fetching lives in `useAuthMe.ts`; this module owns only the answer.
 */
import type { AuthMeResponse } from '@servgrid/shared';

let cached: AuthMeResponse | null = null;

export function cachedAuthMe(): AuthMeResponse | null {
  return cached;
}

export function setAuthMe(me: AuthMeResponse): void {
  cached = me;
}

/**
 * Session teardown — the rule the flag cache already follows: this answer
 * belongs to the person who just left, and keeping it would greet the
 * next user by the previous one's name.
 */
export function resetAuthMe(): void {
  cached = null;
}
