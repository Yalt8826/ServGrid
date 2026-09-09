import {
  type EmployeeAdmin,
  type EmployeeCreateRequest,
  type EmployeeDetail,
  type EmployeeListFilter,
  type EmployeePatchRequest,
  type EmployeePublic,
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

const DEACTIVATED_MESSAGE =
  'This employee may still hold open work, so the account cannot be changed yet.';

/**
 * TODO(T4.5) — the deactivation and role-change preconditions, stubbed for
 * Phase 0 and completed in Phase 4. The three blocking conditions are:
 *
 *   1. open jobs assigned to the employee        (job_cards — migration 007)
 *   2. companies he owns                         (companies.owner_rep_id — 005, but listed with the others)
 *   3. cash reconciliations submitted/disputed   (cash_reconciliations — migration 010)
 *
 * …and a role change adds a fourth: his outbox must be empty (Phase 1
 * sync). A technician silently deactivated mid-week leaves six jobs
 * assigned to someone who can no longer log in; an unconfirmed handover
 * is a row in a queue the owner may not have reached. The check refuses
 * rather than guesses: until the tables exist there is no honest way to
 * say "no open work", so every deactivation and role change gets
 * `409 EMPLOYEE_HAS_OPEN_WORK` with an empty `details` array — the shape
 * Phase 4 will fill with the blocking rows.
 */
async function refuseWhileOpenWorkUnverifiable(): Promise<never> {
  throw new AppError('EMPLOYEE_HAS_OPEN_WORK', DEACTIVATED_MESSAGE, []);
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
   * Name, phone, role, active — under `If-Match`. Deactivation and any
   * real role change run the open-work precondition first (T4.5 stub
   * above), so a deactivation is currently always refused; re-activation
   * and no-op writes are field updates and pass.
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
      await refuseWhileOpenWorkUnverifiable();
    }

    const updated = await repo.updateEmployeeFields(getPool(), id, {
      fullName: patch.fullName,
      phone: patch.phone,
      // A same-value role write is not a role change; it passes with the rest.
      role: roleChanges ? undefined : patch.role,
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
