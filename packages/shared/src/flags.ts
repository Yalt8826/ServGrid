/**
 * Feature flags (PLAN-EXECUTION.md §3) — server-driven, returned in
 * `GET /v1/auth/me`, evaluated per employee and per role. Every phase's
 * user-facing surface ships behind its flag, and every flag defaults
 * off: a flag that defaulted on would make the phase's T0 rollback tier
 * ("turn it off server-side") worthless.
 *
 * Each flag names exactly one surface, so "turn it off" is never
 * ambiguous. The ids are the contract between the API (which evaluates)
 * and the apps (which gate screens on them) — both sides import this
 * list, so a flag cannot drift between them.
 */
export const FEATURE_FLAGS = [
  'tech.jobs', // 1 — technician job screens and completion
  'tech.location', // 1 — background tracking task and ping ingest
  'tech.notifications', // 2 — assignment pushes and local notifications
  'dispatch.console', // 2 — dispatcher dashboard, dispatch form, job logs
  'dispatch.bulk', // 2 — multi-select bulk reassign only; the risky half, separate on purpose
  'dispatch.overdue', // 2 — overdue filter and dashboard count
  'contracts.manage', // 2B — contract screens and CRUD
  'contracts.generate', // 2B — the nightly visit generator alone; unattended, separate on purpose
  'sales.cards', // 3 — sales cards and line items
  'sales.payments', // 3 — payment capture and the pending/collected tabs
  'sales.cash', // 3 — the sales rep's cash handover
  'owner.web', // 4 — the desktop rail and data table
  'owner.location', // 4 — location console and map
  'owner.cash', // 4 — reconciliation queue, confirm, dispute, reopen
  'owner.amend', // 4 — completion amendment
] as const;

export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** What `GET /v1/auth/me` returns: every flag, with its current state. */
export type FeatureFlagState = Readonly<Record<FeatureFlag, boolean>>;

/**
 * Phase 0: no user-facing surface has shipped behind a flag yet, so every
 * flag reads false. Per-phase evaluation (per employee, per role) arrives
 * with the phase that owns the surface; until then this is the whole
 * answer, and the apps treat a missing flag as false regardless.
 */
export function defaultFeatureFlags(): FeatureFlagState {
  return Object.fromEntries(FEATURE_FLAGS.map((flag) => [flag, false])) as FeatureFlagState;
}

/**
 * Effective flags for one employee: the defaults (every flag off) with
 * that employee's stored overrides applied on top. The single evaluation
 * point — `GET /v1/auth/me`, the sync and ping gates and the owner's flag
 * console all answer through it, so two readers can never disagree.
 * Unknown flag names in `overrides` (a renamed flag lingering in the
 * table) are ignored rather than trusted.
 */
export function evaluateFeatureFlags(overrides: Readonly<Record<string, boolean>>): FeatureFlagState {
  const effective: Record<FeatureFlag, boolean> = { ...defaultFeatureFlags() };
  for (const flag of FEATURE_FLAGS) {
    if (flag in overrides) effective[flag] = overrides[flag]!;
  }
  return effective;
}
