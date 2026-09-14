import type { PoolClient } from 'pg';
import {
  type EmployeeAdmin,
  type EmployeeCreateRequest,
  type EmployeeDetail,
  type EmployeeListFilter,
  type EmployeePatchRequest,
  type EmployeePublic,
  type Role,
} from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import { hashPassword } from '../../lib/password.js';
import * as authRepo from '../auth/repo.js';
import * as repo from './repo.js';

/**
 * Employee administration (PLAN-BACKEND.md §4.1). Owner only, except
 * `GET /v1/employees/me`; there is no self-registration and no public
 * surface — accounts exist because the owner created them, which is what
 * keeps the roster closed and the permission matrix honest.
 *
 * `POST /v1/employees` is deliberately a Phase 0 endpoint even though the
 * owner-facing screen is Phase 4: the fourteen accounts have to exist
 * before anyone can log in, and seeding them by hand into production is
 * how a password ends up in a shell history.
 */

/** Unique-violation SQLSTATE — the employees_username_unique constraint. */
const UNIQUE_VIOLATION = '23505';

const OPEN_WORK_MESSAGE =
  'This employee still has open work. Clear the listed items — reassign the jobs and ' +
  'accounts, answer the cash — then try again.';

/**
 * The roles whose handset carries a mirror and an outbox (PLAN-FRONTEND.md
 * §4: dispatchers and owners are online-only, and Phase 3's rep reuses the
 * Phase 1 outbox unchanged). A role change out of one of these roles is
 * what removes offline capability at his next login, so it is the change
 * the fourth blocking condition guards.
 */
const OFFLINE_CAPABLE_ROLES: ReadonlySet<Role> = new Set<Role>(['technician', 'sales_rep']);

/**
 * One row the owner must clear before the account can change (T4.5,
 * PLAN.md §5, PLAN-GAPS.md G15). `kind` tells the owner's screen which
 * reassignment link to render; the 409 is a list of these, not an error
 * message — the screen hands him the work rather than describing it.
 */
export type BlockingRow =
  | { kind: 'job'; id: string; jobNumber: string; title: string; status: string }
  | { kind: 'company'; id: string; name: string }
  | { kind: 'cash'; id: string; businessDate: string; status: string; declaredAmount: string }
  | { kind: 'outbox'; id: string; endpoint: string };

/**
 * The deactivation and role-change preconditions (T4.5), completing the
 * Phase 0 stub. Three conditions block both, and a real role change adds
 * a fourth:
 *
 *   1. open jobs assigned to the employee        (job_cards)
 *   2. companies he owns                         (companies.owner_rep_id)
 *   3. cash reconciliations submitted/disputed   (cash_reconciliations)
 *   4. (role change out of an offline role) an undrained operation
 *
 * A technician silently deactivated mid-week leaves six jobs assigned to
 * someone who can no longer log in; a rep's accounts become invisible to
 * both reps at once; and an unconfirmed handover is a row in a queue the
 * owner may not have reached — deactivating the person is how a real
 * discrepancy becomes an unanswerable one. The promoted technician loses
 * offline capability at his next login, so his outbox must be empty
 * first; the server cannot count queued rows on a handset, so it refuses
 * on the drain evidence it does have (see repo.listUndrainedOperations),
 * with §4.1's client-side drain-first rule carrying the rest.
 */
async function collectBlockingRows(
  client: PoolClient,
  employeeId: string,
  includeOutbox: boolean,
): Promise<BlockingRow[]> {
  const jobs = await repo.listOpenJobs(client, employeeId);
  const companies = await repo.listOwnedCompanies(client, employeeId);
  const cash = await repo.listUnconfirmedCash(client, employeeId);
  const outbox = includeOutbox ? await repo.listUndrainedOperations(client, employeeId) : [];
  return [
    ...jobs.map((j): BlockingRow => ({ kind: 'job', id: j.id, jobNumber: j.job_number, title: j.title, status: j.status })),
    ...companies.map((c): BlockingRow => ({ kind: 'company', id: c.id, name: c.name })),
    ...cash.map(
      (c): BlockingRow => ({
        kind: 'cash',
        id: c.id,
        businessDate: c.business_date,
        status: c.status,
        declaredAmount: c.declared_amount,
      }),
    ),
    ...outbox.map((o): BlockingRow => ({ kind: 'outbox', id: o.key, endpoint: o.endpoint })),
  ];
}

