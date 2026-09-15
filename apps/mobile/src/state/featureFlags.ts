/**
 * Process-level feature-flag store (PLAN-EXECUTION.md §3). The flags the
 * server evaluated for the signed-in employee ride `GET /v1/auth/me`;
 * this module is where every consumer reads them without each owning a
 * fetch. `useTechnicianWork`'s flag loader writes here; the location
 * task reads here.
 *
 * Session rules, per PLAN-FRONTEND.md §4: the answer is cached for the
 * process; until an answer exists every flag reads its default (off) for
 * SCREEN-gating, and a failed fetch keeps the last known answer — a
 * network failure must not flip a live screen dark.
 */
import { defaultFeatureFlags, type FeatureFlag, type FeatureFlagState } from '@servgrid/shared';

let cached: FeatureFlagState | null = null;

export function setFeatureFlags(flags: FeatureFlagState): void {
  cached = flags;
}

export function cachedFeatureFlags(): FeatureFlagState | null {
  return cached;
}

export function resetFeatureFlags(): void {
  cached = null;
}

/**
 * For consumers whose "unknown" must differ from "off". The tracking
 * task discards a fix only when `tech.location` is explicitly false; a
 * merely UNKNOWN answer (offline cold start, no `/auth/me` yet) must not
 * silently kill a day of pings — the server rejects those authoritatively
 * (per-ping `DISABLED`, §8) and the buffer clears on the next drain.
 * Returns null for unknown.
 */
export function explicitFlagState(flag: FeatureFlag): boolean | null {
  return cached === null ? null : cached[flag];
}

/** The screen-gating read: unknown and off are the same answer (dark). */
export function isFlagOn(flag: FeatureFlag): boolean {
  return (cached ?? defaultFeatureFlags())[flag];
}
