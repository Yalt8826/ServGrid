import { FEATURE_FLAGS, evaluateFeatureFlags, type FeatureFlag, type FeatureFlagState } from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import * as repo from './repo.js';

/**
 * Feature-flag evaluation and administration (PLAN-EXECUTION.md §3).
 * Flags are the T0 rollback tier — "the app is on people's phones and
 * the flags are the instrument" — and the dark-launch mechanism: every
 * user-facing surface ships behind one, defaulted off, turned on for one
 * named person at a time.
 *
 * The evaluation itself lives in shared (`evaluateFeatureFlags`); this
 * service owns the override store and the answers built on it: the
 * per-employee state `/auth/me` carries, the gate the sync and ping
 * surfaces read before answering, and the owner's roster-wide view.
 * Unknown flag names are refused loudly — a typo in a console is exactly
 * the mistake that must not look like a success.
 */

const FEATURE_FLAG_NAMES: ReadonlySet<string> = new Set<string>(FEATURE_FLAGS);

export function isFlagName(value: string): value is FeatureFlag {
  return FEATURE_FLAG_NAMES.has(value);
}

export async function effectiveForEmployee(employeeId: string): Promise<FeatureFlagState> {
  const overrides = await repo.listForEmployee(getPool(), employeeId);
  return evaluateFeatureFlags(Object.fromEntries(overrides.map((o) => [o.flag, o.enabled])));
}

/**
 * The sync/ping gates read this before answering: a flag that is not
 * explicitly on is off, which is what "defaulted off" means when the
 * caller is the surface the flag gates.
 */
export async function isFlagOn(employeeId: string, flag: FeatureFlag): Promise<boolean> {
  const r = await getPool().query<{ enabled: boolean }>(
    `SELECT enabled FROM employee_flag_overrides WHERE employee_id = $1 AND flag = $2`,
    [employeeId, flag],
  );
  return r.rows[0]?.enabled === true;
}

export async function listRosterFlags(): Promise<
  Array<{ employeeId: string; username: string; role: string; flags: FeatureFlagState }>
> {
  const rows = await repo.listAll(getPool());
  const byEmployee = new Map<string, { employeeId: string; username: string; role: string; flags: FeatureFlagState }>();
  for (const row of rows) {
    let entry = byEmployee.get(row.employeeId);
    if (!entry) {
      entry = { employeeId: row.employeeId, username: row.username, role: row.role, flags: evaluateFeatureFlags({}) };
      byEmployee.set(row.employeeId, entry);
    }
    (entry.flags as Record<FeatureFlag, boolean>)[row.flag] = row.enabled;
  }
  return [...byEmployee.values()];
}

export async function setOverride(
  employeeId: string,
  flag: FeatureFlag,
  enabled: boolean,
  updatedBy: string,
): Promise<FeatureFlagState> {
  if (!isFlagName(flag)) {
    throw new AppError('VALIDATION_FAILED', `Unknown feature flag: ${flag}`);
  }
  if (!(await repo.employeeExists(getPool(), employeeId))) {
    throw new AppError('NOT_FOUND', "We couldn't find that employee.");
  }
  await repo.upsert(getPool(), employeeId, flag, enabled, updatedBy);
  return effectiveForEmployee(employeeId);
}