export function toEmployeeAdmin(row: repo.EmployeeAdminRecord): EmployeeAdmin {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

function toEmployeePublic(row: authRepo.EmployeeRecord): EmployeePublic {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    phone: row.phone,
    role: row.role,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

export function createEmployeesService() {
  /** The roster. Empty filters return everything; the owner narrows client-side too. */
  async function list(filter: EmployeeListFilter): Promise<EmployeeAdmin[]> {
    const rows = await repo.listEmployees(getPool(), filter);
    return rows.map(toEmployeeAdmin);
  }

  /**
   * Owner creates an account from a temporary password. A duplicate
   * username is `409 DUPLICATE_ENTITY` naming the existing row (§3.1) —
   * caught from the constraint, not pre-checked, so two concurrent
   * creates of the same username cannot both win.
   */
  async function create(actorId: string, input: EmployeeCreateRequest): Promise<EmployeeAdmin> {
    const passwordHash = await hashPassword(input.tempPassword);
    try {
      const row = await repo.insertEmployee(getPool(), {
        username: input.username,
        passwordHash,
        fullName: input.fullName,
        phone: input.phone ?? null,
        role: input.role,
        createdBy: actorId,
      });
      return toEmployeeAdmin(row);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === UNIQUE_VIOLATION
      ) {
        const existing = await authRepo.findEmployeeByUsername(getPool(), input.username);
        throw new AppError('DUPLICATE_ENTITY', 'That username is already taken.', {
          existing: existing
            ? { id: existing.id, username: existing.username }
            : { username: input.username },
        });
      }
      throw error;
    }
  }

  /** Employee + device diagnostics. Tracking health joins in Phase 1, when `v_employee_tracking_health` exists (migration 009). */
  async function detail(id: string): Promise<EmployeeDetail> {
    const row = await repo.findEmployeeAdminById(getPool(), id);
    if (!row) throw new AppError('NOT_FOUND', "We couldn't find that employee.");
    const devices = await repo.listDevices(getPool(), id);
    return {
      ...toEmployeeAdmin(row),
      devices: devices.map((d) => ({
        id: d.id,
        installId: d.install_id,
        manufacturer: d.manufacturer,
        model: d.model,
        osVersion: d.os_version,
        appVersion: d.app_version,
        locationPermission: d.location_permission,
        batteryOptExempt: d.battery_opt_exempt,
        autostartConfirmed: d.autostart_confirmed,
        notificationsEnabled: d.notifications_enabled,
        lastSeenAt: d.last_seen_at?.toISOString() ?? null,
        isActive: d.is_active,
      })),
    };
  }

  /**
   * Name, phone, role, active — under `If-Match`. A deactivation and any
   * real role change run the open-work preconditions first (T4.5), inside
   * the same transaction as the write they guard. A deactivated account's
   * consequence chain — every refresh token revoked, his devices marked
   * inactive — is exactly the password-reset chain plus the devices; the
   * health view and the roster drop him through `is_active` itself, and
   * his completions, payments and pings are untouched: `is_active` was
   * never a delete. Re-activation and no-op writes are field updates and
   * pass.
   */
  async function update(id: string, ifMatch: number, patch: EmployeePatchRequest): Promise<EmployeeAdmin> {
    const row = await repo.findEmployeeAdminById(getPool(), id);
    if (!row) throw new AppError('NOT_FOUND', "We couldn't find that employee.");
    if (row.version !== ifMatch) {
      throw new AppError(
        'VERSION_CONFLICT',
        'This record changed after you opened it — reload it and try again.',
        { currentVersion: row.version },
      );
    }

    const roleChanges = patch.role !== undefined && patch.role !== row.role;
    const deactivates = patch.isActive === false && row.is_active;
    if (roleChanges || deactivates) {
      return withTransaction(async (client) => {
        // The fourth condition is a role change's alone: promotion is what
        // strips offline capability at his next login, so his queue must
        // have drained first (§4.1).
        const blocking = await collectBlockingRows(
          client,
          id,
          roleChanges && OFFLINE_CAPABLE_ROLES.has(row.role),
        );
        if (blocking.length > 0) {
          throw new AppError('EMPLOYEE_HAS_OPEN_WORK', OPEN_WORK_MESSAGE, blocking);
        }
        const updated = await repo.updateEmployeeFields(client, id, {
          fullName: patch.fullName,
          phone: patch.phone,
          // The gated branch is here because the role truly changed; write it.
          role: patch.role,
          isActive: patch.isActive,
        });
        if (deactivates) {
          await authRepo.revokeAllForEmployee(client, id);
          await repo.deactivateDevices(client, id);
        }
        return toEmployeeAdmin(updated);
      });
    }

    const updated = await repo.updateEmployeeFields(getPool(), id, {
      fullName: patch.fullName,
      phone: patch.phone,
      // Here the role is absent or same-value — a no-op role write passes
      // with the rest, and the column keeps at least one SET clause.
      role: patch.role,
      isActive: patch.isActive,
    });
    return toEmployeeAdmin(updated);
  }

  /**
   * Owner resets someone (§4): new temporary hash with
   * `must_change_password` set, and every refresh token for the account
   * revoked — the same consequence chain the self-service change and the
   * break-glass CLI follow, so "reset" always means "every session ends".
   */
  async function resetPassword(id: string, tempPassword: string): Promise<void> {
    const row = await repo.findEmployeeAdminById(getPool(), id);
    if (!row) throw new AppError('NOT_FOUND', "We couldn't find that employee.");
    const passwordHash = await hashPassword(tempPassword);
    await withTransaction(async (client) => {
      await repo.updatePasswordForReset(client, id, passwordHash);
      await authRepo.revokeAllForEmployee(client, id);
    });
  }

  /** `GET /v1/employees/me` — the one endpoint any role may call; self only, keyed off the token. */
  async function me(employeeId: string): Promise<EmployeePublic> {
    const employee = await authRepo.findEmployeeById(getPool(), employeeId);
    if (!employee || !employee.is_active) {
      throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
    }
    return toEmployeePublic(employee);
  }

  return { list, create, detail, update, resetPassword, me };
}

export type EmployeesService = ReturnType<typeof createEmployeesService>;
